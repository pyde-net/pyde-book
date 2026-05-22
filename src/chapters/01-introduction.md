# Introduction

## What is Pyde?

Pyde is a Layer 1 blockchain built greenfield to deliver four properties no chain in production combines today:

1. **Post-quantum cryptography by default** — FALCON-512 signatures, Kyber-768 threshold encryption, Poseidon2 hashing
2. **MEV resistance by structure** — threshold-encrypted mempool + commit-before-reveal ordering + DAG consensus eliminates proposer extraction
3. **Sub-second finality** — Mysticeti-style DAG consensus, ~500ms median finality
4. **Commodity decentralization** — modest hardware for validators not currently on the active committee; equal voting power within the active committee

The execution layer is **WebAssembly via wasmtime**, with Cranelift ahead-of-time compilation and a hybrid parallel scheduler combining Solana-style declared access lists with Aptos-style Block-STM speculation. Smart contracts can be authored in **Rust, AssemblyScript, Go (TinyGo), or C/C++** — whatever language the team already uses — and bundled by the `otigen` developer toolchain.

Cross-chain interactions — calling functions on other chains, querying oracles, off-chain compute — happen through a permissionless **parachain layer** (post-mainnet) with operators who stake PYDE and earn gas fees from contracts that call them. No custodial multisigs, no auctioned slots.

## The Pivots

Pyde has gone through two clean pivots that materially changed the architecture. Both are documented honestly in the preface ([The Pivot](../preface/pivot.md)) and supported by full historical design records in [`pivot/`](../pivot/README.md).

- **Consensus pivot** — from an in-house HotStuff variant (whose 400ms tail-latency wedges proved structural rather than tunable) to Mysticeti-style DAG consensus. The HotStuff-era consensus crates are archived; the Mysticeti-based rebuild is in progress.
- **Execution pivot** — from a custom virtual machine (`pyde-vm`), a custom AOT compiler (`pyde-aot`), and a custom language (Otigen) to WebAssembly via wasmtime. The Otigen *name* lives on as the developer toolchain (`otigen`). The original Otigen Book is preserved as a historical artifact.

This book reflects the post-pivot architecture. The work that preceded each pivot is preserved both in code (`archive/`) and in design documentation (`pivot/`).

## Why a New Layer 1?

### The Quantum Problem

Every major Layer 1 in production today — Bitcoin, Ethereum, Solana, Cardano, Polkadot — uses classical cryptography (secp256k1, Ed25519, BLS12-381) vulnerable to Shor's algorithm. NIST's 2024 standardization of FALCON, ML-DSA, and ML-KEM unblocked post-quantum primitives, but retrofitting them into a live chain is a multi-year coordinated migration. **Pyde ships PQ at genesis without retrofitting.**

### The MEV Problem

Maximum Extractable Value has hardened into a multi-billion-dollar tax paid by retail users to validator-builder coalitions. Sandwich attacks, front-running, and proposer extraction are not bugs — they are structural consequences of public mempools and single-proposer block production. **Pyde eliminates the structural conditions** via threshold encryption + commit-before-reveal + DAG consensus (no single proposer to exploit).

### The Decentralization Problem

Chains optimizing for throughput have ended up requiring datacenter-class validator hardware. Chains optimizing for decentralization have ended up with throughput unusable for serious applications. **Pyde scales hardware requirements by role** — commodity for validators awaiting committee selection, modest professional for validators on the active committee at production targets, datacenter only for aspirational TPS levels.

## What's New (Post-Pivot)

- **Mysticeti DAG consensus** replaces HotStuff. No view changes, no single proposer, sub-second commit latency targeted (implementation in progress)
- **WebAssembly execution** via wasmtime, with Cranelift AOT. Smart contracts written in Rust, AssemblyScript, Go, or C/C++ — same language ecosystem authors already work in
- **Worker / Primary split** (Narwhal pattern) for data dissemination separate from consensus
- **Hybrid execution scheduler** — static access lists for known patterns, Block-STM for dynamic
- **JMT state tree** (Jellyfish Merkle Tree, radix-16) replaces fixed-depth SMT — with dual Blake3 + Poseidon2 roots so standard light clients and future ZK light clients verify against the same tree
- **PIP-2 clustered slot keys + PIP-3 prefetch + PIP-4 write-back cache** — three-layer state performance stack
- **Encryption opt-in** per-tx — MEV protection where needed, no overhead where not
- **`otigen` developer toolchain** — zero-extra-code authoring: write contract logic + `otigen.toml`, the tool handles everything else
- **Honest performance targets** — 10-30K TPS realistic v1, validated by multi-region performance harness
- **Phased mainnet plan** — external audit + incentivized testnet before launch (see Roadmap)

