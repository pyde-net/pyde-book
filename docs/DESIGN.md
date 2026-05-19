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
8. [Encryption & MEV Resistance](#encryption--mev-resistance)
9. [Network Protocol](#network-protocol-summary)
10. [Performance Targets](#performance-targets)
11. [Implementation Status](#implementation-status)

## Layered Architecture

Pyde is a monolithic blockchain (consensus + execution + state in single binary) with these layers:

```
┌─────────────────────────────────────────────┐
│ Application                                 │
│ Otigen contracts, dApps, wallets, RPC       │
├─────────────────────────────────────────────┤
│ Execution                                   │
│ PVM (register-based VM), Block-STM,         │
│ hybrid access-list scheduler                │
├─────────────────────────────────────────────┤
│ State                                       │
│ Jellyfish Merkle Tree (JMT)                 │
│ Hybrid: Blake3 native + Poseidon2 for ZK    │
├─────────────────────────────────────────────┤
│ Consensus                                   │
│ Mysticeti DAG, anchor selection, finality   │
├─────────────────────────────────────────────┤
│ Cryptography                                │
│ FALCON-512, Kyber-768 threshold, DKG        │
├─────────────────────────────────────────────┤
│ Network                                     │
│ libp2p + QUIC, Gossipsub, worker/primary    │
└─────────────────────────────────────────────┘
```

## Consensus: Mysticeti DAG

### Algorithm Choice

Pyde uses Mysticeti-style DAG consensus (Mysten Labs' production protocol on Sui). Chosen over Bullshark for faster commit latency (~390ms vs ~1s) and better liveness under validator failures.

**Why DAG over HotStuff:**
- No single-proposer bottleneck — every committee member contributes vertices continuously
- No view changes — eliminates the bug class that caused Pyde's pre-pivot wedges
- Censorship resistance — 127 honest members can include any transaction; censorship requires near-unanimous collusion
- Throughput scales with committee size, not constrained by one proposer's bandwidth
- Threshold-decryption integrates naturally at the order-commit boundary

### Worker / Primary Split (Narwhal Pattern)

Each validator runs:
- **Workers (N per validator):** handle tx ingress, build batches, gossip batches peer-to-peer
- **Primary (one per validator):** handles consensus — produces vertices, gathers parents, signs state roots

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
    decryption_shares: Vec<DecryptionShare>, // piggybacked partials
    falcon_sig: FalconSig,                   // sig over the vertex
}
```

Each vertex is dual-role: **header** (declaring what data I have) AND **attestation** (acknowledging prior-round vertices via parent_vertex_refs). Parent references are implicit "votes" — no separate vote messages.

### Rounds & Anchors

A round is a layer in the DAG, advancing when a member collects ≥85 parent vertices.

Each round has a deterministically-selected anchor:
```
anchor_member_id = Hash(beacon, round, recent_state_root) mod 128
```

The `recent_state_root` lookback (N=3 rounds) limits anchor predictability to ~450ms (down from a full epoch).

A commit fires when the anchor vertex has sufficient support (Mysticeti 3-stage support). Multiple commits can be in flight; ~95% of rounds commit successfully.

### Wave Commit

```
1. Anchor selected by deterministic rule
2. Anchor's subdag walked via parent_vertex_refs (transitive)
3. Subdag sorted: (round, member_id, list_order)
4. Batches dereferenced from each vertex
5. Threshold decryption ceremony runs (pipelined — partials pre-broadcast)
6. ≥85 partials combine per batch → plaintexts revealed
7. PVM executes in canonical order
8. State root computed (Blake3 + Poseidon2 dual)
9. ≥85 committee FALCON-sign state root (piggybacked on next vertices)
10. Finality declared
```

End-to-end latency: ~500ms median for plaintext, ~700ms for encrypted (decryption ceremony adds ~200ms within wave budget).

### Committee

- **Size:** 128 validators per epoch
- **Selection:** uniform random from validators with stake ≥ 10M PYDE (committee tier; non-committee 100K standby pool stakes but isn't sampled until next selection)
- **Anti-Sybil:** operator identity binding, max 5 validators per operator
- **Equal power:** all 128 have equal voting weight, vertex production rate, anchor probability
- **Stake influence:** only on eligibility + flat 30% pool yield share. Activity rewards within committee are contribution-weighted, not stake-weighted.
- **Epoch length:** ~3 hours (measured in wall-clock, not in round count, so it's stable across consensus-cadence changes)
- **DKG ceremony:** runs in background during prior epoch's last minutes

### Safety & Liveness

- **Safety:** Mysticeti BFT — holds under any network with at most `f = 42` Byzantine members (BFT tolerance `⌊(n-1)/3⌋` for n = 128)
- **Liveness:** holds under partial synchrony
- **Recovery:** explicit halt detection + investigation + recovery (see [CHAIN_HALT.md](./CHAIN_HALT.md))
- **Rollback:** bounded to 1 epoch (3 hours) via governance multisig; beyond that, only hard fork

## Cryptography

### Signatures: FALCON-512

NIST FIPS 206 standard. Used for:
- User transaction authorization
- Validator vertex production
- Committee state-root attestations
- Decryption share authentication

Properties:
- Public key: 897 bytes
- Signature: 666 bytes
- Verification: ~80μs commodity CPU
- Post-quantum secure (lattice-based)

### Threshold Encryption: Kyber-768

NIST FIPS 203 standard, with threshold variant.

- Public key: 1184 bytes (one per epoch, shared across all encrypters)
- Ciphertext overhead: ~1088 bytes + plaintext size
- Decryption: requires ≥85 of 128 partial decryptions combined via Lagrange interpolation

**Critical invariant: commit-before-reveal.** Consensus orders encrypted transactions before any decryption shares are released. Decryption happens after ordering is final.

**v1 risk:** production-grade threshold variants of lattice schemes (Kyber threshold) are research-stage. Pyde v1 may ship with classical-crypto threshold (ElGamal-style) as transitional measure, migrating to threshold Kyber when audited implementations mature. This is the single largest cryptographic engineering risk in the design.

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
1. All 128 members sign a known message `"epoch_N_beacon"` with threshold-share keys
2. ≥85 shares combine into deterministic aggregated signature
3. `beacon_N = Hash(aggregated_signature)` → 32 bytes randomness
4. Published in last wave of epoch N

Properties: deterministic given shares, unpredictable until reveal, bias-resistant.

### DKG (Distributed Key Generation)

Pedersen DKG, multi-round protocol (~30-60s runtime):

```
Round 1: Each member generates random secret polynomial f_i(x), degree 84
Round 2: Each member broadcasts public commitments to coefficients
Round 3: Member i sends f_i(j) to each other member j (encrypted)
Round 4: Member j verifies received values, sums s_j = Σ f_i(j) = f(j)
         where f(x) = Σ f_i(x) is the combined polynomial
Result:  Each member j holds s_j = f(j) (private share)
         SK = f(0) is never computed; PK derivable from public commitments
         Threshold = 85
```

Mathematical foundation: any 85 points on a degree-84 polynomial uniquely determine it (Lagrange interpolation), enabling 85+ members to perform partial decryptions that combine without anyone reconstructing SK.

### Partial Decryption Math

Given ciphertext `(c1, c2)` where `c1 = g^r`, `c2 = m · PK^r`:

```
Each member i: partial_i = c1^(s_i)

Combine via Lagrange (any subset S of 85):
  combined = Π_{i in S} partial_i^(λ_i)
          = c1^(SK)
          = PK^r

Decrypt: m = c2 / combined
```

SK is never assembled. Each member's `s_i` is reusable across many ciphertexts within the epoch.

## Execution Layer

### Pyde Virtual Machine (PVM)

Register-based, custom ISA:
- 16 × 64-bit general-purpose registers (r0 hardwired to zero)
- 8 × 256-bit wide registers for cryptographic operations
- 62 opcodes (arithmetic, memory, control flow, storage, crypto, assertions)
- Checked arithmetic (trap on overflow)
- 4 MB address space (null page, code, heap, stack)
- Memcpy instruction for bulk memory operations
- AOT JIT compilation via Cranelift

**Determinism is load-bearing.** Same input transactions must produce byte-identical state transitions across all validators (consensus safety) and feasible ZK circuits (future validity proofs).

### Otigen Language

Pyde's smart contract language (`.oti` files), compiled by `otic`:

Features:
- 30 keywords; storage maps, structs, enums, variable-length Vec
- Function dispatch with 4-byte selectors (EVM-compatible)
- Reentrancy guards (`#[reentrant]` attribute)
- Checked arithmetic by default
- Custom error types and events
- View / payable / reentrant attributes
- Compile-time **static access list inference**

Compilation output: `.json` artifact (bytecode + ABI).

### Hybrid Parallel Scheduler

Combines two parallel-execution paradigms:

**Static access lists (Solana-style):** for functions where access can be inferred at compile time, the scheduler partitions transactions into parallel groups by their declared access sets. Deterministic, no speculation overhead.

**Block-STM (Aptos-style):** for functions with dynamic access patterns, transactions execute optimistically with read/write set tracking; conflicts trigger re-execution in canonical order.

**The hybrid:** Otigen compiler emits both `declared_access_set` (static) and `dynamic_access_regions` (runtime). Runtime scheduler uses static info for partition planning, falls back to Block-STM for dynamic regions.

Pyde-specific opportunity: controls compiler, runtime, language, and protocol — enabling this hybrid where most chains commit to one approach.

### Preflight Execution

Users request access list + gas estimate via RPC before signing:

```
Client → pyde_estimateAccess(tx)
       → RPC runs PVM preflight (dry-run against current state)
       → Returns: { gas_estimate, access_list }
Client attaches access_list to tx, signs
```

State staleness handled by treating access list as a *hint* — scheduler verifies at runtime, falls back to Block-STM on mismatch.

## State Layer

### Jellyfish Merkle Tree (JMT)

Radix-16, path-compressed Merkle tree (Diem/Aptos lineage):
- ~5–10 nodes per state operation (vs SMT's ~256)
- Substantial I/O savings at high TPS
- Standard authentication properties (commitment, inclusion/exclusion proofs)

### State Root Commitment

Dual-rooted:
- **Blake3 root:** fast native verification (used by validators)
- **Poseidon2 root:** ZK-circuit-friendly (future light clients, validity proofs)

Both computed at each wave commit, both signed by committee.

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
    gas_tank: u128,            // pre-deposited for encrypted tx submission
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
- Account has signing keys AND attached PVM bytecode policy
- Policy runs on every authorization, can implement: spend limits, time locks, allow-listed recipients, social recovery, tiered authorization, AI agent delegation
- Same fields as contracts (`code_hash` + `storage_root`)
- PVM "policy mode" — restricted state access during validation

### Session Keys (v2)

Scoped delegation for dApps:
- User approves specific contract + capped spend + time-bounded duration
- dApp can act on user's behalf within scope without per-action wallet popup
- Critical for gaming, AI agents, consumer apps

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

Wave commit (per round, ~390ms median):
  15. Anchor selected; subdag walked; canonical order emitted
  16. PVM executes in canonical order:
       - Nonce window check (state may have changed)
       - Balance check
       - Access list verification (vs runtime)
       - Hybrid scheduler partitions txs into parallel groups
       - Execute, apply state diffs
  17. JMT updated, state root computed (Blake3 + Poseidon2)
  18. Committee FALCON-signs state root, ≥85 collected
  19. Finality declared
```

### Encrypted Transaction

Same as above, with:
- Step 4.5: After FALCON-sign, Kyber-encrypt signed_tx with epoch PK
- Step 5: pyde_sendRawEncryptedTransaction(encrypted_blob)
- Worker step 8: cannot verify sig (encrypted) — only verify wire format
- Wave commit step 15.5: threshold decryption ceremony — ≥85 partials combine per batch → plaintexts revealed
- Then PVM step 16 includes first sig verification

## Encryption & MEV Resistance

Three structural defenses, layered:

### Layer 1: Threshold Encryption

Users encrypt time-sensitive transactions (DEX swaps, NFT mints, liquidations) before submission. Encrypted blob is opaque — even committee members cannot decrypt alone.

### Layer 2: Commit-Before-Reveal

Consensus orders encrypted transactions before decryption shares are released. By the time content is revealed, ordering is fixed and irreversible.

### Layer 3: No Proposer

Pyde's DAG consensus has no single party empowered to choose which transactions enter a wave commit or in what order. The canonical order emerges deterministically from the DAG; no member can selectively reorder, exclude, or front-run.

**Combined effect:** sandwich attacks, front-running, proposer extraction are structurally impossible — not policed, not auctioned, not made more efficient, but eliminated.

### Encryption is Optional

Per-tx choice via envelope:
- `pyde_sendRawTransaction` — unencrypted, fast path, no MEV protection
- `pyde_sendRawEncryptedTransaction` — encrypted, MEV-resistant, costs more gas

Wallets default to "auto" — encrypt time-sensitive, skip for simple transfers.

Encryption bandwidth cost: ~70% reduction if 80% of txs are unencrypted simple transfers (typical mix).

## Network Protocol Summary

See [NETWORK_PROTOCOL.md](./NETWORK_PROTOCOL.md) for full details.

Key choices:
- **Transport:** QUIC over UDP (no HOL blocking, built-in TLS 1.3)
- **Library:** libp2p (Rust) — mature, audited
- **Peer discovery:** layered (hardcoded → DNS → on-chain registry → PEX → cache); no DHT
- **Gossip:** Gossipsub with per-topic meshes
- **DoS:** 4-layer (connection/message/peer-scoring/application)
- **Committee defense:** sentry node pattern (Cosmos-style)

## Performance Targets

### Honest Targets

Validated by multi-region production-realistic harness (see [PERFORMANCE_HARNESS.md](./PERFORMANCE_HARNESS.md)):

| Metric | Realistic v1 | Stretch v2 | Aspirational |
|---|---|---|---|
| Plaintext TPS (commodity) | 10K-30K | 50K-100K | 500K |
| Encrypted TPS (commodity CPU) | 500-2K | 5K-10K | 50K+ (GPU) |
| Median finality | ~500ms | ~400ms | ~300ms |
| Committee NIC requirement (at TPS) | 500 Mbps | 1 Gbps | 10 Gbps |

### "Claim 1/3 of Bench" Rule

- Harness measures: X TPS sustained
- Public claim: X/3 TPS
- Aspirational: X with "production validation pending"

No external TPS claim without harness evidence.

### Hardware Tiers

| Role | Hardware |
|---|---|
| Light client | Mobile / browser |
| Full node / RPC | 8c / 16GB / 500GB / 100 Mbps |
| Non-committee validator | 8c / 16GB / 500GB / 100-250 Mbps |
| Committee at 30K TPS | 8-16c / 32GB / 1TB SSD / 500 Mbps |
| Committee at 100K TPS | 16c / 32GB / 2TB SSD / 1 Gbps |
| Committee at 500K TPS | 32c / 64GB / 4TB SSD / 10 Gbps |

Modest hardware applies to non-committee at all levels. Committee scales with throughput target.

## Implementation Status

This documentation reflects **designed architecture**, not shipped implementation:

| Component | Status |
|---|---|
| Architecture design | ✅ Complete |
| PVM + Otigen | 🟡 Functional, needs extensions (programmable accounts hooks, hybrid scheduler integration) |
| State layer (JMT) | 🟡 In place, needs hybrid hashing |
| Consensus (Mysticeti DAG) | 🔴 Not yet — rebuild post-pivot |
| Threshold cryptography | 🔴 Research-grade (PQ threshold is bleeding-edge) |
| Network protocol (libp2p) | 🟡 Existing in legacy, needs migration |
| Performance harness | 🔴 Not yet built |
| Slashing + lifecycle | 🟡 Partial in legacy |
| State sync | 🟡 Partial design |
| Documentation | 🟡 This is the current state |

**Mainnet ships when the work above is complete and the external audit passes.** No public schedule.

**Highest-risk piece:** post-quantum threshold cryptography. Research-stage, may require classical-crypto transitional v1 with migration to PQ threshold in v2 as standards mature.

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
