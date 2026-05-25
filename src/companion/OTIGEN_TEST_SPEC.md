# `otigen test` — Contract Behaviour Test Spec

**Status:** v1 design — not yet implemented. The schema, semantics, and CLI surface defined here are the contract; implementation lands across three follow-up PRs (parser → runner → cheatcodes) per the `OTIGEN_TEST` track in [`roadmap.md`](../roadmap.md).

This spec describes how Pyde contract authors write **behaviour-level tests** — assertions about state changes, return values, emitted events, and reverts — declaratively in a TOML file. The `otigen test` command instantiates the contract's `.wasm` in a wasmtime sandbox, runs the declared scenarios with mock host functions, and reports pass / fail per case.

---

## 1. Why this exists

`otigen build` validates that a contract is *well-formed* — it parses, imports the right host functions, exports the declared entries, doesn't reach state-mutating host calls from `view` functions. That's a structural check.

What it does NOT check: does the contract *behave* correctly?

- Does `transfer(amount)` actually decrement the sender's balance?
- Does it emit a `Transfer` event with the right indexed fields?
- Does it revert with `InsufficientBalance` when the sender is overspending?
- Does `expired()` return true after a deadline has passed?

Authors today can write `cargo test` (or the equivalent in their language) for pure helpers, but those tests don't execute the contract through the chain's host-function surface. They can't simulate storage, can't observe events, can't catch reverts as the chain would catch them.

`otigen test` closes that gap. It's Pyde's equivalent of Foundry's `forge test`: a TOML-driven, language-agnostic test framework that runs WASM in wasmtime with mock implementations of every `pyde::*` host function declared in [`HOST_FN_ABI_SPEC.md`](./HOST_FN_ABI_SPEC.md).

---

## 2. When to use vs. when NOT to use

### Use `otigen test` for:

- **Behavioural assertions** — "after `transfer`, alice's balance is X and bob's is Y."
- **Event verification** — "this call emitted exactly these events with these fields."
- **Revert semantics** — "this input path traps with `InsufficientBalance`."
- **Multi-step scenarios** — "alice transfers to bob, then bob transfers to carol; final state is ..."
- **Cheatcode-driven tests** — "after the deadline passes, `claim()` reverts with `Expired`."
- **Cross-language regression** — the same `.test.toml` runs against the contract regardless of source language (Rust / AssemblyScript / Go / C), as long as the resulting WASM matches the same `otigen.toml` shape.

### Use your language's native test framework for:

- **Pure-function unit tests** — math helpers, parsing, formatting. Run them with `cargo test` / `npm test` / `go test` / your C test harness. Faster than spinning up wasmtime.
- **Property-based / fuzz testing** of pure helpers. Use `proptest` / `quickcheck` / language-native fuzzers. v1 `otigen test` is example-based; property testing lands in v2 (see §11).
- **Compiler integration** — the language's own test framework is what catches "this trait isn't implemented" / "this import path doesn't resolve."

### Use a full devnet for:

- **End-to-end chain integration** — actual consensus, actual mempool, actual cross-contract calls between independently-deployed contracts. The mock host functions in `otigen test` are deliberately simple; they don't simulate parallel execution, gas exhaustion under load, or wave finalisation.

---

## 3. Hello world

For a token contract project laid out per spec §3.1:

```
my-token/
├── Cargo.toml           (or package.json / go.mod / Makefile)
├── otigen.toml
├── src/
│   └── lib.rs
└── tests/
    └── contract.test.toml      ← THIS FILE
```

The minimum runnable test file:

```toml
# tests/contract.test.toml

[[tests]]
name = "ping_returns_42"
call = { function = "ping", args = [] }
expect.return_value = "42"
```

Run it:

```bash
otigen build --compile      # build the .wasm
otigen test                  # discovers tests/*.test.toml, runs everything
```

Output:

```
  Running 1 test in tests/contract.test.toml
    ✓ ping_returns_42       (1.2 ms)

  test result: ok. 1 passed; 0 failed; 0 skipped
```

Exit 0 on all-pass, exit 1 on any failure.

---

## 4. Complete schema reference

Every TOML key the test framework understands, in order they appear in a typical file.

### 4.1 `[accounts]` — named addresses

Maps a human-readable name to a deterministic 32-byte address. The address is `Blake3(name.as_bytes())` truncated / taken as-is to 32 bytes — same output every run.

```toml
[accounts]
alice = {}                       # address = Blake3("alice")
bob = {}
carol = { balance = "0x1000" }   # pre-fund the account with 4096 quanta
dao = { balance = "1000000" }    # decimal also OK; same effect
```

