# The Pyde Book

<p align="center">
  <img src="./assets/logo.png" width="120" alt="Pyde logo" />
</p>

<p align="center">
  <strong>Distributed ledger infrastructure for a connected global economy.</strong>
</p>

The Pyde Book is the technical reference for Pyde, a distributed ledger architecture designed to represent, verify, and coordinate global economic state across sovereign networks, open settlement infrastructure, and permissionless applications.

Pyde is organized into three operating environments:

| Tier   | Economic environment          | Primary role                                                                                |
| ------ | ----------------------------- | ------------------------------------------------------------------------------------------- |
| Tier 1 | Sovereign economic networks   | Domestic economic state and regulated institutional applications                            |
| Tier 2 | Open interlinking settlement  | Cross domain settlement, foreign exchange observations, obligations, positions, and netting |
| Tier 3 | Permissionless public network | Open applications, smart contracts, digital assets, and public economic activity            |

The three tiers share a common distributed ledger foundation while keeping authority boundaries explicit. A sovereign network is not required to behave like a public network, and the settlement layer does not become the monetary authority of the jurisdictions it connects.

## How to read this book

Start with [What is Pyde](src/preface/what-is-pyde.md), then read [Why Pyde](src/preface/why-pyde.md) and [Chapter 1: Introduction](src/chapters/01-introduction.md).

[Chapter 2: Architecture Overview](src/chapters/02-architecture-overview.md) defines the current architecture. The following chapters explain the protocol foundation, economic mechanics, security model, developer infrastructure, and deployment requirements.

The book is intentionally descriptive. It explains the system Pyde is designed to provide, the technical machinery beneath that architecture, and the distinction between implemented functionality and architectural components that still require deployment or validation.

## Current implementation position

The current public development environment is Tier 3.

Tier 1 and Tier 2 are architectural designs rather than deployed production networks. Their authority models, settlement mechanisms, institutional integrations, operational requirements, security assumptions, and jurisdiction specific deployments require additional engineering, independent security review, and institutional work.

The Tier 3 engineering work provides the current technical foundation for the broader architecture.

## Core technical areas

The book covers:

- WebAssembly execution through Wasmtime and Cranelift
- deterministic state transitions and parallel execution
- Jellyfish Merkle state
- Mysticeti style DAG consensus
- post quantum cryptographic primitives used by the protocol
- state synchronization and recovery
- accounts and authorization
- networking
- the Otigen developer toolchain
- protocol security and threat modeling
- settlement, obligations, positions, and netting
- PYDE validator alignment and public network economics

## Historical design material

Earlier Pyde designs are retained where they are useful for understanding architectural decisions.

The HotStuff era, original Otigen language era, and superseded cross network designs are historical records, not the current definition of Pyde.

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
