# `otigen test`: Contract Behaviour Test Spec

**Status:** v1 — shipped. The framework runs through `pyde-engine-wasm-exec::WasmExecutor` by default (same code path mainnet uses); the legacy in-process mock surface remains behind `--no-engine` for parachain contracts (parachain runtime ships in engine v2) and runner-side bisection.

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

- **Behavioural assertions**: "after `transfer`, alice's balance is X and bob's is Y."
- **Event verification**: "this call emitted exactly these events with these fields."
- **Revert semantics**: "this input path traps with `InsufficientBalance`."
- **Multi-step scenarios**: "alice transfers to bob, then bob transfers to carol; final state is ..."
- **Cheatcode-driven tests**: "after the deadline passes, `claim()` reverts with `Expired`."
- **Cross-language regression**: the same `.test.toml` runs against the contract regardless of source language (Rust / AssemblyScript / Go / C), as long as the resulting WASM matches the same `otigen.toml` shape.

### Use your language's native test framework for:

- **Pure-function unit tests**: math helpers, parsing, formatting. Run them with `cargo test` / `npm test` / `go test` / your C test harness. Faster than spinning up wasmtime.
- **Property-based / fuzz testing** of pure helpers. Use `proptest` / `quickcheck` / language-native fuzzers. v1 `otigen test` is example-based; property testing lands in v2 (see §11).
- **Compiler integration**: the language's own test framework is what catches "this trait isn't implemented" / "this import path doesn't resolve."

### Use a full devnet for:

- **End-to-end chain integration**: actual consensus, actual mempool, actual cross-contract calls between independently-deployed contracts. The mock host functions in `otigen test` are deliberately simple; they don't simulate parallel execution, gas exhaustion under load, or wave finalisation.

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

### 4.1 `[accounts]`: named addresses

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
| `<name>.pubkey` | `0x` hex (897 bytes) | no | Pre-set FALCON-512 pubkey for the account. Default: deterministic-from-name. **v1 ignored** — pubkey-pinning matters for engine-level signature verification, which v1 contracts don't simulate at the auth-keys layer. Documented for v2. |
| `<name>.keypair` | string | no | When set to `"falcon512"`, the planner generates a fresh FALCON-512 keypair for this account at plan time and caches it for the test run. Required for any test that exercises `pyde::falcon_verify`. Tests reference the pubkey or produce signatures via the `@pubkey:NAME` / `@pubkey_hash:NAME` / `@sig:NAME:args.IDX` DSL prefixes (§5.5 below). |

```toml
[accounts]
alice = { keypair = "falcon512" }      # generates a FALCON-512 keypair at plan time
bob   = { keypair = "falcon512" }
```

Names are used throughout the file to refer to accounts: `from = "alice"`, `args = ["bob", "10"]`, `storage.balances.alice = "100"`.

**Reserved name:** `__contract__` resolves to the contract's own deployed address (`Blake3(contract.name)` — same as how the chain computes it at deploy time). Used for testing `pyde::self()` and self-references.

### 4.2 `[cheats]`: global cheatcodes

State the runner installs before EVERY test, overridable per-test in `[tests.cheats]`:

```toml
[cheats]
now       = 1700000000       # pyde::wave_timestamp() returns this (unix seconds)
wave_id   = 100              # pyde::wave_id() returns this
chain_id  = 31337            # pyde::chain_id() returns this
gas_limit = 10_000_000       # gas budget the runner advances per call
```

Cheatcode catalog (v1):

| Cheat | Type | Host fn affected | Notes |
|---|---|---|---|
| `now` | unix-seconds (u64) | `pyde::wave_timestamp()` | Default `0`. Tests that depend on time should set this explicitly. |
| `wave_id` | u64 | `pyde::wave_id()` | Default `1`. |
| `chain_id` | u64 | `pyde::chain_id()` | Default `31337` (devnet sentinel). |
| `gas_limit` | u64 | Runner-side fuel budget | Default `10_000_000`. Translated to wasmtime fuel 1:1 (runner default `1_000_000_000`). Decremented per host call by the same gas constants the engine charges (see [`HOST_FN_ABI_SPEC §10`](./HOST_FN_ABI_SPEC.md)). Tests that exhaust gas trap with `out of fuel`. |

