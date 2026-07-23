# Chapter 5: Otigen Toolchain

`otigen` is Pyde's developer toolchain: a single binary that **scaffolds** projects (from a language template or canonical example), **validates** the author's WASM build, **runs behaviour tests** against the compiled `.wasm`, **generates** the ABI from `otigen.toml`, **packages** the deploy bundle, **manages FALCON-512 keystores**, and handles **on-chain lifecycle commands** (deploy, upgrade, pause, kill, inspect, verify, console).

What `otigen` deliberately does NOT do: it does not compile WASM, it does not generate code, it does not interface with any language's build pipeline. Authors run their own `cargo build` / `asc` / `tinygo build` / `clang --target=wasm32` and `otigen` checks the result. This keeps the toolchain minimal and language-agnostic, and lets authors keep their full native toolchain experience.

The name carries forward from an earlier design phase, when Otigen was Pyde's domain-specific smart-contract language. The language is retired; the name now describes the role it occupies best: the lightweight verifier and packager that makes WebAssembly deployment on Pyde coherent without forcing authors out of their language ecosystems. See [The Pivot](../preface/pivot.md) for the full story.

This chapter covers the toolchain's design, the subcommand surface, the `otigen.toml` schema, the per-language workflow, build verification, attributes, deploy/upgrade, wallet, behaviour tests, and the console.

For the underlying execution layer that contracts run on, read [Chapter 3: Execution Layer](./03-virtual-machine.md). For the host functions contracts call, read the Host Function ABI spec.

---

## 5.1 Design Principles

The toolchain is built around four principles, each chosen deliberately.

### Author owns the build; otigen verifies

By default `otigen` does not compile WASM. The author runs their language's native build command (`cargo build --target wasm32-unknown-unknown --release`, `npm run build`, `tinygo build -target=wasi -o build/contract.wasm .`, `make`) themselves. They get the full diagnostics, the full IDE integration, the full test workflow their language ecosystem provides.

`otigen build` then **verifies** the result: confirms the `.wasm` file exists at the path declared in `otigen.toml`, validates the WASM module structure, cross-checks that the module imports only allowed host functions and exports every function declared in `[functions]`, and generates the deploy bundle. If anything is missing or wrong, `otigen` says so; if everything checks out, it prints "ready to deploy."

This keeps the toolchain minimal (no per-language compiler invocation logic to maintain) and respects the author's native toolchain.

