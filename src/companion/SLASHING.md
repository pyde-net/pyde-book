# Pyde Slashing Rules

**Version 0.1**

This document specifies all slashable offenses, detection mechanisms, slash amounts, evidence flow, jail mechanics, and the interaction with the validator lifecycle.

**Numbers below are starting points.** Final numbers require economic modeling pre-mainnet and may be adjusted via PIP.

## Principles

1. **Safety vs Liveness distinction** — different severity, detection, and slash amounts
2. **Correlated slashing for safety** — coordinated attacks lose more
3. **Permissionless evidence** — anyone can submit cryptographic evidence; reporter reward incentivizes monitoring
4. **Bounded slashing** — per-epoch caps prevent stacking attacks

## Offense Catalog

### Safety Offenses (Severe, Cryptographic Evidence)

| # | Offense | First instance | Max (correlation/repeat) | Jail | Distribution |
|---|---|---|---|---|---|
| 1 | Equivocation (vertex) — two different vertices for same (round, member_id) | **10%** | 50% | 1 epoch | 50% burn / 30% treasury / 20% reporter |
| 2 | Bad state-root signature — two contradictory state roots for same commit | **10%** | 50% | 1 epoch | Same as above |
| 3 | Bad anchor attestation — vertex's prev_anchor_attestation contradicts 85+ honest majority | **5%** | 20% | 1 epoch | Same as above |
| 4 | Invalid vertex structure — parent refs out of order, refs to non-existent batches | **5%** | 30% | 1 epoch | 100% burn |
| 5 | Bad decryption share — partial that provably doesn't combine correctly | **5%** | 30% | 1 epoch | 50% burn / 30% treasury / 20% reporter |

### Liveness Offenses (Auto-Detected, Graduated)

| # | Offense | Per-event | Per-epoch cap | Jail | Distribution |
|---|---|---|---|---|---|
| 6 | DKG participation failure — invalid or missing shares during DKG | 2% | 10% | Until next epoch | 100% burn |
| 7 | Share withholding — no decryption share when expected | 0.1%/round missed | 5%/epoch | After 100 consecutive missed | 100% burn |
| 8 | Extended downtime — no vertices produced for N consecutive rounds | 0.05%/round | 10%/epoch | After 5% reached | 100% burn |
| 9 | Bad batch attestation — worker gossips batch with invalid txs | 2% | 5% | None (warning) | 100% burn |

### Future / Deferred

| # | Offense | Status |
|---|---|---|
| 10 | Censorship (provable, off-chain coordination) | v2 (requires cryptographic censorship commitments) |

## Correlation Multiplier (Safety Offenses Only)

To punish coordinated attacks and protect isolated failures:

```
correlation_multiplier = 1 + (other_offenders_this_epoch / max_byzantine)
                       = 1 + (k / 42)   for n=128
```

Caps at **2×** to avoid disproportionate punishment in bug scenarios.

| Other offenders | Multiplier | Effective slash (equivocation 10%) |
|---|---|---|
| 1 | 1.02× | 10.2% |
| 10 | 1.24× | 12.4% |
| 42 (max byzantine) | 2.0× | 20% |
| 43+ | 2.0× (cap) | 20% |

Combined with repeat-offense escalation, a coordinated 43-attack can hit the maximum 50% slash within an epoch.

## Slash Math (Percentages of Offender's Stake)

All percentages apply to the **offender's current stake at the time of
offense**. Pyde uses a single staking tier:

- Validators: minimum `MIN_VALIDATOR_STAKE` = 10,000 PYDE
- Operator-identity cap: 3 validators per operator (anti-Sybil)
- Real-world bonds will be higher than the minimum (rational operators
  stake more to absorb minor liveness penalties without falling below
  the floor)

```
Equivocation (10% × correlation × repeat) — minimum 10K PYDE bond:
  1st instance, alone:        1,000 PYDE
  1st instance, 42 others:    2,000 PYDE     (2× correlation cap)
  2nd instance, 42 others:    4,000 PYDE
  Capped at 50%:              5,000 PYDE     (full burn at the bond floor)

Downtime (0.05%/round) — minimum 10K PYDE bond, when serving on the active committee:
  10 rounds missed:           5 PYDE
  100 rounds missed:          50 PYDE        (5% — also triggers jail)
  At 10% epoch cap:           1,000 PYDE
```

Liveness penalties apply only while a validator is on the active
committee for the epoch. Validators awaiting selection have no per-round
liveness obligation (they can still be slashed for safety offenses with
freshness-window evidence).

## Evidence Submission

Permissionless: any node can submit evidence.

```rust
struct Evidence {
    offense_type: OffenseType,
    offender_id: ValidatorId,
    epoch: u64,
    proof: CryptographicProof,
    reporter_id: Option<Address>,  // for reward distribution
}

// Submission as a regular transaction (paid gas)
fn submit_evidence(evidence: Evidence) -> Result<()> {
    // Engine verifies cryptographic proof
    // If valid:
    //   - Stake slashed from offender (subject to 24h escrow)
    //   - Distribution applied (burn / treasury / reporter)
    //   - Jail status set if applicable
    //   - Event emitted for indexing
}
```