Cheats reserved for later releases (parsed but currently a no-op):

- `cheats.expect_emit` — pre-declare an expected event before a call sequence. Today the same effect is achieved via `expect.events` on individual `[[tests.calls]]` entries (see §4.5 + §6.5).
- `cheats.assume_balance` — assume an account has at least N quanta. Reserved for the future fuzz / invariant testing mode; parsed-but-noop today.

**Per-call overrides.** `now`, `wave_id`, `chain_id`, `gas` can also be set on individual `[[tests.calls]]` entries — see §4.5. The per-call values use **sticky semantics**: once a call sets `now = X`, X persists into subsequent calls in the same test until another override fires. This models a real chain's monotonically-advancing clock and avoids the per-call-restore footgun.

```toml
[cheats]
now = 1000      # test baseline

[[tests.calls]]
function = "propose"           # wave_timestamp() returns 1000

[[tests.calls]]
function = "vote"
now      = 1500                # advance clock — wave_timestamp() returns 1500

[[tests.calls]]
function = "check_state"       # wave_timestamp() still 1500 (sticky)

[[tests.calls]]
function = "execute"
now      = 2500                # advance again
```

### Foundry → otigen translation

Coming from Solidity / Foundry? `vm.xxx()` imperative cheats map to declarative TOML in otigen. Same coverage, no scope footguns, contract code stays identical between test and prod.

| Foundry imperative | otigen declarative |
|---|---|
| `vm.prank(addr)` | `from = "alice"` on the call |
| `vm.startPrank / stopPrank(addr)` | every call has its own `from` (no scope to forget) |
| `vm.deal(addr, n)` | `[tests.setup].balances.alice = "100"` |
| `vm.warp(t)` | `[cheats] now = t` (or `now =` per call) |
| `vm.roll(blockNum)` | `[cheats] wave_id = N` (Pyde uses waves, not blocks) |
| `vm.chainId(id)` | `[cheats] chain_id = id` (or per-call) |
| `vm.expectRevert("msg")` | `expect.revert = "msg"` |
| `vm.expectEmit(...)` | `expect.events = [{ name = "Foo", ... }]` |
| `vm.signMessage(key, msg)` | `@sig:NAME:args.IDX` DSL (sigs are FALCON-512, generated at plan time) |
| `vm.mockCall(target, calldata, ret)` | `[[contracts]]` secondary contracts (§4.7) |
| `vm.label(addr, "name")` | `[accounts].alice = {}` — names are always used in traces |
| `vm.snapshot / vm.revertTo` | not needed — each test starts from fresh state |
| `vm.recordLogs` | not needed — events are always recorded for matching |
| `console.log(...)` | `pyde::debug_log(label_ptr, label_len, data_ptr, data_len)` — test-only host fn captured by the runner. Surfaced at `-vv` verbosity; `otigen build` rejects it by default (strict-by-default) and `otigen deploy` always rejects it. Use `otigen build --no-strict` for local inspection only. |

### 4.3 `[[tests]]`: test case array

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

### 4.4 `[tests.setup]`: pre-test state

Installed into the mock environment before `[[tests.calls]]` runs.

| Field | Type | Description |
|---|---|---|
| `setup.storage.<field>.<key>` | hex / decimal string | Named storage slot (see §5 name resolution). |
| `setup.storage."<raw_hex>"` | hex string | Raw 32-byte slot hash → raw value bytes. Bypasses name resolution. Use when the contract's state isn't declared in `[state]`. |
| `setup.code.<account>` | path to `.wasm` | Pre-deploys another contract's WASM at `<account>`'s address. **v2** — multi-contract tests not yet implemented. |
| `setup.balances.<account>` | hex / decimal | Override `[accounts].<name>.balance`. Useful for testing balance changes under a specific starting condition. |

### 4.5 `[[tests.calls]]`: call sequence

Each call executes a contract function in order, with its own caller / value / expectations.

