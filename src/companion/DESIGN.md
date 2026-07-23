# Pyde Technical Design

**Version 0.1**

This is the comprehensive technical design document for Pyde. For high-level pitch, see [WHITEPAPER.md](./WHITEPAPER.md). For operational specs, see the individual documents linked below.

## Table of Contents

1. [Layered Architecture](#layered-architecture)
2. [Consensus: Mysticeti DAG](#consensus-mysticeti-dag)
3. [Cryptography](#cryptography)
4. [Execution Layer](#execution-layer)
5. [State Layer](#state-layer)
6. [Account Model](#account-model)
7. [Transaction Lifecycle](#transaction-lifecycle)
8. [Private Mempool & MEV Resistance](#private-mempool--mev-resistance)
9. [Network Protocol](#network-protocol-summary)
10. [Performance Targets](#performance-targets)
11. [Implementation Status](#implementation-status)

## Layered Architecture

Pyde is a monolithic blockchain (consensus + execution + state in single binary) with these layers:

```
┌─────────────────────────────────────────────┐
│ Application                                 │
│ WASM smart contracts, dApps, wallets, RPC       │
├─────────────────────────────────────────────┤
│ Execution                                   │
│ WebAssembly (wasmtime + Cranelift AOT),     │
│ Block-STM scheduler, MVCC, access-list      │
│ prefetch (PIP-3)                            │
├─────────────────────────────────────────────┤
│ State                                       │
│ Jellyfish Merkle Tree (JMT)                 │
│ Hybrid: Blake3 native + Poseidon2 for ZK    │
├─────────────────────────────────────────────┤
│ Consensus                                   │
│ Mysticeti DAG, anchor selection, finality   │
├─────────────────────────────────────────────┤
│ Cryptography                                │
│ FALCON-512, Blake3 commit-reveal, Kyber txp │
├─────────────────────────────────────────────┤
│ Network                                     │
│ libp2p + QUIC, Gossipsub, worker/primary    │
└─────────────────────────────────────────────┘
```

## Consensus: Mysticeti DAG

### Algorithm Choice

Pyde uses Mysticeti-style DAG consensus (Mysten Labs' production protocol on Sui). Chosen over Bullshark for faster commit latency (~390ms vs ~1s) and better liveness under validator failures.

**Why DAG over HotStuff:**
- No single-proposer bottleneck: every committee member contributes vertices continuously
- No view changes: eliminates the bug class that caused Pyde's pre-pivot wedges
- Censorship resistance: 127 honest members can include any transaction; censorship requires near-unanimous collusion
- Throughput scales with committee size, not constrained by one proposer's bandwidth
- The commit-reveal private mempool resolves naturally at the order-commit boundary

### Worker / Primary Split (Narwhal Pattern)

Each validator runs:
- **Workers (N per validator):** handle tx ingress, build batches, gossip batches peer-to-peer
- **Primary (one per validator):** handles consensus (produces vertices, gathers parents, signs state roots)

Transactions travel the network exactly once (via worker gossip). Consensus vertices stay tiny (carry only batch hashes by reference).

### Vertex Structure

```rust
struct Vertex {
    round: u64,
    member_id: u32,                          // validator address as u32 internally
    batch_refs: Vec<BatchHash>,              // hashes of batches I have
    parent_vertex_refs: Vec<VertexHash>,     // ≥85 round-(N-1) vertex hashes
    state_root_sigs: Vec<StateRootSig>,      // attestations on recent commits
    prev_anchor_attestation: VertexHash,     // attests prior round's anchor
    beacon_share: BeaconShare,               // per-member beacon contribution
    falcon_sig: FalconSig,                   // sig over the vertex
}
```

Each vertex is dual-role: **header** (declaring what data I have) AND **attestation** (acknowledging prior-round vertices via parent_vertex_refs). Parent references are implicit "votes"; there are no separate vote messages.

### Rounds & Anchors

A round is a layer in the DAG, advancing when a member collects ≥85 parent vertices.

Each round has a deterministically-selected anchor:
```
anchor_member_id = Hash(beacon, round, prev_state_root) mod 128
```

The `prev_state_root` lookback (N=3 rounds) limits anchor predictability to ~450ms (down from a full epoch).

A commit fires when the anchor vertex has sufficient support (Mysticeti 3-stage support). Multiple commits can be in flight; ~95% of rounds commit successfully.

### Commit

```
1. Anchor selected by deterministic rule
2. Anchor's subdag walked via parent_vertex_refs (transitive)
3. Subdag sorted: (round, member_id, list_order)
4. Batches dereferenced from each vertex
5. Reveal-resolution pass: each Reveal's `Blake3(...)` is recomputed and matched to its committed commitment; the bond is refunded and the inner tx slotted in commit order (unrevealed commits past the 120-wave window expire, bond burned)
6. wasmtime executes in canonical order (revealed inner txs in commit order)
7. State root computed (Blake3 + Poseidon2 dual)
8. ≥85 committee FALCON-sign state root (piggybacked on next vertices)
9. Finality declared
```

End-to-end latency: ~500ms median for a plaintext transaction. A private-mempool transaction spans two waves (Commit locks order, Reveal executes), so its latency depends on reveal timing, bounded by the 120-wave window.

### Committee

- **Size:** 128 validators per epoch
- **Selection:** uniform random from all validators with stake ≥ `MIN_VALIDATOR_STAKE` (10,000 PYDE). Single tier: every staked validator meeting the floor is in the same pool
- **Anti-Sybil:** operator identity binding, max 3 validators per operator
- **Equal power:** all 128 have equal voting weight, vertex production rate, anchor probability
- **Stake influence:** only on eligibility + flat 30% pool yield share. Activity rewards within committee are contribution-weighted, not stake-weighted.
- **Epoch length:** ~3 hours (measured in wall-clock, not in round count, so it's stable across consensus-cadence changes)
- **Handover:** the prior committee publishes the next epoch's beacon; the new committee swaps in. No key ceremony: the private mempool is keyless (commit-reveal), so there is no threshold decryption key, no DKG

### Safety & Liveness

- **Safety:** Mysticeti BFT, which holds under any network with at most `f = 42` Byzantine members (BFT tolerance `⌊(n-1)/3⌋` for n = 128)
- **Liveness:** holds under partial synchrony
- **Recovery:** explicit halt detection + investigation + recovery (see [CHAIN_HALT.md](./CHAIN_HALT.md))
- **Rollback:** bounded to 1 epoch (3 hours) via governance multisig; beyond that, only hard fork

## Cryptography

### Signatures: FALCON-512

NIST FIPS 206 standard. Used for:
- User transaction authorization
- Validator vertex production
- Committee state-root attestations
- Beacon share authentication

Properties:
- Public key: 897 bytes
- Signature: 666 bytes
- Verification: ~80μs commodity CPU
- Post-quantum secure (lattice-based)

### Private Mempool: Keyless Commit-Reveal

Pyde's MEV protection is a keyless commit-reveal scheme built only on Blake3 (commitment) and FALCON (authorization). No committee holds a decryption key; there is no threshold ceremony, no Kyber/ML-KEM mempool encryption, no Shamir shares, and no DKG.

- **Commit** (`TxType 0x11`): `to` = zero address, `value` = bond, `data` = `borsh(CommitPayload { commitment, value_ceiling })`, where `commitment = Blake3("pyde-commit-reveal-v1" || borsh(inner_tx) || nonce)`.
- **Reveal** (`TxType 0x12`): `to` = zero address, `value` = 0, `data` = `borsh(RevealPayload { commitment, nonce, inner_tx })`. Any account may submit it.
- **Bond:** `max(MIN_COMMIT_BOND = 1e9 quanta = 1 PYDE, value_ceiling × 1%)`, escrowed on commit, refunded on accepted reveal, burned on abandonment/expiry.
- **Window:** `COMMIT_REVEAL_WINDOW_WAVES = 120` waves from the commit's inclusion wave.

**Critical invariant: commit-before-reveal.** The DAG fixes commit order at commit time; in the reveal wave's resolution pass, revealed inner transactions execute **in commit order**, not reveal order. Because no key exists, safety never depends on any honest-committee assumption.

**Why not threshold encryption:** an earlier draft used a Kyber-768 committee key with Shamir-split decryption shares. It was removed: trustless post-quantum threshold key generation is research-blocked (lattice public keys do not combine homomorphically the way BLS does; there is no trustless DKG for ML-KEM). A one-shot ciphertext lane remains v2+ research; see [Chapter 20](../chapters/20-future-direction.md).

### Hash Functions: Hybrid Layered Strategy

| Use case | Hash | Why |
|---|---|---|
| JMT internal nodes | Blake3 | ~30× faster than Poseidon2 on CPU |
| State root (published) | Both | Blake3 native verification + Poseidon2 for ZK |
| Transaction hashes | Blake3 (ciphertext), Poseidon2 (plaintext canonical) | Per use |
| Address derivation | Poseidon2 | Used in sig-verify ZK circuits |
| FALCON sig hashing | Poseidon2 | Inside ZK aggregation circuit |
| Vertex hashes | Blake3 | Small volume, no ZK |

### Random Beacon

Each epoch's beacon is produced by the previous epoch's committee:
1. Each member signs a known message `"epoch_N_beacon"` with its per-member `BeaconKeypair` (FALCON)
2. ≥85 per-member signatures combine into a deterministic aggregated signature
3. `beacon_N = Hash(aggregated_signature)` → 32 bytes randomness
4. Published in last wave of epoch N

Properties: deterministic given the member signatures, unpredictable until the last signer contributes, bias-resistant. The beacon is an aggregated FALCON signature over a fixed message, **not** a VRF and **not** a threshold-key output; each member holds an independent `BeaconKeypair` with no DKG.

> **No threshold-key ceremony.** Earlier drafts ran a Pedersen DKG here to produce a per-epoch threshold *decryption* key for an encrypted mempool, with Lagrange-combined partial decryptions. That mechanism was removed with the encrypted lane; the keyless commit-reveal private mempool needs no such key. A one-shot ciphertext lane (Threshold-LWE) remains v2+ research; see [Chapter 20](../chapters/20-future-direction.md).

## Execution Layer

### WASM Execution Layer (wasmtime)

WebAssembly via wasmtime, with Cranelift ahead-of-time compilation:
- WebAssembly Core Specification as the instruction set (industry-standard, externally maintained)
- Deterministic feature subset enforced (NaN canonicalization on; threads, non-deterministic SIMD, reference types, GC, multi-memory, memory64, WASI all disabled)
- Fuel-based gas metering (wasmtime's built-in mechanism)
- Per-contract module compilation cache (Cranelift AOT artifacts persisted)
- Deploy-time validator rejects modules with forbidden imports or non-deterministic features
- Host-function ABI is the only chain-side surface contracts can reach

**Determinism is load-bearing.** Same input transactions must produce byte-identical state transitions across all validators (consensus safety) and feasible ZK circuits (future validity proofs). wasmtime's determinism config + deploy-time validator together provide this guarantee.

### Smart Contract Authoring

Contracts are authored in any wasm32-target language (Rust, AssemblyScript, Go via TinyGo, C/C++). The `otigen` developer toolchain handles the lifecycle: project scaffolding (`otigen init`), build with state binding generation (`otigen build`), deploy (`otigen deploy`), upgrade governance, wallet management.

Pyde safety attributes (preserved from Otigen-language era):
- Reentrancy off by default (opt-out via `reentrant` attribute)
- Checked arithmetic (wrapping ops require explicit opt-in)
- Typed storage via `[state]` schema in `otigen.toml`
- No `tx.origin` (host function ABI exposes only `caller`)
- View / payable / reentrant / sponsored / constructor attributes
- Compile-time **static access list inference** (from declared state schema)
- 4-byte function selectors

Build output: `.wasm` artifact + JSON ABI + deploy bundle.

### Block-STM Parallel Scheduler

Pyde uses **uniform Block-STM** (Aptos-style) as the v1 execution model. Every tx in a committed wave runs optimistically in parallel through an MVCC layer, with conflicts caught at validation and losers re-executing until fixpoint. Full algorithm + determinism contract: [`BLOCK_STM_EXECUTION.md`](BLOCK_STM_EXECUTION.md).

**Access lists from `pyde_simulateTransaction` are prefetch hints only**: the scheduler unions every declared `(addr, slot)` pair across the wave and issues one batched `state_cf.multi_get` (PIP-3) into the dashmap (PIP-4) before Block-STM workers start. Lists are never used to partition the wave or affect correctness; if a list is wrong, the missed slots just miss the warm-cache fast path, Block-STM still produces the correct deterministic result.

Why uniform Block-STM over a static-list / Block-STM hybrid for v1: single execution path means single test surface, single determinism contract, single bug class. Aptos's measured production numbers (10-30K real-world TPS) match Pyde's v1 target. The access-list-driven scheduling fast path stays available as a v2 throughput lever; see "Path Beyond v1" in BLOCK_STM_EXECUTION.md.

Pyde-specific opportunity: controls compiler, runtime, language, and protocol. The wallet's `pyde_simulateTransaction` round-trip means the chain is the only one where every tx already arrives with an accurate access list, making prefetch coverage near-100% in steady state.

### Preflight Execution

Users request access list + gas estimate via RPC before signing:

```
Client → pyde_estimateAccess(tx)
       → RPC runs a wasmtime preflight (dry-run against current state)
       → Returns: { gas_estimate, access_list }
Client attaches access_list to tx, signs
```

State staleness handled by treating access list as a *hint*: scheduler verifies at runtime, falls back to Block-STM on mismatch.

## State Layer

### Jellyfish Merkle Tree (JMT)

Radix-16, path-compressed Merkle tree (Diem/Aptos lineage):
- ~5 to 10 nodes per state operation (vs SMT's ~256)
- Substantial I/O savings at high TPS
- Standard authentication properties (commitment, inclusion/exclusion proofs)

### State Root Commitment

Dual-rooted:
- **Blake3 root:** fast native verification (used by validators)
- **Poseidon2 root:** ZK-circuit-friendly (future light clients, validity proofs)

Both computed at each commit, both signed by committee.

### State Pruning

| Node type | State retention |
|---|---|
| Archive node | All historical state |
| Full node (default) | Last 90 days |
| Committee validator | Last 30 days |
| Light client | Headers + cared-about accounts |

See [STATE_SYNC.md](./STATE_SYNC.md) for sync protocol details.

## Account Model

### Account State

```rust
struct Account {
    nonce: u64,
    balance: u128,
    gas_tank: u128,            // pre-deposited for sponsored tx submission
    auth_keys: AuthKeys,       // Single | Multisig | Programmable
    code_hash: Hash,           // for contract accounts
    storage_root: Hash,        // for contract storage (JMT subtree)
    key_nonce: u32,            // FALCON key rotation counter
}

enum AuthKeys {
    Single(FalconPubkey),
    Multisig(M, Vec<FalconPubkey>),  // M-of-N, max 16
    Programmable,                     // reserved for v2
}
```

### Nonce Window

Pyde uses a 16-slot sliding nonce window instead of strict sequential nonces:

```rust
struct NonceState {
    base: u64,        // lowest unused nonce
    used: u16,        // 16-bit bitmap of consumed slots in [base, base+15]
}
```

Allows up to **16 concurrent in-flight transactions per account, out-of-order within the window.** Standard EVM-style nonces force head-of-line blocking; Pyde's window decouples submission ordering from execution ordering.

### Native Multisig (v1)

`AuthKeys::Multisig(M, [pubkey_1, ..., pubkey_N])` requires M valid FALCON signatures over the tx hash. Max 16 signers. Used for treasuries, DAOs, exchange custody.

Significantly safer than contract-based multisig (Gnosis Safe model on Ethereum), which reimplements the same logic across projects with subtle bugs.

### Programmable Accounts (v2)

Reserved enum variant at v1. When v2 ships:
- Account has signing keys AND attached WASM policy module
- Policy runs on every authorization, can implement: spend limits, time locks, allow-listed recipients, social recovery, tiered authorization, AI agent delegation
- Same fields as contracts (`code_hash` + `storage_root`)
- WASM "policy mode": restricted state access during validation

### Session Keys (v2)

Scoped, bounded, revocable delegation. The user authorizes a session key once; the dApp (or agent) signs many transactions on the user's behalf within the declared scope.

**Type:**

```rust
struct SessionKey {
    pubkey:      FalconPubkey,
    scope:       SessionScope,
    expires_at:  WaveId,
    revoked:     bool,
}

struct SessionScope {
    contracts:    Vec<Address>,
    methods:      Vec<Selector>,   // optional; empty = all methods on allowed contracts
    max_spend:    u128,
    spent_so_far: u128,            // mutable, updated at tx commit
}
```

**Registry.** Session keys are stored under the account's programmable-policy state subtree. The slot_hash clusters with the account under PIP-2 so lookups during authorization are local. New keys are added by `RegisterSessionKey` txs signed under the main `auth_keys`; existing keys are revoked by `RevokeSessionKey` txs.

**Authorization-time check (pseudocode):**

```text
fn authorize_session_tx(tx) -> Result<(), AuthError> {
    let sk = lookup_session_key(tx.session_key_id)?;

    // 1. Signature
    verify_falcon(sk.pubkey, tx.hash, tx.session_sig)?;

    // 2. Liveness
    require(current_wave < sk.expires_at, KeyExpired);
    require(!sk.revoked, KeyRevoked);

    // 3. Scope
    require(sk.scope.contracts.contains(&tx.to), OutsideContractScope);
    if !sk.scope.methods.is_empty() {
        require(sk.scope.methods.contains(&tx.selector), OutsideMethodScope);
    }

    // 4. Spend cap
    let new_spent = sk.scope.spent_so_far + tx.value;
    require(new_spent <= sk.scope.max_spend, ExceedsSpendCap);

    // On commit:
    //   sk.scope.spent_so_far = new_spent;
    Ok(())
}
```

**Use cases:**

- **Gaming**: sign once, play many actions.
- **AI agents**: bounded delegation (e.g., *"trade at most 100 PYDE/day on this DEX until next Friday"*).
- **Consumer apps**: subscriptions, micro-transactions.
- **Embedded wallets**: passkey-style flows where the main key never leaves a secure enclave.

**Limits.**

- Maximum 32 active session keys per account (anti-squat).
- `max_spend` is monotonic: increasing it requires a new key, not a mutation.
- `expires_at` cannot exceed `current_wave + MAX_SESSION_WAVES` (default: ~30 days at 500ms/wave = ~5.18M waves).

**v1 reservations:** `AuthKeys::Programmable` enum tag `0x03`, account `code_hash` + `storage_root` fields, WASM policy-mode execution flag, multisig signature pipeline. All present at genesis; only the policy engine and session-key registry need to be added at v2.

Threat-model entries for session keys live in [companion/THREAT_MODEL.md](./THREAT_MODEL.md) §Authorization Layer (added v0.2).

## Transaction Lifecycle

### Plaintext Transaction

```
User wallet:
  1. Construct unsigned tx (sender, recipient, amount, nonce, gas, payload, deadline)
  2. RPC pyde_estimateAccess(tx) → returns gas_estimate + access_list
  3. Attach access_list to tx
  4. FALCON-sign tx hash
  5. Submit: pyde_sendRawTransaction(signed_tx)

RPC node:
  6. Verify wire format, size, chain_id
  7. Forward to nearest validator worker

Worker:
  8. Verify FALCON sig at ingress
  9. Verify nonce within window, balance, gas
  10. Batch with other txs
  11. Gossip batch to peer workers

Primary (every ~150ms):
  12. Produce vertex referencing batches + parents
  13. Gossip vertex
  14. Peer primaries cert via next-round parent refs

Commit (per round, ~390ms median):
  15. Anchor selected; subdag walked; canonical order emitted
  16. wasmtime executes in canonical order:
       - Nonce window check (state may have changed)
       - Balance check
       - Access list verification (vs runtime)
       - Hybrid scheduler partitions txs into parallel groups
       - Execute, apply state diffs
  17. JMT updated, state root computed (Blake3 + Poseidon2)
  18. Committee FALCON-signs state root, ≥85 collected
  19. Finality declared
```

### Private-Mempool Transaction (Commit-Reveal)

A two-transaction flow:
- **Commit:** the wallet sends a `TxType 0x11` carrying `Blake3("pyde-commit-reveal-v1" || borsh(inner_tx) || nonce)` and a bond. Workers validate the commitment and bond only; the inner transaction is not present.
- **DAG:** the commit is ordered like any transaction; its position is locked at commit time.
- **Reveal:** within 120 waves, any account submits a `TxType 0x12` carrying the nonce and `inner_tx`.
- **Commit step:** the reveal-resolution pass recomputes the commitment, matches it, refunds the bond, and slots the inner transaction for execution in commit order. wasmtime then verifies the inner FALCON signature and executes.

## Private Mempool & MEV Resistance

Three structural defenses, layered:

### Layer 1: Commit as a Hash

Users hide time-sensitive transactions (DEX swaps, NFT mints, liquidations) behind a Blake3 commitment. The content is an opaque hash; there is no key anyone, committee included, could use to read it.

### Layer 2: Commit-Before-Reveal

The DAG fixes commit order before the content is revealed. By the time content is visible, ordering is fixed and irreversible, and revealed transactions execute in that committed order.

### Layer 3: No Proposer

Pyde's DAG consensus has no single party empowered to choose which transactions enter a commit or in what order. The canonical order emerges deterministically from the DAG; no member can selectively reorder, exclude, or front-run.

**Combined effect:** sandwich attacks, front-running, proposer extraction are structurally impossible: not policed, not auctioned, not made more efficient. The ordering primitive itself doesn't admit them.

### The Private Mempool is Optional

Per-tx choice:
- `pyde_sendRawTransaction`: plaintext, fast path, no MEV protection
- Commit/Reveal pair (`TxType 0x11` / `0x12`): private mempool, MEV-resistant, costs the bond + two transactions

Wallets default to "auto": route time-sensitive transactions through commit-reveal, skip it for simple transfers.

Overhead is only paid on the private-mempool path: ~70% of traffic stays single-tx plaintext if 80% of txs are simple transfers (typical mix).

## Network Protocol Summary

See [NETWORK_PROTOCOL.md](./NETWORK_PROTOCOL.md) for full details.

Key choices:
- **Transport:** QUIC over UDP (no HOL blocking, built-in TLS 1.3)
- **Library:** libp2p (Rust), mature and audited
- **Peer discovery:** layered (hardcoded → DNS → on-chain registry → PEX → cache); no DHT
- **Gossip:** Gossipsub with per-topic meshes
- **DoS:** 4-layer (connection/message/peer-scoring/application)
- **Committee defense:** sentry node pattern (Cosmos-style)

## Performance Targets

### Honest Targets

Validated by multi-region production-realistic harness (see [PERFORMANCE_HARNESS.md](./PERFORMANCE_HARNESS.md)):

| Metric | v1 baseline | Stretch (post-mainnet) | Aspirational |
|---|---|---|---|
| Plaintext throughput (commodity) | awaiting harness | awaiting harness | awaiting harness |
| Encrypted throughput (commodity CPU) | awaiting harness | awaiting harness | awaiting harness (GPU) |
| Median finality | ~500ms | ~400ms | ~300ms |
| Committee NIC requirement | 500 Mbps | 1 Gbps | 10 Gbps |

### Publishing Discipline

- Publish only what the harness measures under sustained, production-realistic conditions.
- Never lab extrapolations, microbenchmark peaks, or single-machine numbers where multi-region is the relevant scope.
- Aspirational figures are labelled "production validation pending" and carry no concrete number.

No external TPS claim without harness evidence.

### Hardware Tiers

| Role | Hardware |
|---|---|
| Light client | Mobile / browser |
| Full node / RPC | 8c / 16GB / 500GB / 100 Mbps |
| Non-committee validator | 8c / 16GB / 500GB / 100-250 Mbps |
| Committee (v1 baseline) | 8-16c / 32GB / 1TB SSD / 500 Mbps |
| Committee (Stretch, post-mainnet) | 16c / 32GB / 2TB SSD / 1 Gbps |
| Committee (Aspirational, GPU-class) | 32c / 64GB / 4TB SSD / 10 Gbps |

Modest hardware applies to any validator awaiting committee selection at all levels. Active-committee hardware scales with the throughput target. The aspirational tier is tied to GPU-acceleration research advances per the honest performance targets above.

## Implementation Status

This documentation reflects **designed architecture**, not shipped implementation:

| Component | Status |
|---|---|
| Architecture design | ✅ Complete |
| WASM execution layer (wasmtime + Cranelift AOT) | 🟡 Foundation in place; integration in progress; programmable-accounts hooks + Block-STM scheduler + access-list prefetch integration pending |
| State layer (JMT) | 🟡 In place, needs hybrid hashing |
| Consensus (Mysticeti-style) | 🔴 Not yet; rebuild post-pivot |
| Private mempool (keyless commit-reveal) | 🟢 Commit/Reveal tx types + commit-order reveal resolution; only Blake3 + FALCON, no threshold crypto |
| Network protocol (libp2p) | 🟡 Existing in archive, needs migration |
| Performance harness | 🔴 Not yet built |
| Slashing + lifecycle | 🟡 Partial in archive |
| State sync | 🟡 Partial design |
| Documentation | 🟡 This is the current state |

**Mainnet ships when the work above is complete and the external audit passes.** No public schedule.

**Note:** the v1 MEV mechanism carries no threshold-cryptography risk: it is the keyless commit-reveal private mempool (Blake3 + FALCON only). A one-shot ciphertext lane (Threshold-LWE) is deferred to v2+ research, gated on a trustless PQ threshold-keygen breakthrough; see [Chapter 20](../chapters/20-future-direction.md).

## Cross-References

| Topic | Document |
|---|---|
| Threats & adversaries | [THREAT_MODEL.md](./THREAT_MODEL.md) |
| Operational failures | [FAILURE_SCENARIOS.md](./FAILURE_SCENARIOS.md) |
| Halt + recovery procedures | [CHAIN_HALT.md](./CHAIN_HALT.md) |
| Slashing rules | [SLASHING.md](./SLASHING.md) |
| Validator state machine | [VALIDATOR_LIFECYCLE.md](./VALIDATOR_LIFECYCLE.md) |
| State sync protocol | [STATE_SYNC.md](./STATE_SYNC.md) |
| Network protocol | [NETWORK_PROTOCOL.md](./NETWORK_PROTOCOL.md) |
| Performance harness | [PERFORMANCE_HARNESS.md](./PERFORMANCE_HARNESS.md) |
| Token economics | [TOKENOMICS.md](./TOKENOMICS.md) |

---

**Document version:** 0.1

**License:** See repository root
