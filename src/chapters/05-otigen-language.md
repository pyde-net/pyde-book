# Chapter 5: Otigen Language

Pyde's smart contract language is **Otigen**. Source files use the `.oti`
extension. The compiler is **`otic`**. Output is a JSON artifact containing
PVM bytecode, an ABI, and metadata — deployable directly via
`wright deploy`.

Otigen is a domain-specific language for blockchain execution. It looks like
Rust at the statement level, but every default is biased toward safety:
reentrancy is blocked unless explicitly opted into, arithmetic is checked,
storage is typed, and `tx.origin` does not exist as a feature.

Otigen also generates the data the runtime needs for parallel execution.
The compiler emits a **compile-time access list** alongside each function:
the set of storage slots the function will read or write, derived from
the typed `storage { ... }` block. When a function's access pattern is
statically resolvable, the scheduler uses these lists to build a conflict
graph and run non-conflicting transactions in parallel (Solana-style).
Functions whose access pattern is dynamic (e.g., cross-contract calls to
runtime-known addresses) fall back to **Block-STM speculation**
(Aptos-style). See Chapter 9 for the hybrid scheduler.

---

## 5.1 Design Principles

### Reentrancy off by default

Every public function is wrapped with an automatic reentrancy guard at
codegen time. The guard uses a reserved storage slot
(`(-2i32 & 0x3FFFF) = 0x3FFFE`, far outside the user-allocated slot range
that starts at 0). On entry the guard reads the slot, asserts it is zero,
sets it to 1; on exit, it clears back to zero.

```
Default behavior:

  Contract A → Contract B
  Contract B tries to call back into A
  → REVERT: reentrancy guard triggered

Explicit opt-in:

  #[reentrant]
  pub fn deposit(amount: u256) { ... }
  // Guard is omitted; A may be re-entered.
```

`#[view]` and `#[constructor]` functions also have no guard (the former cannot
mutate state; the latter runs only once).

### Checked arithmetic by default

Integer overflow and underflow trap. There is no silent wrapping in `+`,
`-`, `*`, `/`. Wrapping or saturating semantics require explicit calls (via
`std::math`):

```otigen
let a: u256 = u256::MAX;
let b: u256 = a + 1;                        // PANIC: overflow

use std::math;
let c: u256 = math::wrapping_add(a, 1);     // c = 0
let d: u256 = math::saturating_add(a, 1);   // d = u256::MAX
```

The PVM's underlying scalar opcodes already trap on overflow; the compiler
relies on that rather than emitting separate check instructions.

### Typed storage

The `storage { ... }` block declares persistent fields by type. The compiler
assigns sequential `u32` slot indices starting at 0 and emits the correct
serialization. Two contracts cannot collide on storage because every key is
derived from the contract address (see §5.7).

### No `tx.origin`

The classic phishing vector — using the originating EOA address through a
chain of cross-contract calls — is not exposed. Authorization checks must
use `msg.sender`, which always reflects the immediate caller.

---

## 5.2 The 30 Keywords

The complete list (defined in `crates/otic/src/token.rs`):

```
contract    storage     struct      interface   event       error
enum        const       fn          pub         let         mut
if          else        for         while       match       return
emit        try         use         module      in          as
break       continue    self        type        true        false
```

That's everything. The grammar is small enough to fit in one block.

---

## 5.3 Type System

### Primitive types

| Type      | Size    | Range / use                                          |
| --------- | ------- | ---------------------------------------------------- |
| `u8`      | 1 B     | 0..255                                               |
| `u16`     | 2 B     | 0..65,535                                            |
| `u32`     | 4 B     | 0..4,294,967,295                                     |
| `u64`     | 8 B     | 0..2^64−1                                            |
| `u128`    | 16 B    | 0..2^128−1 (PYDE quanta)                             |
| `u256`    | 32 B    | 0..2^256−1 (token amounts, hashes)                   |
| `i8`–`i256` | matching | signed two's complement                            |
| `bool`    | 1 B     | `true` / `false`                                     |
| `Address` | 32 B    | account / contract address                           |
| `String`  | dyn     | UTF-8 wrapper around `bytes`                         |
| `bytes`   | dyn     | raw byte array                                       |

