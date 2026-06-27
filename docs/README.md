# Pyde Documentation

This directory contains the canonical documents describing Pyde — a post-quantum Layer 1 blockchain with native MEV protection and DAG-based consensus.

These documents form the source-of-truth for the protocol design as of the May 2026 pivot from in-house HotStuff to a Mysticeti-style DAG consensus.

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

## Pivot Context (May 2026)

Pyde underwent a major architectural pivot:
- **Removed:** in-house HotStuff BFT consensus (400ms slots, persistent wedges)
- **Replaced with:** Mysticeti-style DAG consensus (per-round commits, ~390ms median finality)
- **Workspace:** consensus, mempool, networking moved from active `engine/` to `archive/`; current focus is execution layer + new consensus rebuild
- **Approach:** design-first → publish for peer review → build slowly → testnet → audit → mainnet

## Honest Status

This documentation reflects **designed architecture**, not shipped implementation.

| Aspect | Status |
|---|---|
| Architecture design | ✅ Complete |
| Execution layer (WASM via wasmtime) | 🟡 Foundation in place, integration in progress |
| State layer (JMT) | 🟡 In place, needs hybrid hashing (Blake3 + Poseidon2) |
| Consensus (Mysticeti DAG) | 🔴 Not yet implemented (post-pivot rebuild) |
| Threshold crypto | 🔴 Research-grade (post-quantum threshold is bleeding edge) |
| Network protocol | 🟡 Existing in archive, needs libp2p + QUIC migration |
| Performance harness | 🔴 Not yet built |

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
