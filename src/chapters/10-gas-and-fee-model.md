# Chapter 10: Gas and Fee Model

Pyde meters every operation in **gas**. The economic model on top of gas is
EIP-1559 with 4× elastic blocks, deterministic 70/20/10 fee distribution,
and no priority fees. There is no tip field, no builder/proposer separation,
no bidding war for inclusion order.

This chapter covers the full model: gas costs per opcode, the EIP-1559 base
fee math, elastic block sizing, the 70/20/10 split, sponsored transactions
through gas tanks, and the calldata/tx size limits.

---

## 10.1 Gas Accounting

Pyde uses wasmtime's **fuel** mechanism for gas metering. At node startup, the engine establishes a deterministic mapping from gas units (the chain-level metering unit) to wasmtime fuel units. Every WebAssembly instruction consumes a configurable amount of fuel; host function calls also consume fuel manually, charged by the host based on operation cost (`sstore` is heavier than `add`, for example).

When fuel reaches zero, wasmtime traps the execution with an out-of-fuel error. The transaction reverts; the sender pays gas up to the trap point. Unused fuel translates back to unused gas, refunded to the sender.

```rust
struct ExecContext {
    gas_limit:  u64,    // set by the transaction
    gas_used:   u64,    // computed from fuel consumed
    gas_refund: u64,    // refunded at end (e.g., from sdelete host function)
}
```

Refunds (from explicit storage-slot deallocation via the `sdelete` host function) are applied at transaction end and capped at half of `gas_used` to prevent gas-griefing patterns.

### Why fuel, not opcode counting

Fuel is built into wasmtime's Cranelift backend. Every basic block is instrumented to decrement a fuel counter; when the counter goes negative, execution traps. The instrumentation is efficient enough not to dominate execution time.

Implementing custom opcode-counting on top of wasmtime would be slower and add maintenance burden for no functional gain. The chain-side gas table maps WASM instruction categories and individual host functions to fuel costs; the engine consumes that table at startup and configures wasmtime accordingly.

### Why a single dimension

Earlier drafts of this book described a two-dimensional gas model
(`exec_cost + prove_cost`) intended to price both CPU work and ZK proving
work separately. With ZK proving deferred to post-mainnet, the
proving-cost dimension does not exist at launch and the two-dimensional
model collapses into a single number — the chain-level gas total derived from wasmtime fuel consumption.

Should ZK proving land later, the second dimension can be re-introduced as a separate counter without changing the wire format (transactions already carry only `gas_limit`).

---

## 10.2 EIP-1559 Base Fee

Pyde's base fee adjusts every block by up to 12.5% in either direction
based on whether the previous block exceeded or fell below the gas target.

### Constants (`crates/tx/src/fee.rs`)

| Constant              | Value                          | Meaning                            |
| --------------------- | ------------------------------ | ---------------------------------- |
| `GAS_TARGET`          | 400,000,000                    | 50% of the elastic ceiling         |
| `GAS_CEILING`         | 1,600,000,000                  | 4× target — hard block ceiling     |
| `GENESIS_BASE_FEE`    | 50,000,000,000 quanta          | Initial value at genesis           |
| `MIN_BASE_FEE`        | 1                              | Floor — cannot drop to zero        |
| `ADJUSTMENT_DIVISOR`  | 8                              | 1/8 = 12.5% max change per block   |

### Adjustment formula

```rust
fn adjust_base_fee(parent_base_fee: u128, parent_gas_used: u64) -> u128 {
    if parent_gas_used == GAS_TARGET {
        parent_base_fee
    } else if parent_gas_used > GAS_TARGET {
        let delta = parent_gas_used - GAS_TARGET;
        let bump  = parent_base_fee * delta as u128 / GAS_TARGET as u128 / 8;
        parent_base_fee + bump.max(1)
    } else {
        let delta = GAS_TARGET - parent_gas_used;
        let drop  = parent_base_fee * delta as u128 / GAS_TARGET as u128 / 8;
        (parent_base_fee.saturating_sub(drop)).max(MIN_BASE_FEE)
    }
}
```

Properties:

- **Proportional adjustment.** The change scales with how far the block
  deviated from target. A block at 75% target produces a smaller bump than
  one at 100% target.
- **Capped at ±12.5% per block.** No oracle, no governance vote.
- **Bounded below by `MIN_BASE_FEE`.** Cannot reach zero.
- **Minimum increase of 1 quanta.** Even at very low fees, a busy block
  bumps the fee at least one quanta.

### Convergence at ~500 ms commits

