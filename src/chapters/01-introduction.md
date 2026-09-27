# Introduction

## What is Pyde?

Pyde is **distributed ledger infrastructure for a connected global economy**.

It provides a common programmable foundation for representing, verifying, and coordinating **global economic state** across sovereign networks, open settlement infrastructure, and a permissionless public network.

Global economic state includes balances, ownership, authorization, identity relationships, obligations, licenses, settlement positions, regulatory conditions, and contractual relationships. The purpose of the protocol is not simply to represent digital assets. It is to make relevant economic state programmable, verifiable, and coordinatable across domains with different authorities.

The architecture is divided into three environments.

**Tier 1** provides sovereign consortium networks for domestic economic state and regulated institutional applications. Authorized sovereign agencies control the validator set and the rules that govern the network.

**Tier 2** provides open interlinking settlement infrastructure. Independent validators can participate subject to the protocol's requirements. Tier 2 coordinates cross domain settlement through foreign exchange observations, settlement pools, obligations, positions, and netting without becoming the monetary authority of the currencies involved.

**Tier 3** provides the permissionless public environment. Anyone can participate within the protocol rules, deploy smart contracts, issue digital assets, and build public applications.

All three environments share a distributed ledger foundation while applying different authority and participation rules.

## The Economic Infrastructure Gap

The global economy is deeply digital, but it is not digitally unified. Economic activity is represented across sovereign monetary systems, banks, payment networks, government registries, enterprises, exchanges, custodians, identity systems, and private software platforms. Each system performs a specific function and can operate correctly within its own domain, yet the global economy still depends on these systems being able to interact with one another.

That interaction is where much of the infrastructure gap appears. A single economic relationship can require identity to be established in one system, ownership to be established in another, authorization to be checked somewhere else, value to move through a payment system, and the resulting state to be reconciled across multiple records. The individual systems do not necessarily fail. The friction exists at their boundaries because each system maintains its own representation of economic state, its own authority, and its own rules.

The effects become more significant when economic activity crosses institutional and national boundaries. A cross border transaction can involve sovereign currencies, banking systems, compliance requirements, foreign exchange processes, settlement instructions, liquidity arrangements, and reconciliation systems. The payment itself is only one component of the economic relationship. The surrounding process must establish that the parties are authorized to act, that the relevant value exists, that the applicable exchange rate is accepted, that settlement liquidity is available, and that the resulting obligations and positions are recorded consistently.

This fragmentation limits how easily economic activity can compose across systems. A payment system may know that value moved without directly representing the commercial obligation that caused the movement. A property registry may maintain authoritative ownership information without sharing that state directly with the financial infrastructure financing the property. A sovereign monetary system may maintain the authoritative value of its currency while international commerce still requires separate coordination mechanisms to connect that value to another jurisdiction.

Existing financial and distributed systems already solve important pieces of this problem. Payment networks move value between institutions. Banking systems maintain account and liability state. Settlement infrastructure coordinates transactions between participants. Permissioned distributed ledgers provide shared state for defined groups, while permissionless networks provide open programmability and public consensus. The gap is not the absence of useful infrastructure. The gap is how independently governed economic environments can coordinate through a common programmable architecture without losing the authority boundaries that define them.

Distributed ledger technology provides a natural foundation for this coordination because it can maintain shared, verifiable state across independent participants. But a global economic architecture cannot assume that every participant belongs to one permissionless network or follows one authority model. A sovereign monetary system has different requirements from an open settlement network. An institutional application has different requirements from a public smart contract. A cross border settlement layer must coordinate between domains without becoming the sovereign authority over their currencies.

Pyde is designed around that distinction. It treats **global economic state** as the broader infrastructure abstraction and separates economic participation into three environments with explicit authority boundaries.

## Protocol Foundation

The economic architecture is implemented on a common technical foundation.

### Execution

Pyde executes smart contracts through **WebAssembly using Wasmtime and Cranelift**. The execution environment is deterministic and exposes protocol capabilities through a defined host function interface. Parallel execution uses a Block STM style scheduler with multi version validation and deterministic state application.

Contracts can target the supported WebAssembly environment from languages such as Rust, AssemblyScript, Go through TinyGo, and C or C++ and can be packaged through the `otigen` developer toolchain.

