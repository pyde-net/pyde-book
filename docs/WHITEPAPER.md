# Pyde: A Post-Quantum, MEV-Resistant Layer 1 with DAG Consensus

**Version 0.1**

## Abstract

Pyde is a Layer 1 blockchain built greenfield to deliver, as defaults from genesis, four properties that no chain in production combines today: **post-quantum cryptography** (FALCON-512 signatures, Kyber-768 threshold encryption), **MEV resistance** via threshold-encrypted mempool and commit-before-reveal ordering, **sub-second finality** through Mysticeti-style DAG consensus, and **commodity-hardware decentralization** for non-committee participants with equal-power voting within the active committee.

The execution layer is a register-based virtual machine (PVM) with a hybrid parallel scheduler combining declared access lists (Solana-style) with optimistic Block-STM speculation (Aptos-style). Smart contracts are written in **Otigen**, a purpose-built language with reentrancy guards, checked arithmetic, and compile-time access list inference. Cross-chain interactions, oracles, indexers, and off-chain compute are served by a permissionless **parachain layer** (post-mainnet), with each operation gated by a `HardFinalityCert` — a FALCON quorum certificate verifiable on any chain.

This whitepaper presents the current design following a May 2026 architectural pivot from an in-house HotStuff variant (whose persistent wedges and stalls at 400ms slot timing motivated a clean rebuild) to a DAG-based consensus inspired by Bullshark and Mysticeti. The pivot scoped the chain to its execution and cryptography layers first, with the consensus layer rebuilt from a clean foundation.

Realistic v1 mainnet performance targets, validated by a multi-region production-realistic performance harness, are **30,000 plaintext TPS sustained, 500–2,000 encrypted TPS** on commodity validator hardware. Aspirational long-term targets reach 500K TPS with GPU acceleration and protocol upgrades.

## 1. Introduction

### 1.1 The Problem

Three structural problems compound across production Layer 1 chains:

**Quantum vulnerability.** Every major L1 in production today — Bitcoin, Ethereum, Solana, Cardano, Polkadot — uses classical cryptography (secp256k1, Ed25519, BLS12-381) that falls to Shor's algorithm on a cryptographically-relevant quantum computer. NIST's 2024 standardization of FALCON, ML-DSA, and ML-KEM unblocked the cryptographic primitives, but retrofitting them into a live chain with trillions of dollars at risk is a multi-year coordinated migration.

**MEV extraction.** Maximum Extractable Value has hardened into a multi-billion-dollar tax paid by retail users to validator-builder coalitions on chains where the proposer can observe and reorder pending transactions. Sandwich attacks, front-running, and proposer extraction are not bugs to be patched but structural consequences of public mempools and single-proposer block production.

**Centralization at scale.** Chains optimizing for throughput have ended up requiring datacenter-class validator hardware. A Solana validator at production performance requires 12+ cores, 256+ GB of RAM, and 1 Gbps+ network — a small operator economy. Chains optimizing for decentralization have ended up with throughput unusable for serious applications.

The combination — post-quantum security, MEV resistance, high throughput, commodity decentralization — is what the next default Layer 1 will need to provide. No chain in production today provides all four.

### 1.2 Pyde's Approach

Pyde is built greenfield to ship every property as a default from genesis:

- **Every transaction signature is FALCON-512.** Post-quantum security applies to user-facing cryptography by default, not as a future migration.
- **Every transaction can be encrypted under a Kyber-768 threshold key.** A 128-validator committee holds shares; 85 must combine to decrypt. The encrypted mempool eliminates the information asymmetry that makes MEV extraction possible.
- **Consensus is DAG-based.** No single proposer. Every committee member contributes vertices continuously. Order is computed deterministically from the DAG by every honest validator independently. Front-running, sandwich attacks, and proposer extraction become structurally impossible — not policed, not auctioned, not made more efficient, but eliminated.
- **Validators run on commodity hardware** for non-committee participants. Committee members at production TPS targets require 1 Gbps networking; the "modest hardware" promise applies to full nodes, RPC providers, and light clients.
- **Cross-chain interactions** happen through a permissionless decentralized parachain layer of infrastructure providers — not custodial multisigs, not auctioned slots.