| Key | Type | Required | Description |
|---|---|---|---|
| `<name>.balance` | hex or decimal string | no | Initial native-PYDE balance. Surfaced to the contract via `pyde::balance_of(<addr>)`. Default `0`. |
| `<name>.pubkey` | `0x` hex (897 bytes) | no | Pre-set FALCON-512 pubkey for the account. Default: deterministic-from-name. **v1 ignored** — pubkey only matters for signature verification, which v1 contracts don't simulate. Documented for v2. |

Names are used throughout the file to refer to accounts: `from = "alice"`, `args = ["bob", "10"]`, `storage.balances.alice = "100"`.

**Reserved name:** `__contract__` resolves to the contract's own deployed address (`Blake3(contract.name)` — same as how the chain computes it at deploy time). Used for testing `pyde::self()` and self-references.

### 4.2 `[cheats]` — global cheatcodes

State the runner installs before EVERY test, overridable per-test in `[tests.cheats]`:

```toml
[cheats]
now       = 1700000000       # pyde::now() returns this (unix seconds)
wave_id   = 100              # pyde::current_wave() returns this
chain_id  = 31337            # pyde::chain_id() returns this
gas_limit = 10_000_000       # gas budget the runner advances per call
```

Cheatcode catalog (v1):

| Cheat | Type | Host fn affected | Notes |
|---|---|---|---|
| `now` | unix-seconds (u64) | `pyde::now()` | Default `0`. Tests that depend on time should set this explicitly. |
| `wave_id` | u64 | `pyde::current_wave()` | Default `1`. |
| `chain_id` | u64 | `pyde::chain_id()` | Default `31337` (devnet). |
| `gas_limit` | u64 | `pyde::gas_remaining()` | Default `10_000_000`. Decremented per host call by the same constants the chain uses (see [HOST_FN_ABI_SPEC §gas-table](./HOST_FN_ABI_SPEC.md)). Tests that exhaust gas will see the wasm trap. |

Cheats reserved for v2 (parsed but currently a no-op with a warning):

- `cheats.expect_emit` — pre-declare an expected event before a call sequence.
- `cheats.prank_origin` — separate `tx.origin` from `caller` (Pyde currently has no `origin`; reserved for forward-compatibility).
- `cheats.assume_balance` — assume an account has at least N quanta (fuzzing constraint).

### 4.3 `[[tests]]` — test case array

Each test case is a TOML table-array entry. Order in the file is the order they run; tests are independent (one's state doesn't leak into the next).

```toml
[[tests]]
name = "transfer_moves_balance"           # required, unique within the file

[tests.cheats]                            # optional; per-test override of global cheats
now = 1800000000

[tests.setup]                             # optional; pre-test state
storage.balances.alice = "100"
storage.total_supply   = "1000000"

[[tests.calls]]                           # one or more; order matters
function = "transfer"
from     = "alice"
args     = ["bob", "10"]
value    = "0"
expect.return_value = "1"
expect.events = [
  { name = "Transfer", from = "alice", to = "bob", amount = "10" },
]

[tests.expect]                            # optional; final-state assertions
storage.balances.alice = "90"
storage.balances.bob   = "10"
storage.total_supply   = "1000000"        # invariant: total unchanged
```

### 4.4 `[tests.setup]` — pre-test state

Installed into the mock environment before `[[tests.calls]]` runs.

| Field | Type | Description |
|---|---|---|
| `setup.storage.<field>.<key>` | hex / decimal string | Named storage slot (see §5 name resolution). |
| `setup.storage."<raw_hex>"` | hex string | Raw 32-byte slot hash → raw value bytes. Bypasses name resolution. Use when the contract's state isn't declared in `[state]`. |
| `setup.code.<account>` | path to `.wasm` | Pre-deploys another contract's WASM at `<account>`'s address. **v2** — multi-contract tests not yet implemented. |
| `setup.balances.<account>` | hex / decimal | Override `[accounts].<name>.balance`. Useful for testing balance changes under a specific starting condition. |

### 4.5 `[[tests.calls]]` — call sequence

Each call executes a contract function in order, with its own caller / value / expectations.

