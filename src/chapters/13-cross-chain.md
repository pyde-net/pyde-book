# Chapter 13: Interlinking Settlement and Netting

Tier 2 is Pyde's open interlinking settlement environment.

Its purpose is not to create another sovereign currency, become a global central bank, or operate as a generic bridge marketplace.

Its purpose is to maintain the shared state required for participating economic domains to coordinate cross border activity.

The core state consists of foreign exchange observations, settlement pool state, obligations, positions, and netting results.

## 13.1 Why a Settlement Layer Exists

Cross border commerce is not only a payment problem.

A transaction may require:

- identity and authorization checks;
- account and regulatory state;
- foreign exchange state;
- source liquidity;
- destination liquidity;
- settlement authorization;
- reconciliation of the resulting economic obligation.

Existing systems solve individual parts of this process. Tier 2 provides a shared coordination environment for the relationships between participating systems.

## 13.2 Open Validator Participation

Tier 2 is open infrastructure.

Anyone satisfying the validator requirements can operate the Tier 2 binary and participate in consensus.

Tier 2 validators do not become validators of participating Tier 1 networks.

Tier 2 consensus establishes the canonical state of the shared settlement ledger. Sovereign consensus remains authoritative over each Tier 1 monetary domain.

## 13.3 Foreign Exchange Oracle

Tier 2 validators independently publish foreign exchange observations.

The network aggregates those observations according to the configured oracle rules and records a consensus supported reference state.

The oracle does not independently prove that a real world price is correct. It provides a consensus supported reference from participating observations.

Settlement contracts consume the resulting state subject to their own authorization rules.

## 13.4 Settlement Pools

Each participating sovereign consortium can operate a standardized settlement contract on its Tier 1 network.

The contract maintains a pool of sovereign currency dedicated to authorized cross border settlement.

The pool remains inside its sovereign domain.

Tier 2 does not hold the sovereign currency directly. Instead, the participating Tier 1 consortium grants the settlement mechanism authority to move funds within that defined pool according to the accepted settlement rules.

The sovereign monetary authority controls the pool's funding and withdrawal process.

## 13.5 Cross Border Settlement Example

Consider a Nigerian participant sending the equivalent of €20 to a German participant.

The source participant holds Nigerian sovereign currency. The destination receives euros from the German settlement pool.

The logical flow is:

1. The sender authorizes the operation.
2. The source consortium verifies account status, authorization, balance, allowance, settlement rules, and relevant regulatory restrictions.
3. Tier 2 provides the applicable foreign exchange reference.
4. The required source currency moves into the source settlement pool.
5. Tier 2 records the resulting cross domain obligation.
6. The destination settlement pool releases the corresponding destination currency.
7. The destination participant receives the authorized amount.

```text
Participant
   │
   ▼
Tier 1 source network
   │
   │ source currency enters authorized pool
   ▼
Tier 2
   │  FX state + obligation + settlement state
   ▼
Tier 1 destination network
   │
   │ destination pool releases value
   ▼
Recipient
```

The settlement layer coordinates the relationship. It does not become the owner of either sovereign currency.

## 13.6 Preflight Simulation

Settlement operations can be simulated before execution.

The simulation can evaluate:

- authorization;
- account status;
- allowance;
- relevant regulatory state;
- FX data;
- settlement fees;
- source liquidity;
- destination liquidity;
- other configured settlement conditions.

Simulation is a preflight check. It does not replace consensus or finality.

## 13.7 Obligation State

An obligation records an economic relationship created by cross domain activity.

For example:

```text
Nigeria → Germany: €100
```

means that Tier 2 records an obligation associated with those domains for the stated value and currency.

The obligation is not sovereign money held by Tier 2.

It is shared coordination state.

## 13.8 Position State

A position represents net exposure after relevant obligations are considered.

For example:

```text
Nigeria owes Germany: €100
Germany owes Nigeria: €40
```

produces a bilateral net position of:

```text
Nigeria owes Germany: €60
```

The position is an accounting representation of economic exposure.

## 13.9 Bilateral Netting

Where two domains have opposing obligations, the settlement state can reduce them to a smaller net position.

The historical obligations remain available according to the retention rules of the participating system.

Netting reduces unnecessary gross settlement without pretending that the original economic relationships never existed.

## 13.10 Multilateral Netting

The same principle works across multiple participants.

Consider:

```text
Nigeria → Germany: €100
Germany → Japan: €100
Japan → Nigeria: €100
```

Each participant has a zero net exposure after the cycle is recognized.

No additional gross currency movement is required merely to cancel the circular claims.

The network therefore reduces the amount of settlement activity required to reconcile the participating positions.

## 13.11 Residual Settlement

Most real networks are not perfectly circular.

After netting, residual positive and negative positions can remain.

Those positions remain part of Tier 2 settlement state and can be reconciled through the authorized processes of the participating sovereign monetary systems.

Future transactions can create offsetting obligations and reduce residual exposure over time.

## 13.12 Atomicity

A cross domain operation is treated as one logical settlement.

The participating state transitions must satisfy the required authorization, liquidity, consensus, and settlement conditions before the operation is considered complete.

A partially completed state is not presented as a successful settlement.

This property is critical because the system is coordinating separate economic domains. A system that can debit one side and silently fail on the other side does not provide reliable settlement infrastructure.

## 13.13 Failure Isolation

A Tier 2 failure should pause or restrict cross border settlement rather than rewrite domestic Tier 1 state.

A Tier 1 network can continue domestic activity even if Tier 2 is unavailable.

A sovereign that temporarily stops participating in Tier 2 cannot simply erase historical obligations already recorded in the shared settlement state.

Participation and withdrawal are therefore explicit protocol state transitions.

## 13.14 What Tier 2 Is Not

Tier 2 is not:

- a sovereign monetary authority;
- a shared pool containing all participating sovereign currencies;
- a universal KYC provider;
- a generic application chain marketplace;
- a replacement for domestic banking or legal systems.

It is shared settlement and coordination infrastructure.