### State

Economic state is committed through a **Jellyfish Merkle Tree**. The state model provides authenticated representation of balances, contract state, and other protocol records while allowing validators and clients to verify state transitions and inclusion proofs.

The live state root uses Blake3 today. A Poseidon2 path is designed into the state architecture for future zero knowledge consumers but is not presented as enabled production functionality unless the implementation status says otherwise.

### Consensus

The consensus layer uses a **Mysticeti style DAG design**. Validators contribute vertices continuously and reach Byzantine fault tolerant finality through the DAG rather than through a single proposer model.

Consensus is the mechanism that makes a state transition canonical. The economic architecture defines what that state means in each tier. Consensus determines which valid transition becomes part of the shared ledger state.

### Cryptography

Pyde uses **FALCON 512** for protocol signatures, with Blake3 and Poseidon2 used according to the requirements of each protocol component. Post quantum cryptography is part of the protocol foundation rather than a later migration story.

The exact primitive and implementation status of each cryptographic component is defined in [Chapter 8: Cryptography](./08-cryptography.md).

### Networking and synchronization

Validators and nodes communicate through the protocol networking layer and synchronize authenticated state so that independent participants can converge on the same economic state. Recovery and state synchronization are treated as protocol properties rather than operational assumptions.

## What is implemented today?

The current public development environment is **Tier 3**.

The existing implementation work includes the execution environment, state model, cryptographic foundation, networking, developer tooling, and consensus architecture described throughout this book. Individual components remain at different implementation stages, and this book distinguishes designed functionality from shipped functionality.

Tier 1 and Tier 2 are architectural designs. They are not presented as deployed production networks. Their production deployment requires additional engineering, security review, institutional integration, operational infrastructure, and jurisdiction specific work.

The distinction matters: the three tier architecture is the current definition of Pyde, while Tier 3 is the current public implementation environment.

## What Pyde does not claim

Pyde does not claim that existing financial infrastructure is obsolete. Existing systems already perform critical economic functions at global scale.

Pyde also does not claim that a distributed ledger should become the authority over every economic relationship.

The architectural proposition is narrower and more useful: independently governed economic systems need infrastructure that can represent and coordinate shared economic state where those systems choose to interact.

## Reading Path

**For the economic architecture:**

1. [What is Pyde](../preface/what-is-pyde.md)
2. [Why Pyde](../preface/why-pyde.md)
3. [Chapter 2: Architecture Overview](./02-architecture-overview.md)
4. [Chapter 13: Cross Chain and Settlement](./13-cross-chain.md)
5. [Chapter 14: Economics](./14-tokenomics.md)

**For protocol implementation:**

1. [Chapter 2: Architecture Overview](./02-architecture-overview.md)
2. [Chapter 3: Execution Layer](./03-virtual-machine.md)
3. [Chapter 4: State Model](./04-state-model.md)
4. [Chapter 6: Consensus](./06-consensus.md)
5. [Chapter 8: Cryptography](./08-cryptography.md)
6. [Chapter 11: Account Model](./11-account-model.md)
7. [Chapter 12: Networking](./12-networking.md)

**For security review:**

1. [Chapter 6: Consensus](./06-consensus.md)
2. [Chapter 8: Cryptography](./08-cryptography.md)
3. [Chapter 16: Security](./16-security.md)
4. [Threat Model](../companion/THREAT_MODEL.md)
5. [Failure Scenarios](../companion/FAILURE_SCENARIOS.md)

**For developers:**

1. [Get Started: for Developers](../preface/get-started-for-developers.md)
2. [Chapter 3: Execution Layer](./03-virtual-machine.md)
3. [Chapter 5: Otigen Toolchain](./05-otigen-toolchain.md)
4. [Host Function ABI](../companion/HOST_FN_ABI_SPEC.md)

## Historical pivots

Pyde has gone through major implementation pivots. The HotStuff consensus era and original Otigen language era are preserved as historical design references. They explain why certain decisions changed, but they are not the current definition of the protocol.

See [The Pivot](../preface/pivot.md) and the [Historical Design References](../pivot/README.md) for the archived material.

## Status

**Living document.** Architecture, implementation status, and technical specifications are updated as the protocol evolves.