| Field | Type | Required | Description |
|---|---|---|---|
| `function` | string | yes | Exported function name. MUST match `[functions.<name>]` in the contract's `otigen.toml`. |
| `from` | account name or `0x`-hex | no | Caller address. Defaults to `__zero__` (all-zeros). |
| `args` | array of strings | no | Positional args. v1 supports `i32` / `i64` literals (decimal or `0x`-hex). Complex types deferred to v2. |
| `value` | hex / decimal | no | Quanta attached to the call (visible via `pyde::value()`). Default `"0"`. |
| `gas` | u64 | no | Per-call gas budget override. Default uses `[cheats].gas_limit`. |
| `expect.return_value` | hex / decimal | no | Asserted return value. Decimal and `0x`-hex compare numerically (so `"42"` and `"0x2a"` match the same return). |
| `expect.events` | array of event matchers | no | Each entry MUST appear in this call's emitted events. See §6 for matching rules. |
| `expect.revert` | string | no | If set, the call MUST trap with a reason that contains this substring. |
| `expect.no_revert` | bool | no | Inverse: assert the call does NOT trap. Useful when an earlier call set up state that might cause an unexpected revert. |
| `expect.gas` | u64 (dec or `0x`-hex) | no | Foundry-style **exact** gas assertion. Fails if observed gas (wasmtime fuel delta) does not equal this value. Brittle to opcode-level codegen changes — prefer `expect.gas_max` unless you specifically need a snapshot. |
| `expect.gas_max` | u64 (dec or `0x`-hex) | no | Foundry-style **upper bound** assertion. Fails if observed gas > this value. Use as a regression guard: pick a ceiling once, the test breaks the moment a future change pushes you over it. |

### 4.6 `[tests.expect]` — final-state assertions

After every call in `[[tests.calls]]` has run, the runner checks these once:

| Field | Type | Description |
|---|---|---|
| `expect.storage.<field>.<key>` | hex / decimal | Asserted final value at that named slot. |
| `expect.storage."<raw_hex>"` | hex | Asserted final value at a raw slot hash. |
| `expect.balances.<account>` | hex / decimal | Asserted final native-PYDE balance of the account. |
| `expect.no_other_storage_writes` | bool | If `true`, assert that NO slots outside the declared `expect.storage` were modified by the test. Default `false` (would be too brittle in most cases). |
| `expect.events_total` | u32 | If set, assert exactly N events were emitted across all calls. Helps catch accidental double-emits. |

---

## 5. Name resolution

The test framework lets authors write `storage.balances.alice` instead of `storage."0x9f3d…"`. The toolchain derives the hex behind the scenes.

### 5.1 Account name → 32-byte address

```
addr = Blake3(name.as_bytes())
```

`Blake3` truncated to 32 bytes (default output size). Deterministic — `alice` always resolves to the same address across runs. `__contract__` is special-cased to the contract's own deployed address.

This is **NOT** how the chain computes addresses in production — those come from `Poseidon2(falcon_public_key)`. The test framework uses Blake3-of-name for ergonomic determinism; tests verify *contract logic*, not address-derivation cryptography. If a contract has logic that depends on a specific address shape, the author can override per-account:

```toml
accounts.alice = { addr = "0xabcdef..." }
```

### 5.2 Storage field name → slot hash

The contract's `otigen.toml` declared `[state]`:

```toml
[state]
schema = [
  { name = "owner",         type = "address",                       disc = 0 },
  { name = "total_supply",  type = "uint128",                       disc = 1 },
  { name = "balances",      type = "mapping(address -> uint128)",   disc = 2 },
  { name = "allowances",    type = "mapping(address -> mapping(address -> uint128))", disc = 3 },
]
```

For a scalar field (`owner`, `total_supply`):

```
slot = Poseidon2(contract_addr ++ disc_byte ++ field_name_bytes)
```

For a single-level mapping (`balances`):

```
slot = Poseidon2(contract_addr ++ disc_byte ++ field_name_bytes ++ key_addr)
```

For a nested mapping (`allowances`):

```
slot = Poseidon2(contract_addr ++ disc_byte ++ field_name_bytes ++ outer_key ++ inner_key)
```

This is the **same** derivation the contract source uses when reading / writing slots via `pyde::poseidon2()`. The author and the test framework compute identical hashes.

### 5.3 Usage examples

```toml
# Scalar
setup.storage.total_supply = "1000000"
setup.storage.owner        = "alice"                    # address-typed; resolves via [accounts]

# Single mapping
setup.storage.balances.alice = "100"
setup.storage.balances.bob   = "0"

# Nested mapping
setup.storage.allowances.alice.bob = "50"

# Raw hex escape hatch (for state not declared in [state] schema)
setup.storage."0x9f3d12abcd..." = "0x42"
```

The toolchain reads `[state]` from `otigen.toml` and rejects any named field not in the schema with `UnknownStateField: "balances" not in [state]`.

### 5.4 Event name → topic hash

`[events.Transfer]` in `otigen.toml`:

```toml
[events.Transfer]
signature = "Transfer(address,address,uint128)"
fields = [
  { name = "from",   type = "address",  indexed = true },
  { name = "to",     type = "address",  indexed = true },
  { name = "amount", type = "uint128" },
]
```