For the common iterate-on-a-contract case there is also `otigen build --compile`: an opt-in flag that runs the per-language default build command first (the same invocation the templates document + `init`'s "next:" hint prints), then proceeds with the same verify + package pipeline. Both paths produce byte-identical bundles when the inputs are equivalent: `--compile` is a UX convenience, not a different build. Authors with custom build flags continue to compile manually and call `otigen build` (no flag) afterwards; that verify-only path stays supported forever.

### Zero extra code in the author's project

A contract project contains only the author's contract logic and an `otigen.toml`. No bundler files, no glue code, no manifest-handling boilerplate. The author writes what their language requires (a `Cargo.toml` for Rust, `package.json` for AssemblyScript, `go.mod` for Go, `Makefile` for C/C++) and the contract source itself.

State access and host-function calls go through whatever helper pattern the author or community provides for their language. `otigen` doesn't ship those helpers, doesn't generate them, doesn't depend on them. It only requires that the resulting `.wasm` imports the Host Function ABI correctly.

### Two test layers, one toolchain

Pyde splits contract testing by layer. **Language-native test frameworks** (`cargo test`, `npm test`, `go test`, the author's C test harness) cover pure helpers (math, parsing, formatting) at the function-internals layer. The toolchain doesn't wrap them; authors keep their language's standard test workflow.

**`otigen test`** covers the layer above, contract *behaviour*: does `transfer` decrement the right balance, emit the right event, revert on the right input. It runs the compiled `.wasm` inside a wasmtime sandbox with mock implementations of every `pyde::*` host function declared in the [Host Function ABI](../companion/HOST_FN_ABI_SPEC.md), driven by a TOML test spec (named accounts, named storage slots, time / wave / chain cheats, multi-call sequences, named event matching, named-or-substring revert assertions). The TOML format is language-agnostic: the same `.test.toml` runs against the contract regardless of source language. Full schema and semantics: [OTIGEN_TEST_SPEC](../companion/OTIGEN_TEST_SPEC.md).

The split mirrors Foundry's `forge test` (behaviour) vs Rust's `cargo test` (unit): neither subsumes the other, and both shipping in one toolchain doesn't compromise the language-agnostic posture.

### Attributes and ABI declared in otigen.toml, enforced at runtime

Function attributes (`view`, `payable`, `reentrant`, `sponsored`, `constructor`, `fallback`, `receive`, `entry`) and state schema are declared in `otigen.toml`. `otigen build` reads them, builds a `ContractAbi` struct, Borsh-encodes it, and **injects it as a WASM custom section named `pyde.abi`** directly into the .wasm artifact the language compiler produced. There is no separate `abi.json` file at deploy time: the ABI travels with the code as one binary. At runtime, the WASM execution layer extracts the `pyde.abi` section once, caches the parsed ABI alongside the compiled Module, and applies attribute-driven guards before every call (reentrancy block, view-mode state-write rejection, payable-mode value check, sponsored gas-tank debit, etc.). The WASM module itself does not carry attribute markers; the engine enforces them at the call boundary based on the parsed ABI. Full mechanics: [Host Function ABI Spec §3.5 to §3.7](../companion/HOST_FN_ABI_SPEC.md).

---

## 5.2 Subcommand Surface

Every row links to its canonical [`OTIGEN_BINARY_SPEC`](../companion/OTIGEN_BINARY_SPEC.md) section. The spec is authoritative on flag tables, exit codes, and the per-command pipeline. This chapter is the narrative companion.

| Command | Purpose | Spec |
|---------|---------|------|
| `otigen init <name> --lang <rust\|as\|go\|c>` | Scaffold a new project directory from the language template. Writes `otigen.toml` + a hello-world contract + language-specific build config (Cargo.toml / package.json + asconfig.json / go.mod / Makefile). The Rust scaffold uses the macro substrate (`#[pyde::entry]` + `pyde::declare_storage!()` + `pyde::declare_events!()`); non-Rust scaffolds ship the raw `extern "C"` host-fn pattern. | [§3.1](../companion/OTIGEN_BINARY_SPEC.md#31-otigen-init) |
| `otigen new <name> --from <template>` | Scaffold by cloning a canonical example bundle. Eight templates ship today (`counter`, `erc20-token`, `erc721-token`, `simple-multisig`, `upgradeable-proxy`, `merkle-claim-airdrop`, `vesting`, `dao-governance`), all on the `#[pyde::entry]` + `declare_storage!()` macro substrate, all building clean. Produces a fully-working contract + passing test suite: the fastest path from zero to a green `otigen test`. `--list` shows the catalog. | [§3.11](../companion/OTIGEN_BINARY_SPEC.md#311-otigen-new) |
| `otigen build` | **Verify + package.** Reads `otigen.toml`, locates the `.wasm` at the declared path, validates the WASM module (well-formed, imports allowed only, no `wasi:*` / `env`), cross-checks declared `[functions]` exist as WASM exports, builds the `ContractAbi`, Borsh-encodes it, injects as the `pyde.abi` custom section, writes `<contract>.bundle/` atomically (via a `<name>.bundle.partial/` staging dir; a Ctrl-C SIGINT handler sweeps the partial before exit). By default the author runs their own language build; `--compile` opts in to running it automatically (`cargo` / `npm run build` / `tinygo` / `make`). Strict validation (rejection of test-only host fns like `pyde::debug_log`) is the **default**; `--no-strict` is the opt-out escape hatch for local inspection. `otigen deploy` always runs strict and ignores `--no-strict`. | [§3.2](../companion/OTIGEN_BINARY_SPEC.md#32-otigen-build) |
| `otigen check` | Same validation pipeline as `otigen build` (spec §3.2 steps 1 to 7), minus the bundle write. Fast pre-commit / IDE / TDD gate. Per-violation diagnostics on stderr; exit 1 on any failure. | [§3.13](../companion/OTIGEN_BINARY_SPEC.md#313-otigen-check) |
| `otigen deploy` | Sign and submit a deploy transaction. Loads the bundle, re-validates, fetches nonce via `pyde_getTransactionCount`, builds the canonical `Tx` envelope with `tx_type = Deploy` + borsh-encoded `DeployData{ name, wasm_bytes, contract_type, init_calldata }` in `tx.data`, FALCON-signs the Poseidon2 tx-hash, submits via `pyde_sendRawTransaction`, polls the receipt. `--dry-run` to inspect without submitting; `--no-wait` to skip the receipt poll. `--rpc-url <URL>` + `--chain-id <N>` give a one-shot override of `[network.<name>]` (mandatory pair: raw URL has no chain id, signing against `chain_id = 0` silently bricks the FALCON sig). | [§3.3](../companion/OTIGEN_BINARY_SPEC.md#33-otigen-deploy) |
| `otigen upgrade <target>` | **Engine-gated in v1.** The CLI builds the signed tx but refuses to submit (`EngineNotReady`) because the chain has no `TxType::Lifecycle` handler yet. v1 pattern: proxy + `delegate_call`. `--i-know-engine-rejects` bypasses the gate for stub-engine testing. Mandatory `--rpc-url` + `--chain-id` pair applies when overriding. | [§3.4](../companion/OTIGEN_BINARY_SPEC.md#34-otigen-upgrade) |
| `otigen pause` / `unpause` / `kill` | **Engine-gated in v1**: same `EngineNotReady` refusal + `--i-know-engine-rejects` bypass as `upgrade`. v1 pattern: author-declared `paused: bool` / `killed: bool` in `[state]`, gated in entry-function bodies. `kill --yes` skips the retype-the-target confirmation; mandatory `--rpc-url` + `--chain-id` pair applies when overriding. | [§3.5](../companion/OTIGEN_BINARY_SPEC.md#35-otigen-pause--otigen-unpause--otigen-kill) |
| `otigen call <target> <fn> [args...]` | Sign and submit a contract call (`TxType::Standard` with `data = borsh(CallPayload { function, calldata })`). Routes through the chain's `WasmExecutor::execute_call` for `entry`-attributed functions; view functions skip submission and go through `pyde_call` (free, no tx, no gas) when otigen recognises the `view` attribute from a local `otigen.toml`. Positional args are typed per `[functions.X].inputs`: `otigen call <addr> transfer devnet-1 100` Just Works; address values resolve wallet names from the local keystore; JSON array syntax `[1,2,3]` carries `vec(T)`; JSON5 struct + variant-name forms carry `[types.<Name>]` shapes (`{maker:0xaa…,id:1}`, `Pending`). `--args <hex>` is the escape hatch for raw pre-encoded calldata; view returns auto-decode per `[functions.X].outputs` (`--raw` keeps the hex); `--value <decimal>` attaches a native-token transfer alongside the call. | [§3.X](../companion/OTIGEN_BINARY_SPEC.md) |
| `otigen inspect <target>` | Read deployed contract state via the rpc client. Default mode surfaces address, account type, balance, nonce, code hash, code size, state root, and (when the wasm carries a `pyde.abi` custom section) the full ABI summary: version, function count, constructor / fallback / receive bindings, state schema hash, per-function selector + attribute labels. `--state-field <name>` reads a substrate-typed scalar field: derives the slot `Poseidon2(self_address \|\| field_name)` (the chain's `sstore_scalar` convention), pulls the bytes, and decodes per the type token in `[state].schema`; renders contract / field / slot / raw / decoded value. `--field <name>` reads a legacy raw-storage slot via `Poseidon2(name)`, used by contracts that call `sstore` / `sload` directly; mutually exclusive with `--state-field`. `--rpc-url <URL>` one-shot override + `--at-wave <id>` for archive nodes. ⏳ Owner / version history land when the RPC catalog grows the corresponding endpoints. | [§3.6](../companion/OTIGEN_BINARY_SPEC.md#36-otigen-inspect) |
| `otigen verify <target>` | Reproducibility check: compares the local bundle's `contract.wasm` against the chain-stored bytes from `pyde_getContractCode`. Exit 0 on match, 1 on mismatch with blake3 hashes + size delta + first-diff offset. Two clean local builds of the canonical hello-rust produce byte-identical `contract.wasm` + `abi.json` (modulo `manifest.build_timestamp`). The `make reproducibility` gate locks the invariant. | [§3.9](../companion/OTIGEN_BINARY_SPEC.md#39-otigen-verify) |
| `otigen validator <subcmd>` | Read-only validator-introspection over `pyde_getValidator` + `pyde_getOperatorValidators`. `show <addr>` returns one validator's full chain-side record (operator + pubkey + stake + status + jail / unbond timeline + last-claimed reward checkpoint + uptime bps); exits non-zero with `NotAValidator` for unregistered addresses so shell scripts can branch on exit code. `by-operator <addr>` lists every validator an operator runs. `--json` emits the same data as one NDJSON event per invocation. Registration / stake / unbond / unjail / key-rotation flows live on the `pyde stake` CLI (engine binary). | [§3.14](../companion/OTIGEN_BINARY_SPEC.md#314-otigen-validator) |
| `otigen wallet` | FALCON-512 keystore management. Subcommands: `new <name>`, `list`, `show <name>`, `import <name> [--from-file <path> \| --from-devnet]`, `delete <name> [--yes]`, `password <name>`, `export <name> [--out <path>]`, `sign <name> --message <msg>`, `verify [name] --message <msg> --signature <hex>`. `import --from-devnet` re-derives the 10 deterministic prefunded `otigen devnet` accounts locally (no network call). ⏳ Only the chain-side `rotate` (`KeyRotationTx`) is deferred: it needs the chain to accept that tx variant. | [§3.7](../companion/OTIGEN_BINARY_SPEC.md#37-otigen-wallet) |
| `otigen test` | Run contract behaviour tests declared in `tests/*.test.toml`. Executes through `pyde-engine-wasm-exec::WasmExecutor` by default (same code path mainnet uses), so authors get every `pyde::*` host fn at chain fidelity. `--no-engine` falls back to the legacy in-process mock surface for parachain contracts (parachain runtime ships in engine v2) and runner-side bisection. `--no-compile` skips the per-language compile step. Named-account + named-slot + cheatcode model, multi-call sequences with per-call and final-state assertions, typed-arg marshalling (`address` / `uint128` / `int128` / `bytes32` / `bytes` / primitive ints), FALCON DSL (`@pubkey:NAME` / `@sig:NAME:args.IDX`), `pyde::debug_log` test-only host fn, schema-aware encoding (incl. `struct(<Name>)` via `pyde::declare_storage!()`), `--watch` for Foundry parity, `--json` NDJSON event stream, standard `-v`/`-vv` clap verbosity. | [§3.10](../companion/OTIGEN_BINARY_SPEC.md#310-otigen-test) + [OTIGEN_TEST_SPEC](../companion/OTIGEN_TEST_SPEC.md) |
| `otigen console` | Interactive REPL against a Pyde node. Shipping surface: `help`, `balance <addr>`, `nonce <addr>`, `call <addr> <fn> [hex]` (view, free), `tx <addr> <fn> [hex] [--value <decimal>]` (sign + submit + receipt poll), `state <addr> <field>` (substrate-typed scalar read; same `Blake3(self_address \|\| field_name)` derivation + `[state].schema` decoder `inspect --state-field` uses), `exit` / `quit`. Session-scoped `--network` / `--from` bind once at startup; wallet unlock is lazy (views never prompt, first `tx` asks for password once). Line-edited via rustyline with persisted history at `~/.otigen_console_history`. | [§3.8](../companion/OTIGEN_BINARY_SPEC.md#38-otigen-console) |
| `otigen devnet` | One-command local devnet: **the chain runtime is embedded in the `otigen` binary**; there is no separate `pyde` download or process to fork. Spins up the in-process engine, pre-funds 10 deterministic accounts, exposes JSON-RPC on `127.0.0.1:9933` (plus `/ws` for subscriptions). Headliner is `--fork <FILE_OR_URL>`: accepts either a local borsh snapshot file (produced by the engine's `Snapshotter::build`) or an HTTP(S) URL pointing at a running validator's snapshot RPC. Flags: `--rpc-listen`, `--prefund-count`, `--prefund-amount`, `--chain-id`, `--tick-ms`. On Ctrl-C, all state is wiped. | [§3.12](../companion/OTIGEN_BINARY_SPEC.md#312-otigen-devnet) |

There is no `otigen compile`. Authors use their language's native compiler (`cargo build --target wasm32-unknown-unknown --release`, `asc`, `tinygo build -target=wasi`, `clang --target=wasm32`). The `--compile` flag on `otigen build` is an opt-in convenience that invokes the language's default command, not a separate `compile` subcommand.

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
access_list = [                  # optional; prefetch hint for cache warm-up
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

# ─────────────────────────────────────────────────────────────────
# Custom types — referenced by bare name in [functions.X].inputs/outputs,
# and via struct(...) / vec(...) wrappers in [state].schema.
# ─────────────────────────────────────────────────────────────────

[types.Order]
fields = [
    { name = "id",     type = "uint64"  },
    { name = "maker",  type = "address" },
    { name = "amount", type = "uint128" },
    { name = "paid",   type = "bool"    },
]

[types.Status]
variants = [
    { name = "Pending" },
    { name = "Active"  },
    { name = "Cancelled" },
]

[events.Transfer]
signature = "Transfer(address,address,uint128)"
fields = [
    { name = "from",   type = "address",  indexed = true },
    { name = "to",     type = "address",  indexed = true },
    { name = "amount", type = "uint128" },
]
```

### Schema notes

**`[contract]`**: identity + version + type (contract or parachain). `name` is the ENS-style on-chain name (globally unique; see [Ch 11 §11.2](./11-account-model.md)). The address is derived from the FALCON pubkey at deploy time, not from `name`; the registry binds `name → address`.

**`[contract.lang]`**: declares which language the author compiled with and where their compiler emits the `.wasm`. `language` ∈ {`rust`, `as`, `go`, `c`}. `output` is the path `otigen build` reads. Optional `[contract.lang.toolchain]` pins specific toolchain versions (surfaced in `manifest.json` for reproducible-build verification).

**`[deploy]`**: defaults for `otigen deploy`. `gas_limit` caps the deploy tx's gas. `gas_price = "auto"` uses the current chain base fee; a fixed integer overrides. `owner_deposit` is only meaningful for parachain deploys.

**`[wallet]`**: points at the default keystore + the default account. Both fields are optional; the global `--keystore <path>` and per-command `--from <name>` flags override.

**`[network.*]`**: `[network.default.name]` selects which other `[network.<name>]` table the toolchain talks to. Each named entry carries `rpc_url`, `chain_id`, and an optional `explorer_url`. The global `--network <name>` flag overrides at the command line.

**`[state]`**: the schema of the contract's storage. Used by `otigen build` to compute `state_schema_hash` (which the chain compares against on every state read for type-safety enforcement) and emitted in `abi.json` for explorers. The author's contract code still derives the storage slots itself. Pyde does not ship per-language storage bindings.

**`[functions.<name>]`**: every callable function the runtime should dispatch to. `attributes` is the safety + dispatch attribute set documented in §5.6. `otigen build` cross-checks every `[functions.X]` has a matching WASM export named `X` and rejects exports that aren't declared. Optional `access_list` declares the storage slots the function touches; accurate lists optimize cache prefetch performance in the uniform Block-STM scheduler (declaring nothing still works: the chain just runs with a colder cache).

**`[types.<Name>]`**: author-declared custom types. Two shapes: a struct declares `fields = [{ name, type }, ...]`; an enum declares `variants = [{ name = "X" }, ...]` (v1 is unit-only: no data-carrying variants). Functions reference custom types by **bare name** in `[functions.X].inputs` / `outputs` (e.g. `"Order"`); storage references them via the `struct(<Name>)` wrapper in `[state].schema` (e.g. `{ name = "current_order", type = "struct(Order)" }`), and `vec(<Name>)` similarly wraps for arrays. Rust contract code needs `#[derive(BorshSerialize, BorshDeserialize)]` on every custom type. The macro substrate's typed storage + entry-arg decoders depend on it.

**`[events.<name>]`**: emitted-event declarations. `signature` is the canonical string the chain hashes (Blake3) to derive the topic-0 value. Indexed fields are searchable via `pyde_getLogs`; non-indexed fields are Borsh-encoded into `data`.

**`[parachain]`** *(parachain only)*: consensus preset, validator constraints, slashing preset. Detailed in [Chapter 13](./13-cross-chain.md).

---

## 5.4 Per-Language Workflow

Each language has its own template (scaffolded by `otigen init`) and its own native build command. The author runs the build; then `otigen build` verifies + packages.

### Rust

```bash
otigen init my-contract --lang rust
cd my-contract
# Edit src/lib.rs with contract logic; declare entries + state +
# events in otigen.toml.

# Author runs their own build:
cargo build --release --target wasm32-unknown-unknown

# otigen verifies and packages:
otigen build
otigen deploy --network devnet
```

Scaffolded project tree:
```
my-contract/
├── otigen.toml      # contract identity, network, [functions.*], [state], [events.*]
├── Cargo.toml       # cdylib + release profile tuned for WASM size;
│                    # depends on `pyde-host` (the canonical Rust SDK)
├── src/
│   └── lib.rs       # #![no_std] template with the macro substrate:
│                    # `pyde::declare_storage!()` emits typed storage accessors
│                    # from the [state] schema, `pyde::declare_events!()` emits
│                    # typed event structs from [events.*], `#[pyde::entry]`
│                    # wraps each user fn with the () -> () ABI shim. Authors
│                    # write idiomatic Rust against typed args + return values;
│                    # no hand-written `extern "C"` blocks or `*const u8`
│                    # buffer staging.
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

The scaffold pins `runtime: "minimal"` in `asconfig.json` so the resulting WASM imports nothing outside `pyde`. Anything else would fail the chain's import allowlist.

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

Authors keep their full language toolchain (build errors, IDE integration, dependency management, test runners, fuzzers, profilers, everything). The chain-specific concerns (ABI generation, deploy packaging, on-chain lifecycle) are owned by `otigen`. The interface between them is the `.wasm` file + the `otigen.toml` schema; both are inspectable, neither is generated by the other.

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

Exit codes: `0` on success, `1` on validation failure (with a structured error listing every violation), `2` if the `.wasm` was not found at the expected path. No partial bundles are ever written. The bundle dir is created last, after every validation has passed.

### How Rust authors do state access (macro substrate)

The Rust scaffold ships a thin SDK (`pyde-host` + the `#[pyde::entry]` macro + `pyde::declare_storage!()` + `pyde::declare_events!()`) that hides the WASM ABI entirely. Authors declare a typed state schema once and call generated module-path functions; the macros emit the void-void entry shim (`HOST_FN_ABI §3.5.2`), unpack borsh calldata into typed arguments, derive `Poseidon2(self_address ‖ field [‖ keys])` slots, and call the chain's `sstore_scalar` / `sload_scalar` / `sstore_map<N>` / `sload_map<N>` host fns.

```rust
// src/lib.rs — Rust macro substrate.
#![no_std]
use pyde::Address;

pyde::declare_storage! {
    [state]
    total_supply: u128,
    balances: mapping(Address => u128),
}

pyde::declare_events! {
    Transfer { from: Address, to: Address, amount: u128 }
}

#[pyde::entry]
fn transfer(to: Address, amount: u128) {
    let from = pyde::caller();
    let from_bal = storage::balances().get(&from);
    if from_bal < amount { pyde::revert("transfer: insufficient balance"); }
    storage::balances().set(&from, from_bal - amount);
    storage::balances().set(&to, storage::balances().get(&to) + amount);
    events::Transfer { from, to, amount }.emit();
}
```

The matching `otigen.toml` declares the same schema (canonical form or Solidity-style sugar):

```toml
[state.fields]
total_supply = "uint128"
balances     = "mapping(address => uint128)"

[functions.transfer]
attributes = ["entry"]
inputs     = ["address", "uint128"]
```

The `#[pyde::entry]` macro generates the void-void shim that reads the borsh-encoded calldata via `pyde::calldata_size` + `pyde::calldata_copy`, decodes each declared input, calls the typed `transfer` body, and (if the function returns a value) writes the encoded bytes via `pyde::return`. There is no hand-rolled FFI; `otigen build`'s spec-entry check (HOST_FN_ABI §3.5.2) passes automatically.

### Non-Rust languages

The other three languages (TinyGo, AssemblyScript, C) don't ship a Pyde-supplied SDK. Authors declare a void-void exported entry, read calldata via `pyde::calldata_*` host fns, and call host functions directly through the language's FFI mechanism (`//go:wasmimport`, `@external`, `__attribute__((import_module))`). The canonical reference patterns live in [`pyde-net/otigen/examples/counter-{go,as,c}/`](https://github.com/pyde-net/otigen/tree/main/examples). The WASM_AUTHOR_GUIDE companion doc walks the per-language details.

---

## 5.6 Safety Attributes via otigen.toml

Otigen the language had a set of compiler attributes that made common safety properties default and explicit. **Every one of those properties carries forward unchanged in the WASM era.** Authors declare them in `otigen.toml` `[functions.<name>] attributes = [...]`; `otigen build` includes them in the generated ABI; the runtime enforces them by reading the ABI before invocation and applying the appropriate guards.

The mechanism changed (config-declared metadata enforced at the call boundary instead of compiler-extracted markers in bytecode), but the safety guarantees are identical to the Otigen-language era.

### Reentrancy is still blocked by default

This is the most important property to preserve. Every public function gets an automatically generated reentrancy guard. To **opt OUT** of the guard (for a function that genuinely needs to allow re-entry), add the `#[reentrant]` attribute.

If you write nothing, you are protected.

### The attribute set

| Attribute     | Effect                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------- |
| `view`        | Read-only function. Runtime rejects any state-modifying host call inside it. View calls are FREE (no gas); see [HOST_FN_ABI_SPEC §7.8](../companion/HOST_FN_ABI_SPEC.md). |
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

The author writes the corresponding WASM exports in their language as a void-void function (HOST_FN_ABI §3.5.2). In Rust, the `#[pyde::entry] fn balance(owner: Address) -> u128` macro emits the void-void shim. In AssemblyScript, `export function balance(): void`. In Go (TinyGo), `//go:wasmexport balance` on a `func balance()`. In C, `__attribute__((export_name("balance"))) void balance(void)`. Standard WASM-export idioms for each language; the void-void contract is non-negotiable: `otigen build`'s entry-shape validator rejects any non-void-void export declared in `[functions.<name>]`.

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
| Compile-time access lists           | Build tool emits a static access list per function from the declared state schema; these serve as prefetch hints to warm the cache, improving performance but never affecting Block-STM correctness. |
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
2. `otigen` loads the bundle (manifest.json + otigen.toml + contract.wasm) and re-validates WASM + ABI consistency: defense in depth even though the bundle came from `otigen build`.
3. `otigen` resolves the network from `--network` or `[network.default.name]` and the signer wallet from `--from` or `[wallet.default_account]`. Prompts for the wallet password (no echo).
4. `otigen` fetches the sender's nonce via `pyde_getTransactionCount`.
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

1. `otigen` resolves `<target>`: `0x`-prefixed address or registered name (auto-resolved via `pyde_resolveName`).
2. `otigen` reads the new wasm from `--wasm <file>` or `<bundle>/contract.wasm`.
3. Same signing pipeline as deploy, but the wire shape is `Tx { tx_type: Standard, to: <target>, data: borsh(LifecyclePayload::Upgrade { new_wasm }) }`. The chain decodes the payload, re-runs ABI validation against the new bytes, stores the new code, and bumps `current_version`.

For parachain upgrades, the chain requires equal-power validator-quorum certs collected separately per [PARACHAIN_DESIGN §6.2](../companion/PARACHAIN_DESIGN.md). The CLI flow for parachain governance (`--parachain` / `--finalize <proposal-id>`) is deferred to the parachain rollout post-mainnet.

---

## 5.8 Wallet Management

The wallet is built into the `otigen` binary directly: no separate wallet daemon, no external dependency, no extra install step. The cryptographic primitives (FALCON-512 keypair generation, AES-256-GCM keystore encryption, Argon2id key derivation, in-memory key unlock with zeroize-on-drop) carry forward from the archived `wright` toolchain; the on-disk format was redesigned for the WASM era to match spec §7.1.

### Subcommand surface

```bash
otigen wallet new <name>
    # Generate a new FALCON-512 keypair. Prompts for a password (twice).
    # Adds the encrypted keypair to ~/.pyde/keystore.json under <name>.

otigen wallet import <name> --from-file <path>
otigen wallet import --from-devnet
    # Two modes: --from-file restores a previously-exported encrypted backup;
    # --from-devnet bulk-imports the 10 deterministic prefunded devnet
    # accounts (`Blake3("pyde-devnet-v1/" || i)`) — no network call.

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

otigen wallet export <name> --out <path>
    # Emit an encrypted backup blob for migration / cold storage.

otigen wallet sign <name> --message <msg>
    # Off-chain FALCON-512 signature over arbitrary bytes (NOT chain txs).

otigen wallet verify [name] --message <msg> --signature <hex>
    # Verify a FALCON-512 signature against a message and either a named
    # account's pubkey or `--pubkey <hex>` directly.
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

Only one wallet operation from spec §3.7 is deferred:

- `rotate <name>`: submits a chain-side `KeyRotationTx` so an existing account can move to a fresh FALCON keypair without changing its address. Distinct from `password` (which only re-encrypts the local keystore entry). Blocked on the engine accepting the `KeyRotationTx` variant.

Hardware-wallet bridges and HSM-backed signing (spec §7.4) are post-mainnet; no FALCON-aware hardware wallets exist yet.

---

## 5.9 The Console

`otigen console` is an interactive REPL against a Pyde node: the natural shape for exploration and ad-hoc debugging once a contract is deployed and you want to poke at it without re-typing connection info on every command.

Pair it with `pyde devnet` for the canonical local loop: one terminal runs the devnet, another runs `otigen console` against it. Session-scoped `--network` + `--from` bind once at startup so every command in the session reuses the same RPC URL + sender; wallet unlock is lazy (view-only commands never prompt, first `tx` asks for the password once).

### Shipping commands

| Command | What it does |
|---|---|
| `help` | Lists the full command catalog with one-line descriptions. |
| `balance <addr>` | Calls `pyde_getBalance`; renders raw quanta + pretty-printed PYDE. |
| `nonce <addr>` | Calls `pyde_getTransactionCount`; shows the next-acceptable nonce. |
| `call <addr> <fn> [hex]` | View-mode `pyde_call`: free, no nonce, no receipt. Returns the contract's `return_data` bytes; `--json` mode surfaces it on the `call_included` event. |
| `tx <addr> <fn> [hex] [--value <decimal>]` | Builds a `Standard` tx, FALCON-signs it, submits via `pyde_sendRawTransaction`, polls the receipt. |
| `state <addr> <field>` | Reads a substrate-typed scalar storage field: derives the slot `Poseidon2(self_address ‖ field_name)` (the chain's `sstore_scalar` convention), pulls the bytes, decodes per the type token in `[state].schema`. Map fields print a clear "scalar-only MVP scope" message rather than truncating. |
| `exit` / `quit` | Leaves the REPL with status 0. |

Address arguments accept either `0x`-hex or a registered name (when [`pyde_resolveName`](../companion/HOST_FN_ABI_SPEC.md) lands; today only hex resolves).

### How `state` compares to `inspect --state-field`

Both use the same Poseidon2 slot derivation and the same primitive-type decoder. The difference is the workflow:

- `inspect --state-field` is the **scriptable** path: one-shot, `--json`-able, designed for CI / deploy scripts that want to assert a single value after a deploy.
- `console state` is the **interactive** path: drop into a REPL, poke at multiple fields across multiple contracts without re-typing the RPC URL or sender, exit when you're done.

Implementation lives in a single `otigen-cli::state_decode` module both surfaces consume, so the decoder vocabulary stays in lockstep.

### History and editing

Line-edited via [rustyline](https://docs.rs/rustyline) with persisted history at `~/.otigen_console_history`. Up-arrow recalls prior commands across sessions.

### Deferred surface

Two REPL commands are reserved by spec but blocked on engine work:

- `events <addr> [--from N] [--to N]`: historical event-log query. Needs `pyde_getLogs` (filtered + cursor-paginated). Ask filed.
- `subscribe <addr>`: live event tail. Needs both `pyde_getLogs` and a websocket transport on the devnet.

Both will land in a follow-up once the chain-side methods ship.

---

## 5.10 What the Toolchain Does NOT Do

Deliberately omitted:

- **Language-native unit-test runner**: use `cargo test` / `npm test` / `go test` / the author's C test harness for pure-helper unit tests. `otigen test` covers contract behaviour (state changes, events, reverts), not language-internal function testing. The two layers are complementary, not overlapping (§5.1, [OTIGEN_TEST_SPEC](../companion/OTIGEN_TEST_SPEC.md)).
- **Linter / formatter**: use the language's native tooling (`rustfmt`, `prettier`, `gofmt`, `clang-format`).
- **IDE integration**: uses the language's standard LSP; no Otigen-specific IDE extension required.
- **Documentation generator**: use the language's standard (`rustdoc`, `typedoc`, etc.).
- **Dependency manager**: use the language's standard (`cargo`, `npm`, `go mod`, etc.).
- **Custom syntax**: there is none; the contract is whatever the language allows.

The toolchain wraps deployment-specific concerns + the chain-aware behaviour-test layer. Everything else stays in the language ecosystems the authors already know.

---

## 5.11 Performance

The whole toolchain side of the pipeline (parse `otigen.toml`, validate every cross-cutting rule, walk the compiled `.wasm` for imports + exports + deterministic-feature compliance, build the canonical `ContractAbi`, Borsh-encode it, inject the `pyde.abi` custom section) measures in **single-digit microseconds end-to-end**. Validation work is essentially free against the file-system overhead of reading the `.wasm` and writing the four bundle files; a typical `otigen build` invocation is dominated by I/O (~1 to 5 ms in practice), not by validator CPU.

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

The benches are intentionally tight scope: they measure the toolchain-side work, not the chain-side deploy validator (which redoes every check at deploy time per `HOST_FN_ABI_SPEC.md` §3.7 layer 3) and not the wasmtime AOT compilation step (which happens on the chain at first invocation of a deployed contract, not at `otigen build` time).

---

## 5.12 Contract Behaviour Tests (`otigen test`)

The toolchain ships a TOML-driven contract test runner. Authors write `tests/<name>.test.toml`, run `otigen test`, and get pass / fail per scenario: the same workflow Foundry users know from `forge test`, adapted to Pyde's host-function surface.

The full schema, name-resolution rules, cheatcode catalogue, mock host-function behaviour, and limitations are documented in [`OTIGEN_TEST_SPEC.md`](../companion/OTIGEN_TEST_SPEC.md). The short overview:

### What gets tested

- **State changes**: assert balances / counters / mappings after a call sequence.
- **Return values**: assert a function returned the expected scalar.
- **Events**: assert `Transfer(from, to, amount)` (or any declared event) emitted with the right indexed + non-indexed fields.
- **Reverts**: assert a call traps with a reason substring (`"InsufficientBalance"`).
- **Multi-step scenarios**: assert "alice transfers to bob, then bob transfers to carol; final state is …" across multiple calls in one test.
- **Time / wave / chain conditions**: cheatcode `now`, `wave_id`, `chain_id` per test.

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

Named accounts resolve to 32-byte addresses via the chain's name registry; storage field names resolve to Poseidon2 slots (`Poseidon2(self_address ‖ field_name ‖ keys...)`) per the contract's `[state]` schema. Authors never type slot hashes by hand.

### How it runs

`otigen test` discovers `tests/*.test.toml`, spins up a wasmtime engine, loads the contract's `.wasm` from `./artifacts/<name>.bundle/contract.wasm`, and executes each test against a fresh `TestEnv` that mocks every `pyde::*` host function:

- Real `hash_poseidon2` / `hash_blake3` / `falcon_verify` (via `pyde-crypto`) so author-side slot derivation + signature verification match the runner exactly.
- Mock storage (`sload` / `sstore` / `sdelete`), account (`balance` / `transfer`), context (`caller` / `self_address` / `wave_id` / `wave_timestamp` / `chain_id`), tx (`tx_value`), events (`emit_event`), halt (`revert`), cross-call (`cross_call` / `delegate_call`), and parachain §8 host fns (`parachain_storage_{read,write,delete}` / `parachain_id` / `parachain_version` / `parachain_emit_event`) against an in-memory state map.
- Test-only `pyde::debug_log` printf-style host fn captured in the call's debug log buffer; rejected by `otigen build` (strict is the default) and always rejected by `otigen deploy`. Use `otigen build --no-strict` for local inspection only.
- Host fns that trap with `UnsupportedHostFn` in v1: `origin`, `tx_hash`, `tx_gas_remaining`, `calldata_size`, `calldata_copy`, `hash_keccak256`, `cross_call_static`, `consume_gas`, `beacon_get`, plus the reserved `threshold_encrypt` / `threshold_decrypt` surface (not in v1; a v2+ research direction; see [Chapter 20](./20-future-direction.md)). Each either depends on chain-derived state the runner doesn't model, or no canonical example exercises it yet.

### What it doesn't do (v1)

- No parallel-execution simulation; calls run sequentially.
- No fuzzing / property tests; example-based only (reserved for a future polish item).
- No multi-tx context: each test starts from fresh state; "deploy in tx1, then call from a different sender in tx2 within one test" isn't expressible (use `otigen devnet` + `otigen call` for multi-tx flows).
- No simulating chain-side validators (mempool, access-list, nonce window): those run on a real node; pair with `otigen deploy --network devnet` for end-to-end verification.

Every limitation has a future-phase plan in `OTIGEN_TEST_SPEC.md` §9. The v1 surface is deliberately scoped to what most contract authors need on day one (behaviour, state, events, reverts, gas tracking, cross-contract, FALCON sigs, schema-aware typed args, parachain extension surface) without buying the complexity of fuzz / multi-tx orchestration up front.

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

- [Chapter 3: Execution Layer](./03-virtual-machine.md), the runtime that contracts compile into.
- [Chapter 4: State Model](./04-state-model.md), what `sload` and `sstore` see.
- [Chapter 11: Account Model](./11-account-model.md), the ENS-style name registry that the toolchain registers against.
- [Chapter 13: Cross-Chain (Parachains)](./13-cross-chain.md), parachain-specific deploy and upgrade flows.
- [`HOST_FN_ABI_SPEC.md`](../companion/HOST_FN_ABI_SPEC.md): the locked binary contract between WASM modules and the engine; every imported function the toolchain accepts is in its allowlist.
- [`OTIGEN_BINARY_SPEC.md`](../companion/OTIGEN_BINARY_SPEC.md): the canonical specification for this binary. Every subcommand, flag, `otigen.toml` schema rule, bundle format, exit code, and validation pass is defined there. If the implementation and the spec disagree, the spec is right and the code is a bug.
- [`OTIGEN_TEST_SPEC.md`](../companion/OTIGEN_TEST_SPEC.md): the canonical specification for `otigen test`: TOML schema, name resolution, cheatcode catalogue, mock host functions, limitations.
