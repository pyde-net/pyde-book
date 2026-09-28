# Pyde Technical Design

This document is the technical design reference for the current Pyde architecture.

Pyde is distributed ledger infrastructure for a connected global economy. The current architecture contains three operating environments built on a common technical foundation.

## 1. Economic Environments

### Tier 1

Permissioned sovereign consortium networks represent domestic economic state and regulated institutional applications.

The validator set is defined by the participating sovereign authority. Monetary operations and regulated state transitions require the consortium's authorization and quorum rules.

### Tier 2

Open settlement infrastructure connects participating economic domains.

Tier 2 validators participate openly subject to protocol requirements. Tier 2 maintains foreign exchange reference state, settlement pool coordination, obligations, positions, and netting state.

Tier 2 does not own sovereign currencies and does not replace Tier 1 consensus.

### Tier 3

The permissionless public network provides the open execution environment for contracts, applications, assets, and public economic activity.

The current public development environment is Tier 3.

## 2. Common Technical Foundation

The common technical foundation includes:

- WebAssembly execution through Wasmtime;
- Cranelift AOT compilation;
- deterministic host function execution;
- optimistic parallel execution and MVCC style validation;
- Jellyfish Merkle state;
- Mysticeti style DAG consensus for the Tier 3 design;
- FALCON 512 signatures;
- Blake3 and Poseidon2 hashing;
- authenticated networking;
- state synchronization and recovery;
- account and authorization infrastructure.

Network profiles can enable or disable capabilities according to their authority model.

## 3. Execution Layer

Smart contracts execute in WebAssembly under a deterministic runtime.

Contracts interact with the protocol through a defined Host Function ABI. The host interface exposes state, balances, events, cryptography, calls, and execution context while excluding arbitrary operating system access and other nondeterministic capabilities.

## 4. Parallel Execution

The public Tier 3 execution design uses optimistic parallel execution.

Transactions execute against speculative state, their read and write dependencies are validated, and conflicts are re executed until the result converges to the canonical transaction order.

The objective is deterministic state application with concurrent execution of independent work.

## 5. State

The protocol uses authenticated Merkle state. The current public design uses a Jellyfish Merkle Tree.

The state root commits to balances, contract state, account status, and other protocol records.

## 6. Consensus

Consensus establishes which state transition becomes canonical.

The current public design uses a Mysticeti style DAG architecture with Byzantine quorum rules. The precise quorum and committee configuration are implementation parameters and must remain consistent with the current consensus specification.

## 7. Account Model

Accounts contain cryptographic authorization and economic state.

The conceptual economic model includes nonce, balances, contract identity, status, and an optional reference to an off chain regulatory identity record.

The serialized Tier 3 engine model can contain additional execution metadata such as authorization keys and storage roots.

## 8. Settlement Architecture

Tier 2 settlement uses standardized settlement contracts deployed within participating Tier 1 networks.

Each pool remains within its sovereign domain. Tier 2 records and coordinates the shared state required to move authorized value within those pools.

Cross domain settlement produces obligation and position state that can later be netted.

## 9. Security Boundaries

Security depends on the operating environment.

Tier 1 relies on authorized validator sets and institutional separation.

Tier 2 relies on open validator consensus, settlement pool authorization, oracle aggregation, and atomic settlement rules.

Tier 3 relies on permissionless BFT consensus, deterministic execution, authenticated state, and cryptographic authorization.

## 10. Historical Interfaces

Earlier Pyde versions contained a parachain framework and related host functions. Those interfaces should not be treated as current economic architecture unless they are explicitly restored by a new protocol specification.

Superseded specifications belong in the historical archive.
