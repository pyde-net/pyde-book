# Chapter 16: Security

Pyde security is built around explicit authority boundaries.

A permissionless public network, a sovereign consortium, and an open settlement network do not have identical trust assumptions. Treating them as identical would hide important risks.

## 16.1 Security Domains

Pyde has three primary security domains:

| Domain | Primary security concern                                                     |
| ------ | ---------------------------------------------------------------------------- |
| Tier 1 | Unauthorized sovereign or institutional state changes                        |
| Tier 2 | Unauthorized creation, alteration, or settlement of cross domain obligations |
| Tier 3 | Public network consensus, execution, account, and application security       |

The domains share cryptographic and execution infrastructure but maintain different authorization rules.

## 16.2 Tier 1 Security

Tier 1 uses permissioned validator participation.

Security depends on both technical consensus and institutional separation.

A single sovereign agency should not be able to unilaterally rewrite consortium state where the configured quorum requires agreement among multiple authorized validators.

Critical operations such as monetary issuance, redemption, freeze state, and regulatory transitions are subject to the consortium's authorization and consensus rules.

## 16.3 Tier 2 Security

Tier 2 protects shared settlement state.

The principal security objectives are:

- prevent unauthorized obligation creation;
- prevent unauthorized modification of settlement positions;
- prevent unauthorized use of settlement pools;
- prevent invalid foreign exchange state from becoming authoritative;
- maintain deterministic consensus over shared settlement state;
- prevent a Tier 2 participant from acquiring sovereign authority.

Tier 2 validators operate openly under the protocol rules. Their agreement is used to establish canonical settlement state.

## 16.4 Settlement Pool Security

A settlement pool remains inside its Tier 1 consortium.

Tier 2 receives only the authority explicitly granted by the settlement contract.

The sovereign authority controls pool funding and withdrawal.

This creates an important boundary: compromise of a Tier 2 validator should not automatically grant unrestricted custody over every sovereign asset represented in the settlement system.

## 16.5 Oracle Security

Foreign exchange state is consensus supported observation, not an assertion of omniscient truth.

Security therefore depends on:

- multiple independent observations;
- the configured aggregation mechanism;
- validator honesty assumptions;
- freshness rules;
- rejection of stale or invalid data;
- settlement contracts refusing to act when required oracle conditions are not satisfied.

## 16.6 Cross Domain Atomicity

Cross border settlement creates a special failure mode: one side may succeed while another side fails.

The settlement architecture therefore treats a cross domain operation as one logical settlement.

A partially executed operation must not be represented as a successful completed settlement.

Simulation can prevent many failures before execution, but simulation is not a security guarantee. Finality and atomicity depend on the committed state transitions and consensus rules.

## 16.7 Permissionless Tier 3 Security

Tier 3 inherits the standard distributed ledger attack classes:

- Byzantine validator behavior;
- Sybil attacks;
- network partition and eclipse attacks;
- denial of service;
- state corruption;
- replay attacks;
- smart contract vulnerabilities;
- cryptographic compromise;
- implementation bugs.

The public network's consensus, execution sandbox, state commitment, networking controls, account authorization, and cryptographic primitives form the core defensive layers.

## 16.8 Execution Security

Smart contracts execute inside the defined WebAssembly environment.

The runtime restricts access to host functions and validator resources. Contracts cannot arbitrarily access the host filesystem, network, process state, or nondeterministic system resources.

Determinism is a security requirement because all honest validators must derive the same state transition.

## 16.9 State Security

The state tree provides authenticated commitment to network state.

A state transition that produces a different committed root than the canonical result is a consensus safety failure.

State synchronization uses authenticated state data and consensus evidence so that a recovering node can verify the state it receives rather than accepting an arbitrary snapshot.

## 16.10 Cryptographic Security

Pyde treats post quantum cryptography as a protocol design requirement.

FALCON 512 is used for account and protocol signatures in the current public design. Blake3 and Poseidon2 serve the hashing requirements of the relevant protocol components.

Cryptographic implementation remains subject to independent review and future algorithm migration where the protocol determines that a primitive must be replaced.

## 16.11 Regulatory Security

Tier 1 security cannot be separated from legal and institutional authority.

The protocol can enforce that an account is frozen or restricted.

It cannot independently determine whether a court order, corporate license, tax decision, or property claim is legally valid outside the authority systems that establish those facts.

The correct security model therefore treats real world institutions as authoritative sources for the facts they legally control and the ledger as the verifiable execution environment for the resulting digital state.

## 16.12 Failure Isolation

The three tier architecture is designed to limit failure propagation.

A Tier 2 outage should pause or restrict cross border settlement without automatically halting domestic Tier 1 activity.

A Tier 1 regulatory event should not automatically rewrite Tier 3 public state.

A Tier 3 application failure should not automatically acquire authority over a sovereign consortium.

This separation is itself a security property.

## 16.13 Operational Security

Production operation requires:

- independent security review;
- secure key management;
- validator isolation and network hardening;
- reproducible builds;
- monitoring and alerting;
- incident response procedures;
- state recovery procedures;
- controlled protocol upgrade procedures.

The security chapter is the narrative model. The detailed threat catalog belongs in `companion/THREAT_MODEL.md`.

## 16.14 External Audit

Before production economic deployment, the highest risk surfaces should be independently reviewed.

Priority areas include:

- consensus;
- account state transitions;
- cryptography;
- execution and host functions;
- Tier 2 settlement contracts;
- FX aggregation;
- settlement pool authorization;
- treasury controls;
- cross domain atomicity;
- state synchronization and recovery.

Security review should test both implementation correctness and the economic assumptions on which the architecture depends.

## Summary

Pyde does not use one universal trust model.

Tier 1 protects sovereign state through authorized validators, quorum, and institutional controls.

Tier 2 protects shared settlement state through open consensus, explicit pool authority, oracle rules, and atomic settlement semantics.

Tier 3 protects permissionless public state through BFT consensus, deterministic execution, authenticated state, cryptography, and operational security.

The three tier architecture is therefore part of the security model, not merely an organizational diagram.
