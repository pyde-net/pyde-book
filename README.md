<p align="center">
  <img src="./assets/logo.png" width="120" alt="Pyde logo" />
</p>

<h1 align="center">The Pyde Book</h1>

<p align="center">
  <em>Post-quantum · MEV-resistant · Sub-second · Commodity-decentralized</em>
</p>

---

The comprehensive technical reference for **Pyde** — a post-quantum
Layer 1 blockchain with structural MEV protection, sub-second finality
via Mysticeti DAG consensus, and a WebAssembly execution layer (wasmtime)
designed for safety-by-default.

> **Honest status.** This book describes the *designed* architecture —
> implementation is in flight. Mainnet ships when the work in Chapter 19
> is complete and the external audit passes. No public schedule.

## Reading the Book

The book is organized into chapters, plus a companion `docs/` directory
with full specifications for the parts the chapters summarize.

| # | Chapter | What it covers |
|---|---------|----------------|
| 1 | [Introduction](src/chapters/01-introduction.md) | Vision, 2026 pivot, honest status |
| 2 | [Architecture Overview](src/chapters/02-architecture-overview.md) | High-level component map, worker/primary split |
| 3 | [Virtual Machine](src/chapters/03-virtual-machine.md) | wasmtime runtime, host function ABI, Cranelift AOT |
| 4 | [State Model](src/chapters/04-state-model.md) | JMT (radix-16), hybrid Blake3 + Poseidon2 hashing |
| 5 | [Otigen Toolchain](src/chapters/05-otigen-toolchain.md) | Developer toolchain: scaffolding, build, deploy, wallet |
| 6 | [Consensus (Mysticeti DAG)](src/chapters/06-consensus.md) | DAG vertices, anchor selection, commit ceremony |
| 7 | [State Sync & Chain Halt](src/chapters/07-state-sync.md) | Snapshot sync, halt types, recovery procedures |
| 8 | [Cryptography](src/chapters/08-cryptography.md) | FALCON-512, Kyber-768, Blake3, Poseidon2, lattice VRF |
| 9 | [MEV Protection](src/chapters/09-mev-protection.md) | Keyless commit-reveal private mempool, structural ordering |
| 10 | [Gas and Fee Model](src/chapters/10-gas-and-fee-model.md) | EIP-1559, no tips, 70/20/10 split |
| 11 | [Account Model](src/chapters/11-account-model.md) | 32-byte addresses, 16-slot nonce window, multisig |
| 12 | [Networking](src/chapters/12-networking.md) | libp2p + QUIC, layered discovery (no DHT), sentry pattern |
| 13 | [Cross-Chain](src/chapters/13-cross-chain.md) | Parachain operator layer (v2), `cross_call!` |
| 14 | [Tokenomics](src/chapters/14-tokenomics.md) | PYDE supply, single-tier staking (10K PYDE min), reward pool |
| 15 | [Governance](src/chapters/15-governance.md) | PIPs + on-chain multisig, voluntary upgrade |
| 16 | [Security & Threat Model](src/chapters/16-security.md) | Attack surface, BFT proofs, mitigations |
| 17 | [Developer Tools](src/chapters/17-developer-tools.md) | `otigen` toolchain, JSON-RPC, SDKs |
| 18 | [Protocol Upgrades](src/chapters/18-protocol-upgrades.md) | Voluntary validator upgrade, hard/soft fork |
| 19 | [Launch Strategy](src/chapters/19-launch-strategy.md) | 10-phase mainnet plan, audits, testnet |
| 20 | [Future Direction](src/chapters/20-future-direction.md) | v2+ research: Threshold-LWE one-shot mempool, ZK validity proofs, parachains |
| 21 | [Appendix](src/chapters/21-appendix.md) | Glossary, constants, post-mainnet plan |

Pivot reference: [MIGRATION_NOTES.md](src/MIGRATION_NOTES.md) — what
changed in the 2026 HotStuff → Mysticeti DAG rewrite.

