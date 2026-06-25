# Your First Contract

End-to-end: scaffold → write → test. By the end you'll have a working contract that passes a behaviour suite, with execution traces visible on demand.

This chapter uses Rust. For TinyGo / AssemblyScript / C, the patterns are identical; the per-language `README.md` in each scaffolded project carries the syntactic equivalent. `otigen init --lang <go|as|c>` produces the other-language scaffolds.

---

## 1. Scaffold

```bash
otigen new my-counter --from counter
cd my-counter
```

```text
scaffolded "my-counter" from "counter" at my-counter
  files: 7
next: cd my-counter && cargo build --target wasm32-unknown-unknown --release && otigen test
```

What landed:

```text
my-counter/
├── Cargo.toml             # cdylib + release profile tuned for WASM size
├── Makefile               # build / test / deploy / inspect / verify shortcuts
├── README.md              # project-local Pyde cheatsheet
├── otigen.toml            # contract metadata + state schema + network
├── .gitignore
├── src/
│   └── lib.rs             # your contract (start here)
└── tests/
    └── contract.test.toml # behaviour tests
```

Seven files. The Rust scaffold pulls host fns + the entry macro from the `pyde-host` family of vendored crates referenced from `Cargo.toml` (no `src/host_fns.rs` in the project tree — the macro substrate is the canonical interface). You'll spend your time in:

- **`src/lib.rs`** — your contract code.
- **`otigen.toml`** — declares state fields + function signatures + network endpoints.
- **`tests/contract.test.toml`** — behaviour assertions.

---

## 2. The default contract

`otigen new --from counter` produces a minimal counter — one `uint64` storage slot, two entry points:

```rust
// src/lib.rs (excerpt — the file ships with header docs not reproduced here)

#![no_std]
extern crate alloc;

use core::panic::PanicInfo;
use pyde_host as pyde;

#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

// Reads `otigen.toml`'s `[state] schema` at compile time and emits
// one typed accessor per field. `storage::counter()` returns a
// `CounterField` with `.read() -> u64`, `.write(value: u64)`,
// `.delete()`. Misspelling a field name or supplying the wrong type
// is a compile error.
pyde::declare_storage!();

#[pyde::entry]
fn increment() -> u64 {
    let next = storage::counter().read().wrapping_add(1);
    storage::counter().write(next);
    next
}

#[pyde::entry]
fn get() -> u64 {
    storage::counter().read()
}
```

The `#[pyde::entry]` macro wraps each function in the spec-mandated `() -> ()` WASM shim ([`HOST_FN_ABI_SPEC §3.5.2`](../companion/HOST_FN_ABI_SPEC.md)) — it decodes calldata from `pyde::calldata_*`, calls the inner body, and surfaces the return value via `pyde::return`. You write idiomatic Rust; the macro handles the chain-side ABI.

The corresponding `otigen.toml`:

```toml
[state]
schema = [
    { name = "counter", type = "uint64" },
]

[functions.increment]
attributes = ["entry"]            # callable from outside the contract
inputs     = []
outputs    = ["uint64"]

[functions.get]
attributes = ["entry", "view"]    # callable + must not mutate (engine enforces)
inputs     = []
outputs    = ["uint64"]
```

For the meaning of `attributes` values (`entry`, `view`, `payable`, `constructor`, `fallback`, `receive`), see [`HOST_FN_ABI_SPEC §3.5`](../companion/HOST_FN_ABI_SPEC.md). Mapping fields use `type = "map"` with `keys = [...], value = "..."`, or the Solidity-style sugar `type = "mapping(K => V)"` (lowered to the canonical form at build time; up to 3 keys including nested `mapping(K => mapping(K2 => V))`).

---

## 3. Add a function

Let's add a `decrement` that reverts when the counter is at zero. This exercises three things:

1. Reading + writing storage in the same call.
2. Reverting from inside the contract.
3. Asserting the revert path in a test.

Append to `src/lib.rs`:

```rust
#[pyde::entry]
fn decrement() -> u64 {
    let current = storage::counter().read();
    if current == 0 {
        // pyde::revert never returns; the engine rolls back every
        // state change since this call started.
        pyde::revert("CounterAtZero");
    }
    let next = current - 1;
    storage::counter().write(next);
    next
}
```

Declare it in `otigen.toml`:

```toml
[functions.decrement]
attributes = ["entry"]
inputs     = []
outputs    = ["uint64"]
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
otigen test
```

```text
→ Compiling (rust) — cargo build --target wasm32-unknown-unknown --release
    Finished `release` profile [optimized] target(s) in 11.28s
✓ Compiled → ./target/wasm32-unknown-unknown/release/my_counter.wasm

  Running 6 tests in ./tests/contract.test.toml (via engine)
    ✓ get_returns_zero_initially (29.55 ms)
    ✓ increment_advances_by_one (7.72 ms)
    ✓ three_increments_yield_three (6.82 ms)
    ✓ decrement_at_zero_reverts (8.04 ms)
    ✓ decrement_to_zero (8.91 ms)
    ✓ revert_rolls_back_state (9.13 ms)

  test result: ok. 6 passed; 0 failed; 0 skipped (6 ran)
```

(If you get a different result, jump to [Debugging](./debugging.md) — the most common cause is forgetting `cargo build --release`, but `otigen test` invokes that for you by default.)

The runner executes against `pyde-engine-wasm-exec::WasmExecutor` — the same code path mainnet uses. That's "engine path" in the output line. The legacy in-process mock is still available via `--no-engine` for the handful of cases the engine can't yet host (today: parachains).

---

## 6. Raise the verbosity

`otigen test` accepts the standard clap `-v` flag, repeated for more detail:

```bash
otigen test           # default — per-test pass/fail + duration
otigen test -v        # + INFO logs from the runner
otigen test -vv       # + DEBUG logs (host-fn calls, slot derivations)
otigen test --json    # NDJSON event stream for CI / scripted consumers
```

For per-call trace + storage diff render, the `[tests.expect]` block in `contract.test.toml` already declares what the runner asserts — failures print the expected vs actual for each. To see successful calls' return values + gas, use `--dry-run`:

```bash
otigen test --dry-run
```

That parses + resolves every test without executing the WASM — useful for verifying that your `storage.<field>` assertions resolve to the same `Poseidon2`-derived slot the contract writes to.

---

## 7. Lock in a gas budget

Once a test is green and the gas number looks reasonable, freeze it as a regression guard:

```toml
[[tests.calls]]
function = "increment"
expect.return_value = "1"
expect.gas_max      = "300"     # fail the test if increment grows past 300 gas
```

`expect.gas_max` is an upper-bound check — your contract can use any value ≤ the budget. Prefer `gas_max` over `expect.gas` (exact match) — exact is brittle to opcode-level codegen changes.

---

## What just happened

You scaffolded a project, added a function, wrote tests for both the success and failure paths, and saw the contract execute end-to-end through the production WASM executor.

The next chapter — [Shipping](./shipping.md) — covers the build pipeline and the deploy flow. Then [Inspect & Verify](./inspecting.md) shows how to read state from a deployed contract.

For the deeper why (host fn ABI, slot derivation, WASM constraints), see [WASM Contract Author Guide](../companion/WASM_AUTHOR_GUIDE.md).
