# Migration Notes (2026 Pivot)

This page is the migration log between the pre-pivot Pyde architecture
(in-house HotStuff consensus) and the post-pivot architecture (Mysticeti
DAG consensus + hybrid hashing + keyless private mempool). The book itself
has been rewritten in place; this page exists as a single reference for
**what changed and why**, useful for readers who came in mid-flight or
who need to reconcile against pre-pivot artifacts.

> **Note on MEV protection.** An interim post-pivot draft carried an
> *optional threshold-encrypted mempool* (Kyber-768 + Shamir shares). That
> lane was later removed from the protocol — trustless post-quantum
> threshold keygen is research-blocked. MEV protection is now the **keyless
> commit-reveal private mempool** ([Chapter 9](chapters/09-mev-protection.md));
> a one-shot ciphertext lane remains v2+ research
> ([Chapter 20](chapters/20-future-direction.md)). The cells below that
> mention threshold encryption reflect that interim draft, annotated inline.

## The Pivot, In One Page

**Before (HotStuff variant):**
- Single-proposer-per-slot BFT consensus with 400 ms slot timing.
- View-change protocol for proposer failures.
- Encrypted mempool with proposer-asserted ordering commitment.
- Validators each stake a fixed 10K PYDE; equal vote weight.
- Sparse Merkle Tree (256-deep) for state.
- Poseidon2 hashing everywhere.
- Targeted 12.5K TPS sustained / 50K peak as headline.

**After (Mysticeti DAG):**
- DAG consensus — every round every committee member produces one vertex.
- No proposers, no view changes. Anchor selection is deterministic.
- Keyless commit-reveal private mempool for MEV-sensitive transactions
  (plaintext by default; opt into the private lane per-tx).
- Single-tier staking — 10,000 PYDE minimum, uniform-random committee selection per epoch, operator-identity cap (3 per operator).
- Jellyfish Merkle Tree (radix-16, path-compressed).
- Hybrid hashing — Blake3 (high-volume native) + Poseidon2 (ZK-bearing).
- v1 honest throughput target (to be established by the multi-region
  performance harness) on commodity committee hardware, per the publishing
  discipline: publish only what the harness measures under sustained,
  production-realistic conditions — never lab extrapolations or
  microbenchmark peaks.

## Why the Pivot

The HotStuff variant accumulated wedges, head-divergence deadlocks, and
view-change cascades that resisted patching. Lab measurements peaked at
~4K TPS (full launch tests never ran). Repeated incidents under simple
multi-node tests suggested the issue was structural, not implementation.
The team chose a clean break: remove the consensus, mempool, and
networking layers from the workspace; rebuild with the Mysticeti DAG
protocol that Sui has been running in production since 2024.

## Component-by-Component Diff

| Component | Pre-pivot | Post-pivot |
|-----------|-----------|------------|
| Consensus | HotStuff variant, 1 proposer/slot | Mysticeti DAG, 128 vertices/round |
| Slot timing | 400 ms slot | ~150 ms round, ~500 ms median commit |
| Ordering | Proposer-asserted ordering commitment | Structural via committed subdag |
| Validator architecture | Monolithic | Worker (tx batching) + Primary (consensus) |
| Mempool | Always-encrypted | Plaintext default + opt-in keyless commit-reveal private lane |
| State tree | Fixed-depth Sparse Merkle Tree | Jellyfish Merkle Tree (radix-16, path-compressed) |
| Hashing | Poseidon2 everywhere | Blake3 (native) + Poseidon2 (ZK-bearing) |
| State root | Single Poseidon2 root | Dual: Blake3 + Poseidon2 |
| Execution | Otigen era: static access lists only. Intermediate proposal (dropped): hybrid static + Block-STM speculation. | Current v1: uniform Block-STM; access list is an optional prefetch hint (PIP-3 multiget cache warm-up) and never partitions execution. |
| Staking model | Single 10K PYDE | Single 10K PYDE (unchanged; an interim mid-pivot draft of the book proposed 10M/100K tiers — that was an error; flat-tier with operator-cap was the actual decision) |
| Reward distribution | Direct proposer share (20%) | Epoch reward pool (20%, distributed by stake×uptime) |
| Peer discovery | Kademlia DHT | Layered (seeds → DNS → on-chain registry → PEX → cache) |
| Committee defense | Operational sentry pattern only | Sentry pattern with protocol support |
| Cross-chain | Stub `cross_call!` | `cross_call!` + parachain operator network (v2) |
| Account abstraction | Single + Multisig | Single + Multisig (max 16) + Programmable (v2 reserved) |

## What Stayed the Same

