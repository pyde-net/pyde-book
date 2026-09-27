# The Pyde Book

<p align="center">
  <img src="./assets/logo.png" width="120" alt="Pyde logo" />
</p>

<p align="center">
  <strong>Distributed ledger infrastructure for a connected global economy.</strong>
</p>

The Pyde Book is the technical reference for Pyde, a distributed ledger architecture designed to represent, verify, and coordinate global economic state across sovereign networks, open settlement infrastructure, and permissionless applications.

Pyde is built around one protocol foundation with three operating environments:

| Tier | Economic environment | Primary role |
|---|---|---|
| Tier 1 | Sovereign economic networks | Domestic economic state and regulated institutional applications |
| Tier 2 | Open interlinking settlement | Cross domain settlement, FX observations, obligations, positions, and netting |
| Tier 3 | Permissionless public network | Open applications, smart contracts, digital assets, and public economic activity |

The three tiers share core protocol technology while keeping authority boundaries explicit. A sovereign network is not required to behave like a public network. The settlement layer does not become the monetary authority of the jurisdictions it connects.

## How to read this book

Start with [What is Pyde](src/preface/what-is-pyde.md), then read [Why Pyde](src/preface/why-pyde.md) and [Chapter 1: Introduction](src/chapters/01-introduction.md).

The architectural definition is in [Chapter 2: Architecture Overview](src/chapters/02-architecture-overview.md). From there, the book moves into the technical foundation: execution, state, tooling, consensus, synchronization, cryptography, accounts, and networking.

[Chapter 13: Cross Chain and Settlement](src/chapters/13-cross-chain.md) contains the current settlement and external coordination material. [Chapter 14: Economics](src/chapters/14-tokenomics.md) contains the current PYDE and validator economics and is being aligned with the new three tier model.

The existing technical chapters describe the protocol machinery beneath the economic architecture. They are not a separate product definition.

## Current implementation position

The current public development environment is Tier 3.

Tier 1 and Tier 2 are architectural designs rather than deployed production networks. Their authority models, settlement mechanisms, institutional integration, and operating rules require independent engineering, security review, regulatory work, and institutional deployment before production use.

The Tier 3 engineering work remains the technical foundation on which the broader architecture builds.

The project publishes performance only when measured under the conditions stated with the result. Architectural targets are not presented as unconditional production guarantees.

## Core technical areas

The book covers:

- WebAssembly execution through Wasmtime and Cranelift
- deterministic state transitions and parallel execution
- Jellyfish Merkle state
- Mysticeti style DAG consensus
- FALCON 512 and the protocol cryptographic stack
- state synchronization and recovery
- accounts and authorization
- networking
- the Otigen developer toolchain
- protocol security and threat modeling
- settlement, obligations, positions, and netting
- PYDE validator alignment and protocol economics

## Historical design material

Earlier Pyde designs are retained where they are useful for understanding architectural decisions.

The HotStuff era, original Otigen language era, and other superseded designs remain under [Historical Design References](src/SUMMARY.md). They are historical records, not the current definition of Pyde.

## Building the book

The book is rendered with [mdBook](https://rust-lang.github.io/mdBook/).

```sh
cargo install mdbook
mdbook serve --open
```

The `src/companion/` directory contains detailed specifications referenced by the main chapters. Companion documents are part of the technical record, but the main chapters and current whitepaper define the current architecture.

## License

Pyde is licensed under [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0/). The book content is licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

## Status

**Living document.** Updated as the architecture and implementation evolve.