All arithmetic — signed and unsigned — is checked. Implicit widening is
allowed (`u8` → `u256`); narrowing requires an explicit `as` cast and traps
on out-of-range values.

### Composite types

| Type            | Notes                                                          |
| --------------- | -------------------------------------------------------------- |
| `[T; N]`        | fixed-size array (compile-time bounds checks where possible)   |
| `Vec<T>`        | dynamically-sized vector, `header on stack, data on heap`      |
| `Map<K,V>`      | **storage-only** — declared inside `storage { }`, not local    |
| `(T1, T2, ...)` | tuple                                                          |
| `struct`        | user-defined product type                                      |
| `enum`          | user-defined sum type with optional payloads + exhaustive match|
| `Contract<C>`   | typed handle to a deployed contract (returned by `deploy!`)    |
| `Interface<I>`  | typed handle for cross-contract calls (`I::at(addr)`)          |

Maps are **only** legal inside `storage { ... }` blocks. They lower to
`Sload`/`Sstore` against `Poseidon2(slot, key)`. For in-memory key-value
data inside a function, use `Vec<(K, V)>` or a struct.

Type aliases:

```otigen
type TokenId = u256;
type AddressList = Vec<Address>;
```

---

## 5.4 Contract Structure

```otigen
contract MyToken {
    storage {
        name:         String,
        symbol:       String,
        total_supply: u256,
        balances:     Map<Address, u256>,
        allowances:   Map<Address, Map<Address, u256>>,
    }

    event Transfer {
        #[indexed] from: Address,
        #[indexed] to:   Address,
        amount:          u256,
    }

    error InsufficientBalance { available: u256, required: u256 }

    #[constructor]
    pub fn init(name: String, symbol: String, initial_supply: u256) {
        self.name = name;
        self.symbol = symbol;
        self.total_supply = initial_supply;
        self.balances[msg.sender] = initial_supply;
    }

    pub fn transfer(to: Address, amount: u256) {
        let sender_bal = self.balances[msg.sender];
        require!(sender_bal >= amount, InsufficientBalance {
            available: sender_bal,
            required:  amount,
        });
        self.balances[msg.sender] = sender_bal - amount;
        self.balances[to] = self.balances[to] + amount;

        emit Transfer { from: msg.sender, to: to, amount: amount };
    }

    #[view]
    pub fn balance_of(owner: Address) -> u256 {
        self.balances[owner]
    }
}
```

`self` always refers to the current contract's storage. `self.field_name`
reads or writes the corresponding slot. Local variables (`let`, `let mut`)
are transient — they live only in PVM memory during execution.

---

## 5.5 Function Visibility and Attributes

### Visibility

| Visibility   | Syntax              | Callable by                                  |
| ------------ | ------------------- | -------------------------------------------- |
| Public       | `pub fn`            | external transactions, other contracts       |
| Internal     | `fn`                | same contract only (compiler-inlined when small) |

`pub` functions get a 4-byte selector entry in the dispatch table; internal
functions don't.

### Attributes (8)

| Attribute                   | Target     | Effect                                                |
| --------------------------- | ---------- | ----------------------------------------------------- |
| `#[constructor]`            | function   | Runs once at deploy. Cannot be called afterwards.     |
| `#[view]`                   | function   | Read-only — no `Sstore`/`emit`/state-mutating call.   |
| `#[payable]`                | function   | Accepts native PYDE value (`msg.value` available).    |
| `#[reentrant]`              | function   | Disables the default reentrancy guard.                |
| `#[receive]`                | function   | Called on bare value transfer (no selector).          |
| `#[fallback]`               | function   | Called when no selector matches.                      |
| `#[test]`                   | function   | Marks the function as a unit test for `otic test`.   |
| `#[sponsored]`              | function   | Gas paid by the calling account's gas tank.           |
| `#[sponsored(Paymaster)]`   | function   | Gas paid by the named paymaster contract.             |

