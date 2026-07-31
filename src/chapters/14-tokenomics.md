# Chapter 14: Tokenomics

PYDE is the network's native token. It pays for gas, secures consensus
through validator staking, and funds protocol work via the treasury. This
chapter covers the on-chain mechanics: supply and the capped emission tap,
the fee split, validator pay, the vesting + airdrop machinery that ships
at genesis, and the treasury that funds ongoing protocol work.

Numbers are taken from the actual code constants in `crates/tx/src/fee.rs`
and `crates/tx/src/distributor.rs`, not from aspirational projections.
Where a parameter is set at genesis (as opposed to hard-coded), the
chapter says so.

---

## 14.1 Denomination

PYDE has **9 decimals**: 1 PYDE = 1,000,000,000 quanta (10^9).

```
1 quanta        = 0.000000001 PYDE
1 micro-PYDE    = 1,000 quanta            (10^-6 PYDE)
1 milli-PYDE    = 1,000,000 quanta        (10^-3 PYDE)
1 PYDE          = 1,000,000,000 quanta    (10^9)
1 kilo-PYDE     = 10^12 quanta             (10^3 PYDE)
1 mega-PYDE     = 10^15 quanta             (10^6 PYDE)
```

All on-chain balances are stored as unsigned 128-bit integers in quanta.
This easily covers the genesis supply of 1B PYDE (= 10^18 quanta) without
overflow risk, and provides enough precision for micro-transactions.

(Note: Pyde's denomination is **not** Ethereum's 10^18 wei scale. SDKs
expose the correct conversion automatically.)

---

## 14.2 Genesis Supply

Genesis supply: **1,000,000,000 PYDE** (1 billion).

```rust
pub const GENESIS_SUPPLY_QUANTA: u128 = 1_000_000_000_000_000_000;  // 10^18 quanta
```

(`crates/tx/src/distributor.rs`; mirrored as
`Genesis::TOTAL_SUPPLY_QUANTA` in `crates/types/src/genesis.rs` with a
compile-time drift guard pinning the two equal.)

This is the entire on-chain PYDE in existence at wave 0. From then on,
new PYDE enters circulation only through the capped shortfall mint
(§14.3); there is no other issuance path.

### Distribution

The genesis allocation is set in the genesis manifest TOML; the on-chain
machinery enforces:

- **Supply conservation**: `Genesis::validate_supply_conserved` requires
  committee stakes + prefund balances + treasury + any airdrop pool to
  sum to exactly 10^18 quanta. A manifest that does not sum to the whole
  refuses to boot.
- **Vesting schedules**: most non-validator allocations are subject to
  on-chain vesting (see §14.6).
- **Airdrop pool**: genesis may seed an airdrop account with the expected
  total; claims draw against it; the residual sweeps to the treasury after
  the deadline.

The exact percentages between buckets (treasury, team vesting, ecosystem,
airdrop) are genesis-manifest parameters rather than protocol constants.
The launch genesis is finalized during the genesis key ceremony. There is
no reward endowment bucket: validator pay is funded by fees plus the
capped mint (§14.3), so nothing must be pre-funded for it.

### Supply is not fixed; issuance is capped

The genesis amount is exact, but the ongoing supply is not frozen at it.
Two forces act on it:

- the **30% fee burn** (§14.4) permanently removes PYDE from circulation
  with every transaction, and
- the **shortfall mint** (§14.3) adds PYDE back, but only up to the
  validator wage bill and never more than the hard emission cap of about
  1% of genesis supply per year.

The two roughly cancel: supply hovers near 1B, drifting mildly down when
fees are strong (mint 0, burn > 0) and mildly up (bounded by the cap)
only in a genuine fee drought. The live figure is queryable at any time:
`pyde_getSupply` returns `net_supply = genesis + TOTAL_MINTED −
TOTAL_BURNED`.

---

## 14.3 Supply and Emission: the Capped Tap

There is no inflation schedule. Issuance is a **shortfall-only mint**
that runs once per epoch inside the reward distributor
(`crates/tx/src/distributor.rs`), in strict priority order:

1. **Fees pay first.** The reward pool accrues 50% of every wave's fees
   (§14.4), plus any surplus escrowed from past fee-boom epochs. All of
   it is spent toward the validator wage bill before a single quanta is
   minted.
2. **The tap mints only the gap.** When the pool cannot cover the wage
   bill, the protocol mints exactly
   `max(0, wage_target − pool_balance)` into the pool. Real usage closes
   the gap and the tap stays shut.
3. **A hard, one-way-down cap** bounds the mint per epoch:

```rust
pub const EMISSION_CAP_BPS: u128 = 100;                    // ~1%/yr of genesis supply
pub const EMISSION_CAP_PER_EPOCH_QUANTA: u128 = 3_424_657_534_246;
```

The cap may only be lowered by coordinated release, never raised, so
holders have a permanent ceiling on issuance. At the current wage the
full 128-seat bill is about 0.51% of genesis supply per year, comfortably
under the 1% cap; the cap is a fee-drought backstop, not a target.

### The wage bill

```rust
pub const WAGE_CAP_PER_SEAT_EPOCH: u128 = 13_698_630_136;  // ≈13.70 PYDE/seat/epoch
```

At the production epoch length (21,600 waves of 500 ms, ~3 hours; 2,920
epochs per year) this is **40,000 PYDE per seat per year**. A per-seat
wage cap also bounds the payout in a fee boom: the excess stays escrowed
in the pool, spent before the tap ever reopens, rather than overpaying
seats. A compile-time invariant fails the build if a retune ever lets the
full wage bill reach the emission cap.

### Accounting

Every minted quanta advances the `TOTAL_MINTED` counter (system slot
`0x1C`), the mint-side mirror of `TOTAL_BURNED` (slot `0x16`). The
`pyde_getSupply` RPC exposes `genesis`, `minted`, `burned`, and
`net_supply` so anyone can audit issuance against the cap at any time.

### Why this shape

- **Guaranteed validator pay even at zero fees.** The mint covers the
  wage floor, so security is funded from day one without a draining
  genesis endowment or a distant funding cliff.
- **Usage retires the mint.** As fee volume grows, fees fund the wage and
  the mint tends toward zero. The burn then dominates and net issuance
  goes negative.
- **A purely frozen supply was rejected deliberately.** A token that can
  only shrink rewards holding over using, which is the wrong incentive
  for a high-throughput utility chain, and a finite reward endowment
  would have created a fork-or-die funding cliff roughly a decade out.
  This model was adopted 2026-07-17; the design record is
  `pyde-economics-model-spec.md` in the engine repository.

---

## 14.4 Fee Distribution: 30 / 50 / 20

Every transaction fee splits deterministically (Chapter 10):

```rust
pub const BURN_BPS: u128        = 3_000;   // 30% burned
pub const REWARD_POOL_BPS: u128 = 5_000;   // 50% to the validator reward pool
// treasury takes the remainder (20%), catching rounding dust
```

(`crates/tx/src/fee.rs`)

The split is computed per transaction from `receipt.fee_paid` and applied
once per wave by `apply_wave_fee_credits`, inside the shared serial
commit path, so the committer, the wave replayer, state-sync catch-up,
and recovery all derive identical credited state roots. Summing per
transaction (never re-splitting a wave total) plus remainder-to-treasury
means rounding dust never disappears: burned + reward + treasury equals
fees paid, exactly.

### Where each share goes

- **Burn (30%)**: advances the on-chain `TOTAL_BURNED` counter (system
  slot `0x16`). Permanently removes PYDE from circulation.
- **Reward pool (50%)**: credited to the `pyde-reward-pool` system
  account (no transaction spend path). This is validator pay, drained
  once per epoch by the distributor (§14.5).
- **Treasury (20%)**: credited to the treasury account. Spent through
  `MultisigTx` (Chapter 15).

### Why this split

- **Validators get the majority of fees.** The 50% pool share ties
  validator revenue to real usage, which is what retires the mint.