In the test spec:

```toml
expect.events = [
  { name = "Transfer", from = "alice", to = "bob", amount = "10" },
]
```

The test framework computes the topic hash (`Blake3("Transfer(address,address,uint128)")`), looks up the field positions + indexed flags, and compares against the captured `emit_event` calls. Indexed field values are matched as topic-tail entries; non-indexed are decoded from the Borsh-encoded data payload.

Raw-hex escape hatch (for events not in the schema):

```toml
expect.events = [
  { topic = "0x<topic_hex>", data = "0x<data_hex>" },
]
```

---

## 6. Call execution model

### 6.1 Lifecycle

For each test case:

1. Create a fresh `TestEnv`:
   - `storage: HashMap<[u8;32], Vec<u8>>` — empty
   - `caller: [u8; 32]` — `__zero__` unless overridden
   - `value: u128` — `0`
   - `balances: HashMap<[u8;32], u128>` — populated from `[accounts]` + `setup.balances`
   - `events: Vec<EmittedEvent>` — empty (mutable across calls in the same test)
   - `gas: u64` — `[cheats.gas_limit]`
   - `now`, `wave_id`, `chain_id` — from `[cheats]` (with per-test override)
2. Apply `setup.storage` — populate the storage map.
3. For each entry in `[[tests.calls]]`:
   a. Reset per-call: `caller`, `value` per the entry; keep storage / events / balances accumulated.
   b. Look up the exported function in the WASM module.
   c. Parse `args` to wasmtime `Val`s using the function's signature.
   d. Invoke. Wasmtime traps surface as either expected (`expect.revert` matched) or test failure (unexpected trap).
   e. Check per-call expectations: return value, events emitted *in this call*, revert.
4. After all calls, check `[tests.expect]` (final-state assertions).
5. Report pass / fail.

### 6.2 Arg parsing

v1 supports scalar types: `i32`, `i64`, `f32`, `f64`. The runner uses the function's wasmtime signature to decide how to parse each `args[i]`:

- `i32` / `i64`: decimal (`"42"`) or `0x`-hex (`"0x2a"`).
- `f32` / `f64`: decimal (`"3.14"`).
- Account names resolved via `[accounts]`: `"alice"` → 32-byte address as a `*const u8` pointing into a runtime-allocated scratch region of WASM memory.

**Pointer args (complex types):** v2. Today the runner can pass primitive scalars. For `transfer(addr_ptr: u32, amount: u128)`, the author would set up the address bytes manually via storage / cheat code and pass the ptr as an i32; this is awkward but possible. v2 will accept `args = [{ type = "address", value = "alice" }, { type = "uint128", value = "10" }]` and write the address bytes into memory automatically.

### 6.3 Mock host functions

Every mocked host function uses the canonical `pyde::*` name from [`HOST_FN_ABI_SPEC §7`](./HOST_FN_ABI_SPEC.md) — contract code compiled against the chain runs unchanged under the test runner. v1 implements the read/write/event/balance/hash subset; v2 expands to the full surface.

| Host fn | v1 mock |
|---|---|
| `sload(slot_ptr, value_out_ptr)` | Reads `storage[slot]` if present; returns length or 0. |
| `sstore(slot_ptr, value_ptr)` | Writes 32 bytes to `storage[slot]`. |
| `sdelete(slot_ptr)` | Removes `storage[slot]`. |
| `caller(addr_out_ptr)` | Writes `env.caller` (32 bytes) into wasm memory. |
| `tx_value(value_out_ptr)` | Writes `env.value` as 16-byte little-endian u128. |
| `balance(addr_ptr, out_ptr)` | Reads `env.balances[addr]`; writes 16-byte LE u128. |
| `transfer(to_ptr, amount_lo, amount_hi)` | Decrements `env.balances[caller]`, increments `env.balances[to]`; reverts on underflow. (v1 takes amount as two i64 halves; v2 will take a single 16-byte LE u128 ptr to match HOST_FN_ABI_SPEC §7.2.) |
| `block_height()` | Returns `cheats.wave_id` as i64 (v1: `block_height == wave_id` per chain design). |
| `wave_id()` | Returns `cheats.wave_id` as i64. |
| `block_timestamp()` | Returns `cheats.now` as i64. |
| `chain_id()` | Returns `cheats.chain_id` as i64. |
| `emit_event(topics_ptr, n_topics, data_ptr, data_len)` | Appends to `env.events`. |
| `revert(msg_ptr, msg_len)` | Captures the reason + traps the wasm. |
| `hash_poseidon2(input_ptr, input_len, out_ptr)` | Real Poseidon2 via `pyde-crypto`. Authors using this for slot derivation in source code will produce the same slots the test framework expects. |
| `hash_blake3(input_ptr, input_len, out_ptr)` | Real Blake3 via `pyde-crypto`. Same parity rationale (event topic-0, address derivation). |
| Other host fns (`origin`, `self_address`, `tx_hash`, `tx_gas_remaining`, `calldata_*`, `hash_keccak256`, `falcon_verify`, `cross_call*`, `delegate_call`, `consume_gas`, `beacon_get`, DKG, parachain-only) | **Not mocked in v1.** Calls trap with `UnsupportedHostFn`. v2 expands. |

