# Architecture Overview

Pyde is distributed ledger infrastructure for a connected global economy.

The architecture is organized into three operating environments that share a common protocol foundation while enforcing different authority and participation models.

```text
┌─────────────────────────────────────────────────────────────┐
│ Tier 1                                                       │
│ Sovereign economic networks                                  │
│ Domestic economic state · regulated institutions             │
├─────────────────────────────────────────────────────────────┤
│ Tier 2                                                       │
│ Open interlinking settlement                                 │
│ FX observations · settlement · obligations · positions      │
│ bilateral and multilateral netting                           │
├─────────────────────────────────────────────────────────────┤
│ Tier 3                                                       │
│ Permissionless public network                                │
│ Contracts · applications · digital assets · public economy   │
├─────────────────────────────────────────────────────────────┤
│ Common protocol foundation                                    │
│ Execution · state · consensus · cryptography · networking   │
└─────────────────────────────────────────────────────────────┘
```

The important distinction is not that the three tiers are three unrelated chains. The distinction is that the same core technology is configured for different economic domains and authority boundaries.

## Tier 1: Sovereign Consortium Networks

Tier 1 provides a permissioned distributed ledger environment for a sovereign economic domain.

The validator set is controlled by authorized sovereign agencies under the participating jurisdiction's governance model. A validator set can include a central bank, finance authority, treasury, tax authority, or other legally authorized public institution.

The network can represent domestic monetary state, regulated institutional state, account restrictions, licensing state, and other jurisdiction specific economic records.

Tier 1 is not designed to replace national law. The sovereign remains responsible for monetary policy, legal identity, regulatory authority, licensing, and the legal interpretation of the state represented by the network.

## Tier 2: Open Interlinking Settlement

Tier 2 is the open coordination environment between participating economic domains.

Anyone who satisfies the Tier 2 validator requirements can operate a validator and participate in consensus. A Tier 2 validator does not become a validator of a Tier 1 consortium.

Tier 2 maintains shared cross domain state, including:

- foreign exchange observations and aggregated reference state;
- settlement pool state;
- cross domain obligations;
- participant and sovereign positions;
- bilateral and multilateral netting state;
- residual settlement information.

Tier 2 does not become the owner of sovereign currencies. Sovereign assets remain inside the participating Tier 1 networks and their authorized settlement pools.

## Tier 3: Permissionless Public Network

Tier 3 is Pyde's permissionless public environment.

Developers and users can deploy contracts, build applications, issue supported digital assets, operate public infrastructure subject to protocol rules, and participate in public economic activity.

### Tier 3 Extensions

The permissionless public network can support optional extension mechanisms for capabilities that cannot execute deterministically inside the core network itself, including external data, foreign chain interaction, bridge operations, and off chain computation.

Pyde's parachain design defines one such extension. Parachains are not a fourth economic tier and are not required for ordinary Tier 3 applications. They extend Tier 3 by allowing external computation and data to be brought back into the deterministic protocol through explicit attestation and validation rules.

## Authority Boundaries

The same address or contract technology does not imply the same legal or economic authority in every tier.

| Property                 | Tier 1                                | Tier 2                                  | Tier 3                              |
| ------------------------ | ------------------------------------- | --------------------------------------- | ----------------------------------- |
| Validator participation  | Permissioned                          | Open subject to protocol requirements   | Permissionless public rules         |
| Primary state            | Sovereign domestic economic state     | Cross domain coordination state         | Public economic state               |
| Currency authority       | Sovereign                             | None over sovereign currencies          | Public network token and assets     |
| KYC and regulatory state | Jurisdiction specific                 | Used when required by connected domains | Not a sovereign authorization layer |
| Smart contracts          | Authorized institutional applications | Settlement and coordination logic       | Public applications                 |

A participant in one tier does not automatically receive authority in another.

## Common Technical Foundation

The common protocol foundation includes:

- WebAssembly execution using Wasmtime and Cranelift;
- deterministic state transitions and parallel execution;
- Jellyfish Merkle state;
- Mysticeti style DAG consensus for the public protocol design;
- FALCON 512 and the other protocol cryptographic primitives;
- authenticated networking and state synchronization;
- smart contract infrastructure;
- the Otigen developer toolchain.

The exact consensus configuration, validator authorization, contract permissions, and enabled protocol capabilities are profile specific.

## Structural Capability Boundaries

A permissioned network should not rely only on application level switches to simulate the absence of capabilities that are fundamentally incompatible with its operating model.

Pyde therefore treats network profile as a first class configuration boundary. Where appropriate, profile specific capabilities are excluded from the executable environment rather than merely hidden behind runtime permissions.

This allows a sovereign profile to omit capabilities that belong only to the public environment while retaining the same underlying execution architecture.

## Execution Architecture

The current Tier 3 execution design uses WebAssembly through Wasmtime and Cranelift AOT compilation.

Transactions can execute in parallel using optimistic execution and multi version validation. Independent operations can progress concurrently while conflicting operations are re executed until the canonical result is deterministic.

This architecture is useful beyond public applications. Tier 2 settlement workloads naturally contain many independent operations across accounts, corridors, pools, and netting relationships.

## State Architecture

Pyde uses Merkle based authenticated state. The current Tier 3 design uses a Jellyfish Merkle Tree with the protocol's hybrid hashing strategy.

The state model is intentionally broader than a simple token balance. Depending on the network profile, state can represent balances, contract state, authorization state, obligations, positions, regulatory references, and other protocol defined economic state.

## Consensus and Finality

Consensus makes a valid state transition canonical.

For Tier 1, the validator set is defined by the sovereign consortium. For Tier 2, validators participate openly subject to the network's validator rules. For Tier 3, validators participate under the public protocol rules.

The current Tier 3 design uses a Mysticeti style DAG consensus architecture and Byzantine quorum rules. Exact committee parameters remain subject to the current consensus specification and security validation.

<!-- ## What Exists Today

The current public development environment is Tier 3.

The execution, state, consensus, cryptography, networking, account, and developer infrastructure described in the technical chapters form the current engineering foundation.

Tier 1 and Tier 2 are architectural systems. They are not presented here as deployed production networks.

Their production deployment requires:

- independent engineering validation;
- external security review;
- institutional integration;
- jurisdiction specific regulatory work;
- operational infrastructure;
- deployment specific governance and authorization. -->

## Historical Designs

Earlier Pyde designs included a separate parachain framework and other Layer 1 specific architectural choices. Those materials remain useful as historical records but are no longer the definition of Pyde's current economic architecture.