| Field | Type | Required | Description |
|---|---|---|---|
| `function` | string | yes | Exported function name. MUST match `[functions.<name>]` in the contract's `otigen.toml`. |
| `from` | account name or `0x`-hex | no | Caller address. Defaults to `__zero__` (all-zeros). |
| `args` | array of strings | no | Positional args. Decimal / `0x`-hex literals for `i32` / `i64`; named-account / hex / `@pubkey:NAME` / `@pubkey_hash:NAME` / `@sig:NAME:args.IDX` for typed args (`address`, `uint128`, `bytes32`, `bytes`, `pubkey`, `sig`) declared in `[functions.<name>].inputs`. See §5.5 for the DSL catalog. |
| `value` | hex / decimal | no | Quanta attached to the call (visible via `pyde::value()`). Default `"0"`. |
| `gas` | u64 | no | Per-call gas budget override. Default uses `[cheats].gas_limit`. |
| `now` | u64 (unix seconds) | no | Per-call `wave_timestamp()` override. **Sticky:** the new value persists into subsequent calls in the same test until another override fires. Models a real chain's monotonically-advancing clock. |
| `wave_id` | u64 | no | Per-call `pyde::wave_id()` override. Sticky, same semantics as `now`. |
| `chain_id` | u64 | no | Per-call `chain_id()` override. Sticky. Rare in practice (chain_id doesn't change across a chain's lifetime) — exists for symmetry + future cross-chain replay-protection testing. |
| `expect.return_value` | hex / decimal / negative decimal | no | Asserted return value. Unsigned decimal and `0x`-hex compare numerically (so `"42"` and `"0x2a"` match the same return). **Negative decimal literals** (e.g. `"-10"`) parse as i64 and compare against the wasm result's sign-extended i64 view — useful for asserting error codes returned by host fns like `pyde::cross_call` (which surfaces `ERR_CROSS_CALL_FAILED = -10` when its sub-call traps). |
| `expect.events` | array of event matchers | no | Each entry MUST appear in this call's emitted events. See §6 for matching rules. |
| `expect.revert` | string | no | If set, the call MUST trap with a reason that contains this substring. |
| `expect.no_revert` | bool | no | Inverse: assert the call does NOT trap. Useful when an earlier call set up state that might cause an unexpected revert. |
| `expect.gas` | u64 (dec or `0x`-hex) | no | Foundry-style **exact** gas assertion. Fails if observed gas (wasmtime fuel delta) does not equal this value. Brittle to opcode-level codegen changes — prefer `expect.gas_max` unless you specifically need a snapshot. |
| `expect.gas_max` | u64 (dec or `0x`-hex) | no | Foundry-style **upper bound** assertion. Fails if observed gas > this value. Use as a regression guard: pick a ceiling once, the test breaks the moment a future change pushes you over it. |

### 4.6 `[tests.expect]`: final-state assertions

After every call in `[[tests.calls]]` has run, the runner checks these once:

| Field | Type | Description |
|---|---|---|
| `expect.storage.<field>.<key>` | hex / decimal | Asserted final value at that named slot. |
| `expect.storage."<raw_hex>"` | hex | Asserted final value at a raw slot hash. |
| `expect.balances.<account>` | hex / decimal | Asserted final native-PYDE balance of the account. |
| `expect.no_other_storage_writes` | bool | If `true`, assert that NO slots outside the declared `expect.storage` were modified by the test. Default `false` (would be too brittle in most cases). |
| `expect.events_total` | u32 | If set, assert exactly N events were emitted across all calls. Helps catch accidental double-emits. |

### 4.7 `[[contracts]]`: secondary contracts for cross-contract tests

Cross-contract tests (`pyde::cross_call` / `pyde::delegate_call` targeting an external contract) require multiple contracts deployed at distinct addresses in the same test run. The `[[contracts]]` block declares secondaries; the primary contract is the one whose `otigen.toml` lives in cwd.

```toml
[[contracts]]
name   = "counter-pair-b"
bundle = "../counter-pair-b/artifacts/counter-pair-b.bundle"
```

