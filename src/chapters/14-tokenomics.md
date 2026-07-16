# Chapter 14: Tokenomics

PYDE is the network's native token. It pays for gas, secures consensus
through validator staking, and funds protocol work via the treasury. This
chapter covers the on-chain mechanics: supply, the inflation schedule, the
fee distribution, validator economics, the vesting + airdrop machinery
that ships at genesis, and the treasury that funds ongoing protocol work.

Numbers are taken from the actual code constants in `crates/tx/src/fee.rs`,
`crates/slashing/src/lib.rs`, and `crates/consensus/src/validator.rs` — not
from aspirational projections. Where a parameter is set at genesis (as
opposed to hard-coded), the chapter says so.

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

Genesis total supply: **1,000,000,000 PYDE** (1 billion).

```rust
pub const GENESIS_SUPPLY: u128 = 1_000_000_000 * 1_000_000_000;  // = 10^18 quanta
```

(`crates/tx/src/fee.rs:84`)

This is the entire on-chain PYDE in existence at block 0. From block 1
onward, new PYDE enters circulation only via the inflation schedule; no
other minting path exists.

### Distribution

The genesis allocation is set in the genesis configuration TOML; the
on-chain machinery enforces:

- **Per-bucket caps** — the genesis builder rejects allocations that
  exceed the per-category caps to prevent oversupply.
- **Vesting schedules** — most non-validator allocations are subject to
  on-chain vesting (see §14.6).
- **Validator subsidy stream** — a portion of the genesis pool is reserved
  for validator subsidy that streams over a fixed window (§14.4).
- **Airdrop pool** — genesis seeds an airdrop account with the expected
  total; claims draw against it; the residual sweeps to the treasury after
  the deadline.

The exact percentages between buckets (treasury, team vesting, ecosystem,
validator subsidy, airdrop) are governance-set parameters in the genesis
file rather than protocol constants. The launch genesis is finalized by
the Foundation in coordination with the validator set during the mainnet
genesis ceremony (Phase 10 of the launch plan).

### No supply cap

PYDE has no hard cap. The supply grows by a decreasing inflation rate and
shrinks via the 70% fee burn. At target throughput the burn exceeds
inflation and the network is net deflationary; at low throughput inflation
dominates. The equilibrium depends on usage.

---

## 14.3 Inflation Schedule

The inflation rate decreases on a year-by-year schedule:

```rust
pub const INFLATION_BPS: [u16; 4] = [
    500,   // year 1: 5.0%
    300,   // year 2: 3.0%
    200,   // year 3: 2.0%
    100,   // year 4+: 1.0% (terminal)
];
```

(`crates/tx/src/fee.rs:92-98`, expressed in basis points.)

```
Year   Annual rate
----   -----------
1      5.0%
2      3.0%
3      2.0%
4+     1.0%   (terminal — never decreases further)
```

The 1% terminal floor exists so validators always have a baseline reward
stream regardless of fee volume. At target throughput, fee burn easily
exceeds 1% inflation; at lean throughput, inflation keeps validator
economics viable.

### Per-wave inflation reward

```
waves_per_year = 63_113_904         (2 commits/sec * 86400 s/day * 365.25 days)

reward_per_wave = GENESIS_SUPPLY * inflation_rate_bps / (10_000 * waves_per_year)
```

At year 1 (5%):

```
reward_per_wave = 10^18 quanta * 500 / (10_000 * 63_113_904)
               ≈ 792,202,572 quanta
               ≈ 0.792 PYDE per wave
```

At year 4+ (1%):

```
reward_per_wave ≈ 158,440,514 quanta ≈ 0.158 PYDE per wave
```

This per-wave reward credits the reward pool and the treasury at the
shares specified by the on-chain reward distribution (see §14.4).

### Why a decreasing schedule

- **High initial inflation** bootstraps validator participation before fee
  volume exists.
- **Decreasing schedule** rewards token holders as the network matures —
  early validators were taking risk that later operators don't.
- **Terminal 1%** stays low enough that ordinary fee burn at any
  meaningful usage produces net deflation.

---

## 14.4 Fee Distribution: 70 / 20 / 10

Every transaction fee splits deterministically (Chapter 10):

