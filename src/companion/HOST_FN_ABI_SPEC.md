# Pyde Host Function ABI Specification

This document defines the WebAssembly host interface used by Pyde contracts.

The host ABI is the boundary between deterministic contract execution and protocol state.

## 1. Scope

The current public ABI covers:

- storage;
- balances and transfers;
- account and transaction context;
- events;
- hashing;
- post quantum signature verification;
- contract to contract calls;
- gas accounting;
- approved protocol queries.

## 2. Profile Specific Capabilities

Pyde does not assume that every network profile exposes the same execution surface.

Tier 1 can exclude capabilities that are incompatible with its sovereign authorization model.

Tier 2 exposes the capabilities required for settlement and coordination contracts.

Tier 3 exposes the permissionless public contract surface.

Profile specific capabilities should be selected or excluded through the network profile rather than represented as a generic public parachain runtime.

## 3. Determinism

The following are forbidden to ordinary contracts unless explicitly represented through deterministic protocol state:

- arbitrary network access;
- filesystem access;
- process state access;
- system wall clock access;
- nondeterministic randomness;
- nondeterministic host calls.

All validators executing the same canonical transaction must derive the same result.

## 4. Core Functions

### Storage

`sload`, `sstore`, `sdelete`

### Balances

`balance`, `transfer`

### Context

`caller`, `origin`, `self_address`, `wave_id`, `wave_timestamp`, `chain_id`

### Events

`emit_event`

### Hashing

`keccak256`, `blake3`, `poseidon2`

### Signatures

`falcon_verify`

### Contract Calls

`cross_call`, `cross_call_static`

### Gas

`consume_gas`

The exact signatures, memory rules, gas costs, and error codes remain implementation details of the current ABI and should be kept synchronized with the codebase.

## 5. Historical Interfaces

The repository previously defined a parachain specific host function namespace.

Those functions are superseded by the current Tier 2 settlement architecture unless a future protocol specification explicitly restores them.

The historical specification should be retained for archival purposes rather than presented as the current public ABI.