- **FALCON-512** signatures everywhere. Untouched.
- **Kyber-768** KEM. Retained for transport-layer session keys. (The
  post-pivot interim threshold-encrypted mempool that also used Kyber has
  since been removed; MEV protection is now the keyless commit-reveal lane.)
- **70/20/10 fee split**. Recipient of 20% changed (proposer → reward
  pool) but the percentages held.
- **16-slot nonce window** per account. Untouched.
- **Gas tank + paymaster** sponsored-tx model. Untouched.
- **Treasury multisig + emergency pause** governance model. Untouched
  (multisig threshold raised to 7-of-12 typical).

## Reading Order if You Knew the Pre-Pivot Book

If you're returning to the book after the pivot, the chapters that
changed most are:

1. **Chapter 6 (Consensus)** — full rewrite; HotStuff → Mysticeti DAG.
2. **Chapter 7 (State Sync & Chain Halt)** — new chapter, operational
   procedures absent in pre-pivot.
3. **Chapter 9 (MEV Protection)** — restructured for DAG ordering.
4. **Chapter 4 (State Model)** — hybrid hashing, dual state roots.
5. **Chapter 8 (Cryptography)** — Blake3 added; Poseidon2 scope narrowed.
6. **Chapter 12 (Networking)** — DHT removed; layered discovery + sentry.
7. **Chapter 14 (Tokenomics)** — single-tier staking (10K PYDE min,
   uniform-random committee selection, operator-identity cap), reward
   pool, updated inflation math.
8. **Chapter 19 (Launch Strategy)** — timeline reset post-pivot.
9. **Chapter 20 (Appendix)** — glossary, constants, post-mainnet plan
   updated.

Chapters that changed less:

- **Chapter 3 (Execution Layer)** — full rewrite for WebAssembly via wasmtime (post-pivot).
- **Chapter 5 (Otigen Toolchain)** — full rewrite as the developer toolchain (the binary; name carried forward from the retired language).
- **Chapter 10 (Gas/Fee)** — commit-cadence + honest TPS numbers.
- **Chapter 11 (Account Model)** — reserved `Programmable` AuthKeys
  variant for v2.
- **Chapter 13 (Cross-Chain)** — parachain layer framed as permissionless
  operator network (v2), not auctioned slots.
- **Chapter 16 (Security)** — DAG safety argument replaces HotStuff one;
  attack surface table updated.
- **Chapters 15, 17, 18** — minor parameter / API updates.

## Honest Status

The post-pivot architecture is now substantially implemented. Devnet runs
a multi-validator Mysticeti committee with WASM execution, the keyless
commit-reveal private mempool, and state-sync. Credible public
performance numbers are still gated on the multi-region harness.

| Component | Status |
|-----------|--------|
| Architecture design | ✅ Complete |
| WASM execution (wasmtime + Cranelift AOT, Block-STM) | 🟢 Live; pooled `Engine`, Host Function ABI v1.0 frozen, Block-STM wired into the commit walk |
| State (JMT + hybrid Blake3 / Poseidon2 dual root) | 🟢 Wired; `StateRoot { blake3, poseidon2 }` end-to-end |
| Mysticeti DAG consensus | 🟡 Vertex / anchor / beacon / committee / wave commit live; multi-validator genesis DKG + state-sync replay shipped; soak-test hardening and resharing edge cases in flight |
| MEV protection (keyless commit-reveal private mempool) | 🟢 Commit/Reveal tx types, bond escrow, and commit-order reveal resolution live; no committee key, no DKG (the earlier threshold-encryption lane was removed) |
| Network protocol (libp2p + QUIC + Gossipsub) | 🟢 Migrated; layered discovery, peer scoring, sentry-friendly topology |
| Performance harness | 🟡 Local soak-test driver + multi-validator cluster CLI live; multi-region rig + chaos scenarios not yet built |
| SDKs (TypeScript + Rust) | 🟡 `pyde-ts-sdk` 0.1.0 staged; Rust SDK in progress |

The multi-region performance harness is still the bottleneck on credible
TPS claims. No external number leaves this project without harness
evidence: publish only what the harness measures under sustained,
production-realistic conditions — never lab extrapolations or
microbenchmark peaks.

## Related Docs

- Full technical design: [companion/DESIGN.md](companion/DESIGN.md)
- Whitepaper: [companion/WHITEPAPER.md](companion/WHITEPAPER.md)
- Threat model: [companion/THREAT_MODEL.md](companion/THREAT_MODEL.md)
- Failure scenarios: [companion/FAILURE_SCENARIOS.md](companion/FAILURE_SCENARIOS.md)
- Performance harness spec: [companion/PERFORMANCE_HARNESS.md](companion/PERFORMANCE_HARNESS.md)
- Mainnet plan: [Launch Strategy](chapters/19-launch-strategy.md)