### 6.4 Revert semantics

A contract calls `pyde::revert(msg_ptr, msg_len)` to signal a revert. The mock:

1. Reads the message bytes from wasm memory.
2. Stores the reason in `env.revert_reason`.
3. Returns a wasmtime trap (host-side error).

The runner catches the trap, checks `env.revert_reason`, and matches against `expect.revert` via substring containment. Foundry-style:

```toml
expect.revert = "InsufficientBalance"

# Matches reverts where reason is exactly "InsufficientBalance", or
# "Error: InsufficientBalance(alice has 5, needs 10)", etc.
```

Wasmtime traps from causes OTHER than `revert` (out-of-bounds memory, integer overflow, unreachable opcode) surface as `expect.revert` matches if the contract explicitly mapped its `revert` reason; otherwise they're an unexpected-trap test failure.

### 6.5 Event matching

For each entry in `expect.events`:

1. Compute the expected topic-0 hash:
   - If `name` is given AND `[events.<name>]` is declared in the contract's `otigen.toml`, compute `Blake3(signature)`.
   - If `topic` is given, use the literal hex (raw-hex escape hatch).
   - If `name` is given BUT no `[events.<name>]` is declared, fall through to the shape-only check — match passes if any event was emitted. See "Shape-only fallback" below.
2. Compute expected indexed-field topics (for each `indexed = true` field):
   - If the value is an account name, resolve via `[accounts]`.
   - If decimal / hex, encode as 32-byte left-padded big-endian (matching how `Hash(value)` is computed for indexed fields per Ch 4).
3. Compute the expected data payload (for non-indexed fields):
   - Borsh-encode the listed values in field-declaration order. Width is type-determined: u8/i8/bool = 1, u16/i16 = 2, u32/i32 = 4, u64/i64 = 8, u128 = 16, address = 32. Authors who skip a non-indexed field in the matcher have that field's width skipped in the data cursor (wildcard match).
4. Scan `env.events` for at least one entry whose `(topic_0, topics_indexed, data)` exactly matches.

Ordering is NOT enforced — events may be emitted by helper functions in arbitrary order. The assertion is existence, not sequence. (If ordering matters, the test can assert per-call events under `expect.events` inside the specific `[[tests.calls]]` block.)

#### Supported field types (v1)

| Type | Topic encoding (indexed) | Data encoding (non-indexed) |
|---|---|---|
| `address` | 32 bytes (account name → Blake3, or raw hex) | 32 bytes (same) |
| `uint8` / `int8` / `bool` | 32-byte BE-padded | 1 byte LE |
| `uint16` / `int16` | 32-byte BE-padded | 2 bytes LE |
| `uint32` / `int32` | 32-byte BE-padded | 4 bytes LE |
| `uint64` / `int64` | 32-byte BE-padded | 8 bytes LE |
| `uint128` | 32-byte BE-padded | 16 bytes LE |

Other types (`bytes`, dynamic arrays, custom structs) fall through to shape-only matching in v1; full type-aware matching lands in v2 alongside the rest of the Borsh decoder.

#### Shape-only fallback

If a matcher uses `name = "X"` but the contract's `otigen.toml` doesn't declare `[events.X]`, the runner can't compute the expected topic-0 or know the field layout — so it falls back to **"any event was emitted"** as a conservative existence check. This is useful for contracts that emit events declared only in source (not surfaced in `otigen.toml`), but it's strictly weaker than the schema-driven match. Authors who want precise matching declare the event in `otigen.toml` or use the raw-hex form.

### 6.6 Gas tracking (Foundry-style)

The runner enables wasmtime's `consume_fuel(true)` and seeds every call with a fuel cap (from `cheats.gas_limit` if set; otherwise a runner-internal default of 1,000,000,000 fuel units). Per-call gas usage is computed as `fuel_cap - remaining_fuel` after the call returns.

What the runner records per test (the `TestReport` returned alongside `TestOutcome`):

