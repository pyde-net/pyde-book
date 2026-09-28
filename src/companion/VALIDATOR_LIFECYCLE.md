# Pyde Validator Lifecycle

Validator participation depends on the operating environment.

## 1. Tier 1 Validators

Tier 1 validators are authorized sovereign agencies.

The lifecycle is controlled by the participating consortium. Registration, activation, suspension, replacement, and removal are governed by the jurisdiction's authority model.

Tier 1 validators do not depend on an open PYDE stake market to obtain sovereign authority.

## 2. Tier 2 Validators

Tier 2 is an open validator network.

A participant must satisfy the published validator requirements, operate the required software, maintain the required connectivity and availability, and provide the required economic security or stake.

The exact minimum and slashing parameters are protocol parameters and must be read from the current Tier 2 deployment specification rather than inherited from the historical single tier Layer 1 model.

### Lifecycle

```text
eligible
   ↓
registered
   ↓
active
   ↓
unbonding
   ↓
exited
```

A validator can also enter a suspended or jailed state under the applicable security rules.

## 3. Tier 3 Validators

Tier 3 follows the public network's validator registration, selection, staking, unbonding, and slashing rules.

The current implementation documents these mechanics in the validator and consensus specifications.

## 4. Validator Responsibilities

A validator is responsible for:

- maintaining a correct node implementation;
- participating in consensus when selected;
- preserving the protocol's safety and liveness requirements;
- maintaining secure key material;
- keeping node software synchronized with approved protocol versions;
- responding to operational incidents.

## 5. Slashing

Slashing exists to make protocol safety violations economically costly.

The offense set and penalties depend on the validator environment and must be defined in the current slashing specification.

The validator lifecycle should therefore never be interpreted as a generic yield program. Stake is first an economic security mechanism. Any validator compensation is a protocol rule for work performed.
