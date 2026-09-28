# Implementation Status

This chapter records the difference between the architecture Pyde defines and the infrastructure that currently exists.

It is intentionally not a roadmap. The purpose is to prevent readers from confusing a protocol design with a deployed production system.

## 20.1 Public Development Environment

The current public development environment is Tier 3.

It is the permissionless environment from which developers can evaluate the execution model, deploy contracts, test applications, and interact with the protocol's public infrastructure.

The current engineering foundation includes:

- WebAssembly execution;
- Wasmtime and Cranelift based execution infrastructure;
- parallel execution and deterministic state transitions;
- Jellyfish Merkle state;
- Mysticeti style DAG consensus architecture;
- FALCON 512 and the current hashing stack;
- networking and state synchronization;
- accounts and authorization;
- Otigen tooling;
- security and recovery infrastructure.

## 20.2 Tier 1 Status

Tier 1 is an architectural deployment profile.

The architecture defines permissioned validators, sovereign monetary state, KYC linked account restrictions, institutional contracts, controlled monetary operations, and jurisdiction specific governance.

A production Tier 1 deployment additionally requires a participating sovereign authority, institutional operators, legal authorization, security validation, operational infrastructure, and deployment specific configuration.

Those conditions are not implied merely by the existence of the common Pyde technical foundation.

## 20.3 Tier 2 Status

Tier 2 is an architectural deployment profile for open interlinking settlement.

The design covers foreign exchange observations, settlement pools, cross domain obligations, positions, netting, residual settlement, validator participation, and protocol fees.

A production Tier 2 deployment requires participating Tier 1 networks, validated settlement contracts, defined pool authority, oracle rules, validator economics, operational recovery procedures, and independent security review.

## 20.4 Tier 3 Status

Tier 3 is the current public engineering environment.

Its protocol components are at different stages of implementation and validation. This book intentionally treats measured performance, deployed functionality, and design targets as separate categories.

## 20.5 How to Read Technical Claims

Terms in the book have specific meanings:

| Term                 | Meaning                                                                       |
| -------------------- | ----------------------------------------------------------------------------- |
| Implemented          | Present in the current engineering environment                                |
| Specified            | Defined by a protocol or design document but not necessarily deployed         |
| Target               | An engineering objective subject to validation                                |
| Deployment dependent | Requires institutional, jurisdictional, or operational conditions beyond code |
| Historical           | A superseded design retained for context                                      |

## 20.6 Historical Designs

Earlier versions of Pyde experimented with different consensus systems, execution models, and cross network architectures.

Those designs remain valuable because they document why the architecture changed, but they should not be interpreted as current protocol commitments.

Historical material is kept under the Pivot section of the book.

## 20.7 Source of Truth

For economic architecture, the current Pyde whitepaper defines the current model.

For low level implementation, the relevant companion technical specification and current codebase are authoritative.

Where implementation and architecture differ, the discrepancy should be identified explicitly rather than silently presented as though the systems were already identical.

## Summary

Pyde is currently being built from a Tier 3 technical foundation toward a broader three tier economic architecture.

The book documents both the existing implementation and the defined architecture while keeping the boundary between them explicit.
