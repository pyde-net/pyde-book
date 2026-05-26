# Your First Contract

End-to-end: scaffold → write → test. By the end you'll have a working contract that passes a Foundry-style behaviour suite, with full execution traces visible on demand.

This chapter uses Rust. For TinyGo / AssemblyScript / C, the patterns are identical; the per-language `README.md` in each scaffolded project carries the syntactic equivalent.

---

## 1. Scaffold

```bash
otigen init my-counter --lang rust
cd my-counter
```

```text
scaffolded Rust project "my-counter" at my-counter
next: cd my-counter && cargo build --target wasm32-unknown-unknown --release
```

What landed:

```text
my-counter/
├── Cargo.toml             # cdylib + release profile tuned for WASM size
├── Makefile               # build / test / deploy / inspect / verify
├── README.md              # project-local Pyde cheatsheet
├── otigen.toml            # contract metadata + state schema + network
├── .gitignore
├── src/
│   ├── lib.rs             # YOUR CONTRACT (start here)
│   └── host_fns.rs        # every pyde::* host fn declared once
└── tests/
    └── contract.test.toml # behaviour tests
```

Eight files. Most of the line count is in `src/host_fns.rs` (canonical reference of every Pyde host fn declared once with comments — you almost never edit this file) and `README.md` (your project-local cheatsheet — also rarely edited).

The files you'll actually work in:

- **`src/lib.rs`** — your contract code.
- **`otigen.toml`** — declares state fields + function signatures + network endpoints.
- **`tests/contract.test.toml`** — behaviour assertions.

---

## 2. The default contract

`otigen init` produces a minimal counter — one `uint64` storage slot, two entry points:

```rust
// src/lib.rs (excerpt)

#[no_mangle]
pub extern "C" fn increment() -> i64 {
    let next = read_counter().wrapping_add(1);
    write_counter(next);
    next as i64
}

#[no_mangle]
pub extern "C" fn get() -> i64 {
    read_counter() as i64
}
```

`read_counter` and `write_counter` are private helpers that call `pyde::sload_by_field` / `pyde::sstore_by_field`, passing the raw field name (`b"counter"`). The engine derives `slot = Poseidon2(self_address ‖ field ‖ key)` internally — the contract never has to hash anything by hand. See [WASM Contract Author Guide §7 “Field-keyed storage (recommended)”](../companion/WASM_AUTHOR_GUIDE.md) for the per-language breakdown, and the raw `pyde::sload` / `pyde::sstore` if you need to address a slot you derived yourself.

The corresponding `otigen.toml`:

```toml
[state]
schema = [
    { name = "counter", type = "uint64" },
]

[functions.increment]
attributes = ["entry"]            # callable from outside the contract
inputs     = []
outputs    = ["int64"]

[functions.get]
attributes = ["entry", "view"]    # callable + must not mutate (engine enforces)
inputs     = []
outputs    = ["int64"]
```

For the meaning of `attributes` values (`entry`, `view`, `payable`, `reentrant`, `sponsored`, `constructor`, `fallback`, `receive`), see [`HOST_FN_ABI_SPEC §3.5`](../companion/HOST_FN_ABI_SPEC.md).

---

## 3. Add a function

Let's add a `decrement` that fails when the counter is at zero. This exercises three new things:

1. Reading + writing storage in the same call.
2. Reverting from inside the contract.
3. Adding an `[[tests]]` entry that asserts the revert path.

Edit `src/lib.rs`:

```rust
#[no_mangle]
pub extern "C" fn decrement() -> i64 {
    let current = read_counter();
    if current == 0 {
        // pyde::revert traps the contract; the engine rolls back
        // every state change since this call started.
        let msg = b"CounterAtZero";
        unsafe {
            host_fns::revert(msg.as_ptr(), msg.len() as i32);
        }
    }
    let next = current - 1;
    write_counter(next);
    next as i64
}
```

Note `host_fns::revert` is declared `-> !` (never returns) in `src/host_fns.rs`, so Rust knows the function body below the revert is unreachable. No need for a manual `unreachable!()` after.

Declare it in `otigen.toml`:

```toml
[functions.decrement]
attributes = ["entry"]
inputs     = []
outputs    = ["int64"]
```

---

## 4. Add tests

Edit `tests/contract.test.toml` — append three new `[[tests]]` entries:

