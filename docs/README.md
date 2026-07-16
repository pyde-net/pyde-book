# Pyde Documentation

This directory contains the canonical documents describing Pyde — a post-quantum Layer 1 blockchain with native MEV protection and DAG-based consensus.

These documents form the source-of-truth for the protocol design as of the 2026 pivot from in-house HotStuff to a Mysticeti-style DAG consensus.

## Document Index

### Primary Documents

| Document | Purpose | Audience |
|---|---|---|
| [WHITEPAPER.md](./WHITEPAPER.md) | High-level technical paper | Researchers, investors, validators |
| [DESIGN.md](./DESIGN.md) | Comprehensive technical design | Implementers, contributors, auditors |

### Threat Model & Operations

| Document | Purpose |
|---|---|
| [THREAT_MODEL.md](./THREAT_MODEL.md) | ~50 threats across 7 layers with mitigations |
| [FAILURE_SCENARIOS.md](./FAILURE_SCENARIOS.md) | 12 operational failure scenarios + runbook structure |
| [CHAIN_HALT.md](./CHAIN_HALT.md) | Halt detection + recovery procedures |

### Protocol Specifications

| Document | Purpose |
|---|---|
| [SLASHING.md](./SLASHING.md) | Slashing rules catalog |
| [VALIDATOR_LIFECYCLE.md](./VALIDATOR_LIFECYCLE.md) | Validator state machine, operations |
| [STATE_SYNC.md](./STATE_SYNC.md) | Snapshot sync, light client, pruning |
| [NETWORK_PROTOCOL.md](./NETWORK_PROTOCOL.md) | Transport, gossip, DoS, peer discovery |
| [PERFORMANCE_HARNESS.md](./PERFORMANCE_HARNESS.md) | Testing infrastructure design |

### Economics

| Document | Purpose |
|---|---|
| [TOKENOMICS.md](./TOKENOMICS.md) | PYDE supply, distribution, emission, staking yield |

## Pivot Context (2026)

Pyde underwent a major architectural pivot:
- **Removed:** in-house HotStuff BFT consensus (400ms slots, persistent wedges)
- **Replaced with:** Mysticeti-style DAG consensus (per-round commits, ~390ms median finality)
- **Workspace:** consensus, mempool, networking moved from active `engine/` to `archive/`; current focus is execution layer + new consensus rebuild
- **Approach:** design-first → publish for peer review → build slowly → testnet → audit → mainnet

## Honest Status

The post-pivot architecture is now substantially implemented. Devnet runs a multi-validator Mysticeti committee with WASM execution, the keyless commit-reveal private mempool, and state-sync. Credible public performance numbers are still gated on the multi-region harness.

| Aspect | Status |
|---|---|
| Architecture design | ✅ Complete |
| WASM execution (wasmtime + Cranelift AOT, Block-STM) | 🟢 Live; pooled `Engine`, Host Function ABI v1.0 frozen, Block-STM wired into the commit walk |
| State (JMT + hybrid Blake3 / Poseidon2 dual root) | 🟢 Wired; `StateRoot { blake3, poseidon2 }` end-to-end |
| Consensus (Mysticeti DAG) | 🟡 Vertex / anchor / beacon / committee / wave commit live; multi-validator genesis + state-sync replay shipped; soak-hardening edge cases in flight |
| Private mempool (keyless commit-reveal) | 🟢 Commit (0x11) / Reveal (0x12) lane; Blake3 commitment + FALCON, no committee key. Inner txs execute in DAG commit order. A one-shot ciphertext lane is v2+ research (Chapter 20) |
| Network protocol (libp2p + QUIC + Gossipsub) | 🟢 Migrated; layered discovery, peer scoring, sentry-friendly topology |
| Performance harness | 🟡 Local soak driver + multi-validator cluster CLI live; multi-region rig + chaos scenarios not yet built |
| SDKs (TypeScript + Rust) | 🟡 `pyde-ts-sdk` 0.1.0 staged; Rust SDK in progress |

Mainnet ships when the work above is complete and external audit passes. No public schedule.

## Reading Order

1. **WHITEPAPER.md** — start here for high-level pitch and architecture
2. **DESIGN.md** — deep technical dive
3. **THREAT_MODEL.md** — what we defend against
4. **FAILURE_SCENARIOS.md** — what happens when things go wrong
5. Spec docs (SLASHING, VALIDATOR_LIFECYCLE, etc.) — as needed

## License

See [LICENSE](../LICENSE) at repository root.

## Status

**Living documents.** Updated as the design evolves.