## Honest Status

This book describes **designed architecture**, with implementation in various stages:

| Component | Status |
|---|---|
| Architecture design | Complete |
| WASM execution layer (wasmtime + Cranelift) | Design locked 2026-05-21; wasmtime integration next |
| State layer (JMT, dual-hash, PIP-2 clustering) | Single-hash JMT in place; PIP-2/3/4 + dual-hash in progress |
| Mysticeti DAG consensus | Rebuild in progress post-pivot |
| Post-quantum cryptography (`pyde-crypto`) | Functional; threshold-decryption path is research-grade |
| Network protocol (libp2p + QUIC + Gossipsub) | In place; layered peer discovery (no DHT) in flight |
| `otigen` developer toolchain (WASM-era) | Specification complete; scaffold in progress |
| Parachain framework | Designed; implementation deferred to a later phase |
| Performance harness | Not yet built (mandatory before any TPS claim) |

**Mainnet ships when the implementation is complete, audited, and validated by an incentivized testnet** — no public schedule. See the [Roadmap](../roadmap.md) for the sequenced plan.

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
1. [Chapter 2: Architecture Overview](./02-architecture-overview.md)
2. [Chapter 6: Consensus (Mysticeti DAG)](./06-consensus.md)
3. [Chapter 8: Cryptography](./08-cryptography.md)
4. [Chapter 9: MEV Protection](./09-mev-protection.md)
5. Companion: [Whitepaper](../companion/WHITEPAPER.md)

**For an implementer / contributor:**
1. [Chapter 2: Architecture Overview](./02-architecture-overview.md)
2. [Chapter 3: Execution Layer (WASM)](./03-virtual-machine.md)
3. [Chapter 4: State Model](./04-state-model.md)
4. [Chapter 5: Otigen Toolchain](./05-otigen-toolchain.md)
5. [Chapter 11: Account Model](./11-account-model.md)
6. [Chapter 12: Networking](./12-networking.md)
7. Companion: [Architecture (Design Doc)](../companion/DESIGN.md)
8. Preface: [The Pivot](../preface/pivot.md) for context on architectural choices

**For a validator operator:**
1. [Chapter 6: Consensus](./06-consensus.md)
2. [Chapter 7: State Sync & Chain Halt](./07-state-sync.md)
3. [Chapter 16: Security & Threat Model](./16-security.md)
4. Companions: [Validator Lifecycle](../companion/VALIDATOR_LIFECYCLE.md), [Slashing](../companion/SLASHING.md), [Chain Halt & Recovery](../companion/CHAIN_HALT.md)

**For an investor / decision-maker:**
1. This Introduction
2. [Chapter 14: Tokenomics](./14-tokenomics.md)
3. [Chapter 19: Launch Strategy](./19-launch-strategy.md)
4. Companion: [Pitch Deck](../companion/PITCH_DECK.md), [Tokenomics Detail](../companion/TOKENOMICS.md)

**For someone doing security review / audit:**
1. [Chapter 16: Security & Threat Model](./16-security.md)
2. [Chapter 6: Consensus (safety arguments)](./06-consensus.md)
3. [Chapter 8: Cryptography](./08-cryptography.md)
4. Companions: [Threat Model](../companion/THREAT_MODEL.md), [Failure Scenarios](../companion/FAILURE_SCENARIOS.md), [Network Protocol](../companion/NETWORK_PROTOCOL.md), [Performance Harness](../companion/PERFORMANCE_HARNESS.md)

## License

Pyde is licensed under [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0). The full text lives in `LICENSE` at the root of each Pyde repository. The book content is licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

## Status

**Living document.** Updated as the design evolves.
