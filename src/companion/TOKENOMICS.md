# Pyde Tokenomics

The PYDE token is the native asset of the Pyde blockchain. It is used for: gas payment, validator staking, governance signaling, and parachain operator bonds.

## Total Supply & Genesis

- **Total genesis supply:** 1,000,000,000 PYDE
- **Decimal places:** 9 (1 PYDE = 10^9 quanta — see Chapter 14 for the full denomination ladder)
- **Smallest unit:** 1 quanta = 10^-9 PYDE

## Initial Distribution (v1)

| Allocation | Amount | % | Vesting |
|---|---|---|---|
| Validator rewards pool | 200,000,000 | 20% | Released proportionally over 4 years via inflation |
| Treasury (multisig-controlled) | 150,000,000 | 15% | Released via governance proposals |
| Ecosystem grants | 100,000,000 | 10% | 4-year cliff for grantees |
| Public sale | 200,000,000 | 20% | Released at genesis to public buyers |
| Founders & early contributors | 150,000,000 | 15% | 4-year vesting, 1-year cliff |
| Investors | 200,000,000 | 20% | 4-year vesting, 1-year cliff |

*Numbers above are illustrative starting points; final distribution requires legal review and stakeholder negotiation.*

## Inflation Schedule

| Year | Inflation rate | New PYDE minted |
|---|---|---|
| 1 | 5% | 50M |
| 2 | 3% | ~30M (compounding) |
| 3 | 2% | ~21M |
| 4+ | 1% (fixed) | ~10M/year thereafter |

Rationale: front-loaded inflation rewards early validators; fixed 1% tail provides long-term security budget without unbounded dilution.

Inflation accrues to the **reward pool**, distributed per the same rule as the fee share (see below).

## Fee Model (EIP-1559 Style)

Every transaction has:
- **Base fee:** dynamically adjusted per block (EIP-1559 mechanism, target 50% block utilization)
- **No priority tip.** The keyless commit-reveal private mempool eliminates the information asymmetry that priority fees price. Priority would re-introduce ordering exploitation.
- **Combined gas:** for `cross_call!` invocations (post-mainnet), Pyde-side + parachain-side gas billed in one transaction

### Block Elasticity

- Target gas limit per block: 400M gas
- Maximum (4× elastic): 1.6B gas
- Base fee adjusts up when blocks are >50% full, down when <50%
- Adjustment factor: ±12.5% per block (EIP-1559 standard)

### Per-Transaction Fee Flow

For every transaction's base fee:

```
100% of base_fee
├── 70% burned (deflationary pressure)
├── 10% to treasury (multisig-controlled)
└── 20% to the reward pool
    ├── 70% activity-weighted across active committee  (= 14% of total)
    │     • Vertices certified by ≥85 peers
    │     • Batches included in committed waves (× tx count)
    │     • Beacon shares submitted on time
    │     • Anchor selections (uptime-correlated)
    └── 30% flat across full stake pool                (= 6% of total)
          (every staked validator earns the base; activity bonus is layered on for those currently on the committee)
```

Plus inflation issuance (also flowing into the reward pool) distributed by the same rule.

## Validator Staking

### Bond Requirements

Single-tier staking:

- **Minimum:** 10,000 PYDE (`MIN_VALIDATOR_STAKE`) — any validator meeting this threshold enters the pool from which the 128-member active committee is uniformly randomly selected each epoch
- **Maximum validators per operator:** 3 (anti-Sybil cap, enforced on operator identity)
- **Bonding period:** 1 epoch (~3 hours) before active
- **Unbonding period:** 30 days (must exceed the 21-day safety evidence freshness window)

There is no separate "committee tier" with a higher floor. Pyde relies on
the keyless commit-reveal private mempool + operator-identity cap + slashing
for Sybil resistance, not on stake-size economics (see Chapter 16 §16.4 for
the full security argument).

### Staking Yield Estimate

Assume:
- 50% of supply staked → 500M PYDE
- Year 1 inflation: 50M PYDE → distributed to validators
- Activity rewards from fees: scales with chain usage