- **The burn is a tunable garnish, not the point.** 30% is the launch
  value; the burn's job is to offset the mint so net issuance stays near
  zero. At high volume a large burn would drain supply, so the policy is
  to scale it down with volume by coordinated release, the same
  capture-avoidance stance as the emission cap.
- **MEV resistance layering.** A would-be extractor burns 30% of captured
  value on top of the keyless commit-reveal ordering protections
  (Chapter 9).

### Net issuance

Net issuance per year = mint − burn. The mint is bounded above by the
emission cap (~1% of genesis supply) and tends to zero as fees grow; the
burn grows with usage without bound. The crossover where burn exceeds
mint arrives at modest sustained fee volume, and past it the network is
net negative on issuance. No fixed schedule forces either side: the
`pyde_getSupply` RPC reports the realized balance at any time.

---

## 14.5 Validator Economics

### Single-tier staking

```rust
pub const MIN_VALIDATOR_STAKE: u128 = 10_000_000_000_000;   // 10,000 PYDE
```

| Role | Min stake | Committee role | Earns |
|------|-----------|----------------|-------|
| **Validator** | 10,000 PYDE | Eligible for committee selection each epoch (up to 128 seats) | Per-seat wage while on the committee, paid per epoch from the reward pool: 50% split flat-equal across active seats, 50% weighted by consensus work actually done (§14.5 income). Stake above the minimum earns nothing extra |
| RPC node | none | None | Off-chain RPC fees only |

**Single pool, no tiers.** Every validator meeting the 10K PYDE minimum is
in the same pool. At each epoch boundary, uniform-random selection picks
128 from the pool to form the active committee for that epoch (see
Chapter 6 §7). There is no "committee tier" vs. "non-committee tier":
just one validator role, with committee duty rotating per epoch.

**Equal voting in committee.** All 128 committee members have equal vote
weight regardless of stake. To get additional selection probability, a
wealthy staker must register multiple distinct validators with separate
FALCON keys and operator identities, and each faces independent slashing
exposure plus the per-operator cap (see below).

**Why 10K, not higher.** Pyde's MEV-extraction attack value is structurally
near-zero (the keyless commit-reveal mempool fixes ordering before
content is revealed, removing the profit motive that drives large
stake floors elsewhere). With the attack-incentive removed, stake serves as a
credible-commitment deposit against slashable misbehavior rather than as the
load-bearing economic defense. Pyde's Sybil resistance is layered
(operator-identity cap + slashing + commit-reveal ordering + state-root
divergence detection); see Chapter 16 §16.4 for the full security argument.

The 10K floor matches the spirit of Ethereum's "Lean Consensus" direction
(reducing 32 ETH → 4 ETH as fast finality reduces reversibility-window
risk) and keeps the modest-hardware-decentralization promise intact: at
realistic launch valuations, the bond is accessible without being
trivial.

**Anti-Sybil: operator-identity cap.** Maximum 3 validators per operator
identity. An attacker pursuing a Byzantine fork needs 43 committee slots,
which translates to ≥ 15 distinct KYC'd operator identities under the
cap, meaningfully harder to manufacture than capital alone.

### Income: the per-epoch wage

Validator pay is a **wage for work done**, not a yield on capital. All
seats have equal power and do the same job, so paying more for more stake
would pay for nothing and re-centralize the chain. Stake stays out of the
payout entirely.

Once per epoch (~3 hours), the distributor drains the reward pool budget
to each `Active` seat's operator account:

- **50% flat-equal** across the active seats (`REWARD_FLAT_BPS = 5_000`),
- **50% weighted by committed anchor leadership**: each seat's share of
  the waves it actually led within the epoch. The signal is
  `WaveCommitRecord.anchor_member_id`, a FALCON-signed field every
  committer, replayer, and recovery path already agrees on, so the payout
  is deterministic on every node.

The budget is funded fees-first from the pool, topped up by the shortfall
mint (§14.3), and bounded per seat by the wage cap. A participation
floor, under which a seat that barely showed up earns zero for the epoch,
is designed and lands with the open-committee phase.

This is the shape proven by Polkadot's era-points model (equal power,
work-measured pay, live since 2020), with Aptos's work-fraction formula
and a Cosmos-style floor.

