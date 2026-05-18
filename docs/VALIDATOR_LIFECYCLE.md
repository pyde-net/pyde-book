# Pyde Validator Lifecycle

**Version 0.1 — May 2026**

This document specifies the validator state machine, operations, parameters, and anti-Sybil mechanisms.

## State Machine

```
[NOT REGISTERED]
    ↓ register_validator(stake ≥ 10K PYDE, falcon_pubkey, threshold_key)
[PENDING ACTIVATION] (1 epoch bonding period)
    ↓ next epoch boundary
[ACTIVE - WAITING] ←──────┐
    ↓ VRF selects          │ epoch ends (not re-selected)
[COMMITTEE - ACTIVE] ──────┘
    ↓ request_unbond()
[UNBONDING] (30 days)
    ↓ 30 days elapsed
[WITHDRAWABLE]
    ↓ withdraw()
[NOT REGISTERED]

Side states (from any active state):
  → [SLASHED]  (stake reduced; forced unbond if < min stake)
  → [JAILED]   (excluded from committee; unjail required)
```

## Parameters

| Parameter | Value | Notes |
|---|---|---|
| `MIN_STAKE` | 10,000 PYDE | Anti-Sybil minimum bond |
| `MAX_STAKE_PER_OPERATOR` | 50,000 PYDE | Cap at 5 validators per operator |
| `BONDING_PERIOD` | 1 epoch (~3 hours) | Time from registration to active eligibility |
| `UNBONDING_PERIOD` | 30 days | Long enough for safety evidence to surface |
| `EVIDENCE_FRESHNESS_SAFETY` | 21 days | Must be < unbonding period |
| `EVIDENCE_FRESHNESS_LIVENESS` | 1 epoch | Real-time only |
| `KEY_ROTATION_INTERVAL` | Max once per epoch | Prevents rotation abuse |
| `JAIL_PERIOD_1ST` | 24 hours | First jail |
| `JAIL_PERIOD_2ND` | 7 days | Within 30 days of first |
| `JAIL_3RD` | Permanent | 3rd jail = permanent removal |
| `UNJAIL_FEE` | 10 PYDE | Anti-griefing |
| `MAX_VALIDATORS_PER_OPERATOR` | 5 | Identity-bound cap |
| `SLASHING_ESCROW` | 24 hours | Dispute window before slash finalizes |
| `NEW_VALIDATOR_GRACE_EPOCHS` | 1 | 50% reduced slashing in first epoch |

## State Details

### [NOT REGISTERED]

Default state. Account is a user wallet, not a validator.

### [PENDING ACTIVATION]

Registered with stake, waiting to become eligible.

- Triggered by: `register_validator(stake, falcon_pubkey, threshold_verify_key, operator_identity)`
- Stake is locked
- Earns nothing during pending
- Auto-transitions to ACTIVE-WAITING at next epoch boundary

### [ACTIVE - WAITING]

In the pool, eligible for VRF selection into committee.

- Conditions: stake ≥ MIN_STAKE AND not jailed AND grace period passed
- Earns: flat 30% pool yield (proportional to stake)
- Selected randomly for committee at each epoch boundary
- Cannot be slashed for liveness (no committee duties)
- Can still be slashed for safety (e.g., late-submitted equivocation evidence)

### [COMMITTEE - ACTIVE]

Selected for current epoch as one of 128 active members.

- Duties: vertex production, decryption shares, DKG participation, state-root signing
- Earns: activity-weighted share of 70% committee pool + flat 30% pool yield + inflation share
- Subject to full slashing (safety + liveness)
- Loops back to ACTIVE-WAITING at next epoch boundary unless re-selected

### [UNBONDING]

Exiting voluntarily.

- Triggered by: `request_unbond()`
- Stake locked for 30 days
- Cannot be selected for committee
- Cannot earn rewards
- Can still be slashed for offenses within freshness window
- Auto-transitions to WITHDRAWABLE after 30 days

### [WITHDRAWABLE]

Stake unlocked, claim available.

- Triggered after 30-day unbonding completes
- User calls `withdraw()` to claim remaining stake (after any slashing)
- Transitions to NOT REGISTERED
- Frees operator slot for new validator registration

### [SLASHED] (Modifier)

- Stake reduced by slash amount
- If remaining stake < MIN_STAKE → forced unbonding
- 24-hour slashing escrow before distribution applied
- See [SLASHING.md](./SLASHING.md) for full slashing details

### [JAILED] (Modifier)

- Excluded from committee at next epoch boundary
- Cannot be selected during jail period
- Stake still locked (not unbonding)
- Requires `unjail()` transaction to rejoin pool
- Escalates: 24h → 7d → permanent

## Operations

### Register Validator

```rust
fn register_validator(
    stake: u64,
    falcon_pubkey: FalconPubkey,
    threshold_verify_key: ThresholdVerifyKey,
    operator_identity: Address,  // anti-Sybil binding
) -> ValidatorId

// Preconditions:
//   - stake >= MIN_STAKE
//   - operator_identity has < MAX_VALIDATORS_PER_OPERATOR validators
//   - sender has sufficient balance
//
// Effects:
//   - Transfer stake to bonded escrow
//   - Set state = PENDING_ACTIVATION
//   - Activation epoch = current_epoch + 1
//   - Emit ValidatorRegistered event
```

