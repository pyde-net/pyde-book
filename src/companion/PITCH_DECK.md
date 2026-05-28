# Pyde — Pitch Deck

## The Problem

Every major Layer 1 in production today has at least one structural problem the rest of the decade will require fixing:

| | Post-Quantum Secure | MEV-Free | Sub-second Final | Commodity Decentralized |
|---|---|---|---|---|
| Ethereum | ❌ secp256k1/BLS | ❌ multi-billion $ extracted | ❌ ~12s | ⚠️ Tier-2 chains fragment |
| Solana | ❌ Ed25519 | ❌ proposer extracts | ✅ ~400ms | ❌ 12+cores/256GB+ |
| Bitcoin | ❌ secp256k1 | ✅ (slow blocks) | ❌ 60+ min | ✅ |
| Aptos / Sui | ❌ BLS12-381 | ⚠️ partial | ✅ ~400ms | ⚠️ medium |

**No chain in production today is post-quantum + MEV-resistant + sub-second + commodity-validated.**

The migration to PQ cryptography on existing chains is a multi-year coordinated upgrade — trillions of dollars of value, entrenched wallets, entrenched contracts. The chain built greenfield with PQ as default ships those properties at genesis without retrofitting.

## The Solution: Pyde

A Layer 1 chain built from scratch with all four properties as defaults:

1. **Post-Quantum cryptography by default**
   - FALCON-512 signatures (NIST-standardized) for every transaction
   - Kyber-768 threshold encryption for the mempool
   - Poseidon2 hashing where ZK matters

2. **MEV resistance by structure, not policy**
   - Threshold-encrypted mempool: content invisible until ordered
   - Commit-before-reveal: ordering finalized before decryption
   - DAG consensus: no single proposer to exploit

3. **Sub-second finality via DAG consensus**
   - Mysticeti-style DAG (Sui's production consensus)
   - ~500ms median finality target
   - No view changes (eliminates HotStuff's bug class)

4. **Commodity hardware decentralization**
   - Full nodes / RPC: 8c/16GB/100Mbps (laptop-class)
   - Equal-power voting within the committee
   - Operator identity binding (no Sybil amplification)

## Differentiation

| | Ethereum | Solana | Sui | Pyde |
|---|---|---|---|---|
| Post-Quantum | Migration path 5+ years out | No plan | No plan | **Default at genesis** |
| MEV | Auction (PBS) | Extracted by proposers | Some via Mysticeti | **Structurally impossible** |
| Finality | 12-15s | 400ms | 390ms | **~500ms** |
| Commodity validator | Possible | No (12+ cores) | No (datacenter) | **Yes (any validator awaiting committee selection)** |
| Smart contract language | Solidity | Rust/Anchor | Move | **Any wasm32-target language** (Rust/AS/Go/C) with Pyde safety attributes preserved |
| Account abstraction | Retrofit (ERC-4337) | None native | Limited | **Native (v2)** |
| Cross-chain | Bridges (hacked $3B+) | Bridges | Bridges | **Permissionless parachain layer (v2)** |
| ZK readiness | Retrofit ongoing | Limited | Limited | **Architecture ready (v2)** |

## Architecture Highlights

- **Consensus:** Mysticeti DAG with 128-validator committee, FALCON sigs, Kyber threshold encryption integrated at the order boundary
- **Execution:** WebAssembly via wasmtime, with Cranelift AOT and hybrid Block-STM + access list scheduling
- **State:** Jellyfish Merkle Tree (JMT) with dual Blake3 + Poseidon2 root commitment
- **Language:** Pyde safety attributes (reentrancy off by default, checked arithmetic, typed storage, no tx.origin, compile-time access lists) preserved as language-native attributes across Rust, AssemblyScript, Go, C
- **Networking:** libp2p + QUIC + Gossipsub
- **Cross-chain:** Permissionless parachain layer (post-mainnet) — open spec, multiple implementations, on-chain rules + slashing

## Honest Status

**Design: complete.** 27+ design documents covering every subsystem.

**Implementation: in progress.**
- Execution layer (WASM via wasmtime, JMT with dual-hash and PIP-2 clustering): functional, needs extensions
- Cryptography (FALCON, Kyber base): in place; threshold variant in research
- Consensus (Mysticeti DAG): rebuild post-pivot
- Network (libp2p migration): planned

**Mainnet ships when the work above is complete and the external audit passes.** No public schedule.

## Performance Targets (Honest)

Validated by multi-region production-realistic harness (mandatory before any external claim). Pyde publishes **no forward throughput number** — the v1 throughput target is established only once the harness measures it. Latency targets, by contrast, are concrete:

| Mode | v1 | v2 | Aspirational |
|---|---|---|---|
| Plaintext throughput (commodity) | awaiting harness | awaiting harness | awaiting harness |
| Encrypted throughput (commodity) | awaiting harness | awaiting harness | awaiting harness |
| Median finality | ~500ms | ~400ms | ~300ms |

Aspirational throughput requires GPU acceleration or batch-decryption research advances and carries no concrete number. Pyde will publish only numbers validated by the production-realistic harness, not microbenchmarks.

## The Pivot Story

Pyde's earlier in-house HotStuff consensus suffered persistent wedges, stalls, and view-change cascades at 400ms slot timing. After patching accumulated technical debt without resolving the underlying protocol design problems, the team made a clean break in May 2026:

- **Removed:** consensus, mempool, networking from active workspace (archived as `archive/`)
- **Replaced with:** Mysticeti-style DAG consensus rebuild
- **Refocused:** execution layer + cryptography first, consensus rebuild on solid foundation

This is the chain built deliberately, not the chain rushed to mainnet. The pivot reflects an explicit commitment to safety over speed-to-market.

## The Ask

Pyde is currently a **solo project**, with vision-first development → publish → community → stabilize → audit → mainnet.

Looking for:
1. **Cryptography collaborators** — particularly post-quantum threshold encryption (the hardest piece)
2. **Consensus reviewers** — Mysticeti DAG specialists for safety/liveness analysis
3. **Audit budget** — $500K–$1M projected for v1 mainnet audit
4. **Grant funding** — Ethereum Foundation, NIST, Polkadot for threshold PQ research
5. **Early ecosystem builders** — wallets, block explorers, dApp developers willing to build on a pre-mainnet testnet

## Contact

- Website: [pyde.network](https://pyde.network)
- Repository: [github.com/pyde-net](https://github.com/pyde-net)
- X: [@pydenet](https://x.com/pydenet)
- Telegram: [t.me/pydenet](https://t.me/pydenet)
- Email: [info@pyde.network](mailto:info@pyde.network)
- Documents: see the [Companion Specifications](../SUMMARY.md) section of The Pyde Book (Whitepaper, Threat Model, Performance Harness, Parachain Design, Brand, and more)

---

**This is not vaporware. This is the architecture of the chain that exists for the next decade.**

**Version 0.1**