Compatibility rules enforced by the safety checker
(`crates/otic/src/safety.rs`): `#[view]` cannot combine with `#[payable]`,
`#[constructor]` cannot combine with `#[view]`, and only one
sponsorship attribute may appear at a time.

### Event field attribute

| Attribute      | Target      | Effect                                        |
| -------------- | ----------- | --------------------------------------------- |
| `#[indexed]`   | event field | Marks the field as a topic (max 3 per event). |

---

## 5.6 Events

Events are emitted with `emit`, indexed up to three fields, and routed into
the transaction receipt for off-chain consumption.

```otigen
event Transfer {
    #[indexed] from: Address,
    #[indexed] to:   Address,
    amount:          u256,        // not indexed: lives in event data
}

emit Transfer { from: msg.sender, to: recipient, amount: value };
```

### Encoding

```
Event log entry:
+-------------------+--------------------------+-----------------+----------------+
| contract_address  | topic_0 (4 B selector +  | topic_1, _2, _3 | data (encoded  |
| (32 bytes)         | 28 B padding to 32)      | indexed fields  | non-indexed)   |
+-------------------+--------------------------+-----------------+----------------+
```

`topic_0` is the FNV-1a 32-bit hash of the event name, padded to 32 bytes.
Indexed fields fill `topic_1` through `topic_3` in declaration order.

### Gas

| Operation         | Gas (PVM `Log` opcode) |
| ----------------- | ---------------------- |
| Emit base         | 375                    |
| Per data byte     | 8                      |

---

## 5.7 Storage Layout

### Single fields

```otigen
storage {
    counter: u64,        // slot 0
    owner:   Address,    // slot 1
    paused:  bool,       // slot 2
}
```

Lowering:

```
counter -> Poseidon2(contract_address, 0)
owner   -> Poseidon2(contract_address, 1)
paused  -> Poseidon2(contract_address, 2)
```

### Maps

```otigen
storage {
    balances: Map<Address, u256>,      // slot 3
}
```

Lowering:

```
self.balances[user] -> Poseidon2(contract_address, Poseidon2(3, user))
```

### Nested maps

```otigen
storage {
    allowances: Map<Address, Map<Address, u256>>,   // slot 4
}
```

Lowering:

```
self.allowances[owner][spender]
  -> Poseidon2(contract_address, Poseidon2(4, Poseidon2(owner, spender)))
```

Each nesting level adds one `Poseidon2` call. There is no struct packing —
each storage field occupies one or more slots, never sharing.

---

## 5.8 Error Handling

Otigen has three error mechanisms, all of which abort the transaction and
roll back state writes.

### `require!()`

```otigen
require!(amount > 0, "amount must be positive");
require!(balance >= amount, InsufficientBalance {
    available: balance,
    required:  amount,
});
```

Either a string message or a custom error struct works. Custom errors are
preferred — they encode as a 4-byte selector + ABI-encoded fields, more
compact and easier to decode off-chain than a string.

### `revert!()`

```otigen
if some_condition() {
    revert!("not supported in this state");
}
revert!(Unauthorized {});
```

Unconditional abort.

### Custom errors

```otigen
error InsufficientBalance { available: u256, required: u256 }
error TransferToZeroAddress {}
error AllowanceExceeded { current_allowance: u256, requested: u256 }
```

Encoded as `selector(4 bytes) || abi_encode(fields)` in the revert data.

### Revert semantics

- All state changes since the start of the transaction (or sub-call) are
  rolled back.
- Gas spent up to the revert point is consumed (paid by the fee payer).
- The error data is stored in the transaction receipt for clients to decode.

---

## 5.9 Cross-Contract Calls

### Interfaces

