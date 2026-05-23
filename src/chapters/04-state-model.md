# Chapter 4: State Model

Every blockchain is a replicated state machine. Transactions transform state;
consensus ensures every honest node agrees on the result. The quality of the
state model decides how fast you commit, how cheap you sync, and how well you
parallelize execution.

Pyde stores all state in a **Jellyfish Merkle Tree (JMT)**, persisted in
RocksDB, with **hybrid hashing**: Blake3 on high-volume native paths,
Poseidon2 on ZK-bearing paths. The state commitment is dual-rooted —
Blake3 for fast native verification by committee and validators, Poseidon2
for future ZK light clients and validity proofs.

The JMT replaces the fixed-depth Sparse Merkle Tree the project initially
shipped — a swap made because JMT's radix-16 path compression delivers
roughly 40× faster commits. Hybrid hashing was adopted post-pivot once the
performance cost of running Poseidon2 over every internal JMT node became
clear; Blake3 is ~50× faster on commodity CPUs without sacrificing the
ZK-friendly properties where they matter (state root, address derivation,
FALCON-sig-hashing inside circuits).

---

## 4.1 The Jellyfish Merkle Tree

The JMT is a radix-16 path-compressed Merkle tree. Each internal node has up
to 16 children (one per nibble), and runs of single-child nodes are
compressed into a single edge labelled with the shared key prefix. Empty
subtrees are not materialized.

Why JMT over a fixed-depth Sparse Merkle Tree?

| Property                | Fixed-depth SMT (256 levels) | JMT (radix-16, compressed) |
| ----------------------- | ---------------------------- | -------------------------- |
| Node hashes per update  | 256                          | depth-of-key (typ. 8–14)   |
| Empty subtree storage   | implicit (precomputed)       | implicit (no materialize)  |
| Update batching         | per-key                      | bulk via `update_all`      |
| Throughput (commits)    | baseline                     | ~40× faster                |
| Proof size              | fixed (256 sibling hashes)   | variable (typ. 8–14)       |
| Non-existence proofs    | empty leaf hash              | path divergence proof      |

The headline number — 40× faster commits — was the deciding factor. JMT
removes the per-key 256-Poseidon2 cost, replacing it with a path that follows
the actual key density in the tree.

The implementation lives in `crates/state/src/jmt_store.rs`. The persistent
wrapper exposes a small surface:

```rust
PersistentJMT {
    fn insert(key: H256, value: Vec<u8>) -> ...
    fn get(key: H256) -> Option<Vec<u8>>
    fn update_all(updates: &[(H256, Option<Vec<u8>>)]) -> ...
    fn root() -> H256
    fn delete(key: H256) -> ...
    fn is_empty() -> bool
}
```

A `HybridJmtHasher` adapter implements the `jmt::SimpleHasher` trait,
delegating internal node hashes to **Blake3** (the high-volume path) and
exposing **Poseidon2** for state-root and address-derivation paths. The
JMT internals use Blake3; the snapshot manifest and ZK-bearing exports
use Poseidon2. Both roots are computed and signed (Chapter 6).

---

## 4.1b Two-Table Architecture: `state_cf` + `jmt_cf`

Pyde maintains state in **two RocksDB column families**, each optimized for a different access pattern:

```text
┌────────────────────────────────────────────────────────────────────────┐
│  state_cf — flat key-value index for live reads                         │
│                                                                          │
│    key   = slot_hash (32 bytes, PIP-2 layout)                           │
│    value = current slot value (raw bytes)                               │
│                                                                          │
│    O(1) point lookup. Updated on every state change.                    │
│    Used by: live execution path (sload), RPC queries, range scans.       │
└────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│  jmt_cf — versioned tree structure for proofs + state root              │
│                                                                          │
│    key   = NodeKey(version: u64, NibblePath)                            │
│    value = JmtNode { children_fingerprints[], value_bytes (if leaf) }    │
│                                                                          │
│    O(depth) walk for proofs. Updated at every wave commit.              │
│    Used by: state-root computation, Merkle proofs for light clients,    │
│            historical state queries (on archive nodes).                  │
└────────────────────────────────────────────────────────────────────────┘
```

