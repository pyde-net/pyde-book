# Chapter 14: Economics

Pyde has different economic roles across its three environments.

The most important distinction is between **sovereign monetary value** and **PYDE**.

A participating sovereign currency remains the monetary asset of its Tier 1 domain. PYDE is the public protocol asset used by the permissionless Pyde economy and for validator alignment and related protocol functions.

## 14.1 Tier 1 Economic Role

Tier 1 represents sovereign economic infrastructure.

Its native monetary asset is the jurisdiction's sovereign digital currency.

The sovereign determines:

- issuance;
- redemption;
- monetary policy;
- regulatory treatment;
- authorized institutions;
- account restrictions;
- applicable legal processes.

Pyde provides the distributed ledger infrastructure used to represent and enforce the relevant digital state.

## 14.2 Tier 2 Economic Role

Tier 2 monetizes cross border coordination through protocol fees for services such as settlement, foreign exchange aggregation, oracle state, and network execution.

The fee currency can be the applicable sovereign currency of the participating settlement environment. Tier 2 does not require every sovereign network to adopt PYDE as its settlement currency.

This preserves monetary neutrality across sovereign domains.

The current Tier 2 allocation is:

| Allocation        | Share | Purpose                                                                                                         |
| ----------------- | ----: | --------------------------------------------------------------------------------------------------------------- |
| Validator rewards |   60% | Compensates the open validator set for maintaining consensus, oracle aggregation, and settlement infrastructure |
| Protocol treasury |   40% | Funds protocol development, security, infrastructure, ecosystem operations, and approved network expenses       |

There is no Tier 2 burn of sovereign currency.

## 14.3 Protocol Treasury

The Tier 2 protocol treasury is protocol controlled economic state.

It is not a corporate account and is not owned by Pyde Labs or another operating company.

Treasury funds are spent according to the governance and authorization rules of the network.

An independent engineering, security, infrastructure, research, or maintenance provider can earn revenue by supplying approved professional services to the protocol.

This keeps the protocol's funds separate from the company's commercial revenue.

The network funds remain protocol funds. A company earns money only for services it is authorized and contracted to provide.

## 14.4 Tier 2 Validator Alignment

Tier 2 validators participate in the open validator economy and can use PYDE as the public network's validator alignment and security asset through Tier 3 staking mechanisms.

PYDE is therefore not required to become the sovereign settlement asset of Tier 2.

A Tier 2 validator may need Tier 3 resources to participate in the public protocol economy, but its validation of Tier 2 settlement state does not grant it sovereign monetary authority.

## 14.5 Tier 3 Economic Role

Tier 3 is the permissionless public economic environment.

Its economic model includes:

- transaction and execution fees;
- validator participation and staking;
- public applications;
- digital assets;
- protocol security;
- ecosystem infrastructure.

PYDE is the native public protocol asset of this environment.

The exact Tier 3 fee distribution is an implementation and protocol parameter of the public network. It should not be confused with the Tier 2 sovereign currency fee allocation.

## 14.6 PYDE Utility

PYDE can serve several protocol level functions within the public network, including:

- paying Tier 3 execution fees;
- validator staking or security deposits;
- protocol level network participation;
- treasury operations where the public protocol requires PYDE;
- other functions explicitly defined by Tier 3 protocol rules.

PYDE is not required to represent a sovereign currency.

## 14.7 Supply Policy

The public network's token supply policy belongs to Tier 3 protocol economics.

Supply parameters, issuance, fee treatment, validator rewards, treasury allocation, vesting, and other token mechanics should be treated as versioned protocol rules rather than assumptions about sovereign money.

This distinction prevents the economics of the public network from being mistaken for the monetary policy of a Tier 1 jurisdiction.

## 14.8 No Sovereign Tokenization Through PYDE

Pyde does not need to insert PYDE between two sovereign currencies merely to create token utility.

A transaction between sovereign currencies should remain a transaction between those currencies.

PYDE instead supports the open protocol economy around the infrastructure.

## 14.9 Economic Separation

The architecture can therefore be summarized as:

```text
Tier 1
Sovereign currency
        │
        ▼
Tier 2
Settlement fees in applicable sovereign currency
        │
        ├── 60% validators
        └── 40% protocol treasury
        │
        ▼
Tier 3
Public protocol economy
        │
        └── PYDE for public network functions
```

The economic model deliberately avoids making sovereign monetary policy dependent on the market value of PYDE.

## Summary

Tier 1 represents sovereign monetary state.

Tier 2 coordinates and settles relationships between sovereign domains and allocates its fees 60% to validators and 40% to the protocol treasury.

Tier 3 provides the public protocol economy in which PYDE is the native network asset.

These roles are related, but they are not interchangeable.
