# Chapter 11: Account Model

Pyde uses a common cryptographic account model across its operating environments while allowing each tier to attach different authorization and regulatory rules to the resulting state.

The account is not a website profile and is not itself a legal identity. It is protocol state controlled cryptographically.

## 11.1 Conceptual Account State

The economic architecture is built around a deliberately small account model:

| Field       | Purpose                                                       |
| ----------- | ------------------------------------------------------------- |
| `nonce`     | Prevents replay and sequences account transactions            |
| `balances`  | Records asset balances                                        |
| `code_hash` | Identifies associated contract code where applicable          |
| `status`    | Records protocol or regulatory state                          |
| `kyc_id`    | Optional reference to an off chain regulatory identity record |

The exact serialized representation used by the current Tier 3 engine contains additional protocol metadata required for authentication, storage, and execution. Those implementation details are documented in the companion account and ABI specifications.

## 11.2 Cryptographic Control

Accounts are controlled through the protocol's cryptographic authorization system.

The current public network uses post quantum account signatures based on FALCON 512.

The account address is a cryptographic identifier. It is not automatically a legal identity.

## 11.3 Identity Is Off Chain

The ledger does not need to store a person's passport, national identity document, or other personal record in order to associate an account with a verified participant.

A Tier 1 consortium can keep the authoritative identity record in the jurisdictional identity or institutional system and store only the appropriate reference on the ledger.

This is the role of `kyc_id` in the economic account model.

The identity record remains outside the distributed ledger. The protocol records the authorization relationship needed to enforce regulated actions.

## 11.4 Account Status

Tier 1 can attach jurisdiction specific regulatory states to accounts.

Examples include:

- active;
- restricted;
- frozen;
- discontinued;
- another state defined by the participating consortium.

The exact state machine belongs to the jurisdiction.

A status transition can restrict what the account is permitted to do without changing the underlying cryptographic identity.

## 11.5 Account Creation Is Not Sign Up

Creating an account means establishing account state on the network.

It does not mean creating a website profile or registering a person with Pyde as a global identity authority.

A Tier 3 account can exist without sovereign KYC authorization. A Tier 1 network can require KYC or institutional authorization before the account can access regulated assets or operations.

## 11.6 Contract Accounts

A contract account is represented by its code identity and state.

The contract's code is identified by `code_hash`, while contract storage is authenticated through the state tree.

Contract authorization and upgrade rules depend on the network profile and the application's configuration.

## 11.7 Nonce and Replay Protection

The Tier 3 implementation uses a nonce window so that multiple transactions from the same account can remain in flight without forcing strict head of line blocking.

The nonce mechanism is protocol state and therefore participates in the same deterministic state transition rules as balances and contract storage.

The exact window size and encoding remain implementation details of the current Tier 3 transaction model.

## 11.8 Institutional Accounts

Tier 1 institutions can operate through licensed accounts, service accounts, and approved smart contracts.

The account model provides the protocol identity. The institution's license and legal capacity remain external authority.

An institution can therefore continue to use its existing banking, accounting, compliance, and customer systems while using Pyde as a shared programmable coordination layer.

## 11.9 Sovereign Monetary Operations

Minting, burning, freezing, and other sovereign monetary operations are not ordinary public account operations.

They require the authorization rules of the relevant Tier 1 consortium and the corresponding consensus threshold.

This prevents the public permissionless environment from being confused with a sovereign monetary authority.

## 11.10 Cross Tier Addresses

A cryptographic address is not inherently a Tier 1 address, Tier 2 identity, or Tier 3 identity.

The domain in which the address operates supplies the applicable authorization rules.

The same cryptographic identifier can therefore participate in multiple Pyde environments without creating a universal legal identity system.

## 11.11 Summary

Pyde uses one underlying account model with profile specific authority.

The protocol controls cryptographic account state.

Jurisdictions and institutions control the legal and regulatory meaning attached to that state.

Identity remains external to the ledger, while authorization relevant state can be represented and enforced on chain.