**Why two tables instead of one:**

The JMT alone can serve every read, but each read is `O(depth)` — typically 6-8 RocksDB gets to walk from root to leaf. For live execution at thousands of TPS, that's too expensive.

`state_cf` keeps a flat denormalized index of the *current* value for every slot. A single get returns the value. PIP-2's clustered slot_hash layout keeps `state_cf` entries spatially clustered by contract, so range scans and multigets stay cheap.

The JMT structure is still maintained alongside, because it's needed for:
- **State-root computation**: hash up from leaves to root, deterministically, across all validators
- **Merkle proofs**: light clients verify `(value, proof) → state_root` without holding full state
- **Versioned reads**: archive nodes serve historical state by walking older JMT versions

**The read path:**

```text
fn read_slot(slot_hash) -> Option<Bytes>:
  1. dashmap.get(slot_hash)                ← PIP-4 in-memory cache (most live reads)
  2. state_cf.get(slot_hash)                ← ONE disk read (cache miss path)
  
  Total: one disk get, sometimes amortized to zero.
```

The JMT is **not** in the live read path. Reads use `state_cf`. The JMT is reached only for proofs or for state-root computation at commit time.

**The write path (at wave commit):**

```text
fn commit_wave(dirty_changes: Vec<(SlotHash, Bytes)>):
  1. For each (slot_hash, new_value) in dirty_changes:
       jmt.update(slot_hash, new_value, new_version)
         → JMT recomputes leaf_hash + internal hashes up the affected path
       state_cf.put(slot_hash, new_value)
  
  2. new_state_root = jmt.root_hash(new_version)
  
  3. Both writes happen in a single RocksDB WriteBatch (atomic).
```

The two tables stay in lockstep. They are never out of sync because every write touches both atomically.

**Cost of duplication:** roughly 2× storage for the state itself (the leaves' values appear in both `state_cf` and the JMT's leaf records). This is the trade-off — extra storage in exchange for O(1) live reads while still preserving authenticated proofs.

**Retention split:**