## 2. The May 2026 Pivot

Pyde's earlier architecture used an in-house HotStuff variant with 400ms slot timing. Repeated wedges and stalls — head-divergence deadlocks, view-change cascades, and quorum starvation under network jitter — were being addressed by accumulating patches rather than fundamental architectural changes. The team made a clean break: **remove the entire consensus layer, deliberate from scratch, build a solid foundation.**

Post-pivot:
- The active workspace (`engine/`) contains only crypto, PVM, AOT compiler, state, account, and transaction crates.
- Consensus, mempool, networking, and slashing have been moved to `legacy/` as archive.
- The next consensus layer is being designed against the lessons of HotStuff failure: smaller protocol surface, simpler safety arguments, no view changes, no single-proposer bottleneck.

The decision: **Mysticeti-style DAG consensus.**

## 3. Architecture Overview

Pyde is a monolithic Layer 1 chain — consensus, execution, and state in a single binary — with a layered protocol structure:

```
┌─────────────────────────────────────────────┐
│ Application Layer                           │
│ Otigen contracts, dApps, wallets, RPC       │
├─────────────────────────────────────────────┤
│ Execution Layer                             │
│ PVM (register-based VM), Block-STM,         │
│ hybrid access-list scheduler                │
├─────────────────────────────────────────────┤
│ State Layer                                 │
│ Jellyfish Merkle Tree (JMT), hybrid hashing │
│ Blake3 native + Poseidon2 for ZK exposure   │
├─────────────────────────────────────────────┤
│ Consensus Layer                             │
│ Mysticeti DAG, anchor selection, finality   │
│ (rebuild in progress)                       │
├─────────────────────────────────────────────┤
│ Cryptography Layer                          │
│ FALCON-512 sigs, Kyber-768 threshold,       │
│ DKG, threshold decryption                   │
├─────────────────────────────────────────────┤
│ Network Layer                               │
│ libp2p + QUIC, Gossipsub, worker/primary    │
│ split (Narwhal pattern)                     │
└─────────────────────────────────────────────┘
```

## 4. Cryptography

### 4.1 Signatures: FALCON-512