```
Estimated yield year 1:
  Inflation share: 50M / 500M = 10%
  Fee share: depends on chain activity
  
At low utilization: ~10-12% APY
At moderate utilization (target): ~12-15% APY
At high utilization: ~15-20% APY
```

Specific yields depend on actual network activity. Numbers above are illustrative; actual yields will be observable post-launch.

### Active-Committee vs Awaiting-Selection Earnings

Every staked validator earns from the same pool; the difference is in
the activity-weighted bonus while serving on the active committee.

| Status | Earnings Source |
|---|---|
| Validator on active committee | Base stake × uptime share of reward pool + activity-weighted committee bonus (vertices certified, batches included, anchor selections) + inflation share |
| Validator awaiting selection | Base stake × uptime share of reward pool + inflation share (no committee bonus until selected) |

Committee participation is per-epoch; over time, every validator
qualifying for the pool will rotate onto the active committee
proportionally and accrue activity bonuses then.

## Slashing Economics

Slashing penalties (see [SLASHING.md](./SLASHING.md) for full catalog):

| Offense | First instance | Max |
|---|---|---|
| Equivocation | 10% | 50% (correlation/repeat) |
| Bad state-root | 10% | 50% |
| Downtime | 0.05%/round | 10%/epoch |

**Distribution of slashed amounts (safety offenses):**
- 50% burned (irrecoverable, hurts attacker economics)
- 30% to treasury
- 20% to reporter (incentivizes monitoring)

**Distribution of slashed amounts (liveness offenses):**
- 100% burned (no reporter incentive needed; protocol auto-detects)

## Treasury

The treasury accrues from:
- 10% of all transaction base fees
- Treasury portion of slashing (30% from safety offenses)
- Inflation allocation (if any portion designated)

Treasury spending is gated by **M-of-N FALCON multisig** (7-of-12 recommended) and is restricted to:
- Public goods grants (developer tools, audits, infra)
- Bug bounty payouts
- Emergency response (rare)
- Other purposes ratified by PIP (Pyde Improvement Proposal)

The treasury cannot be unilaterally drained — public PIPs + multisig threshold + 30-day-bounded emergency pause provide checks.

## Parachain Operator Economics (Post-Mainnet)

Parachain operators stake PYDE as their bond and earn from the **combined gas** of every `cross_call!` invocation. The split is:

- **70% to parachain operator(s)** providing the cross-chain service
- **20% to the Pyde-side reward pool** (for executing the originating transaction)
- **10% burned** (consistent with main fee model)

Parachain operators face their own slashing for misbehavior (incorrect responses, downtime), creating staked-honesty guarantees comparable to validators.

## Token Velocity & Use

PYDE is intended to be used for transactions, staking, and bond, not held purely as speculative store-of-value. Mechanisms to encourage utility:

1. **Gas burn (70%):** every transaction reduces supply, creating deflationary pressure when network usage is high
2. **Validator bond locking:** 10K PYDE per validator slot, locked during operation
3. **Treasury spending:** continually deploys PYDE into the ecosystem
4. **No priority tips:** removes the speculative auction layer that creates token-velocity drag

## Long-Term Sustainability

Post year-4, supply economics are:
- Inflation: ~1% per year (~10M PYDE)
- Burn rate: depends on usage; at sustained moderate usage with a mixed workload, estimated ~30-100M PYDE/year burned

**At sustained moderate usage, the chain is net deflationary** (burn > inflation). At low usage, slight inflation maintains validator security budget. At very high usage, deflationary pressure may eventually require fee structure adjustments (governance decision).

## Open Questions

1. **Initial distribution percentages:** above are illustrative; final allocations need legal + stakeholder negotiation.
2. **Investor terms:** lockup, vesting, and post-vesting governance rights are open design questions.
3. **Treasury governance specifics:** which categories of spending require which multisig thresholds — to be detailed in governance PIP.
4. **Parachain reward split:** 70/20/10 above is starting point; may adjust based on operator economics post-mainnet.

## References

- Fee flow: see [WHITEPAPER.md](./WHITEPAPER.md) §12
- Slashing details: see [SLASHING.md](./SLASHING.md)
- Validator lifecycle: see [VALIDATOR_LIFECYCLE.md](./VALIDATOR_LIFECYCLE.md)

---

**Version 0.1**
