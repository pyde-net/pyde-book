# Pyde Tokenomics

The PYDE token is the native asset of the Pyde blockchain. It is used for: gas payment, validator staking, governance signaling, and parachain operator bonds.

## Total Supply & Genesis

- **Genesis supply:** 1,000,000,000 PYDE (supply hovers near this
  amount under the capped net-neutral model; it is not frozen)
- **Decimal places:** 9 (1 PYDE = 10^9 quanta; see Chapter 14 for the
  full denomination ladder)
- **Smallest unit:** 1 quanta = 10^-9 PYDE
- **Supply audit:** `pyde_getSupply` returns genesis, minted, burned,
  and net supply at any time

## Initial Distribution (v1)

| Allocation | Amount | % | Vesting |
|---|---|---|---|
| Treasury reserve for validator onboarding | (part of treasury) | — | Validator pay needs no genesis bucket: it is funded by fees plus the capped shortfall mint |
| Treasury (multisig-controlled) | 150,000,000 | 15% | Released via governance proposals |
| Ecosystem grants | 100,000,000 | 10% | 4-year cliff for grantees |
| Public sale | 200,000,000 | 20% | Released at genesis to public buyers |
| Founders & early contributors | 150,000,000 | 15% | 4-year vesting, 1-year cliff |
| Investors | 200,000,000 | 20% | 4-year vesting, 1-year cliff |

*Numbers above are illustrative starting points; final distribution requires legal review and stakeholder negotiation.*

## Emission: the Capped Shortfall Mint

There is no inflation schedule. Once per epoch the protocol mints only
the gap between the validator wage bill and what fees already put in the
reward pool:

```
mint = min( max(0, wage_target − pool_balance),
            EMISSION_CAP_PER_EPOCH )        # cap ≈ 1%/yr of genesis supply
```

- **Fees pay first.** When usage covers the wage, the mint is zero.
- **Hard cap, one-way-down.** Issuance can never exceed ~1% of genesis
  supply per year, and the cap may only be lowered by coordinated
  release, never raised.
- **At the current wage** the full 128-seat bill is ~5.12M PYDE/year
  (~0.51% of genesis supply), comfortably under the cap.

Rationale: the mint guarantees the security budget from day one without
a genesis endowment or a funding cliff, and real usage retires it.

## Fee Model (EIP-1559 Style)

Every transaction has:
- **Base fee:** dynamically adjusted per wave (EIP-1559 mechanism, target 50% wave utilization)
- **No priority tip.** The keyless commit-reveal mempool eliminates the information asymmetry that priority fees price. Priority would re-introduce ordering exploitation.
- **Combined gas:** for `parachain_call!` invocations (post-mainnet), Pyde-side + parachain-side gas billed in one transaction

### Wave Elasticity

- Target gas limit per wave: 400M gas
- Maximum (4× elastic): 1.6B gas
- Base fee adjusts up when waves are >50% full, down when <50%
- Adjustment factor: ±12.5% per wave (EIP-1559 standard)

### Per-Transaction Fee Flow

For every transaction's base fee:

```
100% of base_fee
├── 30% burned (offsets the mint; TOTAL_BURNED counter on-chain)
├── 20% to treasury (multisig-controlled; remainder catches dust)
└── 50% to the reward pool, paid out once per epoch to active seats:
    ├── 50% of the budget flat-equal across active committee seats
    └── 50% weighted by each seat's share of committed anchor
        leadership (the FALCON-signed consensus-work signal)
```

Plus the shortfall mint (topping up the same pool when fees fall short,
bounded by the emission cap) paid out by the same rule. Stake plays no
role in the payout.

## Validator Staking

### Bond Requirements

Single-tier staking:

- **Minimum:** 10,000 PYDE (`MIN_VALIDATOR_STAKE`). Any validator
  meeting this threshold enters the pool from which the 128-member
  active committee is uniformly randomly selected each epoch
- **Maximum validators per operator:** 3 (anti-Sybil cap, enforced on operator identity)
- **Bonding period:** 1 epoch (~3 hours) before active
- **Unbonding period:** 30 days (must exceed the 21-day safety evidence freshness window)

