# Migration Notes (May 2026 Pivot)

This page is the migration log between the pre-pivot Pyde architecture
(in-house HotStuff consensus) and the post-pivot architecture (Mysticeti
DAG consensus + hybrid hashing + optional encryption). The book itself
has been rewritten in place; this page exists as a single reference for
**what changed and why**, useful for readers who came in mid-flight or
who need to reconcile against pre-pivot artifacts.

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
- Optional threshold encryption per-tx (plaintext or encrypted).
- Single-tier staking — 10,000 PYDE minimum, uniform-random committee selection per epoch, operator-identity cap (3 per operator).
- Jellyfish Merkle Tree (radix-16, path-compressed).
- Hybrid hashing — Blake3 (high-volume native) + Poseidon2 (ZK-bearing).
- v1 honest target: 10-30K plaintext / 0.5-2K encrypted TPS on commodity
  committee hardware, per the "claim 1/3 of measured peak" rule.

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
| Mempool | Always-encrypted | Optional encryption per-tx |
| State tree | Fixed-depth Sparse Merkle Tree | Jellyfish Merkle Tree (radix-16, path-compressed) |
| Hashing | Poseidon2 everywhere | Blake3 (native) + Poseidon2 (ZK-bearing) |
| State root | Single Poseidon2 root | Dual: Blake3 + Poseidon2 |
| Execution | Static access lists only | Hybrid: static + Block-STM speculation |
| Staking model | Single 10K PYDE | Single 10K PYDE (unchanged; an interim mid-pivot draft of the book proposed 10M/100K tiers — that was an error; flat-tier with operator-cap was the actual decision) |
| Reward distribution | Direct proposer share (20%) | Epoch reward pool (20%, distributed by stake×uptime) |
| Peer discovery | Kademlia DHT | Layered (seeds → DNS → on-chain registry → PEX → cache) |
| Committee defense | Operational sentry pattern only | Sentry pattern with protocol support |
| Cross-chain | Stub `cross_call!` | `cross_call!` + parachain operator network (v2) |
| Account abstraction | Single + Multisig | Single + Multisig (max 16) + Programmable (v2 reserved) |

## What Stayed the Same

- **PVM** — register-based, 32-bit fixed encoding, 62 opcodes. Untouched.
- **Otigen language** — `.oti` source, `otic` compiler, default-safe
  semantics. Untouched.
- **FALCON-512** signatures everywhere. Untouched.
- **Kyber-768** threshold encryption primitive. Untouched (now opt-in
  per-tx instead of mandatory).
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
9. **Chapter 20 (Appendix)** — glossary, constants, post-mainnet roadmap
   updated.

Chapters that changed less:

- **Chapter 3 (Virtual Machine)** — added hybrid scheduler note.
- **Chapter 5 (Otigen)** — added compile-time access list inference note.
- **Chapter 10 (Gas/Fee)** — commit-cadence + honest TPS numbers.
- **Chapter 11 (Account Model)** — reserved `Programmable` AuthKeys
  variant for v2.
- **Chapter 13 (Cross-Chain)** — parachain layer framed as permissionless
  operator network (v2), not auctioned slots.
- **Chapter 16 (Security)** — DAG safety argument replaces HotStuff one;
  attack surface table updated.
- **Chapters 15, 17, 18** — minor parameter / API updates.

## Honest Status

**Designed architecture, not shipped implementation.** This book
describes the post-pivot target architecture. Implementation status:

| Component | Status |
|-----------|--------|
| Architecture design | ✅ Complete |
| PVM + Otigen execution | 🟡 Functional, extensions needed |
| State (JMT) | 🟡 In place, needs hybrid hashing wired |
| Mysticeti DAG consensus | 🔴 Not yet — rebuild post-pivot |
| Threshold cryptography | 🔴 Research-grade (PQ threshold is bleeding edge) |
| Network protocol | 🟡 Existing, needs libp2p+QUIC migration |
| Performance harness | 🔴 Not yet built |

The performance harness is the bottleneck on credible TPS claims. No
external number leaves this project without harness evidence under the
"claim 1/3 of measured peak" rule.

## Related Docs

- Full technical design: `docs/DESIGN.md`
- Whitepaper: `docs/WHITEPAPER.md`
- Threat model: `docs/THREAT_MODEL.md`
- Failure scenarios: `docs/FAILURE_SCENARIOS.md`
- Performance harness spec: `docs/PERFORMANCE_HARNESS.md`
- Mainnet plan: `MAINNET_PLAN.md` (repo root)