| Key | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Contract name. Used for the canonical address derivation (`Poseidon2("pyde-contract:" ‖ name)`) — must match the secondary's own `[contract].name`. Address surfaces under the same name in accounts / args / `balances.<name>` paths. |
| `bundle` | path (string) | yes | Path to the secondary's `.bundle/` directory, relative to the test file's location. The CLI reads `<bundle>/contract.wasm`. |

The planner adds each secondary's name to the resolvable-account set, so tests can write `args = ["counter-pair-b", "100"]`, `from = "counter-pair-b"`, or `balances."counter-pair-b" = "100"` without re-declaring under `[accounts]`. Names colliding with the primary or with each other are rejected at plan time.

Empty (the default) means single-contract mode — backwards-compatible with every existing test suite.

See [`otigen/examples/counter-pair-a/tests/contract.test.toml`](https://github.com/pyde-net/otigen/tree/main/examples/counter-pair-a/tests) for the canonical multi-contract test pattern.

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
slot = Poseidon2(self_address ‖ field_name_bytes)
```

For a single-level mapping (`balances`):

```
slot = Poseidon2(self_address ‖ field_name_bytes ‖ key_addr)
```

For a nested mapping (`allowances`):

```
slot = Poseidon2(self_address ‖ field_name_bytes ‖ outer_key ‖ inner_key)
```

This is the **same** derivation the chain's typed-storage host fns (`sstore_scalar` / `sstore_map<N>`) use — the macro substrate emits the same slot from `pyde::declare_storage!()` field access. Author and test framework compute identical hashes.

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

### 5.5 Typed-arg DSL: `@pubkey:NAME`, `@sig:NAME:args.IDX`, `@pubkey_hash:NAME`

Typed-arg marshalling covers the value-typed primitives plus three variable / hash-derived shapes that the runner resolves at plan time:

| Form | Used for type | Resolves to |
|---|---|---|
| `"@pubkey:NAME"` | `bytes` | The 897-byte FALCON-512 public key of an account declared with `keypair = "falcon512"`. |
| `"@sig:NAME:args.IDX"` | `bytes` | A fresh FALCON-512 signature produced by `NAME`'s secret key over the bytes of arg at position `IDX` in the same call. `IDX` must reference an earlier arg in the same `args = [...]` list. The target arg's value must be `0x`-decodable bytes (a hex literal, a `bytes32`, or another `bytes`). |
| `"@pubkey_hash:NAME"` | `bytes32` | `Poseidon2(falcon_pubkey)` — the canonical on-chain "signer ID" for FALCON multisig contracts. |

Plain hex literals (`"0x..."`) are accepted everywhere the typed-arg expects bytes — for `bytes` an even-length hex body of any length, for `bytes32` exactly 64 hex chars.

```toml
[accounts]
alice = { keypair = "falcon512" }
bob   = { keypair = "falcon512" }

# In a contract whose `execute` function has signature
# (address, uint128, bytes32, bytes, bytes, bytes, bytes, bytes, bytes):
[[tests.calls]]
function = "execute"
args = [
  "recipient",                                                     # 0: address
  "500",                                                           # 1: uint128
  "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",  # 2: bytes32 — action hash
  "@pubkey:alice", "@sig:alice:args.2",                            # 3, 4: alice's pubkey + sig over arg 2
  "@pubkey:bob",   "@sig:bob:args.2",                              # 5, 6: bob's pubkey + sig
  "0x", "0x",                                                      # 7, 8: empty bytes (unused signer slot)
]
```

Each `bytes` declared input expands to **two** wasm i32 params (`ptr` + `len`); a length-zero `bytes` arg passes `(0, 0)` to mean "this slot is unused". `address` and `uint128` continue to take a single i32 pointer.

The signatures generated by `@sig:NAME:...` are produced with `pyde_crypto::falcon::falcon_sign`, which uses the canonical domain-separation context `"pyde-falcon-v1"`. Sigs that pass `otigen test` round-trip to a chain-side `falcon_verify` without re-signing.

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

The runner reads each declared input from `[functions.<name>].inputs` and marshals `args[i]` accordingly:

- Primitive ints (`uint8` / `int8` / … / `uint64` / `int64`): decimal (`"42"`) or `0x`-hex (`"0x2a"`).
- `uint128` / `int128`: same numeric forms, written as 16-byte LE into a runtime-allocated scratch region; the entry receives a pointer.
- `address`: named-account reference (`"alice"`) or `0x`-hex address — 32 bytes written into scratch, entry receives a pointer.
- `bytes32`: 64 hex chars (`"0x..."`) — 32 bytes written into scratch, entry receives a pointer.
- `bytes`: arbitrary even-length hex literal or one of the DSL forms (`@pubkey:NAME` / `@sig:NAME:args.IDX`) — written into scratch and the entry receives `(ptr, len)`.

For spec-compliant void-void entries (`HOST_FN_ABI §3.5.2`), the runner writes a single borsh-encoded calldata blob of `[functions.<name>].inputs` values into scratch and exposes it via `pyde::calldata_size` + `pyde::calldata_copy` — the `#[pyde::entry]` macro decodes it into typed Rust arguments. For legacy `extern "C"` entries the runner falls back to direct wasm function parameters (ptr/len pairs for variable bytes, scalars for ints).

### 6.3 Host functions

**Runtime selection.** `otigen test` runs every contract through the engine's real `WasmExecutor` by default (since otigen#107) — the same code path mainnet executes. Per the project principle "same crypto / same VM everywhere across mainnet / testnet / devnet" the engine path is the source of truth and authors get the full `pyde::*` ABI at chain fidelity. The `--no-engine` flag opts back into the legacy in-process mock surface for parachain contracts (whose chain runtime ships in engine v2) and for runner-side bisection / debugging. See [`OTIGEN_BINARY_SPEC §3.10`](./OTIGEN_BINARY_SPEC.md#310-otigen-test) for the runtime-selection table.

**Engine-path host-fn surface.** Every host fn declared in [`HOST_FN_ABI_SPEC §7`](./HOST_FN_ABI_SPEC.md) is implemented at chain fidelity — `tx_hash`, `calldata_size`, `calldata_copy`, `consume_gas`, `cross_call_static`, `return`, `origin`, `tx_gas_remaining`, `hash_keccak256`, `beacon_get`, and the rest of the ABI all behave as they would on-chain. The runner stubs nothing beyond the test-only `debug_log` (printf-style; not registered chain-side, see §7).

**Legacy mock surface (`--no-engine` only).** The legacy path runs each contract in an in-process wasmtime instance wired to test-runner mocks. The runner implements the read/write/event/balance/hash subset that the v1 substrate covers; the rest trap with `UnsupportedHostFn`. Useful when a contract genuinely needs the legacy path (parachain) — for everything else, the engine path is strictly more accurate.

| Host fn | Legacy-path (`--no-engine`) mock |
|---|---|
| `sload(slot_ptr, out_ptr, out_max_len)` | Reads `storage[slot]` if present; writes up to `out_max_len` bytes and returns the actual length, or `-1` (`SLOAD_MISSING`) on miss. |
| `sstore(slot_ptr, val_ptr, val_len)` | Writes `val_len` bytes (≤ 16 KB) to `storage[slot]`. |
| `sdelete(slot_ptr)` | Removes `storage[slot]`. Subsequent `sload` returns `-1`. |
| `caller(addr_out_ptr)` | Writes `env.caller` (32 bytes) into wasm memory. |
| `self_address(addr_out_ptr)` | Writes `env.contract_address` (32 bytes) into wasm memory. |
| `tx_value(value_out_ptr)` | Writes `env.value` as 16-byte little-endian u128. |
| `balance(addr_ptr, out_ptr)` | Reads `env.balances[addr]`; writes 16-byte LE u128. |
| `transfer(to_ptr, amount_ptr)` | Decrements `env.balances[caller]`, increments `env.balances[to]`; reverts on underflow. `amount_ptr` references a 16-byte LE u128 per `HOST_FN_ABI_SPEC §7.2`. |
| `wave_id()` | Returns `cheats.wave_id` as i64. |
| `wave_timestamp()` | Returns `cheats.now` as i64. |
| `chain_id()` | Returns `cheats.chain_id` as i64. |
| `emit_event(topics_ptr, n_topics, data_ptr, data_len)` | Appends to `env.events`. |
| `revert(msg_ptr, msg_len)` | Captures the reason + traps the wasm. |
| `hash_poseidon2(input_ptr, input_len, out_ptr)` | Real Poseidon2 via `pyde-crypto`. Authors using this for slot derivation in source code will produce the same slots the test framework expects. |
| `hash_blake3(input_ptr, input_len, out_ptr)` | Real Blake3 via `pyde-crypto`. Same parity rationale (event topic-0, address derivation). |
| `falcon_verify(pk_ptr, msg_ptr, msg_len, sig_ptr, sig_len)` | Real FALCON-512 verification via `pyde_crypto::falcon::falcon_verify` — same primitive the engine uses, so a sig that passes `otigen test` will pass on-chain. Returns `0` on valid, `ERR_SIGNATURE_INVALID = -17` on invalid (malformed pubkey/signature bytes are also rejected as "invalid" rather than trap). |
| `delegate_call(target_ptr, fn_name_ptr, fn_name_len, calldata_ptr, calldata_len, gas_limit, return_data_out_ptr, return_data_out_len_ptr)` | Re-enters the same wasm `Instance` at a named export, preserving the caller's storage context per `HOST_FN_ABI_SPEC §7.8`. **v1 limitation: target must equal `self_address`** — the proxy + impl must live in the same wasm. Multi-contract delegate (target = a different contract's code) requires multi-module runner support and is planned. The target export must take the canonical `(calldata_ptr: i32, calldata_len: i32) -> i32` shape; the runner passes the contract's original `calldata_ptr` / `calldata_len` through unchanged (same linear memory, no copy). Return-data plumbing through `return_data_out_*` is zero-len in v1 — the inner can still surface state changes via the shared storage. |
| `cross_call(target_ptr, fn_name_ptr, fn_name_len, calldata_ptr, calldata_len, value_ptr, gas_limit, return_data_out_ptr, return_data_out_len_ptr)` | Synchronous call into another contract (§7.8). Multi-contract tests declare secondaries via `[[contracts]]` (§4.7); each gets its own Instance + storage namespace (slots are field-keyed by self_address, so isolation is implicit). The mock: looks up target Instance, snapshots storage / balances / events, transfers `value` from caller to target (parent frame), switches active context (caller, contract_address, instance, scratch_base, tx_value), copies calldata from caller's memory into the callee's separate linear memory at the callee's scratch_base, invokes the named export with the canonical `(calldata_ptr, calldata_len) -> i32` shape, then restores context. Sub-call trap → snapshot restore + return `ERR_CROSS_CALL_FAILED = -10` (parent doesn't trap; gets the rc back and decides). Author-config errors (unknown target / missing export / wrong signature) DO trap loudly. Inside the callee, `caller()` returns the immediate caller-contract's address (= active address at call time, not the tx originator); `tx_value()` returns the cross_call's `value` parameter. |
| `parachain_storage_read(key_ptr, key_len, value_out_ptr, value_out_len_ptr)` | Variable-length kv read namespaced by active parachain address per §8.1. Caller pre-writes `*value_out_len_ptr` with the max bytes the buffer can accept (u32 LE). Mock copies up to that limit, writes the actual length back so callers detect truncation. Returns `0` on success (including "key never written" — len 0) or `ERR_OUTPUT_BUFFER_TOO_SMALL = -7` if the value exists but the buffer was too small. |
| `parachain_storage_write(key_ptr, key_len, value_ptr, value_len)` | Variable-length kv write at `(active_address, key)`. Overwrites any existing value. Returns `0`. |
| `parachain_storage_delete(key_ptr, key_len)` | Remove `(active_address, key)`. No-op if absent. Returns `0` in both cases. |
| `parachain_id(out_ptr)` | Writes the active parachain's 32-byte ID. In the v1 runner this equals `caller.data().contract_address` (same as `self_address()`); the spec §8.2 derivation uses the `"pyde-parachain:"` prefix when real chain code computes it — contract code is byte-identical between prefixes since it just calls the host fn. |
| `parachain_version()` | Returns `TestEnv.parachain_version` as i32 (defaults to 1; future cheat enables upgrade-flow demos). |
| `parachain_emit_event(topics_ptr, topics_count, data_ptr, data_len)` | Delegates to the core `emit_event` mock. The §8.3 difference — event record carries the parachain ID as `contract_addr` — is implicit because the active address IS the parachain's at call time. |
| Other host fns (`origin`, `tx_hash`, `tx_gas_remaining`, `calldata_*`, `hash_keccak256`, `cross_call_static`, `consume_gas`, `beacon_get`, `send_xparachain_message`, and the reserved v2 `threshold_encrypt` / `threshold_decrypt`) | **Not mocked on the legacy path.** Calls trap with `UnsupportedHostFn`. Use the default engine path (drop `--no-engine`) — it implements the v1 surface at chain fidelity; the reserved threshold host fns stay unavailable until the v2+ ciphertext lane (Chapter 20). |