Every transaction is signed with FALCON-512, a NIST-standardized post-quantum signature scheme. FALCON sigs are ~666 bytes (vs Ed25519's 64), with ~80μs verification time on commodity CPU. Pyde uses FALCON for:
- User transaction authorization
- Validator vertex production
- Committee state-root attestations
- Decryption share authentication

### 4.2 Threshold Encryption: Kyber-768

Pyde's encrypted mempool uses Kyber-768 with a threshold variant. At each epoch, the 128 committee members run a Distributed Key Generation (DKG) ceremony producing a single public key `PK` and 128 private shares `s_i`. Threshold is `2f+1 = 85` of 128 — matching the BFT quorum.

User transactions can optionally be encrypted under `PK` before submission. Decryption requires 85+ committee members to compute partial decryptions and combine them via Lagrange interpolation. **No single party — not even a coalition of fewer than 85 — can decrypt anything.**

Critical invariant: **commit-before-reveal.** Consensus orders encrypted transactions before any decryption shares are released. By the time the order is committed, the content remains hidden. Decryption happens after ordering is final. This eliminates MEV extraction at the protocol level: a bot cannot observe content in the mempool to position against, because content is never visible until ordering is fixed.

### 4.3 Hashing: Hybrid Strategy

Pyde uses a layered hash strategy optimized per use case:

| Layer | Hash | Reason |
|---|---|---|
| JMT internal nodes (high volume) | **Blake3** | ~30× faster than Poseidon2 on CPU; not in ZK circuits |
| Published state root (per commit) | **Both** (Blake3 native + Poseidon2 for ZK) | Native verification fast; ZK validity proofs future-compatible |
| Transaction hashes | Blake3 (ciphertext), Poseidon2 (plaintext canonical) | Different uses, different requirements |
| Address derivation | Poseidon2 | Used in sig-verify ZK circuits |
| FALCON sig hashing | Poseidon2 | Inside ZK aggregation circuit |

This avoids Poseidon2's per-op overhead on high-volume native paths while preserving ZK compatibility where it matters.

### 4.4 Randomness Beacon

Each epoch's randomness beacon is produced by the previous epoch's committee via a threshold-signature ceremony. The aggregated signature is hashed to produce a deterministic, unpredictable beacon. The beacon is used for:
- Per-round anchor selection: `Hash(beacon, round, recent_state_root) mod 128`
- Next epoch's committee VRF picks
- Other protocol randomness

Adding `recent_state_root` to anchor derivation reduces predictability window from a full epoch (~3 hours) to a few rounds (~450ms).

## 5. Consensus: Mysticeti-Style DAG

### 5.1 Design Choice

Pyde's consensus is a Mysticeti-style DAG protocol, chosen over Bullshark for faster commit latency (~390ms vs ~1s) and better liveness under validator failures. Both share the underlying Narwhal data dissemination layer.

**Why DAG over HotStuff:**
- No single-proposer bottleneck — every member contributes vertices continuously
- No view changes — eliminates a major source of safety bugs (the HotStuff failure class)
- Censorship resistance — 127 honest members can include any transaction, censorship requires near-unanimous collusion
- Throughput scales with committee size, not constrained by one proposer's bandwidth
- Threshold-decryption integrates naturally at the order-commit boundary

### 5.2 Worker / Primary Split (Narwhal Pattern)

Each validator runs:
- **Workers** (N of them per validator): handle transaction ingress, build batches, gossip batches peer-to-peer to other validators' workers
- **Primary** (one per validator): handles consensus — produces vertices each round, gathers parent references, signs state roots

This separation decouples data flow from consensus structure. Transactions travel the network exactly once (via worker gossip); consensus vertices stay tiny (carrying only batch hashes by reference).

### 5.3 The Vertex

Each round, every committee member's primary produces exactly one vertex:

```rust
struct Vertex {
    round: u64,
    member_id: u32,
    batch_refs: Vec<BatchHash>,                  // hashes of batches I have
    parent_vertex_refs: Vec<VertexHash>,         // ≥85 round-(N-1) vertex hashes
    state_root_sigs: Vec<StateRootSig>,          // attestations on recent commits
    prev_anchor_attestation: VertexHash,         // attestation of prior anchor
    decryption_shares: Vec<DecryptionShare>,     // piggybacked partials
    falcon_sig: FalconSig,                       // sig over the vertex
}
```

Vertices form a Directed Acyclic Graph: parents must be strictly from prior rounds (no skip edges in v1). The "DAG" is purely a consensus structure; the actual transaction data lives in batches stored at the worker layer, referenced by hash.

### 5.4 Anchor Selection & Commit

Each round, an "anchor" is selected deterministically:
```
anchor_member_id = Hash(beacon, round, recent_state_root) mod 128
```

When the anchor vertex collects sufficient support from later rounds (Mysticeti's 3-stage support), a commit fires:
1. Anchor's subdag is collected by walking `parent_vertex_refs` recursively
2. Subdag is sorted deterministically: `(round_number, member_id, list_order)`
3. Batches referenced by each vertex in the sorted order are dereferenced
4. Threshold decryption ceremony runs (pipelined — partials already in flight)
5. PVM executes decrypted transactions in the canonical order
6. State root computed (dual Blake3 + Poseidon2), signed by committee
7. Finality declared once 85+ state-root sigs are accumulated

**Median finality target: ~500ms.** Empirically validated by performance harness pre-publication.

### 5.5 The Committee

128 validators per epoch, selected from the global validator pool:
- **Selection:** uniform random from validators with stake ≥ committee minimum (10,000,000 PYDE)
- **Anti-Sybil:** operator identity binding, max 5 validators per operator
- **Equal power:** all 128 have equal voting weight, equal vertex production rate, equal anchor probability (uniform over members)
- **Stake influence:** only on selection probability (uniform within eligible pool) and proportion of flat 30% stake-pool yield. Activity rewards within the committee are contribution-weighted, not stake-weighted.
- **Epoch length:** ~3 hours (measured in wall-clock)
- **DKG ceremony:** runs in background during the prior epoch's last minutes; new committee has threshold key ready by epoch start

### 5.6 Safety, Liveness, and Halt Recovery

Pyde inherits standard BFT guarantees: safety holds under any network conditions assuming at most `f = 42` Byzantine members (the BFT tolerance `⌊(n-1)/3⌋` with n = 128); liveness holds under partial synchrony.

When safety appears at risk (e.g., contradictory state-root signatures detected), the protocol auto-halts. Three halt classes — **soft stall** (auto-recover), **hard halt** (manual investigation), **emergency halt** (governance multisig) — each with explicit detection, investigation, and recovery procedures.

Rollback is bounded: within a single epoch (~3 hours), governance multisig can authorize rollback to a prior consistent state. Beyond an epoch, only coordinated hard fork is possible. This is the "weak finality with sunset" pattern — operational flexibility for early detection without arbitrary commit reversibility.

## 6. Execution: PVM, Otigen, Hybrid Scheduling

### 6.1 The PVM

Pyde's Virtual Machine is register-based with:
- 16 × 64-bit general-purpose registers (r0 hardwired to zero)
- 8 × 256-bit wide registers for cryptographic operations
- 62 opcodes covering arithmetic, memory, control flow, storage, crypto, and assertions
- Checked arithmetic (trap on overflow)
- 4 MB address space (null page, code, heap, stack)
- AOT JIT compilation via Cranelift

The PVM is deterministic — same input transactions produce byte-identical state transitions across all validators. This determinism is load-bearing for both consensus (state-root agreement) and future ZK validity proofs.

### 6.2 Otigen Language

Smart contracts are written in Otigen (`.oti`), a Rust-like language with:
- 30 keywords; storage maps, structs, enums, variable-length Vec
- Function dispatch with 4-byte selectors (EVM-compatible pattern)
- Reentrancy guards (`#[reentrant]` attribute)
- Checked arithmetic by default
- Custom error types and events
- View / payable / reentrant attributes for function semantics

Otigen compiles via `otic` to a JSON artifact (bytecode + ABI). The compiler also performs **static access list inference**: for each function, the compiler emits the set of storage slots the function provably accesses (where statically knowable), plus regions where access depends on runtime values.

### 6.3 Hybrid Parallel Scheduler

Pyde combines two parallel-execution philosophies:

**Static access lists** (Solana-style): for functions where access can be inferred at compile time, the scheduler partitions transactions into parallel groups by their declared access sets. Deterministic, no speculation overhead.

**Block-STM speculation** (Aptos-style): for functions with dynamic access patterns, transactions execute optimistically. Read/write sets are tracked at runtime. Conflicts trigger re-execution in canonical order.

**The Pyde innovation: hybrid.** The Otigen compiler emits both `declared_access_set` (static) and `dynamic_access_regions` (runtime). The runtime scheduler uses the static information for partition planning, falls back to Block-STM for dynamic regions. Pyde controls compiler, runtime, and language — making this hybrid feasible where most chains commit to one approach.

Preflight execution at user submission time (via `pyde_estimateAccess` RPC) derives a runtime-observed access list, attached to the transaction. The scheduler treats access lists as hints, verifying at runtime and falling back to speculation on mismatch. Safe by construction.

### 6.4 Transaction Lifecycle

```
User wallet:
  1. Construct tx (sender, recipient, amount, payload, ...)
  2. RPC pyde_estimateAccess → returns gas_estimate + access_list
  3. Attach access_list to tx
  4. FALCON-sign tx hash
  5. (Optional) Encrypt signed tx + access_list with epoch PK
  6. Submit to RPC

Worker:
  7. Receive tx, validate wire format
  8. (Plaintext) verify FALCON sig at ingress
  9. Batch with other txs
  10. Gossip batch to peer workers

Primary:
  11. Produce vertex referencing available batches
  12. Gossip vertex; peers cert as parent in next round
  
Wave commit:
  13. Anchor selected; subdag walked; canonical order emitted
  14. (Encrypted) threshold-decrypt batches
  15. PVM executes in canonical order
  16. State root computed, signed by 85+ committee
  17. Finality declared
```

End-to-end latency: ~500ms median for unencrypted, ~700ms for encrypted (adds decryption ceremony to wave commit budget).

## 7. State: Jellyfish Merkle Tree

State is stored in a Jellyfish Merkle Tree (JMT) — radix-16, path-compressed. Compared to a fixed-depth-256 Sparse Merkle Tree:
- ~5–10 nodes per state operation (vs ~256)
- Substantial I/O savings at high TPS
- Same authentication properties (Merkle commitment, inclusion/exclusion proofs)
- Production-proven (Diem, Aptos)

State commitment is dual-rooted: Blake3 for native verification speed, Poseidon2 for ZK-circuit compatibility. Both are computed at each wave commit and signed by the committee.

## 8. MEV Resistance

Three structural defenses, layered:

**Layer 1: Threshold encryption.** Users can encrypt transactions before submission. The encrypted blob is opaque — even committee members cannot decrypt alone. Mempool sees only encrypted bytes; attackers cannot observe content to position around.

**Layer 2: Commit-before-reveal.** Consensus orders encrypted transactions before decryption shares are released. By the time content is revealed, the ordering is fixed and irreversible. An attacker has no information about transaction content during the ordering phase.

**Layer 3: No proposer.** Pyde's DAG consensus has no single party empowered to choose which transactions enter a wave commit or in what order. The canonical order emerges deterministically from the DAG; no member can selectively reorder, exclude, or front-run.

The combination eliminates the structural conditions for sandwich attacks, front-running, and proposer extraction. **MEV is not policed or auctioned — it is structurally impossible at the protocol layer.**

Encryption is opt-in per transaction. Simple transfers and non-time-sensitive operations can be submitted plaintext for lower gas cost. MEV-sensitive operations (DEX swaps, NFT mints, liquidations) opt into encryption via `pyde_sendRawEncryptedTransaction`.

## 9. Network Protocol

### 9.1 Transport & P2P

- **Transport: QUIC** over UDP, with TCP fallback. No head-of-line blocking, built-in TLS 1.3, mature Rust implementations (quinn).
- **P2P library: libp2p (Rust).** Audited, used by Ethereum, Filecoin, Polkadot.
- **Node identity:** Ed25519 keypair (separate from validator FALCON key, rotatable).

### 9.2 Peer Discovery

Layered, without DHT (peers are limited and known on-chain):
1. Hardcoded seeds (5–10, foundation-operated)
2. DNS seeds (community-extensible)
3. On-chain validator registry (committee members publish addresses)
4. Peer Exchange (PEX) between peers
5. Persistent peer cache (survives restarts)

### 9.3 Gossip

Gossipsub (libp2p standard) with per-topic meshes:
- `pyde/vertices/<epoch>` — committee + full nodes
- `pyde/batches/<shard>` — committee workers + RPC
- `pyde/decryption_shares/<commit>` — committee
- `pyde/state_root_sigs/<commit>` — committee + full + light
- `pyde/mempool/{plain|encrypted}` — validators + RPC
- `pyde/state_sync/manifests` — sync nodes

Message size limits per type are enforced at parse time, with rejection + peer score penalty on exceedance. BatchData has the largest practical limit (4 MB), aligning with modest-hardware committee bandwidth (≥500 Mbps NIC sufficient at 100K TPS).

### 9.4 Defense

Multi-layer DoS protections: connection-level (IP/ASN caps), message-level (rate limits per type), peer-scoring (misbehavior accumulates, decays with good behavior), application-level (gas tank prepayment for encrypted-tx submission). Committee validators are recommended to operate behind sentry nodes (Cosmos pattern) for DDoS protection.

## 10. Cross-Chain: The Parachain Layer (Post-Mainnet)

Cross-chain interactions in Pyde — calling functions on other chains, querying oracles, requesting off-chain compute — happen through a **parachain layer of permissionless decentralized infrastructure providers**. A parachain is not a sovereign app-chain. It is an open-source implementation of a Pyde-published specification, run by operators who stake PYDE, follow protocol-defined rules, and earn gas fees from contracts that call them.

### 10.1 The cross_call! Macro

```rust
cross_call!(
    target_chain = "ethereum",
    contract = "0x...",
    function = "balanceOf",
    args = [...],
    callback = "handle_balance_response",
);
```

The macro is asynchronous. The originating transaction marks the call pending and emits an event with the call ID; the actual cross-chain or oracle work happens off-chain at the parachain operator set; the result arrives in a separate callback transaction.

### 10.2 HardFinalityCert

A bridge-out primitive: a FALCON quorum certificate over `(wave_id, blake3_state_root, poseidon2_state_root)`. Verification cost on any counterparty chain: ≥ 85 FALCON-512 verifications (~85ms) plus a Merkle path. Feasible on any chain with a reasonable VM.

The cert's stability across the chain's lifetime is what makes parachains feasible without further protocol changes after mainnet.

### 10.3 Architecture vs Implementation

The architecture surface (the `cross_call!` macro, `HardFinalityCert`, unified gas model) is settled at genesis. The actual parachain layer ships post-mainnet. The mainnet `cross_call!` macro initially returns a runtime "not yet supported" — contracts written today work without rewriting when parachains activate.

## 11. Performance

### 11.1 Honest Targets

Realistic v1 mainnet performance, validated by a multi-region production-realistic harness:

| Metric | Realistic v1 | Stretch v1 | Aspirational |
|---|---|---|---|
| Plaintext TPS (sustained, commodity hardware) | 10,000 – 30,000 | 50,000 – 100,000 | 500,000 |
| Encrypted TPS (sustained, commodity CPU) | 500 – 2,000 | 5,000 – 10,000 | 50,000+ (with GPU) |
| Median finality | ~500 ms | ~400 ms | ~300 ms |
| Committee NIC requirement (at sustained TPS) | 500 Mbps | 1 Gbps | 10 Gbps |

These numbers will be revised based on actual performance harness output and adjusted using the "claim 1/3 of measured peak" rule.

### 11.2 Hardware Tiers

The "commodity validator" promise applies layered:

| Role | Hardware tier |
|---|---|
| Light client | Mobile/browser |
| Full node / RPC | 8c/16GB/500GB/100Mbps |
| Non-committee validator | 8c/16GB/500GB/100-250Mbps |
| Committee validator (30K TPS) | 8-16c/32GB/1TB SSD/500Mbps |
| Committee validator (100K TPS) | 16c/32GB/2TB SSD/1Gbps |
| Committee validator (500K TPS) | 32c/64GB/4TB SSD/10Gbps |

Modest hardware is sustained for non-committee roles at all TPS levels. Committee hardware scales with throughput target.

### 11.3 The HotStuff Lesson

Pyde's earlier HotStuff implementation hit ~4K TPS in practice — below claimed targets. The lesson: **lab benchmarks ≠ production**. Pyde's performance discipline:
- Multi-region testing mandatory (not localhost)
- Production-realistic workload mix (not synthetic transfer-only)
- Continuous soak testing (4-hour minimum for any TPS claim)
- "Claim 1/3 of measured peak" rule for external numbers
- Public dashboard with rolling 30-day metrics

This is non-negotiable. No TPS claim is published externally without harness evidence.

## 12. Economics & Governance

### 12.1 Token

- **Total genesis supply:** 1,000,000,000 PYDE
- **Inflation schedule:** 5% year 1, decreasing 3% / 2% / 1%, fixed at 1% thereafter
- **Validator bond:** two-tier — 10M PYDE committee / 100K PYDE non-committee (anti-Sybil, not stake-weighted power)
- **Fee model:** EIP-1559 with elastic 4× blocks; **no priority tips** (priority would price the information asymmetry the encrypted mempool eliminates)

### 12.2 Fee Distribution

Each transaction's base fee:
- **70% burned** (deflationary pressure)
- **10% to treasury** (multisig-controlled, public PIP review)
- **20% to the reward pool**, split:
  - 70% activity-weighted across the active committee (vertices certified, batches included, decryption shares submitted, anchor selections)
  - 30% flat across the full stake pool (committee + non-committee, by stake)

### 12.3 Governance

Pyde's governance is **off-chain**. Protocol changes proceed via Pyde Improvement Proposals (PIPs) — public, versioned, ratified by social consensus. Validators upgrade voluntarily; hard forks happen by social agreement; the chain retaining 67%+ stake is the legitimate continuation. On-chain governance is restricted to treasury spending and emergency operations, both gated by an M-of-N FALCON multisig with a 30-day-bounded emergency-pause primitive.

Two-chamber on-chain governance was evaluated and rejected — protocol upgrade should require coordinated human decision, not stake-weighted voting that incumbents can capture.

## 13. Validator Lifecycle

Validators progress through a state machine: registration → pending activation (1 epoch bonding) → active waiting → committee active (during selected epoch) → unbonding (30 days) → withdrawable.

Key parameters:
- Committee minimum stake: 10,000,000 PYDE (10M)
- Non-committee minimum stake: 100,000 PYDE (100K)
- Maximum 5 validators per operator (identity-bound)
- Bonding: 1 epoch
- Unbonding: 30 days (must exceed safety evidence freshness window of 21 days)
- Key rotation: max once per epoch
- Jail escalation: 24h → 7d → permanent

Slashing applies during both bonded and unbonding states — preventing attack-then-exit.

## 14. Slashing

Pyde slashing follows industry-aligned magnitudes:

| Offense type | First instance | Max (correlation/repeat) |
|---|---|---|
| Equivocation | 10% | 50% |
| Bad state-root sig | 10% | 50% |
| Bad anchor attestation | 5% | 20% |
| Invalid vertex | 5% | 30% |
| Bad decryption share | 5% | 30% |
| DKG failure | 2% | 10% |
| Share withholding (per round) | 0.1% | 5%/epoch |
| Extended downtime (per round) | 0.05% | 10%/epoch |
| Bad batch attestation | 2% | 5% |

Coordinated safety offenses are multiplied by a correlation factor (up to 2×). Reporter receives 10% of safety-slash distributions. Slashing escrow (24h dispute window) allows governance to void false positives.

## 15. Open Problems & Future Work

### 15.1 Threshold Post-Quantum Cryptography

Production-grade threshold variants of Kyber are research-stage. Pyde v1 may ship with a classical-crypto threshold scheme (ElGamal-style over Ed25519) as a transitional measure, migrating to threshold Kyber when audited implementations mature. This is the single largest cryptographic engineering risk in the design and is being actively researched.

### 15.2 Batch Threshold Decryption

Per-ciphertext threshold decryption scales poorly at high TPS (~50K-100K encrypted TPS ceiling on commodity hardware). Batch decryption schemes (where one threshold ceremony decrypts multiple ciphertexts) are research-stage; Pyde v2 will adopt one once standardization matures.

### 15.3 ZK Light Clients

Pyde's hybrid hashing (Poseidon2 for ZK paths) keeps zero-knowledge proof options open. Post-mainnet, ZK-validated state proofs would enable succinct light clients (kilobytes of proof, full security). Specific SNARK system choice (Plonky3, SP1, Halo2, RISC Zero) deferred.

### 15.4 Programmable Accounts & Session Keys

Native multisig ships at v1. Programmable accounts (PVM bytecode policies authorizing arbitrary spending logic) and session keys (scoped dApp delegation without per-action wallet popups) ship post-mainnet. The `AuthKeys` enum reserves the `Programmable` variant at genesis so contracts written today survive the upgrade without rewriting.

### 15.5 Parachain Layer

The protocol-level cross-chain primitives (`cross_call!`, `HardFinalityCert`) ship at genesis with mainnet stubs. The actual parachain layer — specification, reference implementations, operator economics, bridges to Ethereum/Cosmos/Solana — ships post-mainnet.

## 16. Conclusion

Pyde represents a chain built around the architectural requirements of the next decade: post-quantum security, MEV resistance, sub-second finality, and commodity-hardware decentralization for users and infrastructure. The pivot from in-house HotStuff to Mysticeti-style DAG consensus reflects an explicit commitment to designing from a clean foundation rather than patching accumulated technical debt.

The design is complete; implementation is the work ahead. Mainnet ships when external security audit + multi-region testnet validation pass — no public schedule.

This is not a chain that ships in six months. It is a chain that aims to occupy a category — post-quantum, MEV-free, commodity-validated — that no production chain occupies today. The window for that occupancy is open and time-bound.

---

**Document version:** 0.1
**Status:** Living document
**License:** See repository root
