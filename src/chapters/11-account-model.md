# Chapter 11: Account Model

The account model is the data structure at the center of every blockchain.
It decides how users are identified, how balances are tracked, how
authorization happens, and how concurrent transactions interact.

Pyde's account model is built on three ideas:

1. **Post-quantum from genesis.** Addresses are derived from FALCON-512
   public keys. There is no ECDSA legacy to migrate away from.
2. **Nonce window, not sequential.** Each account gets a 16-slot nonce
   bitmap window — multiple in-flight txs without head-of-line blocking.
3. **Native account abstraction.** Multisig, batch transactions, and
   paymaster sponsorship are protocol features, not application-layer
   add-ons.

This chapter covers the account record, address derivation, nonce mechanics,
multisig configuration, batch transactions, and the transaction wire format.

---

## 11.1 Account Structure

Every account in `crates/account/src/types.rs`:

```rust
struct Account {
    address:      Address,    // 32 bytes (Poseidon2 hash of FALCON pk)
    nonce:        u64,        // 8 B  -- low end of the 16-slot window
    balance:      u128,       // 16 B -- spendable balance, in quanta
    code_hash:    H256,       // 32 B -- 0x00..00 for EOAs
    storage_root: H256,       // 32 B -- 0x00..00 for empty contracts
    account_type: AccountType,// 1 B  -- EOA=0, Contract=1, System=2
    auth_keys:    AuthKeys,   // variable -- see §11.7
    gas_tank:     u128,       // 16 B -- sponsored-tx pool
    key_nonce:    u32,        // 4 B  -- key-rotation counter
}
```

Fixed-portion size: 141 bytes plus the variable `auth_keys` field. The
encoding is little-endian, dense; the JMT stores the serialized blob as
the leaf value.

| Field          | Mutability                              |
| -------------- | --------------------------------------- |
| `address`      | immutable after account creation         |
| `nonce`        | per-tx (window slides forward)          |
| `balance`      | per-tx                                   |
| `code_hash`    | set once at deploy; never changes        |
| `storage_root` | every block that mutates the contract    |
| `account_type` | immutable                               |
| `auth_keys`    | rotatable (increments `key_nonce`)       |
| `gas_tank`     | deposit by anyone; withdraw by owner     |
| `key_nonce`    | increments on key rotation              |

The "spendable" balance is what's available *after* deducting any vesting
locks (Chapter 14). The vesting subsystem reads the on-chain
`VestingSchedule` for the account and subtracts the locked portion before
checking balance during validation.

---

## 11.2 Address Derivation

All Pyde addresses are 32-byte Poseidon2 hashes. The derivation depends on
how the account is created.

### EOA

```
EOA address = Poseidon2(falcon_public_key_bytes)
```

The input is the raw 897-byte FALCON-512 public key. The output is 32
bytes of Poseidon2 over the Goldilocks field — the natural output size, no
truncation.

### CREATE (deploy from a deployer's nonce)

```
CREATE address = Poseidon2(deployer_address || nonce_bytes)
```

The deployer's address and the deployer's current nonce — the same scheme
as Ethereum, but Poseidon2 instead of Keccak.

### CREATE2 (deterministic deploy with a salt)

```
CREATE2 address = Poseidon2(0xFF || deployer_address || salt || code_hash)
```

The leading `0xFF` is a domain separator that distinguishes CREATE2 outputs
from CREATE outputs (so two different derivation inputs can never collide).

### Why 32 bytes (not 20)

A 20-byte address provides 80-bit collision resistance, which is marginal at
chain scale. Pyde uses the full 32 bytes — 128-bit collision resistance —
which matches the natural Poseidon2 output. There is no storage cost
worth saving by truncating.

---

## 11.3 Account Types

```rust
enum AccountType {
    EOA      = 0x00,
    Contract = 0x01,
    System   = 0x02,
}
```

### EOA

The standard user account. Has a single FALCON pubkey (or a multisig set)
in `auth_keys`. No code, no storage. Balance and nonce live directly in the
account record.

### Contract

Has deployed PVM bytecode (`code_hash != 0`) and optionally a storage trie
(`storage_root != 0`). Cannot directly initiate transactions — only
respond to calls. May have a non-empty `gas_tank` to sponsor user calls
into it.

### System

Pre-existing accounts at deterministic addresses for protocol-level
operations (treasury, airdrop pool, validator entries). Their addresses are
typically `Poseidon2("pyde-treasury")` or similar — not derived from any
public key. They are seeded at genesis and only mutated by specific
transaction handlers (e.g. the treasury balance moves only via `MultisigTx`
spend or fee-split crediting).

---