**Slot-derivation invariant.** Both the legacy raw `sload` / `sstore` host fns and the typed-storage family (`sstore_scalar` / `sload_scalar` / `sstore_map1`…`map3`) derive slots via `Poseidon2(self_address ‖ field_name ‖ keys...)`. The macro substrate (`pyde::declare_storage!()` field access) emits the same hash. The engine path exercises the typed family end-to-end; the legacy mock above stubs it for `--no-engine` runs.

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
| `call_traces` | One per `[[tests.calls]]` (function, args, return, revert, gas) | Reserved — surfaced only on NDJSON today |
| `storage_diffs` | Slot-by-slot before/after | Reserved — surfaced only on NDJSON today |

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
otigen test [-v|-vv] [--filter <pattern>] [--bundle <path>] [--dry-run] [--watch] [--no-engine] [--no-compile]
```

| Flag | Default | Description |
|---|---|---|
| `--filter <pattern>` | none | Run only tests whose name contains the pattern (substring match). Multiple `--filter` flags are OR'd. |
| `--bundle <path>` | `./artifacts/<name>.bundle/` | Path to the deploy bundle whose `contract.wasm` should be executed. Defaults to what `otigen build` produces. |
| `--dry-run` | off | Parse + plan the test scenarios; print the plan without invoking wasmtime. Useful for catching schema errors fast. |
| `--watch` | off | Re-run the suite on source / TOML change. Foundry-parity. |
| `--no-engine` | off | Run through the legacy in-process mock surface instead of the chain's `WasmExecutor`. Reserved for parachain contracts (engine v2) and runner-side bisection. |
| `--no-compile` | off | Skip the per-language compile step; reuse the existing `.wasm` on disk. |
| `--json` (global) | off | Emit NDJSON events per test, one per line. CI consumes. |
| `-v` / `-vv` | off | Standard clap verbosity counting. `-v` enables gas-per-test on the human formatter; `-vv` adds events + captured `pyde::debug_log` entries. Per-call trace + storage-diff verbosity tiers are reserved (parsed but no-op today). |

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

What `otigen test` deliberately does NOT do today:

| Limitation | Reason | Workaround |
|---|---|---|
| **No parallel-execution simulation.** Tests run sequentially. | The chain runs txs in parallel under access-list scheduling; the test framework doesn't. Tests are deterministic single-thread. | Real concurrency bugs caught at the chain integration layer (`otigen devnet`). |
| **No fuzzing / property testing.** Tests are example-based only. | Adding fuzzing needs a shrinker + generator + `proptest`-style integration. | Reserved syntax (`[[tests.property]]` with `forall.<arg>` constraints) parsed-but-noop; the real fuzz infrastructure lands as a future polish item. |
| **No multi-tx context.** Each test starts from fresh state; no "deploy contract in tx1, then call from a different sender in tx2" within a single test. | Tx-level isolation keeps the in-process model simple. | Explicit tx boundaries (`[[tests.tx]]` blocks) are a planned future expansion. For today's needs, drive multi-tx flows through `otigen devnet` + `otigen call` / `otigen console` against a real node. |
| **No simulating chain-side validators.** `expect.revert` matches the contract's own revert; it doesn't simulate "this tx would be rejected at mempool / by the access-list check / by the nonce window". | Mempool + admit-tx validation runs on a real node; out of scope for behaviour tests. | Devnet integration tests via `otigen devnet [--fork <FILE_OR_URL>]` for real-chain-state context. |
| **Test files can't share helpers.** Every `.test.toml` is standalone. | TOML is data, not code. | Authors who need shared setup copy the `[accounts]` + `[cheats]` blocks between files. A future `[include]` is reserved. |
| **No mock for the reserved threshold-crypto host fns on the legacy path.** | They depend on a committee threshold-decryption ceremony the legacy runner has no committee for. | Use the default engine path — but note `threshold_encrypt` / `threshold_decrypt` are reserved for the v2+ ciphertext lane (Chapter 20) and are not live in v1; the keyless commit-reveal private mempool is exercised via ordinary Commit/Reveal transactions. |

What `otigen test` is NOT trying to be:

- An audit replacement. It catches what authors think to test for. It doesn't prove the absence of bugs.
- A devnet substitute. Final correctness signal is a real chain integration test. Pair with `otigen devnet` + `otigen deploy --network devnet` for end-to-end verification.
- A proof system. No formal verification, no symbolic execution. Concrete example execution only.

**Shipped surface today** (no longer limitations): cross-contract calls (`cross_call` + `delegate_call` + `[[contracts]]`), in-contract FALCON verification, gas accounting + `expect.gas` / `expect.gas_max`, typed-arg marshalling (`address` / `uint128` / `int128` / `bytes32` / `bytes`), the FALCON DSL (`@pubkey:` / `@pubkey_hash:` / `@sig:`), schema-aware encoding, per-call cheats with sticky semantics, `pyde::debug_log`, four-level verbosity ladder, parachain §8 host fn surface on the `--no-engine` path, the engine path as default (running the real `pyde-engine-wasm-exec::WasmExecutor` — same code path mainnet uses), `--watch` mode for Foundry parity, `struct(<Name>)` typed storage values via `pyde::declare_storage!()`.

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

## 11. What ships today

`otigen test` is the production behaviour-test framework. The surface covered by the spec above is implemented end-to-end against the real engine path by default:

- TOML schema (`[accounts]`, `[cheats]`, `[[tests]]`, `[tests.setup]`, `[[tests.calls]]`, `[tests.expect]`, `[[contracts]]`).
- Name resolution (account → 32-byte Blake3 address, state field → slot hash, event name → topic-0 hash).
- Engine-path execution through `pyde-engine-wasm-exec::WasmExecutor` — same code path mainnet uses; every `pyde::*` host fn implemented at chain fidelity. Legacy in-process mock surface still available behind `--no-engine` for parachain contracts and runner-side bisection / debugging.
- Multi-call sequences with per-call overlay (revert discards; success commits — matches mainnet semantics).
- Final-state assertions across storage slots + balances + event totals.
- Typed-arg marshalling for `address` / `uint128` / `int128` / `bytes32` / `bytes` / primitive ints, with named-account resolution.
- Named-event matchers walking `[events.*]` schemas (indexed-topic / non-indexed-data field encoding).
- FALCON DSL — `@pubkey:NAME` / `@pubkey_hash:NAME` / `@sig:NAME:args.IDX` with real FALCON-512 keypair generation at plan time.
- Schema-aware storage encoding via the `[state]` schema vocabulary (including `struct(<Name>)` via `pyde::declare_storage!()`).
- Per-call cheats with sticky semantics — `now`, `wave_id`, `chain_id`, `gas` on `[[tests.calls]]` entries.
- `pyde::debug_log` test-only host fn captured into the test report; chain-side hard-rejected at `otigen build` + `otigen deploy`.
- Foundry-style verbosity ladder (`-v` / `-vv` / `-vvv` / `-vvvv`).
- `--filter` substring filter; `--bundle` override; `--json` NDJSON event stream; `--watch` continuous re-run; `--no-engine` legacy-mock opt-out.

Reserved for future expansion (parsed-but-noop or noted in §9): fuzz / invariant modes (`[[tests.property]]`), explicit multi-tx context (`[[tests.tx]]`), shared-helper includes, the reserved v2+ threshold-crypto host-fn surface (Chapter 20).

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