| Field | Source | Used by |
|---|---|---|
| `gas_used` | Sum of per-call fuel deltas | `otigen test -v` (and above); NDJSON `test_pass`/`test_fail` events |
| `events` | `TestEnv.events` at test end | `otigen test -vv` |
| `call_traces` | One per `[[tests.calls]]` (function, args, return, revert, gas) | `otigen test -vvv` |
| `storage_diffs` | Slot-by-slot before/after | `otigen test -vvvv` |

The runner's fuel units correlate to but are not bit-identical with on-chain Pyde gas. Foundry has the same caveat — its gas reports are estimates, not chain billing. For ground-truth gas, deploy to a devnet and pull the receipt.

**Per-call gas assertions** (`expect.gas` / `expect.gas_max`, see §4.5) are checked after each call's per-call `expect.return_value` / `expect.events` block. A gas assertion failure produces a test fail with the reason `call[N]: expect.gas[_max] = X; observed Y`.

---

## 7. CLI surface

### 7.1 Discovery

`otigen test` looks for test files in this order:

1. `tests/*.test.toml` — the canonical location.
2. `tests/*.toml` — for projects with a single test file.
3. `./contract.test.toml` — single-file projects.

Each file's `[[tests]]` array contributes to the total test count.

### 7.2 Flags

```
otigen test [--filter <pattern>] [--bundle <path>] [--no-color] [--show-output]
```

| Flag | Default | Description |
|---|---|---|
| `--filter <pattern>` | none | Run only tests whose name contains the pattern (substring match). Multiple `--filter` flags are OR'd. |
| `--bundle <path>` | `./artifacts/<name>.bundle/` | Path to the deploy bundle whose `contract.wasm` should be executed. Defaults to what `otigen build` produces. |
| `--no-color` | off | Disable terminal colour escape sequences (for CI logs). |
| `--show-output` | off | Print captured stdout / stderr from each test (mainly useful for debugging mock host fns). |
| `--json` (global) | off | Emit NDJSON events per test, one per line. CI consumes. |

### 7.3 Output

**Human format (default):**

```
  Running 3 tests in tests/contract.test.toml
    ✓ ping_returns_42              (0.8 ms)
    ✓ transfer_moves_balance       (1.2 ms)
    ✗ transfer_reverts_on_overspend
        expected revert containing "InsufficientBalance"
        got: return value 0 (no trap)

  test result: FAILED. 2 passed; 1 failed; 0 skipped
```

**`--json` NDJSON format:**

```jsonl
{"event":"test_suite_start","file":"tests/contract.test.toml","total":3}
{"event":"test_start","name":"ping_returns_42"}
{"event":"test_pass","name":"ping_returns_42","duration_ms":0.8}
{"event":"test_start","name":"transfer_moves_balance"}
{"event":"test_pass","name":"transfer_moves_balance","duration_ms":1.2}
{"event":"test_start","name":"transfer_reverts_on_overspend"}
{"event":"test_fail","name":"transfer_reverts_on_overspend","reason":"expected revert containing \"InsufficientBalance\", got: return value 0 (no trap)"}
{"event":"test_suite_done","passed":2,"failed":1,"skipped":0}
```

### 7.4 Exit codes

| Code | Meaning |
|---|---|
| `0` | Every test passed. |
| `1` | At least one test failed. Per-test reasons on stderr / in NDJSON. |
| `2` | Resource failure (test file unreadable, `.wasm` not found at the declared `[contract.lang.output]`, wasmtime engine setup failed). |
| `4` | Schema error in the test spec itself (malformed TOML, references an undeclared `[state]` field, etc.). |

---

## 8. Worked example: ERC-20-style transfer

The full file an author would write for a token contract:

```toml
# tests/contract.test.toml

[accounts]
alice = { balance = "0x100" }
bob = {}
carol = {}

[cheats]
now      = 1700000000
chain_id = 31337

# ─── Test 1: happy path ───────────────────────────────────────
[[tests]]
name = "transfer_moves_balance_and_emits_event"

[tests.setup]
storage.balances.alice = "100"
storage.balances.bob   = "0"
storage.total_supply   = "1000000"

[[tests.calls]]
function = "transfer"
from     = "alice"
args     = ["bob", "10"]
expect.return_value = "1"
expect.events = [
  { name = "Transfer", from = "alice", to = "bob", amount = "10" },
]

[tests.expect]
storage.balances.alice = "90"
storage.balances.bob   = "10"
storage.total_supply   = "1000000"   # invariant: total unchanged

# ─── Test 2: revert on overspend ──────────────────────────────
[[tests]]
name = "transfer_reverts_on_overspend"

[tests.setup]
storage.balances.alice = "5"

[[tests.calls]]
function = "transfer"
from     = "alice"
args     = ["bob", "10"]
expect.revert = "InsufficientBalance"

# ─── Test 3: multi-call chain ─────────────────────────────────
[[tests]]
name = "alice_to_bob_to_carol_round_trip"

[tests.setup]
storage.balances.alice = "100"

[[tests.calls]]
function = "transfer"
from     = "alice"
args     = ["bob", "30"]

[[tests.calls]]
function = "transfer"
from     = "bob"
args     = ["carol", "10"]

[tests.expect]
storage.balances.alice = "70"
storage.balances.bob   = "20"
storage.balances.carol = "10"

# ─── Test 4: time-dependent revert ────────────────────────────
[[tests]]
name = "claim_reverts_after_deadline"

[tests.cheats]
now = 2000000000       # well past the contract's hard-coded deadline

[[tests.calls]]
function = "claim"
from     = "alice"
args     = []
expect.revert = "Expired"
```

