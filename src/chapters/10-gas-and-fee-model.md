# Chapter 10: Execution Fees and Economic Fees

Pyde has more than one economic environment, so it is important not to treat every fee in the system as though it belongs to the same monetary model.

The public Tier 3 network has protocol execution fees denominated in PYDE. Tier 2 has settlement and infrastructure fees that can be denominated in the participating sovereign currency rather than forcing sovereign economic activity to use PYDE as its settlement asset.

This chapter describes the distinction.

## 10.1 Tier 3 Execution Fees

Tier 3 uses a gas accounting model to price computation and state changes.

A transaction consumes gas for execution. The transaction pays the applicable network fee in PYDE according to the current Tier 3 fee schedule.

The execution engine uses Wasmtime fuel metering and protocol gas accounting so that resource consumption is bounded and deterministic.

Gas exists to price scarce execution resources. It is not itself a monetary policy mechanism for sovereign currency.

## 10.2 Deterministic Fee Calculation

Every validator must derive the same fee for the same transaction, gas usage, and protocol fee state.

The calculation uses integer arithmetic and deterministic protocol state. Floating point arithmetic is not used for consensus critical fee calculation.

The implementation of the Tier 3 fee schedule is specified in the current transaction and execution code and in the relevant companion specifications.

## 10.3 Sponsored Transactions

Tier 3 applications can abstract gas from end users through application sponsored transactions where the account model and transaction format permit it.

The purpose is onboarding and application UX, not changing the protocol's accounting rules.

A sponsor still pays the underlying network fee. The user simply does not need to hold the fee asset directly for every interaction.

## 10.4 Tier 2 Settlement Fees

Tier 2 has a different economic role.

Its fees compensate the open settlement network for maintaining consensus, foreign exchange aggregation, settlement infrastructure, and related coordination services.

The fee currency is the applicable sovereign currency of the participating settlement environment rather than PYDE by definition.

This preserves monetary neutrality across sovereign domains.

The current Tier 2 allocation is:

| Allocation        | Share | Role                                                                                                       |
| ----------------- | ----: | ---------------------------------------------------------------------------------------------------------- |
| Validator rewards |   60% | Compensates Tier 2 validators for maintaining consensus, oracle aggregation, and settlement infrastructure |
| Protocol treasury |   40% | Funds protocol development, security, infrastructure, ecosystem operations, and approved network expenses  |

No sovereign currency is burned by the Tier 2 fee mechanism.

## 10.5 Tier 2 and PYDE

PYDE can be used for validator alignment and public network security through Tier 3 staking and related protocol functions.

That does not make PYDE the sovereign settlement currency of Tier 2.

A sovereign currency remains the monetary asset represented inside its own Tier 1 domain. Tier 2 coordinates settlement between those currencies.

## 10.6 Settlement Fees Are Not Gas

Tier 2 settlement fees should not be confused with Tier 3 contract gas.

Gas answers the question:

> How much computational and state transition work does this operation consume?

Tier 2 economic fees answer a different question:

> What does it cost to maintain the shared settlement and coordination service used by participating economic domains?

A single cross domain operation can therefore involve both protocol execution cost and economic settlement fees, depending on the network profile and application flow.

## 10.7 Fee Transparency

A production implementation should expose enough information for participants to distinguish:

- computation consumed;
- network execution fee;
- settlement fee;
- foreign exchange related charges;
- recipient amount;
- treasury allocation;
- validator allocation.

The purpose is auditability. Economic infrastructure should not collapse several distinct charges into a single unexplained number.

## 10.8 What This Chapter Does Not Define

Tier 1 monetary policy is not a gas schedule.

Issuance, redemption, minting, burning, account restrictions, and sovereign monetary policy remain under the rules of the participating jurisdiction.

Tier 2 does not create sovereign money.

Tier 3 does not determine a sovereign currency's monetary policy.

## Summary

Pyde separates computational pricing from economic settlement.

Tier 3 prices execution in the public network's native economic system.

Tier 2 prices the coordination services required to connect sovereign economic domains and allocates those fees between validators and the protocol treasury.

Tier 1 remains sovereign over its own monetary state.