Mysticeti DAG produces a commit every ~500 ms median (Chapter 6).
Each commit is the unit at which the base fee is recomputed (`block` and
`commit` are interchangeable here — Pyde collapses both concepts
since the DAG commits at per-commit granularity).

| Scenario                    | Time to 2× the fee         |
| --------------------------- | -------------------------- |
| Sustained 100% full commits  | ~11 commits (~5.5 s)       |
| Sustained 4× full (max)      | ~6 commits (~3 s)          |
| Sustained empty             | half-life ~5 commits (~2.5 s) |

Equilibrium under fluctuating demand sits around 50% of the gas target.

---

## 10.3 Elastic Blocks

Pyde blocks have two gas limits:

| Limit             | Value (gas)        | Role                                  |
| ----------------- | ------------------ | ------------------------------------- |
| Target            | 400,000,000        | "Normal" block fullness               |
| Hard ceiling (4×) | 1,600,000,000      | Cannot exceed even under congestion   |

Block builders can pack up to `4 × GAS_TARGET = 1.6B` gas into a single
block. When they exceed the target, the base fee for the next block rises
proportionally.

```
Gas usage during a congestion spike:

   4× ┤ ......................... hard ceiling
      │
   3× ┤            +-+
      │           /   \
   2× ┤      +---+     +---+
      │     /               \
target┤----+                 +---+----  target line
      │   /                       \
   1× ┤  /                         +-...
      │
      +---------------------------------------> blocks
                spike      decay
        base fee rises ~2x         then settles
```

### Why 4× and not higher

- **Validator memory.** A 4× block has up to 4× more transactions to buffer,
  decrypt, and execute. The per-validator memory ceiling caps how high this
  can safely go on commodity hardware.
- **Decryption + voting timing.** Threshold decryption shares for a 4× block
  take longer to combine; the commit timing budget assumes the worst
  case fits.
- **State growth.** Larger blocks drive faster state growth. The 4× ceiling
  bounds worst-case growth by the same factor.

### Throughput estimates

At 2 commits/sec (~500 ms commit), `GAS_TARGET = 400M`, `GAS_CEILING = 1.6B`:

| Workload                | Gas/tx  | Theoretical target TPS | Realistic v1 (committee-bound) |
| ----------------------- | ------- | ----------------------- | ------------------------------ |
| Simple transfer         | 21,000  | ~38,000                 | ~20-30K plaintext / 1-2K encrypted |
| Token transfer (ERC-20) | 65,000  | ~12,300                 | ~10-15K plaintext / 0.5-1K encrypted |
| DEX swap                | 200,000 | ~4,000                  | ~3-4K plaintext / 200-400 encrypted |

**Honest v1 numbers.** The theoretical numbers above assume committee
hardware fully saturates execution. In practice, the v1 targets are
**10-30K TPS plaintext, 0.5-2K TPS encrypted** on commodity committee
hardware (500 Mbps NIC, 32-core, 64 GB). Higher numbers require larger
NICs and more cores; see Chapter 19 for the launch-strategy capacity
table.

Real numbers depend on workload composition. The performance harness
(docs/PERFORMANCE_HARNESS.md) is the only valid source of TPS claims —
under the **"claim 1/3 of measured peak"** rule, the headline number is
never the theoretical max.

---

## 10.4 No Tips, No Priority Fees

Pyde's transaction format has **no priority-fee field**. Every transaction
pays exactly:

```
fee = gas_used * base_fee
```

There is no bidding, no auction, no out-of-protocol payment to any
committee validator. The MEV-protection consequences are spelled out in
Chapter 9; the gas-economics consequences are:

- **Predictable fees.** Wallets can quote a single number, not a range.
- **No fee market gaming.** No need for fee-estimation oracles or
  multi-priority queues.
- **Simpler accounting.** The fee distribution is a single division, not a
  base-vs-tip split.

### How does ordering happen, then?

Under the Mysticeti DAG, ordering is a deterministic function of the
committed subdag — vertices are produced independently each round, the
anchor commit selects a canonical traversal, and transactions emerge in a
fixed canonical order. No actor chooses positions; the order is structural
(Chapters 6 and 9).

For sequential nonce dependencies, the protocol uses the 16-slot **nonce
bitmap window** (Chapter 11) — a sender can submit txs `n`, `n+1`, `n+2`
out of order; gaps are tolerated up to the window size.

### Legitimate urgency

Use cases that need fast inclusion (liquidations, bridges, time-sensitive
trades) have two routes:

- **Pre-fund a paymaster's gas tank** (sponsored tx — see §10.7) so the
  user doesn't bottleneck on liquidity.
- **Use the deadline field** to expire stale txs that were not included
  quickly, freeing the nonce slot for a fresh attempt.

Neither route bribes anyone for ordering.

---

## 10.5 Fee Distribution: 70 / 20 / 10

Every fee splits deterministically:

| Recipient          | Share | Where it goes                                      |
| ------------------ | ----- | -------------------------------------------------- |
| **Burn**           | 70%   | Increments the on-chain `TOTAL_BURNED` counter      |
| **Reward pool**    | 20%   | Pooled across all staked validators (active committee + validators awaiting selection), distributed each epoch by stake × uptime via lazy accrual |
| **Treasury**       | 10%   | Credited to the treasury account                    |

Note: in the pre-pivot HotStuff design the 20% went directly to the slot
proposer. Under the DAG there is no single proposer, so the validator
share goes to an epoch reward pool indexed by stake and uptime. See
Chapter 14 for the per-validator yield math.

Implemented as `distribute_fee` in `crates/tx/src/execution.rs`:

```rust
pub fn distribute_fee(effective_gas: u64, base_fee: u128) -> FeeDistribution {
    let total_fee  = effective_gas as u128 * base_fee;
    let burned     = total_fee * 70 / 100;
    let reward_pool = total_fee * 20 / 100;
    let treasury   = total_fee - burned - reward_pool;   // remainder catches rounding
    FeeDistribution { burned, reward_pool, treasury }
}
```

The remainder-to-treasury pattern catches rounding dust so no quanta are
lost.

### Why not 100% burn?

A 100% burn (Ethereum's EIP-1559 model for the base fee) means validators
get nothing from fees and depend entirely on inflation rewards. This works
when inflation is generous, but it makes the security budget brittle: as
inflation decreases, validator economics become fully dependent on tip
volume, which Pyde doesn't have.

The 20% reward-pool share compensates the full staked validator set
(both active-committee and validators awaiting selection, per
stake × uptime) and ties their compensation to network usage in addition
to inflation. Under the DAG there is no single
proposer to credit, so the share is pooled and distributed at epoch end.
The 10% treasury share funds protocol work via PIP-driven multisig spends
(Chapter 15).

### Why no prover share?

Earlier drafts of this book had a 70 / 20 / 10 split where the 10% went to
provers. Without provers at mainnet, that 10% goes to the treasury. The
on-chain math is the same; only the recipient changed.

If ZK proving lands in a future hardfork, the split can be adjusted by
governance (a PIP + on-chain multisig action). Until then the treasury
gets the 10%.

---

## 10.6 Fee Calculation Examples

### Simple transfer (21,000 gas)

```
At GENESIS_BASE_FEE = 50,000,000,000 quanta:
  fee = 21,000 * 50,000,000,000
      = 1,050,000,000,000,000 quanta
      = 1,050,000 micro-PYDE
      = 1.05 milli-PYDE
      = 0.00105 PYDE

Distribution:
  Burn:      735,000,000,000,000 quanta  (~0.000735 PYDE)
  Validator: 210,000,000,000,000 quanta  (~0.000210 PYDE)
  Treasury:  105,000,000,000,000 quanta  (~0.000105 PYDE)
```

### High-congestion scenario

If sustained demand has driven the base fee 3.5× higher:

```
base_fee = 175,000,000,000 quanta
fee = 21,000 * 175,000,000,000 = 3,675,000,000,000,000 quanta = 0.003675 PYDE

Burn:      2,572,500 micro-PYDE
Validator:   735,000 micro-PYDE
Treasury:    367,500 micro-PYDE
```

### Low-demand scenario

If sustained empty blocks have driven the base fee to half normal:

```
base_fee = 25,000,000,000 quanta
fee = 21,000 * 25,000,000,000 = 525,000,000,000,000 quanta = 0.000525 PYDE
```

The base fee keeps adjusting until the market clears — congestion makes it
expensive to spam, low usage makes inclusion cheap.

---

## 10.7 Sponsored Transactions

A user with no PYDE balance can still transact if a contract or paymaster
account pays the gas. Two mechanisms exist.

### Gas tanks

Every account has a `gas_tank: u128` field (see Chapter 4 / 11). It's a
balance separate from the account's spendable balance, dedicated to paying
gas on behalf of users.

```
Anyone can deposit to any account's gas tank:
  deposit_gas_tank(target, amount)

Only the account owner can withdraw:
  withdraw_gas_tank(target, amount, recipient)
```

To use a gas tank, a transaction sets:

```
tx.fee_payer = FeePayer::GasTank
```

The engine looks up the target contract's `gas_tank`, debits the fee from
there, and credits the receiver as usual. If the gas tank is empty, the tx
reverts (the sender did not pay).

### Paymaster pattern

For more complex sponsorship (eligibility checks, per-user limits), a
paymaster contract sits between the user and the target:

```
tx.fee_payer = FeePayer::Paymaster(paymaster_address)
```

The engine calls the paymaster's `validate_sponsorship(user, target,
calldata) -> bool` function (gas-bounded — see below). If it returns true,
gas is debited from the paymaster's gas tank.

```
+----------+      +------------------+     +-----------------+
|   User   |----->|   Paymaster      |---->|  Target         |
|  (no $)  |      |   - eligibility  |     |  Contract       |
+----------+      |   - rate limits  |     +-----------------+
                  |   - gas tank pays |
                  +------------------+
