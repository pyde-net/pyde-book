# Chapter 5: Otigen Toolchain

`otigen` is Pyde's developer toolchain — a single binary that **scaffolds** projects (from a language template or canonical example), **validates** the author's WASM build, **runs behaviour tests** against the compiled `.wasm`, **generates** the ABI from `otigen.toml`, **packages** the deploy bundle, **manages FALCON-512 keystores**, and handles **on-chain lifecycle commands** (deploy, upgrade, pause, kill, inspect, verify, console).

What `otigen` deliberately does NOT do: it does not compile WASM, it does not generate code, it does not interface with any language's build pipeline. Authors run their own `cargo build` / `asc` / `tinygo build` / `clang --target=wasm32` and `otigen` checks the result. This keeps the toolchain minimal and language-agnostic, and lets authors keep their full native toolchain experience.

The name carries forward from an earlier design phase, when Otigen was Pyde's domain-specific smart-contract language. The language is retired; the name now describes the role it occupies best — the lightweight verifier and packager that makes WebAssembly deployment on Pyde coherent without forcing authors out of their language ecosystems. See [The Pivot](../preface/pivot.md) for the full story.

This chapter covers the toolchain's design, the subcommand surface, the `otigen.toml` schema, the per-language workflow, build verification, attributes, deploy/upgrade, wallet, behaviour tests, and the console.

For the underlying execution layer that contracts run on, read [Chapter 3: Execution Layer](./03-virtual-machine.md). For the host functions contracts call, read the Host Function ABI spec.

---

## 5.1 Design Principles

The toolchain is built around four principles, each chosen deliberately.

### Author owns the build; otigen verifies

By default `otigen` does not compile WASM. The author runs their language's native build command (`cargo build --target wasm32-unknown-unknown --release`, `npm run build`, `tinygo build -target=wasi -o build/contract.wasm .`, `make`) themselves. They get the full diagnostics, the full IDE integration, the full test workflow their language ecosystem provides.

`otigen build` then **verifies** the result: confirms the `.wasm` file exists at the path declared in `otigen.toml`, validates the WASM module structure, cross-checks that the module imports only allowed host functions and exports every function declared in `[functions]`, and generates the deploy bundle. If anything is missing or wrong, `otigen` says so; if everything checks out, it prints "ready to deploy."

This keeps the toolchain minimal (no per-language compiler invocation logic to maintain) and respects the author's native toolchain.