```rust
pub const FEE_BURN_PCT: u64           = 70;    // burned (deflationary)
pub const FEE_REWARD_POOL_PCT: u64    = 20;    // distributed to stakers
pub const FEE_TREASURY_PCT: u64       = 10;    // treasury account
```

(`crates/tx/src/execution.rs:17-20`)

The `distribute_fee` function:

```rust
pub fn distribute_fee(effective_gas: u64, base_fee: u128) -> FeeDistribution {
    let total_fee   = effective_gas as u128 * base_fee;
    let burned      = total_fee * 70 / 100;
    let reward_pool = total_fee * 20 / 100;
    let treasury    = total_fee - burned - reward_pool;   // remainder catches dust
    FeeDistribution { burned, reward_pool, treasury }
}
```

The remainder-to-treasury pattern means rounding dust never disappears.

### Where each share goes

- **Burn** — increments the on-chain `TOTAL_BURNED` counter under
  discriminator `0x13`. Permanently removes PYDE from circulation.
- **Reward pool** — credited to the epoch reward pool account, distributed
  at epoch end to all staked validators (committee + non-committee)
  proportional to stake × uptime. Under the DAG there is no single
  proposer to credit; the pool model spreads rewards across the entire
  staked validator set.
- **Treasury** — credited to the treasury account at
  `Poseidon2("pyde-treasury")`. Spent through `MultisigTx` (Chapter 15).

### Why 70% burn

- **High burn pressure.** At sustained moderate usage with realistic fee
  loads, the annual burn exceeds the annual mint within a few years —
  net deflation.
- **MEV resistance.** A would-be MEV searcher who used Pyde for
  extraction would burn 70% of the captured value. Combined with the
  keyless commit-reveal private-mempool protections (Chapter 9), this
  further dis-incentivizes attempts.
- **Validator share is meaningful but not dominant.** 20% pool share is
  enough to reward staking without making validators primarily fee-driven.

### Net inflation analysis

Net inflation = (mint per year) − (burn per year). Illustrative figures
at a representative base-fee assumption:

| Avg TPS | Annual fee burn | Year-1 mint (5%) | Net change                    |
| ------- | --------------- | ---------------- | ----------------------------- |
| 500     | ~5.6M PYDE      | 50M              | +44.4M (inflationary)         |
| 5,000   | ~28M PYDE       | 50M              | +22M (inflationary)           |
| 10,000  | ~45M PYDE       | 50M              | +5M (near-neutral)            |
| 20,000  | ~70M PYDE       | 50M              | -20M (deflationary)           |
| 30,000  | ~105M PYDE      | 50M              | -55M (strong deflation)       |

At sustained moderate usage, the network is near-neutral
to deflationary in year 1. At the 1% terminal inflation rate (year 4+),
even very low TPS produces net deflation.

---

## 14.5 Validator Economics

### Single-tier staking

```rust
pub const MIN_VALIDATOR_STAKE: u128 = 10_000_000_000_000;   // 10,000 PYDE
```

| Role | Min stake | Committee role | Earns |
|------|-----------|----------------|-------|
| **Validator** | 10,000 PYDE | Eligible — uniformly-random selection each epoch picks 128 of the eligible pool | Reward pool share (stake × uptime) + inflation share. When selected to the committee: additional activity-weighted share |
| RPC node | — | None | Off-chain RPC fees only |

**Single pool, no tiers.** Every validator meeting the 10K PYDE minimum is
in the same pool. At each epoch boundary, uniform-random selection picks
128 from the pool to form the active committee for that epoch (see
Chapter 6 §7). There is no "committee tier" vs. "non-committee tier" —
just one validator role, with committee duty rotating per epoch.

**Equal voting in committee.** All 128 committee members have equal vote
weight regardless of stake. To get additional selection probability, a
wealthy staker must register multiple distinct validators with separate
FALCON keys and operator identities — and each faces independent slashing
exposure plus the per-operator cap (see below).

