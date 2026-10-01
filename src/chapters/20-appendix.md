# Chapter 20: Appendix

This appendix collects terminology, implementation boundaries, and reference material that would otherwise interrupt the main architecture chapters.

## A. Core Terminology

| Term                  | Meaning                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DLT                   | Distributed ledger technology used to maintain shared verifiable state across independent participants                                                                                |
| Tier 1                | Sovereign consortium network for domestic economic state and regulated institutional applications                                                                                     |
| Tier 2                | Open interlinking settlement infrastructure for cross domain coordination                                                                                                             |
| Tier 3                | Permissionless public network for applications, smart contracts, digital assets, and public economic activity                                                                         |
| Global economic state | The programmable state of balances, ownership, authorization, identities, obligations, licenses, positions, regulatory conditions, and contracts that make economic activity possible |
| Settlement pool       | An authorized pool of sovereign currency held inside a participating Tier 1 network for cross border settlement                                                                       |
| Obligation            | A recorded statement of economic liability between participating domains                                                                                                              |
| Position              | Net economic exposure after relevant obligations are considered                                                                                                                       |
| Netting               | Reduction of gross obligations by offsetting positive and negative positions                                                                                                          |
| Settlement layer      | Tier 2 infrastructure coordinating cross domain settlement and related shared state                                                                                                   |
| Protocol treasury     | Network controlled economic state used under the applicable governance and authorization rules                                                                                        |
| PYDE                  | Native public protocol asset used by Tier 3 for network level functions such as execution fees and validator alignment                                                                |

## B. Current Implementation Boundary

The current public development environment is Tier 3.

Tier 1 and Tier 2 are architectural designs. They should not be described as deployed sovereign production infrastructure unless a specific deployment exists and has been independently validated.

## C. Technical Foundation

The current technical reference includes:

- WebAssembly execution;
- Wasmtime and Cranelift AOT compilation;
- parallel execution with deterministic state application;
- Jellyfish Merkle state;
- Mysticeti style DAG consensus;
- FALCON 512 signatures;
- Blake3 and Poseidon2 hashing;
- authenticated networking and synchronization;
- account authorization;
- Otigen developer tooling.

## D. Transaction and Execution Vocabulary

The public Tier 3 implementation uses waves as the unit of committed transaction execution.

Gas measures execution resource consumption. The state root commits to the canonical resulting state.

The exact transaction tags, host function signatures, storage schema, and consensus wire format belong to the low level companion specifications and current code.

## E. Host Function Surface

The current execution model exposes host functions for:

- storage reads and writes;
- balances and transfers;
- transaction context;
- events;
- hashing;
- signature verification;
- contract to contract calls;
- gas accounting.

Any host capability that is restricted to a network profile should be treated as profile specific rather than assumed to be available in every Pyde environment.

## F. Performance Discipline

A performance claim should include the workload and conditions under which it was measured.

Important variables include:

- validator hardware;
- network topology;
- transaction workload;
- state size;
- duration;
- geographic distribution;
- software version.

Theoretical limits and isolated microbenchmarks are not production guarantees.

## G. Historical Material

Superseded architecture is retained under the Pivot section for traceability.

This includes earlier consensus designs, the original Otigen language direction, historical benchmarks, and other designs that were replaced as Pyde evolved.

## H. Source of Truth

The current economic architecture is defined by the current Pyde whitepaper and the architecture chapters of this book.

Low level implementation behavior is defined by the current codebase and its corresponding companion specifications.

Where a design document and implementation disagree, the discrepancy should be stated explicitly and resolved through the protocol's normal engineering and governance process.
