# Introduction

## What is Pyde?

Pyde is a Layer 1 blockchain built greenfield to deliver four properties no chain in production combines today:

1. **Post-quantum cryptography by default** — FALCON-512 signatures, Kyber-768 threshold encryption, Poseidon2 hashing
2. **MEV resistance by structure** — threshold-encrypted mempool + commit-before-reveal ordering + DAG consensus eliminates proposer extraction
3. **Sub-second finality** — Mysticeti-style DAG consensus, ~500ms median finality
4. **Commodity decentralization** — modest hardware for validators not currently on the active committee; equal voting power within the active committee

The execution layer is a register-based Pyde Virtual Machine (PVM) with a hybrid parallel scheduler combining Solana-style declared access lists with Aptos-style Block-STM speculation. Smart contracts are written in **Otigen**, a purpose-built language with reentrancy guards, checked arithmetic, and compile-time access list inference.

Cross-chain interactions — calling functions on other chains, querying oracles, off-chain compute — happen through a permissionless **parachain layer** (post-mainnet) with operators who stake PYDE and earn gas fees from contracts that call them. No custodial multisigs, no auctioned slots.

## The May 2026 Pivot

Pyde's earlier architecture used an in-house HotStuff variant with 400ms slot timing. Repeated wedges, head-divergence deadlocks, and view-change cascades motivated a clean break:

- **Removed:** the entire consensus, mempool, networking layers from the active workspace
- **Replaced with:** a Mysticeti-style DAG consensus rebuild starting from a clean foundation
- **Refocused:** execution layer + cryptography first, consensus on solid ground

This book reflects the post-pivot architecture. Previous architecture (HotStuff) is archived in `archive/` for reference.

## Why a New Layer 1?

### The Quantum Problem

Every major Layer 1 in production today — Bitcoin, Ethereum, Solana, Cardano, Polkadot — uses classical cryptography (secp256k1, Ed25519, BLS12-381) vulnerable to Shor's algorithm. NIST's 2024 standardization of FALCON, ML-DSA, and ML-KEM unblocked post-quantum primitives, but retrofitting them into a live chain is a multi-year coordinated migration. **Pyde ships PQ at genesis without retrofitting.**

### The MEV Problem

Maximum Extractable Value has hardened into a multi-billion-dollar tax paid by retail users to validator-builder coalitions. Sandwich attacks, front-running, and proposer extraction are not bugs — they are structural consequences of public mempools and single-proposer block production. **Pyde eliminates the structural conditions** via threshold encryption + commit-before-reveal + DAG consensus (no single proposer to exploit).

### The Decentralization Problem

Chains optimizing for throughput have ended up requiring datacenter-class validator hardware. Chains optimizing for decentralization have ended up with throughput unusable for serious applications. **Pyde scales hardware requirements by role** — commodity for validators awaiting committee selection, modest professional for validators on the active committee at production targets, datacenter only for aspirational TPS levels.

## What's New (Post-Pivot)

- **Mysticeti DAG consensus** replaces HotStuff. No view changes, no single proposer, ~500ms commit latency
- **Worker / Primary split** (Narwhal pattern) for data dissemination separate from consensus
- **Hybrid execution scheduler** — static access lists for known patterns, Block-STM for dynamic
- **Hybrid hashing** — Blake3 for high-volume native paths, Poseidon2 for ZK-bearing paths
- **JMT state tree** (Jellyfish Merkle Tree, radix-16) replaces fixed-depth SMT
- **Encryption opt-in** per-tx — MEV protection where needed, no overhead where not
- **Honest performance targets** — 10-30K TPS realistic v1, validated by multi-region performance harness
- **Phased mainnet plan** — external audit + incentivized testnet before launch (Chapter 19)

## Honest Status

This book describes **designed architecture**, not shipped implementation:

| Component | Status |
|---|---|
| Architecture design | ✅ Complete |
| PVM + Otigen execution | 🟡 Functional, extensions needed |
| State (JMT) | 🟡 In place, needs hybrid hashing |
| Mysticeti DAG consensus | 🔴 Not yet — rebuild post-pivot |
| Threshold cryptography | 🔴 Research-grade (PQ threshold is bleeding edge) |
| Network protocol | 🟡 Existing, needs libp2p+QUIC migration |
| Performance harness | 🔴 Not yet built |

**Mainnet ships when the work in Chapter 19 is done and the external audit passes** — no public schedule.

## Performance Targets

Validated by multi-region production-realistic harness (mandatory before any external claim):

| Mode | v1 realistic | v2 stretch | Aspirational |
|---|---|---|---|
| Plaintext TPS (commodity) | 10K-30K | 50K-100K | 500K |
| Encrypted TPS (commodity) | 0.5K-2K | 5K-10K | 50K+ |
| Median finality | ~500ms | ~400ms | ~300ms |

**The HotStuff Lesson:** the pre-pivot implementation hit ~4K TPS in practice despite higher claimed targets. Pyde now adopts the **"claim 1/3 of measured peak" rule** — under-promise, over-deliver. No external TPS claim without harness evidence.

## Reading Path

This book is the comprehensive technical reference. Different paths for different audiences:

**For a researcher / cryptographer:**
1. Chapter 2 (Architecture Overview)
2. Chapter 6 (Consensus)
3. Chapter 8 (Cryptography)
4. Chapter 9 (MEV Protection)
5. Companion: `docs/WHITEPAPER.md`

**For an implementer / contributor:**
1. Chapter 2 (Architecture)
2. Chapter 3 (Virtual Machine)
3. Chapter 4 (State Model)
4. Chapter 11 (Account Model)
5. Chapter 12 (Networking)
6. Companion: `docs/DESIGN.md`

**For a validator operator:**
1. Chapter 6 (Consensus)
2. Chapter 7 (State Sync & Chain Halt)
3. Chapter 16 (Security & Threat Model)
4. Companions: `docs/VALIDATOR_LIFECYCLE.md`, `docs/SLASHING.md`, `docs/CHAIN_HALT.md`

**For an investor / decision-maker:**
1. This Introduction
2. Chapter 14 (Tokenomics)
3. Chapter 19 (Launch Strategy)
4. Companion: `docs/PITCH_DECK.md`

**For someone doing security review / audit:**
1. Chapter 16 (Security & Threat Model)
2. Chapter 6 (Consensus safety arguments)
3. Chapter 8 (Cryptography)
4. Companions: `docs/THREAT_MODEL.md`, `docs/FAILURE_SCENARIOS.md`

## License

Apache-2.0 — see `LICENSE` at the repository root.

## Status

**Living document.** Updated as the design evolves.