Run:

```bash
$ otigen test
  Running 4 tests in tests/contract.test.toml
    ✓ transfer_moves_balance_and_emits_event   (1.2 ms)
    ✓ transfer_reverts_on_overspend            (0.9 ms)
    ✓ alice_to_bob_to_carol_round_trip         (2.1 ms)
    ✓ claim_reverts_after_deadline             (1.0 ms)

  test result: ok. 4 passed; 0 failed; 0 skipped
```

---

## 9. Limitations (explicit)

What `otigen test` v1 deliberately does NOT do:

| Limitation | Reason | Workaround / future |
|---|---|---|
| **No cross-contract calls.** Each test runs ONE contract. `pyde::call(other_addr, ...)` traps. | Multi-contract simulation needs a wasmtime instance per address + a calling-convention layer. | v2: `setup.code.<account> = "./other-bundle.wasm"` pre-deploys other contracts. |
| **No parallel-execution simulation.** Tests run sequentially. | The chain runs txs in parallel under access-list scheduling; the test framework doesn't. Tests are deterministic single-thread. | Real concurrency bugs caught at the chain integration layer (devnet). |
| **No fuzzing / property testing.** Tests are example-based only. | Adding fuzzing needs a shrinker + generator + `proptest`-style integration. | v2: `[[tests.property]]` with `forall.<arg> = { type = "uint128", in = "0..=1000" }`. |
| **No gas accounting.** Calls don't fail on out-of-gas in v1. | Wasmtime metering is configurable but not free; v1 skips. | v2: `gas` field on each call + traps on overflow. |
| **Pointer-arg encoding is awkward.** Complex types need manual setup. | v1 only handles wasmtime-native primitives. | v2: typed `args = [{type = "address", value = "alice"}]`. |
| **u128 narrowed to i64 in `pyde::value()`.** | Wasmtime can't directly return u128 in a single result slot. | v2: switches to `value_out_ptr: u32` writing the u128 LE into memory. |
| **No `tx.origin` distinction from `caller`.** | Pyde doesn't expose `origin` as a host fn. | Likely permanent — Pyde rejects the `tx.origin` footgun by design. |
| **No simulating chain-side validators.** `expect.revert` matches the contract's own revert; it doesn't simulate "this tx would be rejected at mempool". | Mempool validation runs on a real node; out of scope for behaviour tests. | Devnet integration tests. |
| **Test files can't share helpers.** Every `.test.toml` is standalone. | TOML is data, not code. | Authors who need shared setup can copy the `[accounts]` + `[cheats]` blocks between files. v2 may add `[include]`. |

What `otigen test` is NOT trying to be:

- An audit replacement. It catches what authors think to test for. It doesn't prove the absence of bugs.
- A devnet substitute. Final correctness signal is a real chain integration test.
- A proof system. No formal verification, no symbolic execution. Concrete example execution only.

---

## 10. Common patterns

### 10.1 Sentinel addresses

When a test needs an address that's neither the contract nor a named account:

```toml
[accounts]
attacker = {}                                    # Blake3("attacker")
random = { addr = "0xdeadbeef..." }              # explicit override
```

Both work in `args` / `from` / etc.

### 10.2 Initial-state seeding from a fixture

For contracts with complex initial state (a populated airdrop merkle tree, a long allowlist, etc.):

```toml
[tests.setup]
storage."0x<root_slot>"     = "0x<merkle_root>"
storage."0x<allowlist_slot_alice>" = "0x01"
storage."0x<allowlist_slot_bob>"   = "0x01"
# … 200 entries — typically generated by a helper script the author commits alongside the .test.toml
```

The author writes a small generator (Python / Bash / their language of choice) that emits the storage block. v2 may ship `otigen test --seed <generator.json>` but the explicit form keeps v1 self-contained.