| Node tier | `state_cf` | `jmt_cf` |
|-----------|-----------|----------|
| Pruned validator | Current state only | Latest version only (older GC'd) |
| Archive node | Current state | All historical versions |
| Light client | None | Just state_root from WaveCommitRecords |

---

## 4.1c Events Storage: `events_cf` + Indexes

State is not the only thing the chain stores. Events emitted via `pyde::emit_event` (see [Chapter 3 §3.3](./03-virtual-machine.md) and [Host Function ABI Spec §15](../companion/HOST_FN_ABI_SPEC.md)) live in three additional column families parallel to `state_cf` + `jmt_cf`:

```text
events_cf (primary, ordered by wave)
  key:   wave_id (8 BE) || tx_index (4 BE) || event_index (4 BE)
  value: borsh_encode(EventRecord)

events_by_topic_cf (index)
  key:   topic (32) || wave_id (8 BE) || tx_index (4 BE) || event_index (4 BE)
  value: ()                    -- empty; key carries lookup info

events_by_contract_cf (index)
  key:   contract_addr (32) || wave_id (8 BE) || tx_index (4 BE) || event_index (4 BE)
  value: ()
```

**Atomicity:** at every wave commit, the engine writes one RocksDB `WriteBatch` containing updates to `state_cf` + `jmt_cf` + `events_cf` + `events_by_topic_cf` + `events_by_contract_cf` + the wave commit record. Either all five land or none does.

**On-chain commitment:** each wave commit record carries two summaries of the wave's events:
- `events_root` (Blake3) — binary Merkle tree over canonical-ordered events, suitable for inclusion proofs.
- `events_bloom` (256-byte, 2048-bit, 3-hash) — probabilistic summary for cheap "any event matching X in this wave?" checks.

Both are threshold-signed as part of the wave's `HardFinalityCert`, so light clients verify event inclusion identically to how they verify state.

**Retention:**

| Node tier | `events_cf` + indexes |
|-----------|------------------------|
| Archive node | All events, forever |
| Pruned validator | Last 90 days |
| Committee validator | Last 30 days |
| Light client | None (verifies inclusion proofs against signed `events_root`) |

Pruning is in lockstep across all three event column families.

For query semantics (`pyde_getLogs`), subscriptions (`pyde_subscribe`), and the Borsh-recommended event encoding, see [Host Function ABI Spec §14–§15](../companion/HOST_FN_ABI_SPEC.md).

---

## 4.2 Hybrid Hashing: Blake3 + Poseidon2

Pyde uses two hashes in different layers, chosen for what each is best at:

| Hash       | Speed (commodity CPU) | ZK-friendly | Where used |
|------------|----------------------|-------------|------------|
| **Blake3** | ~3 GB/s              | No (huge circuit) | JMT internal nodes, batch hashes, vertex hashes, gossip de-dup, RocksDB keys |
| **Poseidon2** | ~60 MB/s          | Yes (small circuit) | State root commitment, address derivation, FALCON sig hashing inside ZK circuits, threshold MAC |

**The split rule:** every hash that lives entirely off-chain or inside a
trusted committee-signed structure can be Blake3. Every hash that may be
exposed to a future ZK proof (state root, addresses, signature payloads)
is Poseidon2.

### Poseidon2 (Goldilocks)

Poseidon2 is the algebraic hash used everywhere in Pyde — the JMT, contract
storage-key derivation, transaction hashing, the threshold MAC, the VRF, and
the `poseidon2` WASM host function. The parameter set (see Chapter 8 for full
detail):

| Parameter              | Value                              |
| ---------------------- | ---------------------------------- |
| Field                  | Goldilocks (`p = 2^64 - 2^32 + 1`) |
| State width            | 8                                  |
| Rate                   | 4 (256-bit absorb/squeeze)         |
| Capacity               | 4                                  |
| External rounds        | 8 (4 + 4)                          |
| Internal rounds        | 22                                 |
| S-box                  | `x^7`                              |
| Output                 | 256 bits                           |

The hash is exposed as three primitives:

| Function                            | Use                                           |
| ----------------------------------- | --------------------------------------------- |
| `poseidon2_hash(bytes)`             | arbitrary input → 256-bit digest              |
| `poseidon2_pair(left, right)`       | Merkle node hash (order-sensitive by design)  |
| `poseidon2_many(&[Hash256])`        | sponge over a variable-length array of hashes |

The `_pair` form is exposed for compatibility but JMT internal nodes use
Blake3 (`blake3_pair`); Poseidon2's `_hash` form is what storage-key
derivation, address derivation, and the `poseidon2` WASM host function use; the
`_many` form is what the threshold scheme uses to combine epoch randomness
shares.

### Blake3

Used in the high-volume paths where ZK-friendliness is irrelevant:

```
- JMT internal node hashes (hybrid-mode hasher)
- Batch hashes referenced from vertices
- Vertex hashes in the DAG
- Gossip message de-duplication keys
- RocksDB cache keys
```

Blake3 is configured in its default tree-hashing mode with 256-bit output.
Native verification of a JMT inclusion proof against the Blake3 state root
takes ~5-10 hash operations and completes in microseconds — fast enough
that the snapshot manifest verification (Chapter 7) doesn't dominate sync
time.

---

## 4.3 Account Storage Layout

Every account in `crates/account/src/types.rs` has a fixed layout:

```rust
struct Account {
    address:      Address,    // 32 bytes (Poseidon2 hash of FALCON pubkey)
    nonce:        u64,        // 8 bytes (sliding window base — see Chapter 11)
    balance:      u128,       // 16 bytes, in quanta (10^9 quanta = 1 PYDE)
    code_hash:    H256,       // 32 bytes (zero for EOAs)
    storage_root: H256,       // 32 bytes (zero for empty contracts)
    account_type: AccountType,// 1 byte (EOA=0, Contract=1, System=2)
    auth_keys:    AuthKeys,   // variable (FALCON pubkey or multisig set)
    gas_tank:     u128,       // 16 bytes (sponsored-tx pool)
    key_nonce:    u32,        // 4 bytes (rotation counter)
}
```

Fixed portion: 141 bytes plus the variable `auth_keys` field.

The address is a 32-byte Poseidon2 hash. Three derivation paths exist:

```
EOA address     = Poseidon2(falcon_public_key_bytes)              // 897-byte FALCON pk
CREATE address  = Poseidon2(deployer_address || nonce_bytes)
CREATE2 address = Poseidon2(0xFF || deployer_address || salt || code_hash)
```

The 32-byte length matches the natural Poseidon2 output (4 Goldilocks field
elements ≈ 256 bits) and avoids the birthday-bound concerns of 20-byte
truncated addresses at chain scale.

---

## 4.4 Storage Keys and Slots

Pyde uses a flat storage layout. Account fields and contract storage slots
all live in the same JMT, distinguished by **discriminator bytes** in the key
derivation.

The key derivation pattern is:

```
key = Poseidon2(account_address || discriminator || sub_key)
```

Some discriminators currently in use (defined in `crates/state/src/keys.rs`):

| Discriminator | Name                      | What it keys                                   |
| ------------- | ------------------------- | ---------------------------------------------- |
| 0x12          | `SUPPLY`                  | Total PYDE supply counter                      |
| 0x13          | `TOTAL_BURNED`            | Cumulative fee burn counter                    |
| 0x14          | `REWARDS_PER_STAKE_UNIT`  | Lazy-accrual per-stake-unit reward accumulator |
| 0x15          | `ACTIVE_STAKE_WEIGHTED_TOTAL` | Pool divisor (sum of stake × uptime; excludes exited/slashed) |
| 0x16          | `VESTING`                 | Per-account vesting schedule                   |
| 0x17          | `VALIDATOR_SUBSIDY`       | `(total_amount, end_wave)` for streaming subsidy|
| 0x18          | `AIRDROP_ROOT`            | Genesis airdrop Merkle root                    |
| 0x19          | `AIRDROP_DEADLINE`        | Slot height after which sweep is allowed       |
| 0x1A          | `AIRDROP_CLAIMED`         | Per-leaf-index claim bitmap                    |
| 0x1B          | `AIRDROP_EXPECTED_SUM`    | Genesis pool size invariant                    |
| 0x1C          | `MULTISIG_SIGNERS`        | Treasury multisig signer set (FALCON pks)      |
| 0x1D          | `MULTISIG_THRESHOLD`      | Required signature count                       |
| 0x1E          | `MULTISIG_NONCE`          | Replay-protection counter for multisig actions |
| 0x1F          | `EMERGENCY_PAUSE_END_WAVE`| End wave_id of an active emergency pause       |

This flat scheme means a single Merkle path can prove any state claim — there
is no nested account-trie / storage-trie indirection (the classic
Patricia-trie pattern). One proof, one `Poseidon2`-walk to the root.

### Contract storage layout

The `otigen` developer toolchain's state binding generator assigns slot
identifiers to storage fields declared in `otigen.toml`. Each contract
defines its state schema once and gets language-specific bindings that
encode the slot derivation as build-time constants. Single-value fields
lower to:

```
key = Poseidon2(contract_address, slot_index)
```

Maps lower to a doubled hash:

```
key = Poseidon2(contract_address, Poseidon2(slot_index, map_key))
```

Nested maps add another inner Poseidon2 per nesting level. This is the
machinery that makes `self.balances[user_addr]` a single `Sload` opcode in
the compiled bytecode.

---

## 4.5 The Block Witness

Pyde's block witness is the data needed to verify and re-execute a block from
scratch given only the previous state root. It lives in
`crates/state/src/witness.rs`:

```rust
pub struct BlockWitness {
    pub entries:         Vec<WitnessEntry>,
    pub proof:           SparseMerkleProof,   // single batched proof
    pub pre_state_root:  H256,
    pub post_state_root: H256,                // populated by finalize_witness
}
```

The shape:

- `entries` — every state slot the block touched, with its pre-execution
  value.
- `proof` — a single batched Merkle proof covering all entries against
  `pre_state_root`. JMT supports batch verification, so the proof is
  asymptotically smaller than `len(entries)` independent paths.
- `pre_state_root` — the state root *before* this block executes (taken from
  the parent block's header).
- `post_state_root` — the state root *after* execution, set by
  `set_post_state_root()` or `finalize_witness()` once the block is executed.

Critically, `post_state_root` is **not** auto-populated at witness generation
time. The witness is built before execution; the post-root is filled in
afterwards. `is_finalized()` returns false until that step happens.

### The 1 MB witness size cap

A hostile transaction could theoretically force a witness containing millions
of entries (e.g., touching deep, sparse storage paths). Pyde caps witness
size hard:

```rust
pub const MAX_WITNESS_SIZE: usize = 1024 * 1024;  // 1 MB
```

`verify_witnesses()` rejects any witness exceeding this cap before doing the
work of proof verification. The block as a whole is rejected.

---

## 4.6 RocksDB Layout

The JMT and witness logic both persist through RocksDB
(`JmtRocksStore` in `crates/state/src/jmt_store.rs`). The key prefixes are:

| Prefix | Meaning                                  |
| ------ | ---------------------------------------- |
| `0x10` | JMT internal nodes                       |
| `0x11` | Leaf values                              |
| `0x12` | Metadata (version counter, latest root)  |

LRU caches sit in front of node and value reads (256k entries each, sized for
the working set of an active validator). Compression is LZ4 for the L0–L1
levels and ZSTD for cold levels; the block cache is 512 MB and the memtable
pool is 256 MB. These are tuned for the steady-state validator workload, not
for peak burst sync.

Writes to consensus-critical state use `WriteOptions::set_sync(true)` (see
Chapter 6) — JMT updates do not, because the canonical truth is the chain
itself; on restart, a validator can rebuild any missing state from blocks.

---

## 4.7 The Block-Application Pipeline

When a block is executed, the state pipeline runs in this order:

1. Open a batch against the current JMT.
2. Execute each parallel group from the conflict graph (see Chapter 9 for
   how the access-list scheduler builds groups).
3. Within a group, transactions execute sequentially in order; across
   groups, in parallel against the same `pre_state_root`.
4. Apply state writes to the batch.
5. Distribute fees: 70% to the burn counter (`TOTAL_BURNED` discriminator),
   20% to the epoch reward pool (distributed at epoch end by stake × uptime),
   10% to the treasury account.
6. Commit the batch with `update_all`. The new root is `post_state_root`.
7. Set `witness.post_state_root` and stamp the block header.

The "execute then commit" ordering means the post-root is a function of the
exact transaction set, the exact ordering, and the exact starting state — so
two honest validators given the same encrypted block always agree on the
post-root. Disagreement is a slashing-grade safety violation.

---

## 4.8 State Sync

A new node joining the network does not replay every block from genesis —
at production TPS, full replay would take longer than the chain has
existed. Pyde defines three sync modes (full spec: [companion/STATE_SYNC.md](../companion/STATE_SYNC.md),
operational summary: Chapter 7):

1. **Snapshot sync (default for new full nodes).** Download a committee-signed
   `SnapshotManifest` (~5 KB) carrying both Blake3 and Poseidon2 state roots
   plus chunk references. Verify ≥85 FALCON signatures. Download chunks
   (~4 MB each) in parallel from peers, verify each against the manifest,
   reconstruct the JMT, recompute the Blake3 root, compare. Then replay
   the tail blocks (≤ 8 epochs ≈ 24 hours of tx) to reach the current head.
   Total time on commodity (100 Mbps): ~40 minutes.

2. **Light client sync.** Headers only + cared-about accounts via JMT
   inclusion proofs. ~600 KB/year for a typical wallet. Verifies FALCON
   signatures on the headers it receives.

3. **Full sync (archive nodes).** Replay every block from genesis. Slowest
   option; provides full historical state lookup for explorers / indexers.

**Chain-of-trust bootstrap.** A new node verifies the chain of snapshot
manifests from genesis forward: genesis hardcodes `committee_0`'s pubkeys;
each subsequent epoch-boundary manifest is signed by the prior committee
and contains the next committee's pubkeys.

**Weak-subjectivity checkpoints** published by the foundation and reputable
infrastructure providers let new nodes trust a recent checkpoint and skip
the chain-of-trust walk. Beyond a one-epoch rollback window, contradicting
a finality checkpoint is impossible without a hard fork.

---

## 4.9 What Is NOT in the State

A few things deliberately do **not** live in the JMT:

- **Receipts.** Stored in an in-memory ring buffer
  (`crates/node/src/receipt_store.rs`, `MAX_RECEIPT_SLOTS = 10_000`). At
  ~500 ms per commit, this is roughly 80 minutes of recent receipt
  history. Persistent receipt storage (archive-node mode) is tracked as
  post-mainnet hardening.

- **Mempool contents.** Encrypted transactions live in process memory,
  bounded per sender by the rate-limiting subsystem (10 tx/s, 100 concurrent
  per sender).

- **Consensus protocol state.** `pending_votes`, `seen_proposals`,
  `seen_votes`, and pending evidence live in their own RocksDB column under
  the consensus_store, with `set_sync(true)` writes — see Chapter 6.

- **Finality checkpoints.** Stored in the consensus_store with their own key
  (`FINALITY_CHECKPOINT_KEY`), not in the JMT itself.

The line is drawn deliberately: the JMT holds canonical chain state that
everyone agrees on. Operational state (consensus liveness, mempool ingress,
receipt cache) lives outside the consensus root because it does not need to
be globally agreed.

---

## 4.10 Summary

| Component             | Choice                                                        |
| --------------------- | ------------------------------------------------------------- |
| Tree structure        | Jellyfish Merkle Tree (radix-16, path-compressed)             |
| Internal-node hash    | Blake3 (high-volume, native)                                  |
| State root            | Dual: Blake3 (native) + Poseidon2 (ZK-bearing)                |
| Address-derivation    | Poseidon2 (ZK exposure preserved)                             |
| Storage layout        | Flat — single tree, discriminator bytes in keys               |
| Address format        | 32 bytes, Poseidon2 of the FALCON-512 public key              |
| Account record size   | 141 bytes fixed + variable `auth_keys`                        |
| Storage keying        | `Poseidon2(addr, slot)` for values; doubled for maps          |
| Witness format        | Single batched JMT proof + entries + pre/post roots           |
| Witness size cap      | 1 MB (rejected at verification time)                          |
| Persistence           | RocksDB with LRU node and value caches                        |
| Block-app commit cost | ~40× faster commits than the prior fixed-depth SMT design     |

The next chapter covers the developer toolchain (`otigen`) that sits on top
of this state model — how a contract's `[state]` declaration in `otigen.toml`
becomes the slot identifiers the JMT actually sees, via language-specific
state binding generators that pre-compute slot prefix constants at build time.