### Payment mechanics

Rewards are pushed automatically: the distributor credits each operator
account at the epoch boundary inside the shared commit path. There is
nothing to claim for rewards; the historical claim-based accrual lane
(`ClaimReward`, a per-stake accumulator) is not how validator pay works.
The unbonding flow (§14.5 lifecycle) remains the path that returns the
stake itself after exit.

### Validator status lifecycle

```rust
enum Status {
    Active    = 0x00,
    Unbonding = 0x01,
    Exited    = 0x02,
}
```

Transitions:

```
register     ->  Active
StakeWithdraw ->  Unbonding (30-day countdown)
unbond expires -> Exited (stake returned, removed from pool)
slashed (forced) -> Exited (stake reduced or zero)
```

### Unbonding period

```rust
pub const UNBONDING_PERIOD_DAYS: u64 = 30;   // wall-clock, independent of consensus cadence
```

(`crates/consensus/src/validator.rs`)

A validator who initiates `StakeWithdraw` (tx type 4) cannot reclaim their
stake until 30 days have passed. The period must exceed the
21-day safety-evidence freshness window so attackers cannot withdraw before
their offense becomes provable.

During the unbonding window:

- Status is `Unbonding`.
- Stake is locked.
- Validator no longer signs (removed from active committee).
- Pending rewards continue to accrue and can be claimed via `ClaimReward`.
- Slashing for past offenses still applies; the unbonding window exists
  precisely so post-exit evidence can still penalize.

After 30 days, an explicit follow-up sweeps the unbonded stake back to
the validator's spendable balance and marks them `Exited`.

### Slashing