### 10.3 Asserting an invariant across many tests

If `total_supply` should NEVER change after deploy, every test asserts it:

```toml
[[tests]]
# ... call code that should NOT change total_supply ...
[tests.expect]
storage.total_supply = "1000000"   # invariant
```

v2 may add `[invariants]` declared once at the file level, auto-asserted after every test.

---

## 11. Implementation phases

This spec lands incrementally. Phases 1–3 ship the core surface; Phase 4 adds typed-arg marshalling; later phases add cross-contract, fuzzing, invariants, gas metering.

### Phase 1: parser + name resolution + spec validation ✅ shipped (PR [otigen#30](https://github.com/pyde-net/otigen/pull/30))

- `crates/otigen-test` crate with the TOML schema types
- `[accounts]` + `[cheats]` + `[[tests]]` parsing
- Name resolution (account → addr, state field → slot)
- `otigen test --dry-run` lists tests + their resolved addresses / slots without executing
- E2E tests against a hand-written `.test.toml` fixture

### Phase 2: wasmtime runner + read/write/event/revert mocks ✅ shipped (PR [otigen#31](https://github.com/pyde-net/otigen/pull/31))

- `pyde::sload` / `sstore` / `sdelete` / `caller` / `tx_value` / `emit_event` / `revert` / `block_timestamp` / `wave_id` / `chain_id`
- Single-call execution + per-call `expect`
- Return-value + storage-after + events + revert assertions
- `examples/hello-rust` ships a sample `tests/contract.test.toml`
- E2E tests asserting pass / fail outcomes

### Phase 3: full Foundry surface ✅ shipped (PR [otigen#32](https://github.com/pyde-net/otigen/pull/32))

- Multi-call sequences (`[[tests.calls]]` chains) with per-call state rollback on trap
- Native-balance mocks (`balance`, `transfer`)
- Final-state assertions (`[tests.expect]`)
- Per-test cheat overrides
- Named event matching against `[events.*]` declarations + shape-only fallback
- `--filter` flag + per-test timing
- `--json` NDJSON test events (`test_suite_start` / `test_start` / `test_pass` / `test_fail` / `test_suite_done`)
- `--bundle` override (test against an arbitrary `<bundle>/contract.wasm`)
- `hash_poseidon2` / `hash_blake3` host fn mocks (added during PR [otigen#43](https://github.com/pyde-net/otigen/pull/43) when the `counter-token` example exercised contract-side slot derivation)

The `examples/counter-token` realistic-contract reference (PR [otigen#43](https://github.com/pyde-net/otigen/pull/43)) exercises every Phase 3 feature end-to-end: multi-call sequences, named events, expect.revert with rollback, per-test cheats, final-state storage assertions.

### Phase 4: typed-arg marshalling (planned)

- Runner-side encoding of declared `inputs` (e.g. `["address", "uint128"]`) so authors can pass `args = ["alice", "100"]` against contract signatures that take pointer-args without writing two-i64-half boilerplate.
- For `address`: resolve account name, allocate 32 bytes at a safe linear-memory offset, write the bytes, pass the offset as i32. Requires parsing the contract's WASM data segments to find the data-end watermark and use a higher offset.
- For `uint128`: allocate 16 bytes, write LE bytes, pass the offset.

Until Phase 4 ships, contracts that take pointer-args must use `caller()` to sidestep the staging gap (e.g. `counter-token`'s `mint() / balance_of_caller()` pattern), or accept the two-i64-halves convention for u128 values.

### Beyond Phase 4

Later releases add `cross_call*` mocks (and a sibling-contract registry so cross-contract tests resolve to other `.bundle/` artifacts), gas metering, fuzz / invariant test modes, and the full parachain host-fn surface (`parachain_storage_*`, `send_xparachain_message`, `threshold_*`).

---

## 12. Cross-references

- [`OTIGEN_BINARY_SPEC.md`](./OTIGEN_BINARY_SPEC.md) — canonical CLI spec; `otigen test` lands as §3.10.
- [`HOST_FN_ABI_SPEC.md`](./HOST_FN_ABI_SPEC.md) — every host fn the mocks must match.
- [Chapter 4: State Model](../chapters/04-state-model.md) — PIP-2 slot derivation that name resolution mirrors.
- [Chapter 5: Otigen Toolchain](../chapters/05-otigen-toolchain.md) — narrative overview; `otigen test` section lands at §5.13.
- [Chapter 17 §17.6](../chapters/17-developer-tools.md) — developer tools roundup; references back here.
- [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) — Stream α tracking, `OTIGEN_TEST` track.

---

If the implementation and this spec disagree, the spec is right and the code is a bug.
