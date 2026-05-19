# The Pyde Book

The comprehensive technical reference for **Pyde** — a post-quantum
Layer 1 blockchain with structural MEV protection, sub-second finality
via Mysticeti DAG consensus, and a smart-contract language (Otigen)
designed for safety-by-default.

> **Honest status.** This book describes the *designed* architecture —
> implementation is in flight. Mainnet ships when the work in Chapter 19
> is complete and the external audit passes. No public schedule.

## Reading the Book

The book is organized into chapters, plus a companion `docs/` directory
with full specifications for the parts the chapters summarize.

| # | Chapter | What it covers |
|---|---------|----------------|
| 1 | [Introduction](src/chapters/01-introduction.md) | Vision, May 2026 pivot, honest status |
| 2 | [Architecture Overview](src/chapters/02-architecture-overview.md) | High-level component map, worker/primary split |
| 3 | [Virtual Machine](src/chapters/03-virtual-machine.md) | PVM register-based ISA, 62 opcodes, AOT compiler |
| 4 | [State Model](src/chapters/04-state-model.md) | JMT (radix-16), hybrid Blake3 + Poseidon2 hashing |
| 5 | [Otigen Language](src/chapters/05-otigen-language.md) | Smart-contract language, compile-time access lists |
| 6 | [Consensus (Mysticeti DAG)](src/chapters/06-consensus.md) | DAG vertices, anchor selection, wave commits |
| 7 | [State Sync & Chain Halt](src/chapters/07-state-sync.md) | Snapshot sync, halt types, recovery procedures |
| 8 | [Cryptography](src/chapters/08-cryptography.md) | FALCON-512, Kyber-768, Blake3, Poseidon2, threshold, DKG |
| 9 | [MEV Protection](src/chapters/09-mev-protection.md) | Commit-before-reveal DAG, optional encryption |
| 10 | [Gas and Fee Model](src/chapters/10-gas-and-fee-model.md) | EIP-1559, no tips, 70/20/10 split |
| 11 | [Account Model](src/chapters/11-account-model.md) | 32-byte addresses, 16-slot nonce window, multisig |
| 12 | [Networking](src/chapters/12-networking.md) | libp2p + QUIC, layered discovery (no DHT), sentry pattern |
| 13 | [Cross-Chain](src/chapters/13-cross-chain.md) | Parachain operator layer (v2), `cross_call!` |
| 14 | [Tokenomics](src/chapters/14-tokenomics.md) | PYDE supply, two-tier staking, reward pool |
| 15 | [Governance](src/chapters/15-governance.md) | PIPs + on-chain multisig, voluntary upgrade |
| 16 | [Security & Threat Model](src/chapters/16-security.md) | Attack surface, BFT proofs, mitigations |
| 17 | [Developer Tools](src/chapters/17-developer-tools.md) | `otic`, `pyde-dev`, JSON-RPC, SDKs |
| 18 | [Protocol Upgrades](src/chapters/18-protocol-upgrades.md) | Voluntary validator upgrade, hard/soft fork |
| 19 | [Launch Strategy](src/chapters/19-launch-strategy.md) | 10-phase mainnet plan, audits, testnet |
| 20 | [Appendix](src/chapters/20-appendix.md) | Glossary, constants, post-mainnet roadmap |

Pivot reference: [MIGRATION_NOTES.md](src/MIGRATION_NOTES.md) — what
changed in the May 2026 HotStuff → Mysticeti DAG rewrite.

## Companion Specifications (`docs/`)

The chapters cross-link to these stand-alone specs:

| File | Purpose |
|------|---------|
| [WHITEPAPER.md](docs/WHITEPAPER.md) | High-level technical paper |
| [DESIGN.md](docs/DESIGN.md) | Full implementation-level design |
| [PITCH_DECK.md](docs/PITCH_DECK.md) | Short-form pitch with differentiation table |
| [TOKENOMICS.md](docs/TOKENOMICS.md) | Supply schedule, fee distribution math |
| [SLASHING.md](docs/SLASHING.md) | 10-offense slashing catalog with evidence flow |
| [VALIDATOR_LIFECYCLE.md](docs/VALIDATOR_LIFECYCLE.md) | Register / unbond / jail / unjail state machine |
| [STATE_SYNC.md](docs/STATE_SYNC.md) | Snapshot manifest format, chunk download, verification |
| [CHAIN_HALT.md](docs/CHAIN_HALT.md) | Three halt types, recovery paths, drill plan |
| [NETWORK_PROTOCOL.md](docs/NETWORK_PROTOCOL.md) | QUIC + libp2p, discovery, DoS, sentry pattern |
| [PERFORMANCE_HARNESS.md](docs/PERFORMANCE_HARNESS.md) | Multi-region test infra, workload generators, "claim 1/3 of peak" rule |
| [THREAT_MODEL.md](docs/THREAT_MODEL.md) | ~50 threats across 7 layers, mitigation mapping |
| [FAILURE_SCENARIOS.md](docs/FAILURE_SCENARIOS.md) | 12 operational scenarios with runbooks |

## Building Locally

The book is rendered with [mdBook](https://rust-lang.github.io/mdBook/).

```bash
# Install mdbook
cargo install mdbook

# Build to ./book/
mdbook build

# Serve locally with live reload
mdbook serve --open
```

The `docs/` markdown files are plain markdown — readable as-is or via any
viewer. They are **not** part of the mdBook output; they live alongside
it as authoritative specs.

## Status of the Project

| Area | State |
|------|-------|
| Architecture design | Complete |
| PVM + Otigen execution | Functional; extensions in flight |
| State (JMT) | In place; hybrid hashing wiring in flight |
| Mysticeti DAG consensus | Rebuild in flight post-pivot |
| Threshold cryptography (PQ) | Research-grade — bleeding edge |
| Network protocol | Existing; libp2p + QUIC migration in flight |
| Performance harness | Not yet built (mandatory before TPS claims) |

No external performance number is published without harness evidence
under the **"claim 1/3 of measured peak"** rule.

## Contributing

This book is a living document. Substantive changes to the protocol go
through a PIP (see Chapter 15); changes to the book itself go through a
normal PR.

## License

This book is licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