Reused from Chapter 6 and [companion/SLASHING.md](../companion/SLASHING.md). Penalties scale with stake
(percentages of the offender's at-risk stake at the time of offense):

| Offense                          | Penalty (% of stake)   |
| -------------------------------- | ---------------------- |
| Double signing (safety)          | 100% + permanent ban   |
| Equivocation (DAG fork at round) | 100% + permanent ban   |
| Liveness < 90% per epoch         | 1% per epoch           |
| Liveness < 50% per epoch         | 5% + jail (next epoch) |
| Liveness == 0% per epoch         | 10% + forced unbonding |
| Invalid vertex production         | 50% (with proof)       |
| Decryption withholding           | 2% per offense (jail at 3) |
| Sentry exposure violation         | 1% (warning escalation)|

Of every slashed amount:

- 10% pays the evidence submitter (`FINDER_FEE_PERCENT`).
- 90% is burned.

This permissionless evidence-and-burn model means anyone who detects
misbehavior is incentivized to submit it, and slashed PYDE is removed from
circulation rather than redistributed (preventing perverse "slashing
profit" incentives).

### Indicative operator pay

There is no advertised APY. Pyde deliberately does not promise a yield on
staked capital: the 10K PYDE bond is a security deposit, and pay is a
wage for consensus work, so the honest unit is PYDE per seat per year.

- **Wage cap:** 40,000 PYDE per seat per year (~13.70 PYDE per epoch),
  the most a fully participating seat can earn.
- **Floor:** even at zero fee volume the shortfall mint funds the wage,
  so a working seat is paid from day one.
- **Within an epoch**, a seat's actual pay scales with the 50/50
  flat/leadership blend: a seat that led more committed waves earns more
  of the weighted half.

The wage cap is a protocol constant retunable only by coordinated
release. It is a ceiling, not a promise: real pay depends on
participation, and the figure is denominated in PYDE, whose price the
protocol does not control.

---

## 14.6 Vesting

Genesis allocations (team, ecosystem) are subject to on-chain vesting.

```rust
struct VestingSchedule {
    start_wave:     u64,
    cliff_waves:    u64,
    duration_waves: u64,
    total_amount:   u128,
}
```

(`crates/tx/src/vesting.rs:29-34`, wire format 40 bytes:
`start:8 || cliff:8 || duration:8 || total:16` LE)

### Unlock curve

```
wave_id < start + cliff             -> unlocked = 0
wave_id >= start + duration         -> unlocked = total_amount
otherwise                            -> unlocked = total_amount * (wave_id - start) / duration
```

### Cliff > duration safeguard

A genesis misconfiguration where `cliff > duration` would trap funds
forever (the cliff fires before the duration ends, then the duration
"ends" but the cliff still applies). The slice-5.1 audit fix prioritizes
end-of-vesting over cliff:

```rust
if wave_id >= start + duration {
    return total_amount;          // FULL UNLOCK regardless of cliff
}
if wave_id < start + cliff {
    return 0;
}
// linear interpolation
```

Plus genesis validation rejects schedules where `cliff > duration`.

### Validation integration

Every transaction validation reads the sender's vesting schedule and
subtracts `vesting.locked_at(current_wave_id)` from the account's balance
before checking that the sender can pay `gas_limit * base_fee + value`. A
sender cannot transfer locked tokens; the protocol enforces it at
ingress.

---

## 14.7 Airdrop

Genesis ships an airdrop pool with claims gated by Merkle proof.

### State

| Discriminator | Name                  | Holds                                |
| ------------- | --------------------- | ------------------------------------ |
| `0x18`        | `AIRDROP_ROOT`        | Merkle root of the airdrop list       |
| `0x19`        | `AIRDROP_DEADLINE`    | Slot height after which sweep is allowed|
| `0x1A`        | `AIRDROP_CLAIMED`     | Per-leaf-index claim flag             |
| `0x1B`        | `AIRDROP_EXPECTED_SUM`| Genesis pool size (sanity check)      |

The airdrop pool account lives at `Poseidon2("pyde-airdrop-pool")`. At
genesis, the pool is funded with `AIRDROP_EXPECTED_SUM` (sanity check
against drift between the off-chain Merkle builder and the genesis
balance).

### Merkle tree format

```
Leaf:     Poseidon2(0x00 || leaf_index_le8 || address || amount_le16)
Internal: poseidon2_pair(left, right)

Direction bit comes from the leaf_index (prevents sorted-pair attacks where
an attacker could swap left and right siblings to forge a proof).
```

### Claim flow (tx type 7)

```
data = [leaf_index:8 LE][amount:16 LE][proof_len:1][sibling_0:32]...[sibling_N-1:32]

ClaimAirdrop handler:
  1. Check current_wave_id <= AIRDROP_DEADLINE.
  2. Check claim hasn't been redeemed (AIRDROP_CLAIMED bit unset).
  3. Verify Merkle path against AIRDROP_ROOT.
  4. Debit pool by amount; credit claimant.
  5. Set the claim bit.
```

Gas: 30,000 base + 5,000 per Merkle level. Early gas guard rejects if
`tx.gas_limit < required_gas` *before* mutating any state (fixed in PR
#212 to prevent under-paid claims from drifting state). Max proof length
is 255 levels.

### Sweep flow (tx type 8)

After the deadline, anyone can call `SweepAirdrop`:

```
SweepAirdrop handler (any sender):
  1. Check current_wave_id > AIRDROP_DEADLINE.
  2. Move pool's residual balance to the treasury account.
```

Gas: 40,000 flat. The sweep is permissionless because the funds belong to
the protocol; anyone can submit it once the window closes. The early-gas
guard pattern applies here too.

---

## 14.8 Treasury

The treasury is a system account at `Poseidon2("pyde-treasury")`. It
accumulates value from three streams:

1. **Genesis allocation**: direct allocation in the genesis config.
2. **Fee share**: 10% of every transaction fee.
3. **Inflation share**: a configurable share of per-block mint.
4. **Airdrop residual**: whatever wasn't claimed by the deadline.

Treasury spending is **always** through the on-chain `MultisigTx` (tx
type 9). There is no other path that drains the treasury account
(enforced by the pipeline writeback-clobber protections; see §14.9).

### `MultisigTx` payload

```rust
struct MultisigSpend {
    target:      Address,
    value:       u128,
    data_digest: [u8; 32],   // hash(pip_file_contents) — audit trail to PIP
}
```

The `data_digest` field is the on-chain link to the off-chain PIP
(Pyde Improvement Proposal) document. Anyone auditing the chain can
recover the PIP from its hash, verify the signers approved that exact
spend, and trace the on-chain action back to a published proposal.

### Multisig configuration

| Discriminator | Name                | Holds                                |
| ------------- | ------------------- | ------------------------------------ |
| `0x1C`        | `MULTISIG_SIGNERS`  | Length-prefixed array of FALCON pks   |
| `0x1D`        | `MULTISIG_THRESHOLD`| Required signature count (`u8`)       |
| `0x1E`        | `MULTISIG_NONCE`    | Replay-protection counter             |

Max signers: 16 (`MAX_MULTISIG_SIGNERS`). Each spend bumps
`MULTISIG_NONCE` so the same signed bytes cannot be replayed.

Wire format (`MultisigPayload` in `crates/tx/src/multisig.rs`):

```
[op_version: 1] [op_body: variable] [sig_count: 1]
[sig_entry_0] ... [sig_entry_N-1]

sig_entry = [signer_index: 1] [sig_len: 2 LE] [falcon_sig: sig_len]
op_version = 0x01 (MULTISIG_VERSION)
```

Gas: 50,000 base + 50,000 per signature.

### Rotating the signer set

`RotateMultisig` (tx type 10):

```rust
struct MultisigRotate {
    new_signer_pks: Vec<Vec<u8>>,    // each is a 897-byte FALCON pk
    new_threshold:  u8,
}
```

Rotation requires the **current** signer set to authorize. Validation
checks: at least one new signer, threshold ≤ new signer count.

Gas: 60,000 base + 50,000 per signature + 10,000 per new signer.

---

## 14.9 Emergency Pause

A multisig-authorized circuit breaker that halts all transactions except
`EmergencyResume`.

### Pause (tx type 11)

```rust
struct EmergencyPausePayload {
    duration_waves: u64,
    sigs:           Vec<SigEntry>,
}
```

- `duration_waves ∈ [1, MAX_PAUSE_DURATION_WAVES]` where the cap is
  6,500,000 slots (≈ 30 days). Reject zero or excessive durations.
- Reject re-pause if the chain is already paused.
- Sets `EMERGENCY_PAUSE_END_WAVE` (discriminator `0x1F`) =
  `current_wave_id + duration_waves`.
- Bumps multisig nonce.
- Gas: 40,000 base + 50,000 per signature.

### Resume (tx type 12)

```rust
struct EmergencyResumePayload {
    sigs: Vec<SigEntry>,
}
```

- Requires the chain to be currently paused.
- Zeros `EMERGENCY_PAUSE_END_WAVE`.
- Bumps multisig nonce.
- Gas: 40,000 base + 50,000 per signature.

### Pause-gate semantics

`is_paused(state, current_wave_id)` returns true if
`current_wave_id < EMERGENCY_PAUSE_END_WAVE`. While paused, the pipeline
rejects every transaction type **except** `EmergencyResume` *before*
running validation or charging gas. This means a paused chain cannot be
spammed into draining gas budgets.

The pause auto-expires (`current_wave_id >= end_wave`) without an explicit
sweep; the gate just stops returning true. This means the worst case for
a runaway pause is the 30-day cap, never indefinite.

### Use cases

- Critical bug discovered after audit but before fix is deployed.
- Active exploit being mitigated; pause halts state mutation until a fix
  ships.
- Coordinated upgrade window (rare; voluntary upgrades are the normal
  path, see Chapter 18).

The signer set should be picked specifically for crisis response (likely
core developers + security team multisig), not the same set that signs
treasury spends. This is a configuration decision, not a protocol
constraint.

---

## 14.10 Writeback Clobber Protection

A subtle pipeline interaction: every transaction's post-execution stage
unconditionally writes the sender's and recipient's account state back to
the JMT. If a `MultisigTx` handler credits a `target` that collides with
either `tx.from` or `tx.to`, the writeback would overwrite the credit.

The fix:

- `MultisigTx` rejects if `spend.target == tx.from` (submitter).
- `MultisigTx` rejects if `tx.to != Address::ZERO` (must not collide with
  a regular tx target).

Same defenses are applied to `RotateMultisig` to prevent any signer
collision from clobbering the signer-set update.

---

## 14.11 Distributor Inputs and Unified Parsing

The payout is deterministic because every input the distributor reads is
on-chain JMT state, identical on the committer, the wave replayer,
state-sync catch-up, and recovery:

- **`COMMITTEE_REGISTRY`** (slot `0x28`): the settled epoch's
  `member_id → operator` map, so consensus work resolves to the right
  operator account.
- **Per-seat anchor-leadership tally** (slot `0x1D`): incremented every
  committed wave in the shared path from
  `WaveCommitRecord.anchor_member_id`, the FALCON-signed effort signal.
- **The `Active` filter**: only seats in `Active` status are paid.
  `Unbonding` and `Exited` validators earn nothing, so exits never dilute
  or collect from the pool.

Deliberately not inputs, because each would fork replay: the
consensus-store committee snapshot, live gossip support sets, and
anything derived from the node-local beacon state.

`ValidatorEntry` parsing is unified through `ValidatorEntry::decode()`:
the same parser is used by every consensus and tx-handler call site.
Length: 4 + 897 (FALCON pk) + 16 (stake u128) + 1 (status) + 16
(last_claimed_at u128) = **934 bytes**.

(This unification fixed a genesis bug where an earlier per-call-site
parser returned `None` on every genesis validator, surfaced and fixed in
multi-node test #228.)

---

## 14.12 Long-Run Equilibrium

The model targets a supply that hovers near the 1B genesis amount:

| Regime            | Mint                         | Burn          | Net       |
| ----------------- | ---------------------------- | ------------- | --------- |
| Fee drought       | Wage shortfall (≤ cap ~1%/yr) | Small         | Mild positive, bounded |
| Growing usage     | Shrinking toward zero        | Growing       | Near zero |
| Strong usage      | Zero (fees cover the wage)   | Full 30% flow | Negative  |

The mint exists to fund security, not to pay holders; the burn exists to
offset the mint, not to promise deflation. Neither side is on a schedule,
so the honest statement is the invariant, not a forecast: issuance can
never exceed about 1% of genesis supply per year, tends to zero as usage
grows, and the realized balance is auditable on-chain via
`pyde_getSupply` at any moment.

---

## Summary

| Property                | Value                                              |
| ----------------------- | -------------------------------------------------- |
| Native token            | PYDE                                                |
| Decimals                | 9 (1 PYDE = 10^9 quanta)                           |
| Genesis supply          | 1,000,000,000 PYDE (hovers near this; not frozen)   |
| Issuance                | Shortfall-only mint, hard-capped ~1%/yr, one-way-down |
| Validator wage cap      | 40,000 PYDE per seat per year (≈13.70 PYDE/epoch)   |
| Payout blend            | 50% flat-equal / 50% weighted by committed anchor leadership |
| Fee distribution        | 30% burn / 50% reward pool / 20% treasury           |
| Supply audit            | `pyde_getSupply` (genesis, minted, burned, net)     |
| Validator stake (min)   | 10,000 PYDE (single tier, uniform-random committee selection) |
| Operator-identity cap   | 3 validators per operator                            |
| Unbonding period        | 30 days (must exceed 21-day safety evidence freshness) |
| Slashing finder fee     | 10% of slashed amount                               |
| Vesting                 | On-chain, balance-locked at validation              |
| Airdrop                 | Merkle-proof claim, Sweep after deadline             |
| Treasury spend          | `MultisigTx` (type 9) + PIP `data_digest` audit trail|
| Multisig signers        | Up to 16; threshold rotatable via `RotateMultisig`   |
| Multisig threshold (governance)| 7-of-12 typical (set at launch)              |
| Emergency pause         | `EmergencyPause` (type 11), max 30 days              |

The next chapter covers governance: how PIPs (Pyde Improvement Proposals)
become on-chain `MultisigTx` actions, and what scope governance has versus
what's hard-coded.