There is no separate "committee tier" with a higher floor. Pyde relies on
the keyless commit-reveal mempool + operator-identity cap + slashing
for Sybil resistance, not on stake-size economics (see Chapter 16 §16.4 for
the full security argument).

### Operator Pay

There is no advertised APY. The bond is a security deposit, not a yield
instrument, and pay is a wage for consensus work:

- **Wage cap:** 40,000 PYDE per seat per year (~13.70 PYDE per epoch),
  the most a fully participating seat can earn.
- **Funding:** fees first; the capped mint covers any shortfall, so a
  working seat is paid even at zero fee volume.
- **Within an epoch:** actual pay scales with the 50/50 flat/leadership
  blend; a seat that led more committed waves earns more.

The wage cap is a protocol constant retunable only by coordinated
release. It is a ceiling, not a promise.

### Active-Committee vs Awaiting-Selection Earnings

Only seats doing consensus work are paid. Equal-power seats do identical
work, so pay is per seat and per work done, never per stake.

| Status | Earnings Source |
|---|---|
| Validator on active committee | Per-epoch wage from the reward pool: 50% flat-equal + 50% weighted by committed anchor leadership |
| Validator awaiting selection | Nothing while off the committee (the bond confers eligibility, not income) |

Committee membership rotates per epoch; over time, validators in the
eligible pool take committee turns and earn during them.

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
- 20% of all transaction base fees
- Treasury portion of slashing (30% from safety offenses)
- Inflation allocation (if any portion designated)

Treasury spending is gated by **M-of-N FALCON multisig** (7-of-12 recommended) and is restricted to:
- Public goods grants (developer tools, audits, infra)
- Bug bounty payouts
- Emergency response (rare)
- Other purposes ratified by PIP (Pyde Improvement Proposal)

The treasury cannot be unilaterally drained: public PIPs + multisig
threshold + 30-day-bounded emergency pause provide checks.

## Parachain Operator Economics (Post-Mainnet)

Parachain operators stake PYDE as their bond and earn from the **combined gas** of every `parachain_call!` invocation. The split is:

- **70% to parachain operator(s)** providing the cross-chain service
- **20% to the Pyde-side reward pool** (for executing the originating transaction)
- **10% burned** (consistent with main fee model)

Parachain operators face their own slashing for misbehavior (incorrect responses, downtime), creating staked-honesty guarantees comparable to validators.

## Token Velocity & Use

PYDE is intended to be used for transactions, staking, and bond, not held purely as speculative store-of-value. Mechanisms to encourage utility:

1. **Gas burn (30%):** every transaction reduces supply, offsetting the capped mint so net supply hovers near genesis
2. **Validator bond locking:** 10K PYDE per validator slot, locked during operation
3. **Treasury spending:** continually deploys PYDE into the ecosystem
4. **No priority tips:** removes the speculative auction layer that creates token-velocity drag

## Long-Term Sustainability

Supply economics have no year-by-year schedule; the invariant does the
work:

- Mint: shortfall-only, bounded by the ~1%/yr cap, tends to zero as fee
  volume grows
- Burn: 30% of every fee, growing with usage without bound

In a fee drought issuance is mildly positive and bounded. As usage grows,
fees fund the wage, the mint shuts, and the burn dominates. The burn
share is a retunable constant with a scale-down-with-volume policy, so
sustained high usage never drains supply. Net supply hovers near the 1B
genesis amount by construction and is auditable on-chain at any time.

## Open Questions

1. **Initial distribution percentages:** above are illustrative; final allocations need legal + stakeholder negotiation.
2. **Investor terms:** lockup, vesting, and post-vesting governance rights are open design questions.
3. **Treasury governance specifics:** which categories of spending
   require which multisig thresholds; to be detailed in governance PIP.
4. **Parachain reward split:** 70/20/10 above is starting point; may adjust based on operator economics post-mainnet.

## References

- Fee flow: see [WHITEPAPER.md](./WHITEPAPER.md) §12
- Slashing details: see [SLASHING.md](./SLASHING.md)
- Validator lifecycle: see [VALIDATOR_LIFECYCLE.md](./VALIDATOR_LIFECYCLE.md)

---

**Version 0.2**