**Why 10K, not higher.** Pyde's MEV-extraction attack value is structurally
near-zero (the keyless commit-reveal private mempool fixes ordering before
content is revealed, eliminating the profit motive that drives Ethereum-scale
stake floors). With the attack-incentive removed, stake serves as a
credible-commitment deposit against slashable misbehavior rather than as the
load-bearing economic defense. Pyde's Sybil resistance is layered
(operator-identity cap + slashing + commit-reveal ordering + state-root
divergence detection) — see Chapter 16 §16.4 for the full security argument.

The 10K floor matches the spirit of Ethereum's "Lean Consensus" direction
(reducing 32 ETH → 4 ETH as fast finality reduces reversibility-window
risk) and keeps the modest-hardware-decentralization promise intact: at
realistic launch valuations, the bond is accessible without being
trivial.

**Anti-Sybil: operator-identity cap.** Maximum 3 validators per operator
identity. An attacker pursuing a Byzantine fork needs 43 committee slots,
which translates to ≥ 15 distinct KYC'd operator identities under the
cap — meaningfully harder to manufacture than capital alone.

### Income sources

A validator's gross income per year:

1. **Inflation share.** A portion of the per-block inflation reward, paid
   to the epoch reward pool. Distributed across staked validators
   (committee + non-committee) proportional to stake × uptime —
   discriminator `0x15` tracks the active stake-weighted total used as
   the denominator.
2. **Fee revenue.** 20% of every fee in every committed wave flows to the
   same epoch reward pool, distributed by the same stake × uptime rule
   (there is no single proposer in the DAG to credit).

### Lazy reward accrual

Rewards do not get pushed to the validator on every block — that would
mean N writes per block. Instead, a global per-stake accumulator
(`REWARDS_PER_STAKE_UNIT` at discriminator `0x14`) tracks the cumulative
yield per unit of staked PYDE × uptime:

```
On each block:
  rewards_per_stake_unit += per_block_reward / total_active_stake_weighted_by_uptime

On ClaimReward (tx type 6):
  owed = (current_accumulator - validator.last_claimed_at) * validator.stake * validator.uptime_share
  pay owed
  validator.last_claimed_at = current_accumulator
```

`ClaimReward` is only valid for `Active` (status `0x00`) and `Unbonding`
(status `0x01`) validators; `Exited` (status `0x02`) validators are
explicitly rejected to prevent post-exit accrual leakage.

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
- Slashing for past offenses still applies — the unbonding window exists
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

### Indicative APY

APY = `(annual_PYDE_rewards / staked_PYDE) × 100`. Rewards distribute by
stake × uptime, so per-token yield is uniform across all validators —
only the absolute PYDE earned scales with stake. Committee participation
adds an activity-weighted bonus, but the base yield is the same.

At year 1, assume 5,000 active validators averaging 100K PYDE staked each
(~500M total staked, modest middle ground while supply distributes), 128
selected to the active committee, modest fee volume, 60% of mint flowing
to the reward pool:

```
Inflation share to reward pool (assume 60% of mint):
  ~30M PYDE / 500M total staked  ≈ 6% APY on staked balance
Committee bonus (activity-weighted, 128 of 5000):
  marginal additional ~0.5-1% APY during the ~3 hr epoch a validator
  is on the committee (and 0 the rest of the time)
Average over a year: small uplift for active operators
```

Yields vary with how much total stake competes for the pool and where
inflation sits on the taper:

| Year | Active validators | Avg stake | Total staked | Inflation | Indicative APY |
| ---- | ----------------- | --------- | ------------ | --------- | -------------- |
| 1    | ~1,000            | 100K      | 100M         | 5.0%      | ~30%           |
| 2    | ~5,000            | 100K      | 500M         | 3.0%      | ~3.6%          |
| 3    | ~10,000           | 100K      | 1B (incl. inflation) | 2.0% | ~1.2%   |
| 4+   | ~10,000           | 100K      | 1B+          | 1.0%      | ~0.6%          |

Year 1 yields are high by design — bootstrap incentive while the validator
set grows from genesis. As more validators come online, the per-token
yield compresses naturally. The 1% terminal inflation rate plus the 20%
fee-share keeps the steady-state validator economic viable without
unbounded dilution.

The exact split between reward pool and treasury inside the inflation
mint, and the trajectory of total validator count, are governance
parameters; the numbers above are rough sketches, not commitments.

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
sender cannot transfer locked tokens — the protocol enforces it at
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
`tx.gas_limit < required_gas` *before* mutating any state — fixed in PR
#212 to prevent under-paid claims from drifting state. Max proof length is
255 levels.