## Companion Specifications (`src/companion/`)

The chapters cross-link to these stand-alone specs:

| File | Purpose |
|------|---------|
| [WHITEPAPER.md](src/companion/WHITEPAPER.md) | High-level technical paper |
| [DESIGN.md](src/companion/DESIGN.md) | Full implementation-level design |
| [TOKENOMICS.md](src/companion/TOKENOMICS.md) | Supply schedule, fee distribution math |
| [SLASHING.md](src/companion/SLASHING.md) | 10-offense slashing catalog with evidence flow |
| [VALIDATOR_LIFECYCLE.md](src/companion/VALIDATOR_LIFECYCLE.md) | Register / unbond / jail / unjail state machine |
| [STATE_SYNC.md](src/companion/STATE_SYNC.md) | Snapshot manifest format, chunk download, verification |
| [CHAIN_HALT.md](src/companion/CHAIN_HALT.md) | Three halt types, recovery paths, drill plan |
| [NETWORK_PROTOCOL.md](src/companion/NETWORK_PROTOCOL.md) | QUIC + libp2p, discovery, DoS, sentry pattern |
| [PERFORMANCE_HARNESS.md](src/companion/PERFORMANCE_HARNESS.md) | Multi-region test infra, workload generators, publishing discipline |
| [THREAT_MODEL.md](src/companion/THREAT_MODEL.md) | ~50 threats across 7 layers, mitigation mapping |
| [FAILURE_SCENARIOS.md](src/companion/FAILURE_SCENARIOS.md) | 12 operational scenarios with runbooks |
| [HOST_FN_ABI_SPEC.md](src/companion/HOST_FN_ABI_SPEC.md) | The chain-facing ABI contracts compile against |
| [OTIGEN_BINARY_SPEC.md](src/companion/OTIGEN_BINARY_SPEC.md) | Authoritative spec for the `otigen` toolchain |
| [OTIGEN_TEST_SPEC.md](src/companion/OTIGEN_TEST_SPEC.md) | Test-framework spec (cheats, DSL, expectations, mocking model) |
| [WASM_AUTHOR_GUIDE.md](src/companion/WASM_AUTHOR_GUIDE.md) | Pattern guide for contract authors |
| [PARACHAIN_DESIGN.md](src/companion/PARACHAIN_DESIGN.md) | v2 parachain operator layer |
| [SDK_AUTHOR_GUIDE.md](src/companion/SDK_AUTHOR_GUIDE.md) | Pattern guide for community-language SDK ports |

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

The `src/companion/` markdown files are plain markdown — readable as-is
or via any viewer. They are part of the mdBook output (linked from the
chapters via `../companion/`) and serve as the authoritative
specifications the narrative chapters summarize.

## Status of the Project

| Area | State |
|------|-------|
| Architecture design | Complete (chapters + companion specs frozen-ish; PIP-track for revisions) |
| WASM execution layer (wasmtime) | Functional; substrate macros + typed storage + cross-contract calls shipped |
| State (JMT) | In place; hybrid Blake3 + Poseidon2 hashing wired |
| Devnet binary (`pyde devnet`) | Shipped — one-command local devnet, 10 prefunded accounts |
| Developer toolchain (`otigen`) | Shipped — scaffold / build / test / deploy / inspect / verify / console / wallet; engine-by-default test runtime |
| Mysticeti DAG consensus | Rebuild in flight post-pivot |
| MEV protection (keyless commit-reveal) | Private mempool implemented — Blake3 commitment + FALCON, no committee key |
| Network protocol | Existing; libp2p + QUIC migration in flight |
| Performance harness (multi-region, chain-throughput) | Not yet built (mandatory before TPS claims) |

No external performance number is published without harness evidence —
publish only what the harness measures, never lab extrapolations.

## Contributing

This book is a living document. Substantive changes to the protocol go
through a PIP (see Chapter 15); changes to the book itself go through a
normal PR.

## License

This book is licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