```toml
# decrement from zero reverts with "CounterAtZero".
[[tests]]
name = "decrement_at_zero_reverts"

[[tests.calls]]
function = "decrement"
expect.revert = "CounterAtZero"


# decrement from non-zero succeeds and reaches zero.
[[tests]]
name = "decrement_to_zero"

[[tests.calls]]
function = "increment"

[[tests.calls]]
function = "increment"

[[tests.calls]]
function = "decrement"

[[tests.calls]]
function = "decrement"
expect.return_value = "0"

[tests.expect]
storage.counter = "0"


# decrement after revert leaves state untouched (rollback semantics).
[[tests]]
name = "revert_rolls_back_state"

[[tests.calls]]
function = "increment"

[[tests.calls]]
function = "decrement"
expect.return_value = "0"

# This call reverts. State changes since the call started are
# discarded; the counter stays at the value from the previous call.
[[tests.calls]]
function = "decrement"
expect.revert = "CounterAtZero"

[[tests.calls]]
function = "get"
expect.return_value = "0"
```

---

## 5. Run the tests

```bash
make test
```

```text
  Running 6 tests in ./tests/contract.test.toml
    ✓ get_returns_zero_initially (0.1 ms)
    ✓ increment_advances_by_one (0.03 ms)
    ✓ three_increments_yield_three (0.03 ms)
    ✓ decrement_at_zero_reverts (0.02 ms)
    ✓ decrement_to_zero (0.04 ms)
    ✓ revert_rolls_back_state (0.04 ms)

  test result: ok. 6 passed; 5 failed; 0 skipped (6 ran)
```

(If you get a different result, jump to [Debugging](./debugging.md) — the most common cause is forgetting `--release` in `cargo build`.)

---

## 6. Raise the verbosity

Foundry-style — four levels.

```bash
make test-v       # + gas per test
make test-vv      # + events emitted
make test-vvv    # + per-call trace
make test-vvvv   # + storage diffs
```

`make test-vvvv` on our updated contract:

```text
  Running 6 tests in ./tests/contract.test.toml
    ✓ get_returns_zero_initially (0.09 ms, 147 gas)
      Calls:
        [0] get() -> 0  [147 gas]
    ✓ increment_advances_by_one (0.04 ms, 439 gas)
      Calls:
        [0] increment() -> 1  [292 gas]
        [1] get() -> 1  [147 gas]
      Storage diff:
        0x385c70...: <unset> → 0x00...01
    ✓ three_increments_yield_three (0.04 ms, 876 gas)
      ...
    ✓ decrement_to_zero (0.05 ms, 1,168 gas)
      Calls:
        [0] increment() -> 1  [292 gas]
        [1] increment() -> 2  [292 gas]
        [2] decrement() -> 1  [292 gas]
        [3] decrement() -> 0  [292 gas]
      Storage diff:
        0x385c70...: <unset> → 0x00...00
    ✓ revert_rolls_back_state (0.04 ms, 876 gas)
      Calls:
        [0] increment() -> 1  [292 gas]
        [1] decrement() -> 0  [292 gas]
        [2] decrement() revert("CounterAtZero")  [292 gas]
        [3] get() -> 0  [147 gas]
      Storage diff:
        (none — the revert rolled back the increment-then-decrement
        ping-pong, and the standing balance is what get() reads.)
```

That last test is the rollback-on-revert proof. The third call (`decrement` again, from zero) reverts. Its state changes — and only its state changes — were discarded. The contract's view of the world is exactly what the second call left behind.

---

## 7. Lock in a gas budget

Once a test is green and the gas number looks reasonable, freeze it as a regression guard:

```toml
[[tests.calls]]
function = "increment"
expect.return_value = "1"
expect.gas_max      = "300"     # fail the test if increment grows past 300 gas
```

`expect.gas_max` is an upper-bound check — your contract can use any value ≤ the budget. Foundry's `--gas-report` equivalent. Prefer `gas_max` over `expect.gas` (exact match) — exact is brittle to opcode-level codegen changes.

---

## What just happened

You scaffolded a project, added a function, wrote tests for both the success and failure paths, and saw the contract execute end-to-end with full traces + storage diffs.

The next chapter — [Shipping](./shipping.md) — covers the build pipeline and the deploy flow. Then [Inspect & Verify](./inspecting.md) shows how to read state from a deployed contract.

For the deeper why (host fn ABI, slot derivation, WASM constraints), see [WASM Contract Author Guide](../companion/WASM_AUTHOR_GUIDE.md).