### Sweep flow (tx type 8)

After the deadline, anyone can call `SweepAirdrop`:

```
SweepAirdrop handler (any sender):
  1. Check current_wave_id > AIRDROP_DEADLINE.
  2. Move pool's residual balance to the treasury account.
```

Gas: 40,000 flat. The sweep is permissionless because the funds belong to
the protocol — anyone can submit it once the window closes. The early-gas
guard pattern applies here too.

---

## 14.8 Treasury

The treasury is a system account at `Poseidon2("pyde-treasury")`. It
accumulates value from three streams:

1. **Genesis allocation** — direct allocation in the genesis config.
2. **Fee share** — 10% of every transaction fee.
3. **Inflation share** — a configurable share of per-block mint.
4. **Airdrop residual** — whatever wasn't claimed by the deadline.

Treasury spending is **always** through the on-chain `MultisigTx` (tx
type 9). There is no other path that drains the treasury account
(enforced by the pipeline writeback-clobber protections — see §14.9).

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
sweep — the gate just stops returning true. This means the worst case for
a runaway pause is the 30-day cap, never indefinite.

### Use cases

- Critical bug discovered after audit but before fix is deployed.
- Active exploit being mitigated; pause halts state mutation until a fix
  ships.
- Coordinated upgrade window (rare; voluntary upgrades are the normal
  path — see Chapter 18).

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

## 14.11 Active-Stake Divisor and Unified Parsing

The pool-share calculation divides by `ACTIVE_STAKE_WEIGHTED_TOTAL`
(discriminator `0x15`) — the sum of `stake × uptime_share` across every
validator currently in `Active` status. This diverges from
`VALIDATOR_COUNT` (the total registered count) once validators exit or
are slashed, and from a flat-per-validator divisor once validators
differ in stake or uptime (the common case across the two staking tiers).

Without this divisor, exited validators would dilute the pool share —
even though they're not contributing security. Adjusted on:

- `StakeWithdraw` (validator transitions to `Unbonding`; their stake
  weight is removed from the total)
- `Slash` of an `Active` validator (stake weight decreases, or removed
  entirely on jail/exit)
- Each block where a validator's `uptime_share` changes (lazy, indexed
  by the same accumulator pattern as `REWARDS_PER_STAKE_UNIT`)

`ValidatorEntry` parsing is unified through `ValidatorEntry::decode()` —
the same parser is used by every consensus and tx-handler call site.
Length: 4 + 897 (FALCON pk) + 16 (stake u128) + 1 (status) + 16
(last_claimed_at u128) = **934 bytes**.

(This unification fixed a genesis bug where an earlier per-call-site
parser returned `None` on every genesis validator — surfaced and fixed in
multi-node test #228.)

---

## 14.12 Long-Run Equilibrium

The model targets:

| Phase             | Net change                         |
| ----------------- | ---------------------------------- |
| Year 1–2          | Net mint > burn → modest inflation |
| Year 3–5          | Burn ≈ mint → near-zero net change |
| Year 6+ (terminal)| Burn > mint → mild deflation        |

The 1% terminal inflation rate × `GENESIS_SUPPLY` is around 10M PYDE per
year. Even modest sustained throughput (a few thousand TPS at typical
fee levels) burns more than that. Net deflation is the long-run
expected state.

---

## Summary

| Property                | Value                                              |
| ----------------------- | -------------------------------------------------- |
| Native token            | PYDE                                                |
| Decimals                | 9 (1 PYDE = 10^9 quanta)                           |
| Genesis supply          | 1,000,000,000 PYDE                                  |
| Supply cap              | None (decreasing inflation, fee burn)               |
| Inflation schedule      | 5% → 3% → 2% → 1% (terminal)                        |
| Commits per year        | ~63,113,904 (2/sec median)                          |
| Fee distribution        | 70% burn / 20% reward pool / 10% treasury           |
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

The next chapter covers governance — how PIPs (Pyde Improvement Proposals)
become on-chain `MultisigTx` actions, and what scope governance has versus
what's hard-coded.