```otigen
interface IERC20 {
    fn transfer(to: Address, amount: u256);
    fn balance_of(owner: Address) -> u256;
    fn approve(spender: Address, amount: u256);
}
```

### Typed calls

```otigen
let token = IERC20::at(self.token_address);
token.transfer(recipient, amount);

#[view]
pub fn check_balance() -> u256 {
    let token = IERC20::at(self.token_address);
    token.balance_of(address(self))
}
```

Each cross-contract call lowers to a `CallExt` opcode (2,500 gas plus the
callee's execution cost). The callee runs with `msg.sender = address(self)`
and a fresh reentrancy guard for its own contract.

### `try` for fallible calls

```otigen
let result = try IERC20::at(token).transfer(to, amount);
if result.is_err() {
    emit TransferFailed { token: token, to: to, amount: amount };
}
```

Without `try`, a reverting cross-contract call bubbles up and reverts the
caller. With `try`, the caller observes the failure and decides how to
proceed.

### Low-level `raw_call!`

```otigen
let (success, return_data) = raw_call!(
    target:   contract_address,
    calldata: encoded_data,
    gas:      100_000,
    value:    0,
);
```

Used when the callee's interface is not known at compile time.

---

## 5.10 Built-in Globals and Functions

### Globals

| Variable          | Type      | Source                                          |
| ----------------- | --------- | ----------------------------------------------- |
| `msg.sender`      | `Address` | immediate caller                                |
| `msg.value`       | `u256`    | native PYDE value sent with the call             |
| `msg.data`        | `bytes`   | raw calldata                                     |
| `block.height`    | `u64`     | wave_id of the committing wave                  |
| `block.timestamp` | `u64`     | commit timestamp (seconds, consensus-set)  |
| `block.anchor`    | `Address` | address of the anchor member of the committing wave |
| `tx.gas_price`    | `u256`    | base fee at submission                          |
| `tx.nonce`        | `u64`     | sender's nonce in the bitmap window              |
| `tx.hash`         | `u256`    | this transaction's hash                          |
| `tx.gas_limit`    | `u64`     | the limit set by the sender                     |
| `address(self)`   | `Address` | this contract's address                         |
| `gas_remaining()` | `u64`     | remaining gas in the current execution context   |

`tx.origin` is **deliberately not provided**. Use `msg.sender`.

`block.proposer` (the Solidity convention) does not exist on Pyde — the
DAG has no single proposer. `block.anchor` is the closest analog: the
deterministically-selected committee member whose vertex commits the
wave. Contracts that depended on `block.proposer` for proposer rewards
or proposer-gated logic on other chains do not have an analog here.

### Built-in functions and macros (5)

| Name             | Kind     | What it does                                          |
| ---------------- | -------- | ----------------------------------------------------- |
| `hash(...)`      | function | Variadic Poseidon2 hash (any number of arguments)    |
| `require!(...)`  | macro    | Assert a condition or revert with the given error    |
| `revert!(...)`   | macro    | Unconditionally revert                                |
| `cross_call!(...)`| macro   | Async parachain message (post-mainnet feature stub)   |
| `raw_call!(...)` | macro    | Low-level external call returning raw bytes          |

`cross_call!` is wired through the parser and IR but is a no-op at mainnet
because the parachain SDK is post-mainnet.

---

## 5.11 Standard Library

### `std::math` (15 functions)

```otigen
use std::math;

let r = math::sqrt(value);
let m = math::min(a, b);
let M = math::max(a, b);
let p = math::pow(base, exp);
let c = math::clamp(x, lo, hi);
let d = math::mul_div(a, b, divisor);   // (a*b)/divisor without intermediate overflow
```

Plus `abs_diff`, `average`, `log10`, `checked_*`, `saturating_*`,
`wrapping_*` for `add` / `sub`.

### `std::hash` (3 functions)

```otigen
use std::hash;

let h  = hash::poseidon2(data);                  // bytes -> 256-bit
let h2 = hash::poseidon2_pair(left, right);      // (256, 256) -> 256
let h3 = hash::poseidon2_many(elements);         // sponge over Vec<u256>
```

The variadic `hash(...)` built-in uses the same primitive under the hood.

### `std::signature` (2 functions)

```otigen
use std::signature;

let ok = signature::verify(sig, msg, pubkey);
let addr = signature::recover(sig, msg);
```

`verify` validates a FALCON-512 signature; `recover` recovers an address from
a signature + message pair (where the address was bound at sign time).

### `std::token` (3 interfaces)

Pre-defined `IERC20`, `IERC721`, and `INFT` interfaces ready to import. Use:

```otigen
use std::token::IERC20;
let bal = IERC20::at(token_addr).balance_of(user);
```

---

## 5.12 Compiler Pipeline

The `otic` compiler runs nine stages:

```
.oti source
   │
   ▼
+-------+   +--------+   +----------+   +-----------+   +--------+
| Lex   |─▶| Parse   |─▶| Resolve  |─▶| Typecheck │─▶| Safety │
+-------+   +--------+   +----------+   +-----------+   +--------+
                                                          │
   +-------+   +----------+   +---------+   +-----------+ │
   │ Lower │◀──│ (loop  ◀──│ Optimize│◀──│ (per-fn)  │◀┘
   +-------+   +----------+   +---------+   +-----------+
       │
       ▼
   +---------+
   │ Codegen │  →  PVM bytecode + ABI JSON
   +---------+
```

| Stage            | Output                                                   |
| ---------------- | -------------------------------------------------------- |
| Lexer            | tokens (with `Span` metadata)                            |
| Parser           | AST: contracts, structs, enums, functions, etc.          |
| Resolver         | name resolution; rejects shadowing of builtins           |
| Typechecker      | infers + validates types, applies widening rules         |
| Safety checker   | attribute consistency, sponsorship rules                 |
| Lowerer          | produces flat register-based IR (basic blocks + insts)    |
| Optimizer        | constant folding, DCE, unused-vreg elimination           |
| Codegen          | linear-scan register allocation, PVM bytecode emission   |

### Optimizer passes

| Pass                          | What it does                                       |
| ----------------------------- | -------------------------------------------------- |
| Constant folding              | evaluates compile-time `Add`/`Sub`/`Mul`/`Div` etc.|
| Dead code elimination         | removes unreachable basic blocks                   |
| Unused register elimination   | strips IR that has no consumer                     |

### Register allocation

Linear-scan allocation. 11 GP scratch registers (`r1`–`r11`) and 6 wide
scratch registers (`w0`–`w6`) are available to user code; `r0`, `r2`, `r3`,
`r12`–`r15` and `w7` are reserved for the ABI / runtime. Allocation is
**no-eviction**: once a vreg is bound to a hardware register, it stays until
the function returns. Spills land in memory through `r14`/`r15`.

---

## 5.13 ABI Format

The `otic` build emits a JSON artifact with this shape (simplified):

```json
{
  "contractName":         "Counter",
  "compiler":             "otic <version>",
  "bytecode":             "0x...",
  "constructorBytecode":  "0x...",
  "deployedBytecode":     "0x...",
  "instructionCount":     1024,
  "selectors": {
    "0xd14e6e7c":         "increment",
    "0x12a7b3f2":         "get_count"
  },
  "abi": {
    "contract":  "Counter",
    "functions": [
      {
        "name":        "increment",
        "selector":    "0xd14e6e7c",
        "params":      [{ "name": "amount", "type": "u256" }],
        "returns":     "",
        "view":        false,
        "payable":     false,
        "constructor": false,
        "reentrant":   false
      }
    ],
    "events": [
      {
        "name":   "Incremented",
        "fields": [{ "name": "new_value", "type": "u256", "indexed": true }]
      }
    ],
    "errors": [
      { "name": "OverflowError", "fields": [{ "name": "max", "type": "u256" }] }
    ],
    "storage": [
      { "name": "count",   "type": "u256",                "slot": 0 },
      { "name": "allowed", "type": "Map<Address,u256>",   "slot": 1 }
    ],
    "structs": [],
    "enums":   []
  }
}
```

### Function selectors

Selectors are 4-byte FNV-1a hashes of the function name (`compute_selector`
in `crates/otic/src/codegen.rs`). The constructor uses selector `0x00000000`
(it is not callable through the dispatch table — it runs only during the
deployment transaction).

---

## 5.14 The `otic` CLI

```
otic build <file.oti>    Compile to .json artifact (bytecode + ABI)
otic check <file.oti>    Type check without emitting bytecode
otic test  <file.oti>    Run #[test] functions on an embedded PVM
otic abi   <file.oti>    Print only the ABI JSON
otic lex   <file.oti>    (debug) Dump the token stream
```

Most projects use `wright build` / `wright test` instead, which wraps
`otic` and applies project-level conventions (multiple files, dependencies,
`pyde.toml` config).

---

## 5.15 The `#[test]` Harness

Functions tagged `#[test]` are compiled, isolated, loaded into a fresh PVM
instance (with a 1 M gas limit), and stepped to completion (capped at
100,000 instructions per test). The test passes if the function halts
normally; `#[should_panic]` (encoded in a doc comment) inverts the
expectation.

```otigen
#[test]
fn test_overflow() {
    let a: u256 = u256::MAX;
    let _ = a + 1;     // expected to panic
}
```

```
$ otic test src/counter.oti
running 7 tests...
  test_increment ... ok
  test_decrement ... ok
  test_overflow  ... ok (panicked as expected)
  ...
ok. 7 passed; 0 failed.
```

---

## 5.16 Modules

Otigen supports splitting code across multiple files using `module` and
`use`. Standard-library modules live under `std::`:

```otigen
// file: src/math_utils.oti
module math_utils;

pub fn percentage(value: u256, bps: u256) -> u256 {
    value * bps / 10_000
}
```

```otigen
// file: src/token.oti
use math_utils;

contract Token {
    storage { fee_bps: u256, balances: Map<Address, u256> }

    pub fn apply_fee(amount: u256) -> u256 {
        let fee = math_utils::percentage(amount, self.fee_bps);
        amount - fee
    }
}
```

`use` can also pull in items from sibling files relative to the source root
(e.g. `use events::transfer::Transfer`). `wright` resolves the import
graph during `build`.

---

## 5.17 Worked Example: ERC-20 Token

```otigen
contract PydeToken {
    storage {
        name:         String,
        symbol:       String,
        decimals:     u8,
        total_supply: u256,
        balances:     Map<Address, u256>,
        allowances:   Map<Address, Map<Address, u256>>,
    }

    event Transfer {
        #[indexed] from: Address,
        #[indexed] to:   Address,
        amount:          u256,
    }

    event Approval {
        #[indexed] owner:   Address,
        #[indexed] spender: Address,
        amount:             u256,
    }

    error InsufficientBalance   { available: u256, required: u256 }
    error InsufficientAllowance { available: u256, required: u256 }
    error TransferToZeroAddress {}

    #[constructor]
    pub fn init(name: String, symbol: String, decimals: u8, initial_supply: u256) {
        self.name = name;
        self.symbol = symbol;
        self.decimals = decimals;
        self.total_supply = initial_supply;
        self.balances[msg.sender] = initial_supply;

        emit Transfer { from: Address::ZERO, to: msg.sender, amount: initial_supply };
    }

    pub fn transfer(to: Address, amount: u256) {
        require!(to != Address::ZERO, TransferToZeroAddress {});

        let from_bal = self.balances[msg.sender];
        require!(from_bal >= amount, InsufficientBalance {
            available: from_bal, required: amount,
        });

        self.balances[msg.sender] = from_bal - amount;
        self.balances[to] = self.balances[to] + amount;

        emit Transfer { from: msg.sender, to: to, amount: amount };
    }

    pub fn approve(spender: Address, amount: u256) {
        self.allowances[msg.sender][spender] = amount;
        emit Approval { owner: msg.sender, spender: spender, amount: amount };
    }

    pub fn transfer_from(from: Address, to: Address, amount: u256) {
        require!(to != Address::ZERO, TransferToZeroAddress {});

        let allow = self.allowances[from][msg.sender];
        require!(allow >= amount, InsufficientAllowance { available: allow, required: amount });
        self.allowances[from][msg.sender] = allow - amount;

        let from_bal = self.balances[from];
        require!(from_bal >= amount, InsufficientBalance { available: from_bal, required: amount });
        self.balances[from] = from_bal - amount;
        self.balances[to] = self.balances[to] + amount;

        emit Transfer { from: from, to: to, amount: amount };
    }

    #[view] pub fn balance_of(owner: Address) -> u256 { self.balances[owner] }
    #[view] pub fn allowance(owner: Address, spender: Address) -> u256 { self.allowances[owner][spender] }
    #[view] pub fn get_total_supply() -> u256 { self.total_supply }
}
```

This compiles to PVM bytecode that the AOT compiler then converts to native
machine code at deploy time. The dispatch table maps the four-byte selectors
of `transfer`, `approve`, `transfer_from`, `balance_of`, `allowance`, and
`get_total_supply` to their respective entry points.

---

## 5.18 Operators

Otigen uses standard infix syntax. All arithmetic operators are checked.

| Category    | Operators                                                       |
| ----------- | --------------------------------------------------------------- |
| Arithmetic  | `+ - * / %`                                                     |
| Comparison  | `== != < > <= >=`                                                |
| Logical     | `&& \|\| !`                                                      |
| Bitwise     | `& \| ^ ~ << >>`                                                 |
| Assignment  | `= += -= *= /= %= &= \|= ^= <<= >>=`                              |

Loops are gas-bound by the transaction's `gas_limit`; there is no separate
loop-count cap. A runaway loop runs out of gas and reverts.

---

## 5.19 What's Not Yet in the Language

Honest about the gaps tracked for post-mainnet:

- **No user-defined generics.** `Vec<T>`, `Map<K,V>`, `[T; N]` are
  parametric; user `fn foo<T>(...)` is not yet supported.
- **No `Result<T, E>` enum sugar.** Errors flow through `require!` /
  `revert!` and `try` blocks, not via a return-type ADT.
- **No struct packing.** Each storage field occupies its own slot.
- **`cross_call!` is parsed but inert at mainnet.** The parachain SDK that
  would make it real is post-mainnet work.

These are tracked in the project's post-mainnet research list, not blockers
for any contract anyone would write today.

---

## Summary

| Property                     | Otigen                                                   |
| ---------------------------- | -------------------------------------------------------- |
| File extension               | `.oti`                                                   |
| Compiler                     | `otic`                                                   |
| Keyword count                | 30                                                        |
| Attribute count              | 8 (function) + 1 (event field)                            |
| Built-in functions/macros     | 5                                                         |
| Reentrancy                   | guarded by default; `#[reentrant]` opts out               |
| Arithmetic                   | checked by default; explicit `wrapping_*` / `saturating_*`|
| Storage model                | typed slots, flat layout, address-derived keys            |
| Map syntax                   | `self.balances[key]` (storage-only)                        |
| Selector format              | 4-byte FNV-1a hash of function name                       |
| Output                       | JSON artifact (bytecode + ABI + metadata)                 |
| Test runner                  | `otic test` runs `#[test]` functions on an embedded PVM   |
| Standard library             | `math`, `hash`, `signature`, `token`                       |
| `tx.origin`                  | not exposed                                                |

The next chapter covers the consensus protocol that decides the order in which
these contract calls execute.