### Request Unbond

```rust
fn request_unbond(validator_id: ValidatorId) -> UnbondingClaim

// Preconditions:
//   - Caller is validator's stake account
//   - State is ACTIVE-WAITING or COMMITTEE-ACTIVE
//   - If COMMITTEE-ACTIVE: complete current epoch first
//
// Effects:
//   - Set state = UNBONDING
//   - withdrawable_at = current_time + UNBONDING_PERIOD
//   - Emit ValidatorUnbonding event
```

### Withdraw

```rust
fn withdraw(validator_id: ValidatorId) -> u64

// Preconditions:
//   - Caller is validator's stake account
//   - State is WITHDRAWABLE
//   - No unresolved slashing escrow
//
// Effects:
//   - Compute remaining stake (after any slashing)
//   - Transfer to operator account
//   - Set state = NOT_REGISTERED
//   - Free up operator slot
//   - Emit ValidatorWithdrawn event
```

### Rotate Keys

```rust
fn rotate_keys(
    validator_id: ValidatorId,
    new_falcon_pubkey: FalconPubkey,
    new_threshold_verify_key: ThresholdVerifyKey,
) -> Result

// Preconditions:
//   - Caller is validator's stake account
//   - Last rotation > KEY_ROTATION_INTERVAL ago
//   - State is ACTIVE-WAITING (not in committee — disruption risk)
//
// Effects:
//   - Update pubkeys in account state
//   - Effective at next epoch boundary
//   - Old pubkey kept for VERIFY ONLY during 1-epoch grace
//   - Emit KeyRotated event
```

### Unjail

```rust
fn unjail(validator_id: ValidatorId) -> Result

// Preconditions:
//   - State is JAILED
//   - Time since jail >= jail_period_for_this_offense
//   - Pays UNJAIL_FEE
//   - Remaining stake >= MIN_STAKE
//   - Not 3rd jail (permanent)
//
// Effects:
//   - Set state = ACTIVE-WAITING
//   - Eligible for next committee selection
//   - Emit ValidatorUnjailed event
```

## Anti-Sybil: Multiple Validators per Operator

Identity binding via `operator_identity` field:

- Default: same address as stake account (1:1 binding)
- Optional: multiple validators per operator if registered under same identity
- Cap: `MAX_VALIDATORS_PER_OPERATOR = 5`

### Why Cap?

- Sybil amplification: rich operator could otherwise run 50 cheap validators to win 50/128 committee slots
- Cap forces multi-operator diversity in committee
- 5 still allows operational diversity (HSM groups, redundant infrastructure)

### Optional Stronger Anti-Sybil

Escalating bond for additional validators:

| Validator slot | Required stake |
|---|---|
| 1st | 10,000 PYDE |
| 2nd | 10,000 PYDE |
| 3rd | 10,000 PYDE |
| 4th | 20,000 PYDE |
| 5th | 20,000 PYDE |

Reduces ROI on heavy concentration. (Optional; numbers tunable.)

## Committee Selection (Each Epoch)

```python
# At end of epoch N, derive committee for epoch N+1:
eligible = [v for v in all_validators if v.stake >= MIN_STAKE 
            and not v.jailed
            and v.grace_period_passed]

for slot in 0..128:
    seed = Hash(beacon || slot)
    member = uniform_random_pick(eligible, seed)
    committee[slot] = member
    eligible.remove(member)  # without replacement
```

**Selection is uniform random within eligible pool.** Stake influences only:
- Probability of being eligible (must meet MIN_STAKE)
- Proportion of flat 30% stake-pool yield

Stake does NOT influence committee selection probability. Equal probability among eligible validators.

## Edge Cases

### 1. Slashed below MIN_STAKE

- Validator forced into UNBONDING state
- 30-day countdown starts
- Cannot be re-selected during unbonding
- After unbonding, can re-register with fresh stake

### 2. Operator wants more validators

- Register new validator under same `operator_identity`
- Allowed up to `MAX_VALIDATORS_PER_OPERATOR`
- Each requires separate `MIN_STAKE`

### 3. Mid-Epoch Hardware Upgrade

- Key rotation requires ACTIVE-WAITING state
- P2P endpoint updates allowed any time (cosmetic)
- For key compromise: emergency rotation allowed any time (with higher fee + audit)

### 4. Operator Goes Bankrupt / Disappears

- Accumulates downtime slashing over ~3 epochs
- Eventually slashed below MIN_STAKE → forced unbond
- 30-day timer starts
- Stake withdrawable by operator's stake account after 30 days
- No "abandoned validator" cleanup needed; lifecycle handles it

## References

- Slashing details: see [SLASHING.md](./SLASHING.md)
- Committee selection (full algorithm): see [WHITEPAPER.md](./WHITEPAPER.md) §5.5
- Network protocol (peer addresses): see [NETWORK_PROTOCOL.md](./NETWORK_PROTOCOL.md)

---

**Document version:** 0.1
**Date:** 2026-05-18
**License:** See repository root