```

### Validation gas limit

To stop a paymaster from running an expensive validation function as a DoS
vector, the paymaster's `validate_sponsorship` has a hard gas cap of
**100,000 gas**. If validation exceeds that, the tx is rejected. This
prevents an adversarial paymaster from making mempool inclusion expensive
for relays.

### Use cases

| Use case            | Mechanism                                             |
| ------------------- | ----------------------------------------------------- |
| Free-to-play games  | Game contract's gas tank pays for player moves        |
| DeFi onboarding     | Protocol pays for first N swaps per user              |
| Corporate dApps     | Company paymaster covers employee transactions        |
| Airdrop claims      | Airdrop contract sponsors claim transactions          |
| Governance voting   | DAO pays gas for governance participation             |

---

## 10.8 Gas Costs for Common Operations

The full WASM-instruction and host-function gas table is published in the Host Function ABI specification. The headline numbers for the operations that dominate real-world gas usage:

### Storage

| Operation     | Host function | Gas       |
| ------------- | ------------- | --------- |
| Storage read  | `sload`       | 100 (warm)|
| Storage write | `sstore`      | 200 (warm)|
| Storage delete| `sdelete`     | 200 + refund |

### Crypto

| Operation                  | Host function   | Gas                    |
| -------------------------- | --------------- | ---------------------- |
| Poseidon2 hash             | `poseidon2`     | 1,000 + 6 per 32B chunk|
| Blake3 hash                | `blake3`        | 100 + 1 per 32B chunk  |
| Keccak256 hash             | `keccak256`     | 200 + 3 per 32B chunk  |
| FALCON-512 verification    | `falcon_verify` | 20,000                 |
| Merkle path verification   | host fn         | 5,000                  |

### Cross-contract

| Operation              | Host function   | Gas                |
| ---------------------- | --------------- | ------------------ |
| External call          | `cross_call`    | 2,500 + callee work|
| Contract deployment    | system tx       | 32,000 + init code  |

### Events

| Operation     | Host function | Gas              |
| ------------- | ------------- | ---------------- |
| Emit event    | `emit_event`  | 375 + 8 per byte |

### WASM execution (per-instruction baseline)

| Category               | Fuel cost           |
| ---------------------- | ------------------- |
| Arithmetic instructions| 1-3 fuel per op    |
| Memory load/store      | 5 fuel per op       |
| Control flow           | 1-2 fuel per op     |
| Memory grow            | 200 fuel per 64KB page (first touch) |

The build-time state binding generator (see Chapter 5) emits efficient access patterns; for example, a single map lookup expands to one host-function call rather than multiple. The wasmtime-AOT pass then compiles the resulting WASM to native code for execution.

---

## 10.9 Validation Limits

The transaction validator
(`crates/tx/src/validation.rs`) enforces these limits at RPC ingress:

| Limit             | Value      | Constant                   |
| ----------------- | ---------- | -------------------------- |
| Min gas limit     | 21,000     | `MIN_GAS_LIMIT`            |
| Max gas per block | 1.6B       | `BLOCK_GAS_MAX`            |
| Max tx size       | 128 KB     | `MAX_TX_SIZE`              |
| Max calldata size | 64 KB      | `MAX_CALLDATA`             |

`MAX_CALLDATA` is a separate cap from `MAX_TX_SIZE` (per the audit
recommendation — task 055 in the mainnet plan). The split prevents an
attacker from building a tx whose calldata fills the entire 128 KB tx
budget and starves the rest of the encoded fields.

A transaction that fails any of these checks is rejected at the RPC node
and never enters the mempool — pollution is constrained to that single
ingress node.

---

## 10.10 Fee Estimation API

`pyde_estimateGas` runs the transaction in simulation against the current
state and returns the predicted gas consumption.

```json
> pyde_estimateGas
> {
>   "from":  "0xpyde1abc...",
>   "to":    "0xpyde1def...",
>   "data":  "0x...",
>   "value": "0x0"
> }
< {
<   "gas_estimate": 45200,
<   "base_fee":     "0x2D79883D2000",
<   "estimated_fee": "2260000000000000"
< }
```

Wallets typically multiply the estimate by ~1.10 to absorb state changes
between estimation and inclusion. Because base fee can move at most ±12.5%
per block, the inclusion-time fee is bounded relative to the
estimation-time fee.

`pyde_call` runs read-only simulation without state mutation;
`pyde_createAccessList` produces the access list that should accompany the
transaction. Wallets typically chain these calls automatically:
`createAccessList` → `estimateGas` → submit signed tx with the resulting
access list.

---

## 10.11 Comparison

| Feature                  | Ethereum (EIP-1559)         | Pyde                              |
| ------------------------ | --------------------------- | --------------------------------- |
| Gas dimensions           | 1                           | 1                                 |
| Base fee mechanism       | Algorithmic (EIP-1559)      | Algorithmic (EIP-1559)            |
| Max base-fee change/block| ±12.5%                      | ±12.5%                            |
| Priority fee / tip       | Yes                         | No                                |
| Block elasticity         | 2× (15M target / 30M max)   | 4× (400M target / 1.6B max)       |
| Fee burn                 | 100% of base fee            | 70% of total fee                  |
| Validator share          | Tips only                   | 20% of total fee (no tip)         |
| Treasury share           | None                        | 10% of total fee                  |
| Native account abstraction| No (ERC-4337 add-on)       | Yes (gas tanks + paymaster)       |
| Storage rent             | None                        | None (gas pays for the SSTORE)    |
| MEV bribery resistance   | None (tip-based ordering)   | Structural (no tip; encrypted pool)|

---

## 10.12 Implementation Notes

### Integer arithmetic

All fee calculations use integer arithmetic to avoid floating-point
non-determinism. Quanta are `u128` (1 PYDE = 10^9 quanta — note this is
**not** Ethereum's 10^18 wei scale).

### Overflow protection

`compute_fee()` uses `checked_mul` to detect overflow. Realistic inputs
(`gas_used` in millions, `base_fee` in billions of quanta) fit comfortably
in `u128` (max product ≈ `2^60 * 2^40 = 2^100`, well below `2^128`). The
overflow check guards against pathological encodings.

### Base fee in the commit header

Pyde's commit header is the equivalent of Ethereum's block header
for fee-market purposes — each commit carries the base fee for
transactions executed in that commit:

```rust
struct CommitHeader {
    // ...
    base_fee:    u128,     // base fee for txs in THIS commit
    gas_used:    u64,      // total gas consumed by this commit's txs
    gas_target:  u64,      // = GAS_TARGET (always 400M)
    gas_limit:   u64,      // = GAS_CEILING (always 1.6B)
}
```

(The web3-compatibility RPC methods `pyde_getBlockByNumber` /
`pyde_getBlockByHash` return a representation of this header, since
external tooling expects "block" terminology.)

The base fee for block `N+1` is computed from block `N`'s header by
`adjust_base_fee()` — every honest node arrives at the same value.

---

## Summary

| Property                  | Value                                           |
| ------------------------- | ----------------------------------------------- |
| Gas dimensions            | 1 (single counter)                              |
| Base fee mechanism        | EIP-1559, ±12.5% per block adjustment           |
| Genesis base fee          | 50,000,000,000 quanta                            |
| Gas target                | 400,000,000 (50% of ceiling)                    |
| Gas ceiling               | 1,600,000,000 (4× target — elastic max)         |
| Priority fee / tip        | None                                             |
| Fee distribution          | 70% burn / 20% reward pool / 10% treasury       |
| Sponsored transactions    | Native (`gas_tank` field + paymaster pattern)   |
| Validation gas cap (paymaster)| 100,000                                      |
| Max tx size               | 128 KB (`MAX_TX_SIZE`)                           |
| Max calldata size         | 64 KB (`MAX_CALLDATA`)                           |
| Min gas limit             | 21,000                                           |
| Storage rent              | None                                             |

The next chapter covers the account model the fee model sits on top of —
addresses, the nonce window, multisig, and batch transactions.