For the common iterate-on-a-contract case there is also `otigen build --compile`: an opt-in flag that runs the per-language default build command first (the same invocation the templates document + `init`'s "next:" hint prints), then proceeds with the same verify + package pipeline. Both paths produce byte-identical bundles when the inputs are equivalent — `--compile` is a UX convenience, not a different build. Authors with custom build flags continue to compile manually and call `otigen build` (no flag) afterwards; that verify-only path stays supported forever.

### Zero extra code in the author's project

A contract project contains only the author's contract logic and an `otigen.toml`. No bundler files, no glue code, no manifest-handling boilerplate. The author writes what their language requires (a `Cargo.toml` for Rust, `package.json` for AssemblyScript, `go.mod` for Go, `Makefile` for C/C++) and the contract source itself.

State access and host-function calls go through whatever helper pattern the author or community provides for their language. `otigen` doesn't ship those helpers, doesn't generate them, doesn't depend on them. It only requires that the resulting `.wasm` imports the Host Function ABI correctly.

### Two test layers, one toolchain

Pyde splits contract testing by layer. **Language-native test frameworks** (`cargo test`, `npm test`, `go test`, the author's C test harness) cover pure helpers — math, parsing, formatting — at the function-internals layer. The toolchain doesn't wrap them; authors keep their language's standard test workflow.

**`otigen test`** covers the layer above: contract *behaviour* — does `transfer` decrement the right balance, emit the right event, revert on the right input. It runs the compiled `.wasm` inside a wasmtime sandbox with mock implementations of every `pyde::*` host function declared in the [Host Function ABI](../companion/HOST_FN_ABI_SPEC.md), driven by a TOML test spec (named accounts, named storage slots, time / wave / chain cheats, multi-call sequences, named event matching, named-or-substring revert assertions). The TOML format is language-agnostic — the same `.test.toml` runs against the contract regardless of source language. Full schema and semantics: [OTIGEN_TEST_SPEC](../companion/OTIGEN_TEST_SPEC.md).

The split mirrors Foundry's `forge test` (behaviour) vs Rust's `cargo test` (unit) — neither subsumes the other, both shipping in one toolchain doesn't compromise the language-agnostic posture.

### Attributes and ABI declared in otigen.toml, enforced at runtime

Function attributes (`view`, `payable`, `reentrant`, `sponsored`, `constructor`, `fallback`, `receive`, `entry`) and state schema are declared in `otigen.toml`. `otigen build` reads them, builds a `ContractAbi` struct, Borsh-encodes it, and **injects it as a WASM custom section named `pyde.abi`** directly into the .wasm artifact the language compiler produced. There is no separate `abi.json` file at deploy time — the ABI travels with the code as one binary. At runtime, the WASM execution layer extracts the `pyde.abi` section once, caches the parsed ABI alongside the compiled Module, and applies attribute-driven guards before every call (reentrancy block, view-mode state-write rejection, payable-mode value check, sponsored gas-tank debit, etc.). The WASM module itself does not carry attribute markers — the engine enforces them at the call boundary based on the parsed ABI. Full mechanics: [Host Function ABI Spec §3.5–§3.7](../companion/HOST_FN_ABI_SPEC.md).

---

## 5.2 Subcommand Surface

| Command | Purpose | v1 status |
|---------|---------|-----------|
| `otigen init <name> --lang <rust\|as\|go\|c>` | Scaffold a new project directory from the language template. Writes `otigen.toml` + a hello-world contract + language-specific build config (Cargo.toml / package.json + asconfig.json / go.mod / Makefile). | ✅ |
| `otigen new <name> --from <template>` | Scaffold by cloning a canonical example bundle (counter, erc20-token, erc721-token, simple-multisig, upgradeable-proxy, merkle-claim-airdrop, vesting, dao-governance). Produces a fully-working contract + passing test suite — the fastest path from zero to a green `otigen test`. `--list` shows the catalog. | ✅ |
| `otigen build` | **Verify + package.** Reads `otigen.toml`, locates the `.wasm` at the declared path, validates the WASM module (well-formed, imports allowed only, no `wasi:*` / `env`), cross-checks declared `[functions]` exist as WASM exports, builds the `ContractAbi`, Borsh-encodes it, injects as the `pyde.abi` custom section, writes `<contract>.bundle/`. By default the author runs their own language build; `--compile` opts in to running it automatically (`cargo` / `npm run build` / `tinygo` / `make`). `--strict` rejects test-only host fns (production gate). | ✅ |
| `otigen check` | Same validation pipeline as `otigen build` (spec §3.2 steps 1–7), minus the bundle write. Fast pre-commit / IDE / TDD gate. Per-violation diagnostics on stderr; exit 1 on any failure. | ✅ |
| `otigen deploy` | Sign and submit a deploy transaction. Loads the bundle, re-validates, fetches nonce, builds the canonical `Tx`, FALCON-signs the Poseidon2 hash, submits via `pyde_sendRawTransaction`, polls the receipt. `--dry-run` to inspect without submitting; `--no-wait` to skip the receipt poll. | ✅ |
| `otigen upgrade <target>` | Submit an upgrade transaction. Same pipeline as deploy but `TxType::Standard` with `LifecyclePayload::Upgrade { new_wasm }`. | ✅ contract owner-signed upgrade; ⏳ parachain governance flow (`--parachain` / `--finalize <proposal-id>`) deferred to the parachain rollout post-mainnet. |
| `otigen pause` / `unpause` / `kill` | Operational lifecycle. Owner-signed `LifecyclePayload::{Pause, Unpause, Kill}`. `kill --yes` skips the retype-the-target confirmation. | ✅ |
| `otigen inspect <target>` | Read deployed contract state via the rpc client. Surfaces address, account type, balance, nonce, code hash, code size, state root, and (when the wasm carries a `pyde.abi` custom section) the full ABI summary: version, function count, constructor / fallback / receive bindings, state schema hash, per-function selector + attribute labels. `--field <name>` queries `Poseidon2(name)`-derived storage slots; `--at-wave <id>` is forwarded for archive nodes. | ✅ account + state + ABI fields; ⏳ owner / version history land when the RPC catalog grows the corresponding endpoints. |
| `otigen verify <target>` | Reproducibility check: compares the local bundle's `contract.wasm` against the chain-stored bytes from `pyde_getContractCode`. Exit 0 on match, 1 on mismatch with blake3 hashes + size delta + first-diff offset. | ✅ |
| `otigen wallet` | FALCON-512 keystore management. Subcommands: `new <name>`, `list`, `show <name>`, `import <name> [--from-file <path>]`, `delete <name> [--yes]`, `password <name>`, `export <name> [--out <path>]`, `sign <name> <hex>`. | ✅ eight subcommands; ⏳ only the chain-side `rotate` (`KeyRotationTx`) is deferred — it needs the chain to accept that tx variant, so it lands after Stream β's executor. |
| `otigen test` | Run contract behaviour tests declared in `tests/*.test.toml`. Spins up a wasmtime sandbox per test, mocks every `pyde::*` host function, applies a named-account + named-slot + cheatcode model, supports multi-call sequences with per-call and final-state assertions. Foundry-style verbosity ladder (`-v` through `-vvvv`). Phase 4 typed-arg marshalling, FALCON DSL, `pyde::debug_log` test-only host fn, schema-aware encoding. See [OTIGEN_TEST_SPEC](../companion/OTIGEN_TEST_SPEC.md). | ✅ |
| `otigen console` | Interactive REPL against a Pyde node. | ⏳ post-devnet — pairs with the engine's local devnet binary, also in flight. Every read / write surface is already scriptable via the other subcommands + `otigen-rpc::Client` until then. |

There is no `otigen compile`. Authors use their language's native compiler (`cargo build --target wasm32-unknown-unknown --release`, `asc`, `tinygo build -target=wasi`, `clang --target=wasm32`). The `--compile` flag on `otigen build` is an opt-in convenience that invokes the language's default command — not a separate `compile` subcommand.

---

## 5.3 The otigen.toml Schema

A single TOML file declares everything `otigen` needs to know about the project. The full schema with field-by-field validation rules is documented in [`OTIGEN_BINARY_SPEC.md` §4](../companion/OTIGEN_BINARY_SPEC.md); the shape below is the canonical reference.

```toml
[contract]
name        = "my-token"          # required; lowercase + hyphens (ENS-style)
version     = "1.0.0"             # required; semver
description = "Example token"     # optional
type        = "contract"          # "contract" (default) or "parachain"

[contract.lang]
language = "rust"                 # required; rust | as | go | c
output   = "target/wasm32-unknown-unknown/release/my_token.wasm"
                                  # required; path the author's compiler emits

[contract.lang.toolchain]
rust_channel   = "stable"         # rust only — informational, surfaced in manifest.json
# asc_version, tinygo_version, clang_version for the other languages

[deploy]
gas_limit     = 10_000_000        # default per-deploy gas budget
gas_price     = "auto"            # "auto" = use current base_fee; or fixed quanta
owner_deposit = 1000              # PYDE locked at deploy time (parachain only)

[wallet]
default_keystore = "~/.pyde/keystore.json"   # optional; --keystore overrides
default_account  = "deployer"                # optional; --from overrides

[network.default]
name = "testnet"                  # selects one of the named [network.X] entries

[network.mainnet]
rpc_url      = "https://rpc.pyde.network"
chain_id     = 1
explorer_url = "https://explorer.pyde.network"

[network.testnet]
rpc_url      = "https://rpc-testnet.pyde.network"
chain_id     = 2

[network.devnet]
rpc_url      = "http://localhost:9933"
chain_id     = 31337

[state]
# State schema; each entry declares a top-level field name + type.
# Used for ABI emission (state_schema_hash) + explorer decoding.
# Authors still write their own slot derivation in contract code —
# otigen does not generate accessor bindings.
schema = [
    { name = "owner",         type = "address" },
    { name = "total_supply",  type = "uint128" },
    { name = "balances",      type = "mapping(address -> uint128)" },
]

[functions.transfer]
attributes  = ["entry", "payable"]
inputs      = ["address", "uint128"]
outputs     = ["bool"]
access_list = [                  # optional; unlocks parallel scheduling
    "balances[caller()]",
    "balances[args.0]",
]

[functions.balance_of]
attributes = ["entry", "view"]
inputs     = ["address"]
outputs    = ["uint128"]

[functions.init]
attributes = ["constructor"]      # callable only at deploy time
inputs     = ["uint128"]

[events.Transfer]
signature = "Transfer(address,address,uint128)"
fields = [
    { name = "from",   type = "address",  indexed = true },
    { name = "to",     type = "address",  indexed = true },
    { name = "amount", type = "uint128" },
]
```

### Schema notes

**`[contract]`** — identity + version + type (contract or parachain). `name` is the ENS-style on-chain name (globally unique; see [Ch 11 §11.2](./11-account-model.md)). The address is derived from the FALCON pubkey at deploy time, not from `name`; the registry binds `name → address`.

**`[contract.lang]`** — declares which language the author compiled with and where their compiler emits the `.wasm`. `language` ∈ {`rust`, `as`, `go`, `c`}. `output` is the path `otigen build` reads. Optional `[contract.lang.toolchain]` pins specific toolchain versions (surfaced in `manifest.json` for reproducible-build verification).

**`[deploy]`** — defaults for `otigen deploy`. `gas_limit` caps the deploy tx's gas. `gas_price = "auto"` uses the current chain base fee; a fixed integer overrides. `owner_deposit` is only meaningful for parachain deploys.

**`[wallet]`** — points at the default keystore + the default account. Both fields are optional; the global `--keystore <path>` and per-command `--from <name>` flags override.

**`[network.*]`** — `[network.default.name]` selects which other `[network.<name>]` table the toolchain talks to. Each named entry carries `rpc_url`, `chain_id`, and an optional `explorer_url`. The global `--network <name>` flag overrides at the command line.

**`[state]`** — the schema of the contract's storage. Used by `otigen build` to compute `state_schema_hash` (which the chain compares against on every state read for type-safety enforcement) and emitted in `abi.json` for explorers. The author's contract code still derives the storage slots itself — Pyde does not ship per-language storage bindings.

**`[functions.<name>]`** — every callable function the runtime should dispatch to. `attributes` is the safety + dispatch attribute set documented in §5.6. `otigen build` cross-checks every `[functions.X]` has a matching WASM export named `X` and rejects exports that aren't declared. Optional `access_list` declares the storage slots the function touches; declaring them unlocks the parallel scheduler.

**`[events.<name>]`** — emitted-event declarations. `signature` is the canonical string the chain hashes (Blake3) to derive the topic-0 value. Indexed fields are searchable via `pyde_getLogs`; non-indexed fields are Borsh-encoded into `data`.

**`[parachain]`** *(parachain only)* — consensus preset, validator constraints, slashing preset. Detailed in [Chapter 13](./13-cross-chain.md).

---

## 5.4 Per-Language Workflow

Each language has its own template (scaffolded by `otigen init`) and its own native build command. The author runs the build; then `otigen build` verifies + packages.

### Rust

```bash
otigen init my-contract --lang rust
cd my-contract
# Edit src/lib.rs with contract logic; declare entries + state in otigen.toml.

# Author runs their own build:
cargo build --release --target wasm32-unknown-unknown

# otigen verifies and packages:
otigen build
otigen deploy --network testnet
```

Scaffolded project tree:
```
my-contract/
├── otigen.toml      # contract identity, network, [functions.*]
├── Cargo.toml       # cdylib + release profile tuned for WASM size
├── src/
│   └── lib.rs       # #![no_std] template: panic handler + one ping export +
│                    # commented-out example host-fn import (link wasm_import_module = "pyde")
└── .gitignore
```

`otigen build` does:
- Read `otigen.toml`; validate schema (§5.3) + attribute combinations.
- Locate the `.wasm` at `[contract.lang.output]` (`target/wasm32-unknown-unknown/release/<crate>.wasm`).
- Validate the WASM module (parses cleanly via `wasmparser`, every import declares module `pyde`, every imported function is on the [HOST_FN_ABI_SPEC](../companion/HOST_FN_ABI_SPEC.md) allowlist, every `[functions.X]` has a matching export, only deterministic WASM features used).
- Run the static call-graph view check: any `view`-attributed function whose transitive call graph reaches a state-mutating host function is rejected.
- Build the `ContractAbi` from `otigen.toml`, Borsh-encode it, inject as the `pyde.abi` custom section via `wasm-encoder`.
- Write `<out>/<contract_name>.bundle/` containing `contract.wasm` (with `pyde.abi` embedded), `otigen.toml` (verbatim), `abi.json` (human-readable mirror), `manifest.json` (hashes, build timestamp, otigen version, target chain_id).

### AssemblyScript

```bash
otigen init my-contract --lang as
cd my-contract
# Edit assembly/index.ts; declare entries + state in otigen.toml.

npm install && npm run build        # delegates to: asc assembly/index.ts --config asconfig.json --target release

otigen build                         # verify + package
otigen deploy --network testnet
```

The scaffold pins `runtime: "minimal"` in `asconfig.json` so the resulting WASM imports nothing outside `pyde` — anything else would fail the chain's import allowlist.

### Go (TinyGo)

```bash
otigen init my-contract --lang go
cd my-contract
# Edit main.go; declare entries + state in otigen.toml.

tinygo build -target=wasi -o build/contract.wasm .

otigen build                         # verify + package
otigen deploy --network testnet
```

The scaffold uses `//go:wasmexport ping` to mark the entry point and documents the `//go:wasmimport pyde caller` pattern (commented out) for host-fn imports. TinyGo requires a `main()`; the chain dispatcher never calls it.

### C / C++

```bash
otigen init my-contract --lang c
cd my-contract
# Edit contract.c; declare entries + state in otigen.toml.

make                                 # delegates to: clang --target=wasm32 -nostdlib -Wl,--no-entry ...

otigen build                         # verify + package
otigen deploy --network testnet
```

The scaffold's `Makefile` pins `-nostdlib` so libc never leaks into the resulting WASM (which would fail the allowlist). Host-fn imports go through `__attribute__((import_module("pyde"), import_name(<fn>)))`; the scaffold ships one commented-out example. Exports use `__attribute__((export_name(<fn>)))`.

### Why this split

Authors keep their full language toolchain (build errors, IDE integration, dependency management, test runners, fuzzers, profilers — everything). The chain-specific concerns (ABI generation, deploy packaging, on-chain lifecycle) are owned by `otigen`. The interface between them is the `.wasm` file + the `otigen.toml` schema; both are inspectable, neither is generated by the other.

---

## 5.5 Build Verification + Packaging

`otigen build` is purely a validator + packager. It runs in this order:

```
1. Load otigen.toml; validate schema (§5.3) + attribute combinations per
   HOST_FN_ABI_SPEC §3.5.1.
2. Locate the .wasm at the path declared in [contract.lang.output];
   reject (exit 2) if the file doesn't exist.
3. Parse the .wasm via wasmparser; reject if the binary is malformed.
4. Walk the WASM import table; reject any import whose module is not
   "pyde" or whose function name is not on the HOST_FN_ABI_SPEC
   allowlist (and, for non-parachain contract types, reject any
   parachain-only host functions).
5. Walk the WASM export table; cross-check every [functions.X] has a
   matching export named X, and reject any export that isn't declared.
6. Validate the WASM feature set is in the deterministic subset
   (no threads, no SIMD, no reference types, etc.).
7. Run the static call-graph view check: for each `view`-attributed
   function, walk its transitive call graph. Reject if any reachable
   function imports a state-mutating host call (sstore, sdelete,
   transfer, emit_event, parachain_storage_write, etc.).
8. Build the ContractAbi from [functions.*] + [events.*] + [state]
   (computing 4-byte selectors as blake3(fn_name)[..4], topic
   signature hashes, state schema hash).
9. Borsh-encode the ContractAbi.
10. Inject the encoded ABI into the .wasm as a custom section named
    `pyde.abi`, using the `wasm-encoder` crate. The code section is
    untouched; reproducible builds still verify byte-identical.
11. Write the bundle to <out>/<contract_name>.bundle/:
      - contract.wasm        (.wasm with pyde.abi custom section)
      - otigen.toml          (verbatim copy of the source config)
      - abi.json             (human-readable ABI mirror)
      - manifest.json        (blake3 hashes, build timestamp, otigen
                              version, language toolchain pins,
                              target chain_id)
12. Print "✓ built <name> → <bundle_path>" with the wasm + abi sizes
    and blake3 prefixes (16 hex chars) per artifact.
```

Exit codes: `0` on success, `1` on validation failure (with a structured error listing every violation), `2` if the `.wasm` was not found at the expected path. No partial bundles are ever written — the bundle dir is created last, after every validation has passed.

### How authors do state access (without otigen-generated code)

Because `otigen` doesn't generate bindings, the author writes their state access using whatever pattern their language community supplies (or just uses raw extern declarations + a small helper module they write themselves). Pyde does not ship per-language SDKs (see [no-SDK approach](../preface/pivot.md)) — the canonical example projects in `pyde-net/otigen` show one workable pattern per language.

A typical Rust pattern looks like this (the author writes the entire file; `otigen` never touches it):

```rust
// src/main.rs (author writes all of this)

// Host function imports (declared once, used everywhere):
extern "C" {
    fn pyde_storage_read(slot_hash_ptr: *const u8, slot_hash_len: usize) -> i64;
    fn pyde_storage_write(slot_hash_ptr: *const u8, slot_hash_len: usize, value_ptr: *const u8, value_len: usize);
    fn pyde_caller(out_ptr: *mut u8);
    fn pyde_emit_event(topic_ptr: *const u8, topic_len: usize, data_ptr: *const u8, data_len: usize);
    fn pyde_poseidon2(input_ptr: *const u8, input_len: usize, out_ptr: *mut u8);
}

// Slot derivation: author derives slot_hash according to the PIP-2 layout
// described in Chapter 4. They can precompute the contract's address prefix
// as a `const fn` invocation, or compute on first use and cache.
const CONTRACT_NAME: &[u8] = b"mytoken";
const BALANCE_DISC: u8 = 0;  // from otigen.toml

fn balance_slot(addr: &[u8; 32]) -> [u8; 32] {
    let mut slot = [0u8; 32];
    let contract_prefix = poseidon2_const_prefix(CONTRACT_NAME);  // computed at startup; cached
    slot[..16].copy_from_slice(&contract_prefix[..16]);
    let mut inner_input = [0u8; 33];
    inner_input[0] = BALANCE_DISC;
    inner_input[1..].copy_from_slice(addr);
    let mut inner = [0u8; 32];
    unsafe { pyde_poseidon2(inner_input.as_ptr(), inner_input.len(), inner.as_mut_ptr()); }
    slot[16..].copy_from_slice(&inner[..16]);
    slot
}

// Entry function — name must match [functions.transfer] in otigen.toml
#[no_mangle]
pub extern "C" fn transfer(to_ptr: *const u8, amount_lo: u64, amount_hi: u64) -> i32 {
    // ... read inputs, derive slots, call pyde_storage_read/write, etc.
    0  // success
}
```

The author has total control over how slot derivation is done. They can precompute prefix hashes at startup (Rust `lazy_static!`, AssemblyScript module-level init, Go `init()`), keep them in module-level constants, or call `pyde_poseidon2` per access. None of this is `otigen`'s concern — `otigen` just checks that the resulting `.wasm` is well-formed and matches the declared `[functions]`.

### Build-time pre-hashing is the author's responsibility (and easy)

The build-time pre-hashing optimization (computing contract-name prefix once at compile time) is a per-language pattern. In Rust it's a `const fn` or a `lazy_static!`. In AssemblyScript it's a top-level constant initializer. In Go it's an `init()`. In C it's a `static const` array. The author follows their language's idioms; `otigen` doesn't get involved.

---

## 5.6 Safety Attributes via otigen.toml

Otigen the language had a set of compiler attributes that made common safety properties default and explicit. **Every one of those properties carries forward unchanged in the WASM era.** Authors declare them in `otigen.toml` `[functions.<name>] attributes = [...]`; `otigen build` includes them in the generated ABI; the runtime enforces them by reading the ABI before invocation and applying the appropriate guards.

The mechanism changed (config-declared metadata enforced at the call boundary instead of compiler-extracted markers in bytecode), but the safety guarantees are identical to the Otigen-language era.

### Reentrancy is still blocked by default

This is the most important property to preserve. Every public function gets an automatically generated reentrancy guard. To **opt OUT** of the guard — for a function that genuinely needs to allow re-entry — add the `#[reentrant]` attribute.

If you write nothing, you are protected.

### The attribute set

| Attribute     | Effect                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------- |
| `view`        | Read-only function. Runtime rejects any state-modifying host call inside it. View calls are FREE (no gas) — see [HOST_FN_ABI_SPEC §7.8](../companion/HOST_FN_ABI_SPEC.md). |
| `payable`     | Function accepts PYDE attached to the call. Non-`payable` functions reject any attached amount. |
| `reentrant`   | **Opts INTO** allowing reentrancy. Default for every function is reentrancy-blocked.            |
| `constructor` | Initialization-only. Callable exactly once, at deploy time.                                     |
| `sponsored`   | Gas charged to the contract's `gas_tank` rather than the caller's balance. Enables gasless UX.  |
| `fallback`    | Invoked when the call's function selector matches no declared function. At most one per contract. |
| `receive`     | Invoked on bare PYDE transfers (no selector, value > 0). At most one per contract. **Must also be `payable`**. |
| `entry`       | Marks the function as callable from outside the contract (top-level tx or cross_call). Required for any function not marked with another dispatch attribute (`constructor`/`fallback`/`receive`). Internal helpers omit `entry` and are not exposed in the public selector table. |

For attribute compatibility rules (which combinations are rejected at build + deploy), see [HOST_FN_ABI_SPEC §3.5.1](../companion/HOST_FN_ABI_SPEC.md).

### How attributes are declared

Attributes are declared in `otigen.toml`, per function. The author writes plain TOML; the source code is whatever they write in their language. No per-language macro syntax is needed and no source-code parsing is required.

```toml
[functions.balance]
attributes = ["entry", "view"]
inputs     = ["address"]
outputs    = ["uint128"]

[functions.deposit]
attributes = ["entry", "payable"]
inputs     = []

[functions.complex_callback]
attributes = ["entry", "reentrant"]   # opts INTO reentrancy; default is BLOCKED
inputs     = ["bytes"]

[functions.user_signup]
attributes = ["entry", "sponsored"]   # gas paid by contract's gas_tank
inputs     = ["address"]

[functions.init]
attributes = ["constructor"]          # callable only at deploy time
inputs     = ["uint128"]
```

The author writes the corresponding WASM exports in their language as normal exported functions. There is no required annotation pattern in source — the function just needs to be exported under the name declared in `[functions.<name>]`. In Rust, this is `#[no_mangle] pub extern "C" fn balance(...)`. In AssemblyScript, `export function balance(...)`. In Go (TinyGo), `//go:wasmexport balance`. In C, `__attribute__((export_name("balance")))`. Standard WASM-export idioms for each language.

### What the build tool does with attributes

`otigen build` validates them (e.g., a function cannot be both `view` and `payable`) and writes them into the generated ABI:

```json
{
  "functions": [
    {
      "name": "transfer",
      "selector": "0xa9059cbb",
      "attributes": ["entry"],
      "inputs": [...],
      "outputs": [...]
    },
    {
      "name": "balance",
      "selector": "0x70a08231",
      "attributes": ["entry", "view"],
      "inputs": [...],
      "outputs": [...]
    },
    {
      "name": "user_signup",
      "selector": "0x...",
      "attributes": ["entry", "sponsored"],
      "inputs": [...],
      "outputs": [...]
    }
  ]
}
```

### How the runtime enforces them

The WASM execution layer reads the function's attribute set from the deployed ABI before invocation and applies the appropriate behavior:

| Attribute     | Runtime enforcement                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `view`        | Host functions `sstore`, `sdelete`, `transfer`, `emit_event` trap if called inside a view function.                                                              |
| `payable`     | If `tx.value > 0` and target function is not `payable`, transaction reverts at dispatch. No state change.                                                        |
| `reentrant`   | Runtime skips the reentrancy guard for this function. ALL OTHER functions get the guard.                                                                         |
| Not `reentrant` (default) | On entry, the runtime sets a per-contract reentrancy flag. Any host call that re-enters this contract checks the flag; if set, traps with `ReentrancyViolation`. On exit, flag is cleared. |
| `constructor` | Callable only by the deploy transaction. Subsequent calls trap.                                                                                                  |
| `sponsored`   | At dispatch time, the engine debits gas from the contract's `gas_tank` instead of the caller's balance. If the gas tank is empty, transaction reverts.            |

This is identical behavior to Otigen the language. The change is implementation venue: attributes now ride on the ABI declared in `otigen.toml` rather than on compiler-extracted markers in bytecode. The safety guarantees are the same. The author's per-function declaration moves from source-code annotation to a config file. Both equally explicit; the config form keeps `otigen` decoupled from per-language source parsing.

### Other Otigen design choices preserved

Beyond function attributes, several broader Otigen design choices carry forward as runtime properties of the engine:

| Otigen design choice                | How it's preserved in the WASM era                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Reentrancy off by default           | Runtime reentrancy guard for every function not marked `reentrant`.                                                       |
| Checked arithmetic by default       | Per-language SDK helper patterns; wrapping ops require explicit opt-in (e.g., Rust's `wrapping_add` is explicitly named). |
| Typed storage                       | `otigen.toml` `[state]` schema declares types; ABI includes the schema so the runtime + explorers know what each slot is. Authors implement type-safe access in their own code. |
| No `tx.origin`                      | Host function ABI exposes `caller()` (direct caller) but no `origin()`. The Solidity-style phishing footgun is absent.     |
| Compile-time access lists           | Build tool emits a static access list per function from the declared state schema; the parallel scheduler uses these.     |
| 4-byte function selectors           | Build tool emits `selector = first 4 bytes of Hash(function_signature)` in the ABI.                                       |
| Sponsored / gasless transactions    | `#[sponsored]` attribute + `gas_tank` per contract account, exactly as designed in the Otigen era.                        |
| Reserved-storage-slot guards        | Reentrancy guard uses a reserved slot in the contract's state subtree, never reachable by user-allocated slots.            |

The safety floor that Otigen provided is preserved end-to-end. The mechanism is different; the contract author's experience is the same.

---

## 5.7 Deploy and Upgrade Flow

### Deploy

```bash
otigen deploy --network testnet
```

What happens, per spec §3.3:

1. `otigen` resolves the bundle dir (default `./artifacts/<name>.bundle/` from `otigen.toml`'s `[contract.name]`, override via `--bundle <path>`).
2. `otigen` loads the bundle (manifest.json + otigen.toml + contract.wasm) and re-validates WASM + ABI consistency — defense in depth even though the bundle came from `otigen build`.
3. `otigen` resolves the network from `--network` or `[network.default.name]` and the signer wallet from `--from` or `[wallet.default_account]`. Prompts for the wallet password (no echo).
4. `otigen` fetches the sender's nonce via `pyde_getNonce`.
5. `otigen` builds the canonical `Tx`:
   ```
   Tx {
     from:       sender (32-byte Poseidon2(falcon_pubkey)),
     to:         Address::ZERO,
     value:      0,
     data:       borsh(DeployData { name, wasm_bytes, contract_type, init_calldata }),
     gas_limit:  from [deploy.gas_limit] (default 10_000_000),
     nonce:      fetched above,
     signature:  filled in next step,
     fee_payer:  Sender,
     access_list: [],
     deadline:   None,
     chain_id:   from [network.<name>.chain_id],
     tx_type:    Deploy (0x01),
   }
   ```
6. `otigen` computes the canonical Poseidon2 tx hash (Ch 11 §"Transaction hash") and FALCON-signs it. The signature is NOT included in the hashed payload.
7. `--dry-run` mode: print tx hash + wire size and exit 0 without submitting.
8. Otherwise: Borsh-encode the full Tx and submit via `pyde_sendRawTransaction`. Print the server-returned tx hash.
9. Unless `--no-wait`, poll `pyde_getTransactionReceipt` (60 s timeout, 1 s interval) until included. Report success / reverted / out-of-gas.

Exit codes: `0` on inclusion + success, `1` on validation failure, `2` on RPC / network / inclusion-timeout, `3` on revert, `4` on wallet failure.

### Upgrade

```bash
otigen upgrade <target> --bundle <new-bundle-dir>     # contract path
```

What happens (contract path):

1. `otigen` resolves `<target>` — `0x`-prefixed address or registered name (auto-resolved via `pyde_resolveName`).
2. `otigen` reads the new wasm from `--wasm <file>` or `<bundle>/contract.wasm`.
3. Same signing pipeline as deploy, but the wire shape is `Tx { tx_type: Standard, to: <target>, data: borsh(LifecyclePayload::Upgrade { new_wasm }) }`. The chain decodes the payload, re-runs ABI validation against the new bytes, stores the new code, and bumps `current_version`.

For parachain upgrades, the chain requires equal-power validator-quorum certs collected separately per [PARACHAIN_DESIGN §6.2](../companion/PARACHAIN_DESIGN.md). The CLI flow for parachain governance (`--parachain` / `--finalize <proposal-id>`) is deferred to the parachain rollout post-mainnet.

---

## 5.8 Wallet Management

The wallet is built into the `otigen` binary directly — no separate wallet daemon, no external dependency, no extra install step. The cryptographic primitives (FALCON-512 keypair generation, AES-256-GCM keystore encryption, Argon2id key derivation, in-memory key unlock with zeroize-on-drop) carry forward from the archived `wright` toolchain; the on-disk format was redesigned for the WASM era to match spec §7.1.

### Subcommand surface

```bash
otigen wallet new <name>
    # Generate a new FALCON-512 keypair. Prompts for a password (twice).
    # Adds the encrypted keypair to ~/.pyde/keystore.json under <name>.

otigen wallet import <name>
    # Add an existing keypair. Both halves of the FALCON keypair are read
    # interactively — FALCON does not allow recovering the public key from
    # the secret key alone, so the user must paste both (public hex first,
    # then secret key via a no-echo prompt).

otigen wallet list
    # List every account in the keystore (name + address).

otigen wallet show <name>
    # Print the account's address + public key. No password needed —
    # public material is stored unencrypted.

otigen wallet delete <name> [--yes]
    # Remove an account from the keystore. Requires retyping the name
    # to confirm unless --yes is passed.

otigen wallet password <name>
    # Rotate the account's encryption password. Decrypts with the old
    # password, generates a fresh salt + nonce, re-encrypts. The keypair
    # itself is unchanged.
```

Override the default keystore location via the global `--keystore <path>` flag (e.g. `otigen --keystore ./test-keys.json wallet list`).

### Keystore format

Per spec §7.1, a single JSON file at `~/.pyde/keystore.json` holds every account. Schema:

```json
{
  "version": 1,
  "accounts": {
    "deployer": {
      "address":    "0x" + 64 hex chars,
      "pubkey":     "0x" + hex of FALCON-512 public key (897 bytes → 1794 chars),
      "ciphertext": "0x" + hex of AES-256-GCM ciphertext of the FALCON secret key,
      "salt":       "0x" + 32 hex chars (16-byte Argon2id salt),
      "nonce":      "0x" + 24 hex chars (12-byte AES-GCM nonce),
      "kdf": {
        "name":        "argon2id",
        "memory_kb":   65536,    // 64 MiB
        "iterations":  3,
        "parallelism": 4
      }
    },
    "deployer-staging": { ... },
    "alice":            { ... }
  }
}
```

KDF parameters are embedded per-entry so a future tightening of the pinned values still decrypts old entries.

Unix file permissions are set to `0700` on `~/.pyde/` and `0600` on the keystore file. The plaintext secret key is decrypted in memory only when needed for signing and wiped on drop via `zeroize::Zeroizing`. The `Wallet` struct's `Debug` impl is hand-rolled to redact the secret key bytes so accidental `unwrap_err()` on a `Result<Wallet, _>` cannot dump key material into a panic message.

### Signing flow

When `otigen deploy`, `otigen upgrade`, `otigen pause`, `otigen unpause`, or `otigen kill` is invoked:

1. Resolve the wallet name from `--from <name>` or `[wallet.default_account]`.
2. Resolve the keystore path from `--keystore <path>` or the default (`~/.pyde/keystore.json`).
3. Prompt for the password via `rpassword` (no TTY echo).
4. Derive the AES-256 key from the password + per-account salt via Argon2id.
5. Decrypt the FALCON-512 secret key into a `zeroize::Zeroizing` wrapper.
6. Construct the canonical `Tx`, compute the Poseidon2 tx hash, FALCON-sign the digest.
7. Submit the signed `Tx` via `pyde_sendRawTransaction`. Zeroize the secret-key buffer on scope exit.

AES-GCM decryption failures all surface as the same `Error::DecryptionFailed` variant, regardless of cause (wrong password, tampered ciphertext, corrupt nonce). This avoids a timing oracle that would distinguish "you typed the wrong password" from "someone modified your keystore."

### Deferred surface

Three advanced wallet operations from spec §3.7 are deferred to a later pass:

- `rotate <name>` — submits a chain-side `KeyRotationTx` so an existing account can move to a fresh FALCON keypair without changing its address. Distinct from `password` (which only re-encrypts the local keystore entry).
- `export <name>` — emit an encrypted backup blob for migration / cold storage.
- `sign <name> <hex-message>` — sign arbitrary bytes for advanced workflows (off-chain attestations, etc.).

Hardware-wallet bridges and HSM-backed signing (spec §7.4) are post-mainnet; no FALCON-aware hardware wallets exist yet.

---

## 5.9 The Console

`otigen console` is reserved by spec §3.8 as an interactive REPL against a Pyde node — useful for exploration and ad-hoc debugging.

Status: **deferred until the engine's devnet binary lands.** The REPL pairs with `pyde-node --devnet` (engine task, in flight) — once authors can spin up a local single-validator devnet with prefunded accounts, the REPL becomes the natural way to poke at deployed contracts. Until then, every read / write surface the REPL would expose is already scriptable via the other subcommands (`inspect`, `verify`, `deploy`, the wallet commands), and `otigen-rpc::Client` is a small enough crate to embed directly in a one-off Rust script when something more dynamic is needed.

---

## 5.10 What the Toolchain Does NOT Do

Deliberately omitted:

- **Language-native unit-test runner** — use `cargo test` / `npm test` / `go test` / the author's C test harness for pure-helper unit tests. `otigen test` covers contract behaviour (state changes, events, reverts), not language-internal function testing. The two layers are complementary, not overlapping (§5.1, [OTIGEN_TEST_SPEC](../companion/OTIGEN_TEST_SPEC.md)).
- **Linter / formatter** — use the language's native tooling (`rustfmt`, `prettier`, `gofmt`, `clang-format`).
- **IDE integration** — uses the language's standard LSP; no Otigen-specific IDE extension required.
- **Documentation generator** — use the language's standard (`rustdoc`, `typedoc`, etc.).
- **Dependency manager** — use the language's standard (`cargo`, `npm`, `go mod`, etc.).
- **Custom syntax** — there is none; the contract is whatever the language allows.

The toolchain wraps deployment-specific concerns + the chain-aware behaviour-test layer. Everything else stays in the language ecosystems the authors already know.

---

## 5.11 Performance

The whole toolchain side of the pipeline — parse `otigen.toml`, validate every cross-cutting rule, walk the compiled `.wasm` for imports + exports + deterministic-feature compliance, build the canonical `ContractAbi`, Borsh-encode it, inject the `pyde.abi` custom section — measures in **single-digit microseconds end-to-end**. Validation work is essentially free against the file-system overhead of reading the `.wasm` and writing the four bundle files; a typical `otigen build` invocation is dominated by I/O (~1–5 ms in practice), not by validator CPU.

Reference numbers on an Apple M-series dev machine (arm64, macOS 15), measured by the criterion benches committed under `crates/<crate>/benches/baseline/*.json` in the `pyde-net/otigen` repo. Reproduce with `cargo bench -p otigen-toml --bench parse_validate` and `cargo bench -p otigen-abi --bench abi_pipeline`.

| Operation | Median |
|---|---:|
| `selector_of` (Blake3 prefix, function-name → 4-byte selector) | **50 ns** |
| `Attributes::from_attributes` (3-attribute set) | **1 ns** |
| `from_project_config` (build canonical `ContractAbi` from parsed TOML) | **449 ns** |
| Borsh encode `ContractAbi` (3-function contract) | **39 ns** |
| Borsh decode `ContractAbi` | **156 ns** |
| `pyde.abi` custom-section inject (3-fn realistic WASM) | **494 ns** |
| `pyde.abi` custom-section extract | **154 ns** |
| WASM import validator (3 imports against the host-fn allowlist) | **196 ns** |
| WASM export validator (cross-reference vs `ContractAbi`) | **343 ns** |
| WASM deterministic-feature validator (full function-body opcode pass) | **2.3 µs** |
| `otigen.toml` parse (canonical spec example, ~50 lines) | **23 µs** |
| `otigen.toml` cross-cutting validation pass | **278 ns** |
| `otigen.toml` parse + validate (stress: 100 functions + 50 events + 30 state fields) | **488 µs** |
| **Full in-memory toolchain pipeline** (parse → validate → build → encode → inject) | **14.5 µs** |

These numbers are tracked from commit `pyde-net/otigen#6` forward. Future regressions surface on PRs that run `cargo bench --baseline=v1`.

The benches are intentionally tight scope — they measure the toolchain-side work, not the chain-side deploy validator (which redoes every check at deploy time per `HOST_FN_ABI_SPEC.md` §3.7 layer 3) and not the wasmtime AOT compilation step (which happens on the chain at first invocation of a deployed contract, not at `otigen build` time).

---

## 5.12 Contract Behaviour Tests (`otigen test`)

The toolchain ships a TOML-driven contract test runner. Authors write `tests/<name>.test.toml`, run `otigen test`, and get pass / fail per scenario — the same workflow Foundry users know from `forge test`, adapted to Pyde's host-function surface.

The full schema, name-resolution rules, cheatcode catalogue, mock host-function behaviour, and limitations are documented in [`OTIGEN_TEST_SPEC.md`](../companion/OTIGEN_TEST_SPEC.md). The short overview:

### What gets tested

- **State changes** — assert balances / counters / mappings after a call sequence.
- **Return values** — assert a function returned the expected scalar.
- **Events** — assert `Transfer(from, to, amount)` (or any declared event) emitted with the right indexed + non-indexed fields.
- **Reverts** — assert a call traps with a reason substring (`"InsufficientBalance"`).
- **Multi-step scenarios** — assert "alice transfers to bob, then bob transfers to carol; final state is …" across multiple calls in one test.
- **Time / wave / chain conditions** — cheatcode `now`, `wave_id`, `chain_id` per test.

### What it looks like

```toml
# tests/contract.test.toml

[accounts]
alice = { balance = "0x100" }
bob = {}

[[tests]]
name = "transfer_moves_balance"

[tests.setup]
storage.balances.alice = "100"
storage.balances.bob   = "0"

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
```

Account names resolve to 32-byte Blake3-of-name addresses; storage field names resolve to Poseidon2 slots per the contract's `[state]` schema + the [PIP-2 layout in Ch 4 §4.3](./04-state-model.md). Authors never type slot hashes by hand.

### How it runs

`otigen test` discovers `tests/*.test.toml`, spins up a wasmtime engine, loads the contract's `.wasm` from `./artifacts/<name>.bundle/contract.wasm`, and executes each test against a fresh `TestEnv` that mocks every `pyde::*` host function:

- Real `hash_poseidon2` / `hash_blake3` / `falcon_verify` (via `pyde-crypto`) so author-side slot derivation + signature verification match the runner exactly.
- Mock storage (`sload` / `sstore` / `sdelete`), account (`balance` / `transfer`), context (`caller` / `self_address` / `wave_id` / `wave_timestamp` / `chain_id`), tx (`tx_value`), events (`emit_event`), halt (`revert`), cross-call (`cross_call` / `delegate_call`), and parachain §8 host fns (`parachain_storage_{read,write,delete}` / `parachain_id` / `parachain_version` / `parachain_emit_event`) against an in-memory state map.
- Test-only `pyde::debug_log` printf-style host fn captured in the call's debug log buffer; chain-side hard-rejected via `otigen build --strict`.
- Host fns that trap with `UnsupportedHostFn` in v1: `origin`, `tx_hash`, `tx_gas_remaining`, `calldata_size`, `calldata_copy`, `hash_keccak256`, `cross_call_static`, `consume_gas`, `beacon_get`, plus the DKG / threshold-encryption surface. Each either depends on chain-derived state the runner doesn't model, or no canonical example exercises it yet.

### What it doesn't do (v1)

- No parallel-execution simulation; calls run sequentially.
- No fuzzing / property tests; example-based only (Phase 6 ladder).
- No multi-tx context — each test starts from fresh state; "deploy in tx1, then call from a different sender in tx2 within one test" isn't expressible (Phase 6).
- No simulating chain-side validators (mempool, access-list, nonce window) — those run on a real node; pair with `otigen deploy --network devnet` for end-to-end verification.

Every limitation has a future-phase plan in `OTIGEN_TEST_SPEC.md` §9. The v1 surface is deliberately scoped to what most contract authors need on day one — behaviour, state, events, reverts, gas tracking, cross-contract, FALCON sigs, schema-aware typed args, parachain extension surface — without buying the complexity of fuzz / multi-tx orchestration up front.

### When to use what

| You want to test | Use |
|---|---|
| Pure helper functions (math, parsing) | Language-native test runner (`cargo test`, `npm test`, `go test`) |
| Contract behaviour given storage / time / caller | `otigen test` |
| Cross-contract integration | Devnet (real chain integration) |
| Fuzz / property testing of pure helpers | Language-native fuzzer (`proptest`, `quickcheck`) |
| Multi-validator chain behaviour | Devnet + the performance harness ([Companion: PERFORMANCE_HARNESS](../companion/PERFORMANCE_HARNESS.md)) |

The three layers (unit / behaviour / integration) compose; each catches things the others miss. `otigen test` is the middle layer that didn't exist before this rev of the toolchain.

---

## 5.13 Reading on

- [Chapter 3: Execution Layer](./03-virtual-machine.md) — the runtime that contracts compile into.
- [Chapter 4: State Model](./04-state-model.md) — what `sload` and `sstore` see.
- [Chapter 11: Account Model](./11-account-model.md) — the ENS-style name registry that the toolchain registers against.
- [Chapter 13: Cross-Chain (Parachains)](./13-cross-chain.md) — parachain-specific deploy and upgrade flows.
- [`HOST_FN_ABI_SPEC.md`](../companion/HOST_FN_ABI_SPEC.md) — the locked binary contract between WASM modules and the engine; every imported function the toolchain accepts is in its allowlist.
- [`OTIGEN_BINARY_SPEC.md`](../companion/OTIGEN_BINARY_SPEC.md) — the canonical specification for this binary. Every subcommand, flag, `otigen.toml` schema rule, bundle format, exit code, and validation pass is defined there. If the implementation and the spec disagree, the spec is right and the code is a bug.
- [`OTIGEN_TEST_SPEC.md`](../companion/OTIGEN_TEST_SPEC.md) — the canonical specification for `otigen test`: TOML schema, name resolution, cheatcode catalogue, mock host functions, limitations.