### Evidence Freshness Window

- **Safety offenses:** 21 days
- **Liveness offenses:** 1 epoch (real-time only)
- **DKG failures:** 1 epoch (same as ceremony)

Outside the window: cannot slash. Evidence becomes historical record but no enforcement.

### Reporter Cooldown

- Same reporter address: max **5 evidence transactions per epoch**
- Limits griefing (malicious reporter spamming invalid evidence)

## Jail Mechanics

When a validator is jailed:
- Removed from committee at next epoch boundary
- Cannot rejoin until `unjail()` transaction executed
- Unjail requirements:
  - Time elapsed ≥ jail period
  - Pays unjail fee (10 PYDE — anti-griefing)
  - Remaining stake ≥ minimum bond for the validator's tier
    (MIN_VALIDATOR_STAKE = 10K PYDE — single tier)

### Escalating Jail Periods

- **1st jail:** 24 hours
- **2nd jail within 30 days:** 7 days
- **3rd jail:** permanent removal (kicked out of validator set)

## Slashing Escrow (24-Hour Dispute Window)

To handle false-positive slashes:

```
Stake state machine:
  bonded → slashed_frozen → slashed_finalized
              (24h)
```

During the 24-hour escrow:
- Slashed stake is in "frozen" state (not yet destroyed)
- Governance multisig can void or reduce the slash
- After 24h with no dispute: slash finalizes (distribution applied)

This protects against bugs in slashing logic or contested circumstances (e.g., network partition that fooled detection).

## New Validator Grace Period

A validator in their first epoch has **50% reduced slashing** on all offenses. Encourages experimentation with new operational setups; bad actors can't hide forever (just one epoch).

## Unbonding Interaction

Critical: unbonding must exceed evidence freshness to prevent attack-then-exit.

```
Unbonding period: 30 days
Safety evidence freshness: 21 days
30 > 21 → prevents attacker withdrawing before evidence is submitted
```

State machine:
```
bonded → (request_unbond) → unbonding (30d) → withdrawable
                                  ↓
                            still slashable during unbonding
```

Slashing applies during BOTH bonded and unbonding states. After withdrawal (past 30 days): cannot slash.

## Edge Cases

### 1. Network Partition

If >43 validators go offline simultaneously due to network split:
- Downtime slashing PAUSES (auto-detected by protocol — committee active count < 85 → liveness mode)
- Resumes once active count ≥ 85
- Prevents punishing the 85+ honest majority while 43+ are partitioned

### 2. Key Compromise

Validator's key stolen, attacker double-signs:
- Slashing applies (your responsibility as key holder)
- Mitigations: HSM, key rotation, multisig validators (v2)
- No insurance pool (avoid moral hazard)

### 3. Chain Halt

If chain halts entirely:
- No automatic slashing during halt
- Manual investigation post-recovery
- Specific validators slashed only with cryptographic evidence

### 4. Hard Fork

If chain hard-forks:
- Slashing state migrates with the chain
- "Wrong-fork" validators on minority chain don't auto-slash (separate chains, separate state)

## Sanity Check

At the bond floor, total committee bond: 128 × 10K = **1.28M PYDE**.
In practice operators stake more to absorb minor penalties without
falling below the floor — realistic total committee bond depends on
actual operator behavior post-launch.

Max single-event slash at floor (42 offenders × equivocation × 2× correlation):
```
42 × 10K × 10% × 2.0 = 84K PYDE   (= 6.5% of total committee bond at floor)
```

Max correlated attack across epoch (42 offenders × 5 events × 2× correlation, capped at 50%):
```
42 × 10K × 50% = 210K PYDE        (= 16.4% of total committee bond at floor)
```

These dollar numbers are intentionally not the load-bearing deterrent.
Pyde's security argument (Chapter 16 §16.4) is that threshold encryption
removes the *attack-profit motive* entirely — there is no MEV-extraction
revenue to recoup. Stake serves as a credible-commitment deposit
against slashable misbehavior plus the input the slashing mechanism
has to slash. The operator-identity cap, KYC binding, and slashing-with-
finder's-fee do the heavy lifting on Sybil resistance.

## Implementation Notes

Slashing is implemented as system transactions handled by the engine:

```rust
// At evidence submission:
engine.execute_system_tx(SystemTx::SubmitEvidence(evidence));

// At slashing escrow expiry (24h after slash):
engine.execute_system_tx(SystemTx::FinalizeSlash(slash_id));

// At unjail request:
engine.execute_system_tx(SystemTx::Unjail(validator_id));
```

All slashing state is part of validator account state, indexed by validator_id.

## References

- Validator lifecycle: see [VALIDATOR_LIFECYCLE.md](./VALIDATOR_LIFECYCLE.md)
- Threat catalog (cross-reference): see [THREAT_MODEL.md](./THREAT_MODEL.md)
- Chain halt + recovery: see [CHAIN_HALT.md](./CHAIN_HALT.md)

---

**Document version:** 0.1
**License:** See repository root