## 11.4 Nonce Bitmap Window

Sequential nonces (Ethereum's model) cause head-of-line blocking: if a tx
at nonce 5 is stuck (e.g., dependent on a state change that hasn't
happened), all higher nonces from the same sender are blocked behind it.

Pyde uses a **16-slot bitmap window**:

```rust
pub const WINDOW_SIZE: u64 = 16;

struct NonceState {
    base: u64,   // lowest unused nonce
    used: u16,   // bitmap: bit i = nonce (base + i) used
}
```

A transaction can use any nonce in `[base, base + 15]`. The bitmap tracks
which slots are filled. When the lowest bit becomes set, the window slides
forward past every consecutive used slot.

```rust
fn use_nonce(state: &mut NonceState, n: u64) -> Result<(), Error> {
    if n < state.base || n >= state.base + 16 {
        return Err(NonceOutOfWindow);
    }
    let offset = (n - state.base) as u16;
    let bit = 1 << offset;
    if state.used & bit != 0 {
        return Err(NonceAlreadyUsed);
    }
    state.used |= bit;
    while state.used & 1 == 1 {           // slide window past contiguous used
        state.base += 1;
        state.used >>= 1;
    }
    Ok(())
}
```

### Worked example

```
Initial:  base=100, used=0b0000000000000000   window [100..115]

Submit tx with nonce=103:
          base=100, used=0b0000000000001000   100,101,102 still available

Submit tx with nonce=100:
          (slide) base=101, used=0b0000000000000100   window [101..116]

Submit tx with nonce=101:
          (slide past 101 and 102 -- 103 is set)
          base=102, used=0b0000000000000010   window [102..117]

Submit tx with nonce=102:
          base=104, used=0b0000000000000000   window [104..119]
```

### Properties

| Property                | Outcome                                         |
| ----------------------- | ----------------------------------------------- |
| Concurrent submissions  | Up to 16 in-flight from one sender              |
| Stuck-tx tolerance      | A stuck nonce N doesn't block N+1, N+2, ...     |
| Replay protection       | Each (account, nonce) usable exactly once        |
| Cancellation            | Submit a different tx with the same nonce       |
| Compact state           | 10 bytes of nonce state per account              |

### Limit

If a power user genuinely needs more than 16 in-flight, they use multiple
accounts. In practice, even high-frequency market makers rarely exceed 16
pending — a 400 ms slot at the target throughput drains the queue quickly.

---

## 11.5 Authorization: AuthKeys

Each account stores a `auth_keys` field that determines who is allowed to
sign for it:

```rust
enum AuthKeys {
    None,                                            // tag 0x00
    Single(Vec<u8>),                                 // tag 0x01 — FALCON pk
    MultiSig { keys: Vec<Vec<u8>>, threshold: u32 }, // tag 0x02 — max 16 signers
    Programmable,                                    // tag 0x03 — RESERVED v2
}
```

| Variant         | Status | Used for                                                |
| --------------- | ------ | ------------------------------------------------------- |
| `None`          | v1     | System accounts, contracts that have no admin              |
| `Single`        | v1     | Standard EOA — one FALCON-512 public key (~897 bytes)   |
| `MultiSig`      | v1     | Native multi-signature — set of keys + threshold (max 16) |
| `Programmable`  | v2 reserved | Contract-defined auth logic (session keys, social recovery, biometric, etc.) — discriminant is reserved at v1 so contracts written today survive the v2 upgrade without rewriting |

**Why native multisig at v1.** Gnosis Safe's contract-based multisig on
Ethereum has been re-implemented dozens of times across projects with
subtle bugs in each. Pyde standardizes the simple `t-of-n` case as a
protocol primitive, so wallets and contracts can rely on a single audited
implementation. Weighted multisig and exotic schemes still live at the
contract layer.

**The Programmable reservation.** Reserving `0x03` at v1 means contracts
that today reference `AuthKeys::Programmable` (as a future-proofing hint)
won't break at the v2 upgrade — the discriminant is allocated. Session
keys, social recovery, and biometric auth are post-mainnet features.

A `Single` EOA uses one FALCON pubkey for all transactions. A `MultiSig`
account requires `threshold`-of-`N` signatures to authorize.

### Key rotation

Both `Single` and `MultiSig` are mutable. A key rotation transaction signed
by the current `auth_keys` updates the field and increments
`key_nonce` by 1. The increment invalidates any in-flight transaction
signed under the old key — they will fail signature verification on
inclusion.

The address itself **never changes**. Storing addresses in contracts (for
balances, allowances, ACLs) remains valid across any number of key
rotations.

### Why no native key-recovery

Pyde does not ship a built-in social-recovery scheme. The intended pattern
for high-value accounts is `MultiSig` with guardian keys:

```
keys: [
  Owner       (weight 3 if you implement weighted multisig in a contract),
  Guardian_1  (weight 1),
  Guardian_2  (weight 1),
  Guardian_3  (weight 1),
]
threshold: 3

Normal:    Owner signs alone (weight 3 == threshold).
Recovery:  Three guardians together (1+1+1 = 3) authorize a key rotation.
```

The base `MultiSig` variant in `AuthKeys` provides equal-weight `t-of-n`.
Weighted variants live at the contract layer (a deployed multisig contract
that owns the EOA via key rotation).

---

## 11.6 Transaction Wire Format

A transaction in `crates/tx/src/types.rs`:

```rust
struct Transaction {
    from:        Address,        // 32 B
    to:          Address,        // 32 B (Address::ZERO for deploy)
    value:       u128,           // 16 B (in quanta)
    data:        Vec<u8>,        // calldata or initcode
    gas_limit:   u64,            // 8 B
    nonce:       u64,            // 8 B (in [base, base+15])
    signature:   FalconSig,      // ~666 B
    fee_payer:   FeePayer,       // tag + optional address (1-33 B)
    access_list: Vec<AccessEntry>,
    deadline:    Option<u64>,    // 0 or 8 B
    chain_id:    u64,            // 8 B
    tx_type:     TransactionType,// 1 B (see §11.8)
}
```

### `fee_payer`

```rust
enum FeePayer {
    Sender,                 // pays from their own balance (default)
    GasTank,                // gas paid from the target contract's gas_tank
    Paymaster(Address),     // gas paid by named paymaster (calls validator)
}
```

See Chapter 10 for sponsorship semantics.

### `access_list`

```rust
struct AccessEntry {
    address:      Address,
    storage_keys: Vec<U256>,
    access_type:  AccessType,    // Read | ReadWrite
}
```

The access list drives parallel execution (Chapter 9). Wallets generate it
automatically by simulating the transaction (`pyde_createAccessList`) and
attach it to the signed transaction. If the actual on-chain execution
touches a slot not in the access list, the transaction reverts cleanly with
`AccessListViolation`.

### `deadline`

A slot height after which the tx becomes invalid. If included before
`deadline` it executes normally; if not, it is dropped from mempools and
the nonce slot frees up. Recommended values:

| Use case          | Deadline (slots after submission) | Wall time     |
| ----------------- | --------------------------------- | ------------- |
| DEX swap          | +25                                | ~10 sec       |
| Token transfer    | +150                               | ~60 sec       |
| Mint              | +750                               | ~5 min        |
| Governance vote   | +37,500                            | ~4 hr         |
| No urgency        | `None`                             | indefinite    |

### Transaction hash

Computed via Poseidon2 over the canonical encoding of all fields. The
signature is over this hash:

```
tx_hash = Poseidon2(
    chain_id || from || to || value || Poseidon2(data) || gas_limit || nonce ||
    fee_payer_tag || Poseidon2(access_list) || deadline || tx_type
)
```

`data` and `access_list` are pre-hashed to keep the outer Poseidon2 input
size bounded.

### Typical sizes

A simple transfer (no calldata, no access list, no deadline) is roughly
**780 bytes** — dominated by the FALCON-512 signature. A complex tx with a
populated access list and several KB of calldata can reach the 128 KB
`MAX_TX_SIZE`.

---

## 11.7 Multisig Treasury Spend

Beyond per-account multisig (where `auth_keys = MultiSig{...}`), Pyde has a
**treasury-level multisig** for protocol-funded actions. This is what
moves PYDE out of the treasury account when a PIP is approved.

The mechanism uses two new transaction types:

| Type ID | Name             | Purpose                                  |
| ------- | ---------------- | ---------------------------------------- |
| 9       | `MultisigTx`     | Treasury spend: debit treasury, credit target |
| 10      | `RotateMultisig` | Rotate the signer set + threshold         |

The current signer set and threshold live in state under the discriminators
`MULTISIG_SIGNERS` / `MULTISIG_THRESHOLD`; replay is prevented by
`MULTISIG_NONCE`. See Chapter 15 for the governance flow that produces
these signatures.

The handler enforces:

- `value > 0`
- `target != Address::ZERO`
- `target != treasury_address`
- `target != tx.from` (prevents pipeline-writeback clobber)
- `tx.to == Address::ZERO` (must not collide with a regular tx target)

The signature count + threshold check happens against the on-chain signer
set. A successful spend bumps `MULTISIG_NONCE` so the same signed payload
cannot be replayed.

---

## 11.8 Transaction Types

The `TransactionType` enum (in `crates/tx/src/types.rs`) currently has 13
variants:

| ID  | Name              | What it does                                                |
| --- | ----------------- | ----------------------------------------------------------- |
| 0   | `Standard`        | Value transfer or contract call                             |
| 1   | `Deploy`          | Contract deployment (`to == Address::ZERO`, data == initcode)|
| 2   | `Batch`           | Multiple operations atomically (or best-effort)             |
| 3   | `StakeDeposit`    | Lock 10K PYDE, register validator (data = FALCON pubkey 897 B)|
| 4   | `StakeWithdraw`   | Begin 14-day unbonding                                       |
| 5   | `Slash`           | Submit double-sign evidence (data = serialized evidence)    |
| 6   | `ClaimReward`     | Claim accrued staking yield from the pool                   |
| 7   | `ClaimAirdrop`    | Claim genesis airdrop with Merkle proof                     |
| 8   | `SweepAirdrop`    | Move unclaimed airdrop residue to treasury (post-deadline)  |
| 9   | `MultisigTx`      | Treasury spend with multisig signatures                     |
| 10  | `RotateMultisig`  | Rotate multisig signer set + threshold                      |
| 11  | `EmergencyPause`  | Halt block production (multisig-signed)                     |
| 12  | `EmergencyResume` | Resume normal processing (multisig-signed, clears pause)    |

Each handler in `crates/tx/src/pipeline.rs` validates the type-specific
payload, applies the state effect, and runs through the same fee
distribution + post-execution writeback. Unknown discriminators are
rejected at validation.

---

## 11.9 Batch Transactions

```rust
enum FailureMode {
    Atomic,       // failure -> revert the entire batch
    BestEffort,   // failure -> skip and continue
}

struct BatchOperation {
    to:           Address,
    value:        u128,
    data:         Vec<u8>,
    gas_limit:    u64,           // per-op (0 = use remaining gas)
    failure_mode: FailureMode,
}

struct BatchTransaction {
    // standard tx fields...
    tx_type:    TransactionType::Batch,
    operations: Vec<BatchOperation>,
}
```

A `Batch` consumes one nonce, one signature, and one base-tx overhead. Each
operation runs sequentially within the batch.

### Per-op failure modes

- **Atomic**: a revert in the operation reverts the whole batch.
- **BestEffort**: the operation reverts, the batch continues, and the
  receipt records the per-op outcome.

### Gas savings

| Cost component        | N individual txs    | One batch tx                    |
| --------------------- | ------------------- | ------------------------------- |
| Base tx cost (21,000)  | 21,000 × N          | 21,000                          |
| Signature verify (FALCON)| 20,000 × N        | 20,000                          |
| Nonce validation      | ~100 × N            | ~100                            |
| Per-op execution gas  | sum of op gas       | sum of op gas                    |
| **Overhead saved**    | —                   | **(41,100 × (N − 1))**          |

For 5 operations, that's roughly 164,400 gas saved on overhead alone.

### Receipt

```rust
struct BatchReceipt {
    tx_hash:           Hash,
    success:           bool,            // false if any Atomic op failed
    total_gas_used:    u64,
    total_fee:         u128,
    operation_results: Vec<OperationResult>,
}

struct OperationResult {
    success:       bool,
    gas_used:      u64,
    return_data:   Vec<u8>,
    logs:          Vec<Log>,
    revert_reason: Option<Vec<u8>>,
}
```

---

## 11.10 Contract Code and Storage

### Deployment

```rust
Transaction {
    from:    deployer,
    to:      Address::ZERO,                  // signals deployment
    value:   ...,
    data:    init_bytecode,                  // executed once at deploy
    gas_limit: ...,
    nonce:   ...,
    tx_type: TransactionType::Deploy,
    ...
}
```

The PVM executes `init_bytecode` against a fresh context. The init code's
return value is stored as the contract's runtime bytecode. The deployed
contract address is `Poseidon2(deployer || nonce)` (see §11.2). The
`code_hash` is set to `Poseidon2(runtime_bytecode)`.

After deployment, the `code_hash` is **immutable**. Upgradeability is
handled at the application layer with the proxy pattern:

```
+-----------+         DELEGATECALL          +------------------+
|   Proxy   |  ---------------------------> |  Implementation  |
| (fixed)   |                               |  (v1, v2, v3)    |
| storage:  |  proxy uses its own storage   |  no storage of   |
|  current_ |  but executes the impl's code  |  its own         |
|  impl     |                               +------------------+
+-----------+
```

The proxy's address never changes; upgrading is a single state write to
`current_impl` in the proxy's storage.

### Storage schema

Otigen's compile-time storage layout (Chapter 5) and the JMT key derivation
(Chapter 4) together produce a fully typed storage model. There is no
"random raw 256-bit slot" — every storage access is keyed against the
contract address with a discriminator that came from a typed declaration.

---

## 11.11 Account State in the JMT

Accounts and their storage all live in the same JMT. A single Merkle path
from the JMT root proves any claim about any account.

To prove "Alice's balance at slot S equals X":

1. Show the JMT path from the slot-S state root (in the block header) to
   Alice's account leaf.
2. Decode the account record; read the `balance` field.

There is no separate "account trie" + "storage trie" indirection. One root,
one path, one proof.

Light clients use this property to verify state without storing the full
chain — they need block headers and on-demand JMT proofs from full nodes.

---

## 11.12 Worked Lifecycle: Sponsored Token Transfer

```
Step 1 — Wallet builds tx
  from:        0xpyde1abc... (Alice)
  to:          0xpyde1def... (DEX contract)
  value:       0
  data:        swap(USDC, PYDE, 1000)
  gas_limit:   150,000
  nonce:       42 (within Alice's nonce window)
  fee_payer:   GasTank          <- DEX contract pays
  deadline:    block 2,000,025  (10 sec from now)
  chain_id:    1
  tx_type:     Standard
  signature:   FALCON-512(Alice's sk, hash of all fields)

Step 2 — RPC ingress
  - chain_id matches
  - FALCON sig verifies against Alice's auth_keys
  - nonce 42 is in [40, 55]
  - DEX.gas_tank >= 150_000 * base_fee
  - deadline > current_slot
  - access_list dedup OK
  - tx size + calldata size within limits
  -> ENQUEUE on gossip channel BEFORE returning Ok

Step 3 — Mempool propagation
  Encrypted payload reaches every node's mempool via gossipsub.

Step 4 — DAG vertex production (round R)
  Tx referenced by batch hash in worker batch; each committee member's
  primary references the batch in its round-R vertex.

Step 5 — Wave commit (round R+3, ~500 ms after submission)
  Deterministic anchor commits the subdag; canonical order emitted.

Step 6 — Threshold decryption (rounds R+4 to R+5)
  85+ Kyber shares -> shared_secret -> AES decrypt payload.

Step 7 — Execution (hybrid scheduler)
  - PVM gas charged from DEX.gas_tank (FeePayer::GasTank).
  - Conflict graph built from access list; parallel groups execute.
  - DEX swap logic runs: SLOAD reserves, SLOAD/SSTORE Alice's USDC,
    transfer PYDE to Alice.
  - Total gas used: 87,400.

Step 8 — Fee distribution
  total_fee = 87,400 * base_fee
  burn:       70%
  reward pool: 20%  (distributed at epoch end across stakers)
  treasury:   10%
  Debited from DEX.gas_tank.

Step 9 — State writeback
  Alice's USDC balance updated, PYDE balance updated, DEX gas_tank
  debited.  Alice's nonce 42 marked used; window slides if 40, 41 also used.

Step 10 — Finality (state root attestation, ~500 ms median end-to-end)
  85+ FALCON state-root sigs piggybacked on subsequent vertices.

Step 11 — Receipt
  pyde_getTransactionReceipt returns success, gas_used, logs, fee_paid.
```

---

## Summary

| Property                  | Value                                          |
| ------------------------- | ---------------------------------------------- |
| Address size              | 32 bytes (Poseidon2 hash, no truncation)        |
| Address derivation        | EOA from FALCON pk; CREATE / CREATE2 from deployer |
| Account types             | EOA, Contract, System                           |
| Auth schemes              | `None`, `Single` FALCON pk, `MultiSig{keys, threshold}` |
| Address mutability        | Immutable across key rotations                  |
| Nonce window              | 16 slots (bitmap), sliding base                 |
| Native account abstraction| Yes (`fee_payer = GasTank` / `Paymaster(addr)`) |
| Multisig per-account      | Yes (via `AuthKeys::MultiSig`)                  |
| Multisig treasury         | Yes (`MultisigTx` = type 9)                     |
| Batch transactions        | Yes (`Batch` = type 2, `Atomic` / `BestEffort`) |
| Transaction types         | 13 (Standard, Deploy, Batch, Stake*, Slash, Claim*, Sweep*, Multisig*, Emergency*) |
| Validation gas cap        | 100,000 for paymaster validation                |

The next chapter covers the networking layer that ferries all these
transactions between nodes — libp2p, QUIC, the four gossipsub channels, and
the FALCON peer-attestation handshake.
