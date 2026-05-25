# Pyde Otigen Toolchain Binary Specification

**Version:** v1.0 (draft)
**Status:** Authoritative for v1 mainnet. Subject to revision until mainnet genesis; frozen at v1 launch and only extended in backwards-compatible ways thereafter.

This document is the canonical specification of the **`otigen` developer toolchain binary** — the command-line program contract authors use to scaffold projects, drive language-specific builds, validate against the chain ABI, sign and submit deploys, manage wallets, and interact with running networks.

Where [`HOST_FN_ABI_SPEC.md`](./HOST_FN_ABI_SPEC.md) defines the binary surface between the WASM execution layer and contract code, this document defines the surface between the *author* and the chain.

If the implementation and this document disagree, **this document is authoritative**. Implementation bugs are bugs in `otigen`, not in the spec.

For the narrative overview, see [Chapter 5 — Otigen Toolchain](../chapters/05-otigen-toolchain.md).

---

## 1. Scope

This spec defines:

- The **subcommand catalog** — every `otigen X Y Z` command, its flags, semantics, and exit codes
- The **`otigen.toml` schema** — every key, type, default, and validation rule
- The **per-language build pipeline** — exactly how `otigen` invokes Rust / AssemblyScript / Go / C compilers
- The **`pyde.abi` custom-section injection** — how `otigen` integrates ABI metadata into the WASM output
- The **wallet integration** — keystore format, FALCON signing pipeline, key rotation
- The **deploy / upgrade / lifecycle flow** — what transactions `otigen` submits and how
- The **artifact format** — the deploy bundle structure (`.wasm` + manifest)
- The **network configuration** — RPC endpoints, chain IDs, default gas
- The **CI / scripting interface** — JSON output mode, exit codes
- The **versioning rules** — `otigen` binary version vs chain ABI version compatibility

This spec does **not** define:

- The Host Function ABI (see [HOST_FN_ABI_SPEC.md](./HOST_FN_ABI_SPEC.md))
- Language compiler internals (those belong to upstream — rustc, asc, TinyGo, clang)
- The chain's transaction wire format (see [Chapter 11 — Account Model](../chapters/11-account-model.md))
- Per-language SDKs — `otigen` is not an SDK; it's a build harness (see [PARACHAIN_DESIGN §10](./PARACHAIN_DESIGN.md) for the no-SDK rationale)

---

## 2. What `otigen` is and isn't

**Is:**

- A *build harness*: it invokes the language compiler the author already has installed, then post-processes the output WASM.
- A *deploy client*: it signs, submits, and tracks lifecycle transactions against a Pyde network.
- A *wallet*: it manages FALCON-512 keypairs in an encrypted keystore.
- A *REPL*: it offers an interactive shell for querying state, calling contracts, and debugging.
- A *contract-behaviour test runner*: `otigen test` executes WASM in a wasmtime sandbox against a TOML-driven test spec, with mock implementations of every host function (see [OTIGEN_TEST_SPEC](./OTIGEN_TEST_SPEC.md)).

**Is NOT:**

- A *language compiler*. `otigen` does not parse Rust / AssemblyScript / Go / C. It calls the language's own compiler.
- A *language-specific SDK*. There are no first-party Rust, TypeScript, AssemblyScript, etc. bindings shipped by `otigen`. Author writes `extern` declarations against the [Host Function ABI](./HOST_FN_ABI_SPEC.md) themselves; canonical example projects show the idiom.
- An *IDE*. Authors use their language's standard IDE tooling (rust-analyzer, AssemblyScript LSP, gopls, clangd). `otigen` is invoked from the command line or from a project's `npm run` / `cargo run` script.
- A *language-native unit-test runner*. `cargo test` / `npm test` / `go test` are still the right choice for pure helpers (math, parsing, formatting). `otigen test` complements them at the behaviour-and-state-changes layer, not the function-internals layer.

---

## 3. Subcommand catalog

`otigen <subcommand> [subsubcommand] [args] [flags]`

All subcommands accept the global flags:

| Flag | Effect |
|---|---|
| `-v, --verbose` | Verbose logging (also `-vv` for debug) |
| `-q, --quiet` | Suppress non-error output |
| `--json` | Output structured JSON (for CI / scripting) |
| `--network <name>` | Override the default network (default: read from `otigen.toml` → `[network.default]`) |
| `--keystore <path>` | Override the default keystore location (default: `~/.pyde/keystore.json`) |
| `--config <path>` | Override the default config path (default: `./otigen.toml`) |
| `-h, --help` | Show subcommand help |

### 3.1 `otigen init`

Scaffold a new project from a language template.

```
otigen init <name> --lang <rust|as|go|c> [--type <contract|parachain>] [--dir <path>]
```

| Arg | Required | Description |
|---|---|---|
| `<name>` | yes | Project name. Used for the contract/parachain identity and the directory. |
| `--lang` | yes | Target language: `rust`, `as` (AssemblyScript), `go` (TinyGo), or `c` (clang/wasm32). |
| `--type` | no | `contract` (default) or `parachain`. Selects the appropriate scaffold. |
| `--dir` | no | Target directory (default: `./<name>`). |

Side effects:

1. Creates `<dir>/`.
2. Writes `<dir>/otigen.toml` from the language template (see §4 for schema).
3. Writes `<dir>/src/` containing a hello-world contract with `extern "C"` declarations for one host function and one exported function.
4. Writes language-specific config (e.g., `Cargo.toml` for Rust, `package.json` for AS, `go.mod` for Go).
5. Writes `.gitignore` excluding `target/`, `node_modules/`, `build/`.

Exit codes: `0` on success, `1` if `<dir>` already exists, `2` if the language is unknown.

### 3.2 `otigen build`

Verify + package. By default does **not** invoke the language compiler — that is the author's responsibility (run `cargo build` first, etc.). The opt-in `--compile` flag inverts this: it runs the per-language default build command first, then proceeds with the same verify + package pipeline. Both paths produce byte-identical bundles when the inputs are equivalent — `--compile` is a UX convenience, not a different build.

```
otigen build [--release|--debug] [--compile] [--out <path>]
```

| Flag | Default | Description |
|---|---|---|
| `--release` | (default) | Validate against release-build expectations |
| `--debug` | off | Allow debug-build artifacts (useful for local dev) |
| `--compile` | off | Invoke the per-language build command first. Dispatch table: `rust` → `cargo build --target wasm32-unknown-unknown --release`, `as` → `npm install && npm run build`, `go` → `tinygo build -target=wasi -o <output> .`, `c` → `make`. Only the default invocation per language; authors with custom build flags continue to compile manually and run `otigen build` afterwards. After the compiler exits, otigen discovers the actual emit path from each language's native config (`Cargo.toml`'s `[package].name` for Rust, `asconfig.json`'s `targets.release.outFile` for AssemblyScript; Go uses our `-o` flag, C uses the Makefile-declared path) and copies the `.wasm` to `[contract.lang.output]` if they differ, with a `Reconciling emit path` notice. Discovery falls back to `[contract.lang.output]` on workspace `Cargo.toml`, missing / malformed configs, or features we don't parse (JSON5 in asconfig). Error codes: `ToolchainMissing` when the compiler isn't on `PATH`; resource failure on non-zero compiler exit; `CompileOutputMissing` when the compiler exited 0 but emitted nowhere we can find. |
| `--out` | `./artifacts/` | Output directory for the deploy bundle |

Pipeline:

1. **Read** `otigen.toml`. Validate schema (§4). Validate attribute combinations per [HOST_FN_ABI_SPEC §3.5.1](./HOST_FN_ABI_SPEC.md).
2. **Locate** the compiled `.wasm` at the path declared in `[contract.lang.output]`.
3. **Validate** the WASM:
   - Well-formed binary (passes `wasmparser` round-trip).
   - Every WASM import declares module `pyde` (no `env`, no `wasi:*`).
   - Every imported function name is in the [HOST_FN_ABI_SPEC](./HOST_FN_ABI_SPEC.md) allowlist (and for non-parachain types, no parachain-only fn imports).
   - Every function declared in `[functions.X]` has a matching WASM export.
   - Every WASM export (other than internal helpers) is declared in `[functions.X]`.
   - WASM features used are in the deterministic subset (no threads, no SIMD, etc.).
4. **Static call-graph view check.** For each `view` function, build the transitive call graph from its body. If any reachable function imports `pyde::sstore` / `sdelete` / `transfer` / `emit_event` / `parachain_storage_write` / `parachain_storage_delete` / `parachain_emit_event`, reject with `BuildRejected: ViewMutatesState(<fn_name>, <mutating_import>)`.
5. **Build `ContractAbi` struct** from `otigen.toml`:
   - For each `[functions.X]`: extract attributes, compute selector = `Blake3(fn_name)[..4]`, copy access list.
   - For each `[events.X]`: extract field list, compute `topic_signature_hash = Blake3(canonical_signature)`, mark indexed fields.
   - Compute `state_schema_hash = Blake3(canonical_state_schema_bytes)`.
6. **Borsh-encode** the `ContractAbi`.
7. **Inject** the encoded ABI as a WASM custom section named `pyde.abi`, using the `wasm-encoder` Rust crate. The code section is untouched.
8. **Write** the bundle to `<out>/<contract_name>.bundle/`:
   - `contract.wasm` (with the `pyde.abi` custom section embedded)
   - `otigen.toml` (verbatim copy)
   - `abi.json` (human-readable mirror of the ABI for tooling)
   - `manifest.json` (hashes, build timestamp, otigen version, target network)

Exit codes: `0` on success, `1` on validation failure, `2` if the `.wasm` was not found at the expected path.

### 3.3 `otigen deploy`

Sign and submit a deploy transaction.

```
otigen deploy [--network <name>] [--from <addr-or-keyname>] [--bundle <path>] [--dry-run]
```

| Flag | Default | Description |
|---|---|---|
| `--network` | from `otigen.toml` | Target network |
| `--from` | from `otigen.toml` | Deploying address or named key |
| `--bundle` | `./artifacts/<name>.bundle/` | Path to the deploy bundle |
| `--dry-run` | off | Validate + simulate only; do not submit |

Pipeline:

1. Load bundle. Re-validate WASM + ABI consistency (defense in depth).
2. Construct a `DeployTx`:
   ```
   DeployTx {
       sender,
       name,                  // contract/parachain name
       wasm_bytes,            // the .wasm with embedded pyde.abi
       contract_type,         // Contract or Parachain
       initial_state_input,   // calldata for the constructor (if any)
       nonce,
       gas_limit,
       gas_price,
   }
   ```
3. Compute canonical tx hash. FALCON-sign with the sender's key (prompts for keystore password unless cached).
4. Submit via `pyde_sendRawTransaction`. Print the tx hash.
5. (Optional) Wait for inclusion: poll `pyde_getTransactionReceipt` until included. Report success / revert.

Exit codes: `0` on inclusion + success, `1` on validation failure, `2` on network error, `3` on revert.

### 3.4 `otigen upgrade`

Replace a contract's WASM via the upgrade flow.

```
otigen upgrade <name-or-address> [--network <name>] [--bundle <path>]
```

For contracts: submits an `UpgradeContractTx` signed by the contract owner.

For parachains: requires governance certs collected separately (per [PARACHAIN_DESIGN §6.2](./PARACHAIN_DESIGN.md)). `otigen upgrade --parachain` runs the full vote flow if `[parachain.governance.auto_collect]` is true; otherwise the author submits the proposal, gathers votes externally, and runs `otigen upgrade --finalize <proposal-id>` to submit the activation tx.

### 3.5 `otigen pause` / `otigen unpause` / `otigen kill`

Operational lifecycle.

```
otigen pause   <name-or-address> [--from <key>]
otigen unpause <name-or-address> [--from <key>]
otigen kill    <name-or-address> [--from <key>] [--yes]
```

- `pause`: owner-only. Submits `PauseContractTx`. Reversible.
- `unpause`: owner-only. Submits `UnpauseContractTx`.
- `kill`: owner-only, irreversible. Requires `--yes` to confirm. Submits `KillContractTx`.

### 3.6 `otigen inspect`

Read contract / parachain state and metadata.

```
otigen inspect <name-or-address> [--at-wave <wave_id>] [--field <name>]
```

Outputs:

- Contract type, name, owner, current version, total versions
- ABI summary (functions, events, state schema)
- Code hash, WASM size, deployment wave
- If `--field <name>` is given: the current value of that storage field (uses ABI for type-safe decoding)
- If `--at-wave` is given: state as of that historical wave (archive nodes only)

### 3.7 `otigen wallet`

Wallet subcommands.

```
otigen wallet new [--name <label>]              # generate a new FALCON keypair
otigen wallet list                               # list keys in keystore
otigen wallet show <name>                        # show address + public-key fingerprint
otigen wallet rotate <name>                      # initiate key rotation (submits KeyRotationTx)
otigen wallet import <path>                      # import an external keystore entry
otigen wallet export <name>                      # export a keystore entry (prompts for password)
otigen wallet password <name>                    # change a keystore entry's password
otigen wallet sign <name> <hex-message>          # sign arbitrary bytes (for advanced use)
```

Keystore format: see §6.

### 3.8 `otigen console`

Interactive REPL against a Pyde node.

```
otigen console [--network <name>] [--from <key>]
```

REPL commands:
- `call <addr> <fn> <args...>` — invoke a view function (free, off-chain)
- `tx <addr> <fn> <args...>` — submit a state-changing tx
- `events <addr> [--topic <hash>] [--from <wave>]` — query event history
- `balance <addr>` — query balance
- `state <addr> <field>` — query a state field (type-safe via ABI)
- `subscribe <addr> --logs --topic <hash>` — open a live event subscription
- `help`, `exit`

The console caches the contract ABI on first contact so subsequent calls are type-checked locally.

### 3.9 `otigen verify`

Verify that a published contract's bundled artifact matches its on-chain deployment.

```
otigen verify <name-or-address> [--bundle <path>]
```

Compares the local bundle's WASM bytes against the chain's stored bytes. Useful for confirming reproducible builds: if two builders run `otigen build` from the same source and toolchain versions, they should produce byte-identical bundles.

Exit codes: `0` on match, `1` on mismatch (with a diff summary).

### 3.10 `otigen test`

Run contract behaviour tests declared in TOML against the built `.wasm`.

```
otigen test [--filter <pattern>] [--bundle <path>] [--no-color] [--show-output]
```

| Flag | Default | Description |
|---|---|---|
| `--filter <pattern>` | none | Run only tests whose name contains the pattern (substring). Multiple `--filter` flags OR together. |
| `--bundle <path>` | `./artifacts/<name>.bundle/` | Bundle whose `contract.wasm` is executed. |
| `--no-color` | off | Disable terminal colour escapes (CI logs). |
| `--show-output` | off | Print captured stdout / stderr per test (for mock-host debugging). |

Discovery order:
1. `tests/*.test.toml` (canonical)
2. `tests/*.toml`
3. `./contract.test.toml` (single-file projects)

Each file's `[[tests]]` array contributes to the total count. Tests run sequentially; each starts from a fresh `TestEnv` (no state leaks between cases). A wasmtime engine is created once per file.

Per-test pipeline:

1. Apply `[cheats]` (and per-test `[tests.cheats]` overrides).
2. Resolve account names → 32-byte Blake3 addresses; resolve storage field names → Poseidon2 slot hashes per the contract's `[state]` schema + PIP-2.
3. Pre-populate storage from `[tests.setup].storage`.
4. Record start time.
5. For each `[[tests.calls]]` entry: parse args, invoke the WASM export, capture the return value + emitted events + revert reason. On trap, roll back the per-call state overlay. Check per-call `expect`.
6. After the call sequence, check `[tests.expect]` (final-state assertions).
7. Record end time; compute `duration_ms`.
8. Emit pass / fail (with `duration_ms` included in the NDJSON event under `--json`).

Mock host fns (v1) — canonical names per [`HOST_FN_ABI_SPEC §7`](./HOST_FN_ABI_SPEC.md):

- Storage: `sload`, `sstore`, `sdelete`
- Account & balance: `balance`, `transfer`
- Execution context: `caller`, `block_height`, `wave_id`, `block_timestamp`, `chain_id`
- Transaction context: `tx_value`
- Events + halt: `emit_event`, `revert`
- Hashing: `hash_poseidon2`, `hash_blake3`

Trap with `UnsupportedHostFn`: every other `pyde::*` import (DKG, parachain-only, cross-contract, `origin`, `self_address`, `tx_hash`, `tx_gas_remaining`, `calldata_size`, `calldata_copy`, `falcon_verify`, `beacon_get`, `hash_keccak256`, `consume_gas`, `cross_call*`, `delegate_call`, `return`). v2 expands.

Exit codes: `0` all-pass; `1` any failure; `2` resource failure (test file unreadable, bundle missing); `4` schema error (malformed TOML, reference to undeclared `[state]` field).

The full TOML schema, name resolution rules, cheatcode catalogue, mock host-function behaviour, and limitations are documented in [`OTIGEN_TEST_SPEC.md`](./OTIGEN_TEST_SPEC.md). That spec is authoritative.

---

## 4. `otigen.toml` schema

The canonical config file. Lives at the project root.

### 4.1 Top-level tables

```toml
[contract]
name        = "my-token"          # required; lowercase + hyphens (ENS-style; see §4.2)
version     = "1.0.0"             # required; semver
description = "Example token"     # optional
type        = "contract"          # "contract" (default) or "parachain"

[contract.lang]
language = "rust"                 # required; rust | as | go | c
output   = "target/wasm32-unknown-unknown/release/my_token.wasm"  # required; Rust crate name uses snake_case (cargo convention), so the .wasm filename uses underscores even though the Pyde contract name uses hyphens

[contract.lang.toolchain]
rust_channel   = "stable"         # for rust
rust_toolchain = "1.75.0"          # pinned toolchain
asc_version    = "0.27.0"          # for AS
tinygo_version = "0.30.0"          # for go
clang_version  = "17"              # for c

[deploy]
gas_limit  = 10_000_000           # default per-deploy gas budget
gas_price  = "auto"               # "auto" = use current base_fee; or fixed quanta
owner_deposit = 1000              # PYDE locked at deploy time (parachain only)

[wallet]
default_keystore = "~/.pyde/keystore.json"
default_account  = "deployer"     # name of the keystore entry to use by default

[network.default]
name = "testnet"

[network.mainnet]
rpc_url      = "https://rpc.pyde.network"
chain_id     = 1
explorer_url = "https://explorer.pyde.network"

[network.testnet]
rpc_url      = "https://rpc-testnet.pyde.network"
chain_id     = 2
explorer_url = "https://explorer-testnet.pyde.network"

[network.devnet]
rpc_url      = "http://localhost:9933"
chain_id     = 31337

[state]
# State schema; each entry declares a top-level state field name and its type.
schema = [
    { name = "owner",         type = "address" },
    { name = "total_supply",  type = "uint128" },
    { name = "balances",      type = "mapping(address -> uint128)" },
]

[functions.transfer]
attributes = ["entry", "payable"]
inputs     = ["address", "uint128"]
outputs    = ["bool"]
access_list = [
    "balances[caller()]",       # informational; runtime computes hashes
    "balances[args.0]",
]

[functions.balance_of]
attributes = ["entry", "view"]
inputs     = ["address"]
outputs    = ["uint128"]
access_list = ["balances[args.0]"]

[functions.init]
attributes = ["constructor"]
inputs     = ["uint128"]

[events.Transfer]
signature = "Transfer(address,address,uint128)"
fields = [
    { name = "from",   type = "address",  indexed = true },
    { name = "to",     type = "address",  indexed = true },
    { name = "amount", type = "uint128" },
]

[events.Approval]
signature = "Approval(address,address,uint128)"
fields = [
    { name = "owner",   type = "address",  indexed = true },
    { name = "spender", type = "address",  indexed = true },
    { name = "amount",  type = "uint128" },
]
```

### 4.2 `[contract]` keys

| Key | Type | Required | Default | Validation |
|---|---|---|---|---|
| `name` | string | ✅ | — | 1-32 chars, lowercase alphanumeric + `-`; matches ENS-style naming (see [Chapter 11](../chapters/11-account-model.md)) |
| `version` | string | ✅ | — | semver |
| `description` | string | ❌ | empty | ≤ 200 chars |
| `type` | enum | ❌ | `"contract"` | `"contract"` or `"parachain"` |

### 4.3 `[contract.lang]` keys

| Key | Type | Required | Default | Notes |
|---|---|---|---|---|
| `language` | enum | ✅ | — | `"rust"`, `"as"`, `"go"`, `"c"` |
| `output` | path | ✅ | — | Path (relative to project root) where the language compiler writes the `.wasm` |

The `[contract.lang.toolchain]` subtable holds language-specific version pins. `otigen build` does not invoke the compiler — it only validates that the output `.wasm` exists. But it records the declared toolchain in the bundle manifest for reproducibility.

### 4.4 `[functions.<name>]` keys

| Key | Type | Required | Default | Validation |
|---|---|---|---|---|
| `attributes` | array of strings | ✅ | — | Any subset of `view`, `payable`, `reentrant`, `sponsored`, `constructor`, `fallback`, `receive`, `entry`. Subject to compatibility rules per [HOST_FN_ABI_SPEC §3.5.1](./HOST_FN_ABI_SPEC.md) |
| `inputs` | array of strings | ❌ | `[]` | Parameter types in declaration order |
| `outputs` | array of strings | ❌ | `[]` | Return types in declaration order |
| `access_list` | array of strings | ❌ | `[]` | Informational state slot patterns; the runtime computes the actual hashes |

A function declared in `[functions.X]` must have a matching WASM export named `X`. The reverse must also hold (no orphan exports), unless the export name starts with `_` (internal helper convention).

### 4.5 `[events.<name>]` keys

| Key | Type | Required | Default | Notes |
|---|---|---|---|---|
| `signature` | string | ✅ | — | Canonical signature string (Solidity-style), e.g. `"Transfer(address,address,uint128)"`. Must match the field types in declaration order. |
| `fields` | array of tables | ✅ | — | Field metadata (name, type, indexed flag). See [HOST_FN_ABI_SPEC §14.1](./HOST_FN_ABI_SPEC.md). |

Each field entry:

| Key | Type | Required | Default |
|---|---|---|---|
| `name` | string | ✅ | — |
| `type` | string | ✅ | — |
| `indexed` | bool | ❌ | `false` |

Rules (validated at `otigen build`):
- **Up to 3 fields can be `indexed`** (so total topics, including `topic[0]` = signature hash, ≤ 4 — matches EVM LOG4).
- The `signature` string must, when parsed, yield exactly the field types in order. `otigen build` cross-checks.
- Event names are unique within a contract.

### 4.6 `[state]` table

Declares the contract's storage schema. The toolchain doesn't generate accessor code (that's the author's job per the [no-SDK approach](./PARACHAIN_DESIGN.md)) — but the schema is embedded in the bundle and used for type-safe inspection (`otigen inspect --field`), for explorer UI rendering, and for the `state_schema_hash` value in the deployed ABI.

`schema` is an ordered array of `{ name, type }` entries. Types follow the Solidity-token convention used in event signatures (§4.5).

### 4.7 `[deploy]` table

| Key | Type | Default | Notes |
|---|---|---|---|
| `gas_limit` | u64 | 10_000_000 | Default gas budget for deploy/upgrade txs |
| `gas_price` | string or u128 | `"auto"` | `"auto"` reads chain's current base_fee; explicit value is in quanta per gas |
| `owner_deposit` | u128 | 0 | PYDE locked at deploy (parachain only; refunded on `kill`) |

### 4.8 `[wallet]` table

| Key | Type | Default |
|---|---|---|
| `default_keystore` | path | `~/.pyde/keystore.json` |
| `default_account` | string | — |

### 4.9 `[network.X]` tables

Multiple networks can be declared. `[network.default]` names which is used when `--network` is not specified.

| Key | Type | Required | Notes |
|---|---|---|---|
| `rpc_url` | URL | ✅ | JSON-RPC endpoint |
| `chain_id` | u64 | ✅ | Per the [HOST_FN_ABI_SPEC](./HOST_FN_ABI_SPEC.md) chain_id table |
| `explorer_url` | URL | ❌ | For convenient link generation in console output |

`[network.default]` has only a `name` field that selects one of the other `[network.*]` tables as the default.

### 4.10 `[parachain]` table (parachain only)

For `type = "parachain"`:

```toml
[parachain]
consensus_preset = "simple_bft"   # or "threshold" or "optimistic"
min_validators   = 7
quorum_threshold = "2/3"

[parachain.governance]
voting_period_days     = 3
proposal_cooldown_days = 30
auto_collect           = false    # if true, `otigen upgrade` runs the full vote flow

[parachain.slashing]
preset = "standard"               # minimal / standard / strict
```

See [PARACHAIN_DESIGN](./PARACHAIN_DESIGN.md) for the semantics of each preset.

---

## 5. Per-language build pipeline

`otigen` does **not** invoke the language compiler. The author runs the language's own build command first (e.g., `cargo build --target wasm32-unknown-unknown --release`); `otigen build` then picks up the resulting `.wasm` and post-processes it.

This separation keeps `otigen` simple: it doesn't need to track language toolchain versions, manage compiler flags, or replicate package-manager behavior. The language ecosystem owns the build; `otigen` owns the chain-specific packaging.

The expected build commands per language (documented in canonical example projects):

| Language | Command | Output |
|---|---|---|
| Rust | `cargo build --target wasm32-unknown-unknown --release` | `target/wasm32-unknown-unknown/release/<name>.wasm` |
| AssemblyScript | `npx asc src/main.ts -o build/contract.wasm --target release` | `build/contract.wasm` |
| Go (TinyGo) | `tinygo build -target=wasm-unknown -o build/contract.wasm` | `build/contract.wasm` |
| C / C++ | `clang --target=wasm32 -nostdlib -Wl,--no-entry -o build/contract.wasm src/*.c` | `build/contract.wasm` |

The path in `[contract.lang.output]` tells `otigen build` where to find the `.wasm`. If absent, the build fails with `BuildRejected: WasmNotFound(<expected_path>)`.

### 5.1 Toolchain pinning

`[contract.lang.toolchain]` declares which compiler version the contract was built against. `otigen build` does not enforce this (it doesn't invoke the compiler) but it records the values in the bundle manifest. `otigen verify` uses these values to detect cross-toolchain drift.

---

## 6. `pyde.abi` custom-section injection

The mechanism by which `otigen build` integrates ABI metadata into the WASM artifact.

### 6.1 What gets embedded

A `ContractAbi` struct, Borsh-encoded.

The **canonical shape is defined in [`HOST_FN_ABI_SPEC.md` §3.7](./HOST_FN_ABI_SPEC.md)** — every byte the chain side reads at deploy time. The struct is deliberately lean: only what the chain's dispatch wrapper needs at runtime (per-function name + selector + attribute bitfield + access list, plus the schema hash + dispatch indices).

For reference, repeated here:

```rust
struct ContractAbi {
    pyde_abi_version:  u32,           // monotonic; matches engine's supported ABI version
    contract_type:     ContractType,  // Contract | Parachain
    functions:         Vec<FunctionAbi>,
    state_schema_hash: [u8; 32],      // Blake3 of canonical state-schema bytes
    constructor_index: Option<u32>,
    fallback_index:    Option<u32>,
    receive_index:     Option<u32>,
}

struct FunctionAbi {
    name:        String,
    selector:    [u8; 4],             // = Blake3(name)[..4]
    attributes:  u32,                 // bitfield (see HOST_FN_ABI_SPEC §3.5)
    access_list: Vec<String>,         // declared state-slot access patterns
}
```

The lean shape is intentional. Two design decisions follow from it:

- **Events are not embedded in `pyde.abi`.** Event metadata (signature, indexed fields, topic-hash derivation) is a runtime convention: contracts call `host_emit_event(topics, data)` and the chain stores topics + data verbatim. Wallets and indexers reconstruct event semantics from the event signature alone (the canonical encoding of which is documented in [HOST_FN_ABI_SPEC §14.1](./HOST_FN_ABI_SPEC.md)). The bundle's `otigen.toml` (shipped alongside `contract.wasm` per §9) carries the `[events.X]` declarations for tooling that wants the full picture.

- **Function `inputs` / `outputs` are not embedded either.** The chain dispatches by selector — it does not need typed parameter or return-value metadata to invoke a function. Wallets that want to construct calldata from typed arguments read the bundle's `otigen.toml` (or its richer `abi.json` mirror, per §9.3) which retains the `[functions.X]` `inputs` / `outputs` lists.

If the implementation and this document disagree on the byte shape, [`HOST_FN_ABI_SPEC.md` §3.7](./HOST_FN_ABI_SPEC.md) is authoritative.

### 6.2 Injection mechanism

`otigen build` uses the `wasm-encoder` Rust crate (or equivalent) to inject a custom section into the `.wasm`:

```rust
use wasm_encoder::{CustomSection, Module};

let mut module = Module::new();
// ... copy all sections from the input WASM ...
module.section(&CustomSection {
    name: "pyde.abi",
    data: borsh::to_vec(&contract_abi)?,
});
let final_wasm: Vec<u8> = module.finish();
```

The code section is untouched — `otigen` does not modify a single executable byte. Only a new metadata section is appended.

### 6.3 Verification

On deploy, the chain's deploy validator parses the `pyde.abi` custom section and re-runs every check from `otigen build` §3.2 step 3-5 against the actual WASM bytes. This is defense in depth: a malicious author could hand-edit the `pyde.abi` section to bypass the build check, but the deploy validator would catch it.

See [HOST_FN_ABI_SPEC §3.7](./HOST_FN_ABI_SPEC.md) for the chain side of this contract.

---

## 7. Wallet integration

### 7.1 Keystore format

JSON file (default location `~/.pyde/keystore.json`). One file holds multiple accounts:

```json
{
  "version": 1,
  "accounts": {
    "deployer": {
      "address": "0xabcd...",
      "pubkey":  "...base64 FALCON-512 pubkey (~897 bytes)...",
      "ciphertext": "...AES-256-GCM ciphertext of the FALCON secret key...",
      "salt":   "...random 16 bytes for Argon2id...",
      "nonce":  "...random 12 bytes for AES-GCM...",
      "kdf": {
        "name": "argon2id",
        "memory_kb": 65536,
        "iterations": 3,
        "parallelism": 4
      }
    }
  }
}
```

Decryption: `key = Argon2id(password, salt, kdf_params)`; `secret_key = AES-256-GCM-Decrypt(ciphertext, key, nonce)`.

### 7.2 Key generation

`otigen wallet new` runs:

1. Generate a fresh FALCON-512 keypair via `pyde-crypto`.
2. Prompt the user for a password.
3. Derive `key = Argon2id(password, random_16_byte_salt, kdf_params)`.
4. Encrypt the secret key: `ciphertext = AES-256-GCM-Encrypt(secret_key, key, random_12_byte_nonce)`.
5. Compute the address: `addr = Poseidon2(falcon_public_key_bytes)` (full 32 bytes, no truncation). Matches [Chapter 11 §11.2](../chapters/11-account-model.md) and the [`address-naming-collision`](https://book.pyde.network/companion/IMPLEMENTATION_PLAN) locked-in derivation — every EOA on Pyde is `Poseidon2(falcon_public_key_bytes)`. The input is the raw 897-byte FALCON-512 public key; the output is the full 32-byte Poseidon2 hash.
6. Append the entry to the keystore.

### 7.3 Signing pipeline

For every tx-submitting subcommand (`deploy`, `upgrade`, etc.):

1. Build the canonical tx bytes per the chain's tx format ([Chapter 11](../chapters/11-account-model.md)).
2. Compute `tx_hash = Blake3(canonical_tx_bytes)`.
3. Load the keystore entry. Prompt for password (or use cached if `--cache-password` was passed).
4. Decrypt the secret key (§7.1).
5. `signature = FALCON-512-Sign(tx_hash, secret_key)`.
6. Attach the signature + pubkey to the tx.
7. Submit via JSON-RPC.

The decrypted secret key is held in memory only for the duration of the signing operation, then zeroized.

### 7.4 Hardware-wallet bridge

Out of scope for v1. The keystore is software-only.

Post-v1, a `WalletBackend` trait will allow hardware wallets (Ledger / Trezor / dedicated FALCON HSM devices) to be plugged in behind the same API. The `[wallet]` table will gain a `backend = "hardware-ledger" | "hardware-trezor" | "software"` field.

---

## 8. Deploy, upgrade, and lifecycle flow

### 8.1 Deploy transaction

```
DeployContractTx {
    sender:         [u8; 32],
    name:           String,            // contract name (registered in name registry)
    wasm_bytes:     Vec<u8>,           // .wasm with embedded pyde.abi
    contract_type:  ContractType,
    init_calldata:  Vec<u8>,           // calldata for the constructor (if any)
    deploy_fee:     u128,
    nonce:          u64,
    gas_limit:      u64,
    gas_price:      u128,
    sig:            FalconSignature,
    pubkey:         FalconPubkey,
}
```

Chain handling on `DeployContractTx`:

1. FALCON-verify the signature.
2. Validate nonce, balance for `deploy_fee + gas_limit × gas_price`.
3. Parse the `pyde.abi` custom section from `wasm_bytes` and validate (per [HOST_FN_ABI_SPEC §3.7](./HOST_FN_ABI_SPEC.md)).
4. Register the contract name. Compute the contract address (see [Chapter 11](../chapters/11-account-model.md)).
5. Store `wasm_bytes` in state at the contract's code slot.
6. If a constructor is declared, instantiate the WASM and invoke the constructor with `init_calldata`.
7. Emit a `ContractDeployed` event.

### 8.2 Upgrade transaction

For contracts (single-signer):

```
UpgradeContractTx {
    sender:         [u8; 32],         // must be the contract owner
    contract_addr:  [u8; 32],
    new_wasm:       Vec<u8>,
    nonce, gas_limit, gas_price, sig, pubkey,
}
```

Chain validates owner authorization, re-runs ABI parsing/validation against `new_wasm`, stores it, and bumps `current_version`.

For parachains: the upgrade requires governance certs (per [PARACHAIN_DESIGN §6.2](./PARACHAIN_DESIGN.md)). The full proposal → vote → finalize flow is documented there.

### 8.3 Pause / Unpause / Kill transactions

All owner-only. Submitted as simple txs (`PauseContractTx`, `UnpauseContractTx`, `KillContractTx`). No special governance required.

---

## 9. Artifact format

### 9.1 The deploy bundle

`otigen build` produces a directory:

```
./artifacts/<contract_name>.bundle/
  contract.wasm     # WASM binary with embedded pyde.abi custom section
  otigen.toml       # verbatim copy of the source config
  abi.json          # human-readable ABI mirror
  manifest.json     # build metadata
```

### 9.2 `manifest.json`

```json
{
  "version": 1,
  "name": "my-token",
  "contract_type": "contract",
  "build_timestamp": "2026-05-23T16:42:00Z",
  "otigen_version": "1.0.0",
  "pyde_abi_version": "1.0.0",
  "target_chain_id": 1,
  "wasm_hash_blake3": "0xabcd...",
  "wasm_size_bytes": 152384,
  "wasm_size_bytes_uncompressed": 152384,
  "pyde_abi_hash_blake3": "0x1234...",
  "language": "rust",
  "language_toolchain": {
    "rust_channel": "stable",
    "rust_toolchain": "1.75.0"
  }
}
```

### 9.3 `abi.json`

The same `ContractAbi` data structure as the embedded `pyde.abi` custom section, but serialized as JSON for human inspection and IDE / explorer tooling. Authoritative source is the embedded custom section; `abi.json` is a mirror.

### 9.4 Reproducibility

Two builders running `otigen build` from the same:
- Source code
- `otigen.toml`
- Language toolchain version
- `otigen` version

should produce byte-identical `contract.wasm` and `manifest.json` (modulo `build_timestamp`). `otigen verify` exists to confirm this property.

---

## 10. Diagnostics and CI mode

### 10.1 Verbose mode

`-v` shows informational logs (which file is being read, which step is running). `-vv` adds debug-level logs (HTTP requests, key derivation timings, etc.).

### 10.2 JSON output mode

`--json` causes every subcommand to emit one JSON object per logical event, one per line (NDJSON-style):

```json
{"event": "build_start", "name": "my_token", "ts": "2026-05-23T16:42:00Z"}
{"event": "validation_passed", "checks": ["wasm_well_formed", "imports_allowed", "abi_consistent"]}
{"event": "abi_injected", "bytes_added": 1840}
{"event": "bundle_written", "path": "./artifacts/my_token.bundle/"}
{"event": "build_success", "duration_ms": 248}
```

`otigen test --json` adds the test-suite stream:

```jsonl
{"event":"test_suite_start","file":"tests/contract.test.toml","total":3}
{"event":"test_start","name":"transfer_moves_balance"}
{"event":"test_pass","name":"transfer_moves_balance","duration_ms":1.2}
{"event":"test_start","name":"transfer_reverts_on_overspend"}
{"event":"test_fail","name":"transfer_reverts_on_overspend","reason":"expected revert containing \"InsufficientBalance\", got: return value 0"}
{"event":"test_suite_done","passed":1,"failed":1,"skipped":0}
```

CI / scripting consumers parse this stream. Human readers see a friendlier format by default (omit `--json`).

### 10.3 Exit codes

Standardized across all subcommands:

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Validation / logic failure (bad config, ABI inconsistency, etc.) |
| `2` | Resource failure (file not found, network unreachable, etc.) |
| `3` | Transaction failure (revert, gas exhausted, sub-call failed) |
| `4` | Wallet failure (bad password, missing keystore entry, etc.) |
| `5` | Authorization failure (signing party not authorized) |
| `64` | Unhandled internal error (should not occur in a correct implementation; report as a bug) |

### 10.4 Error message format

Errors include a structured prefix for easy parsing:

```
otigen [ERROR] BuildRejected: ViewMutatesState
  function:    transfer
  reason:      reachable via call graph from `do_transfer_internal`
  mutating:    pyde::sstore at offset 0x4a2
  see:         HOST_FN_ABI_SPEC.md §3.7 step 4
```

---

## 11. Versioning and compatibility

### 11.1 otigen binary version

`otigen` itself follows semver (`MAJOR.MINOR.PATCH`):

- **MAJOR**: breaking CLI / config-schema changes
- **MINOR**: new subcommands, new flags, new schema fields (backwards-compatible)
- **PATCH**: bug fixes

### 11.2 ABI compatibility

`otigen` emits a `pyde_abi_version` field in the bundle. The chain refuses to accept a deploy whose declared ABI is newer than the chain's supported ABI. See [HOST_FN_ABI_SPEC §2](./HOST_FN_ABI_SPEC.md).

Cross-version matrix:

| otigen | chain ABI | Compatible? |
|---|---|---|
| 1.0.x | 1.0 | ✅ |
| 1.1.x | 1.0 | ✅ (otigen down-targets to 1.0 if `pyde_abi_version = "1.0.0"` in `otigen.toml`) |
| 1.0.x | 1.1 | ✅ (chain supports older modules) |
| 2.0.x | 1.x | ⚠️ otigen 2.x defaults to ABI v2.0; users can `--target-abi 1.x` to downgrade |

### 11.3 Schema migration

When `otigen` introduces a new `otigen.toml` key in a minor version, existing configs continue to work (the new key is optional with a sensible default). `otigen init` produces the latest schema.

When `otigen` introduces a *required* new key, that's a MAJOR bump; `otigen migrate` exists to upgrade old configs.

### 11.4 Release pipeline

`otigen` ships as a pre-built binary on every `v*` tag push. The pipeline lives at [`.github/workflows/release.yml`](https://github.com/pyde-net/otigen/blob/main/.github/workflows/release.yml) in the `pyde-net/otigen` repo and produces signed, reproducible artifacts:

**Target matrix:**

| OS | Architecture | Triple | Tarball name |
|---|---|---|---|
| Linux | x86_64 | `x86_64-unknown-linux-gnu` | `otigen-{version}-x86_64-unknown-linux-gnu.tar.gz` |
| Linux | aarch64 | `aarch64-unknown-linux-gnu` | `otigen-{version}-aarch64-unknown-linux-gnu.tar.gz` |
| macOS | arm64 | `aarch64-apple-darwin` | `otigen-{version}-aarch64-apple-darwin.tar.gz` |
| Windows | x86_64 | `x86_64-pc-windows-msvc` | `otigen-{version}-x86_64-pc-windows-msvc.zip` |

**Per-platform job:**

1. Check out the tagged commit (no `dirty` builds).
2. Install the pinned MSRV toolchain (currently 1.87).
3. `cargo build --release --target <triple>` → produces `target/<triple>/release/otigen[.exe]`.
4. `tar -czf` (or `zip` on Windows) → produces the tarball above.
5. `sha256sum` → produces `otigen-{version}-{triple}.tar.gz.sha256` alongside.
6. Upload to the GitHub Release for the tag.

**Signing:**

Each tarball is signed via [sigstore-keyless OIDC](https://github.com/sigstore/cosign) using the GitHub Actions runner's OIDC token as the identity. The signature artifacts (`*.sig` + `*.pem`) are uploaded alongside the tarball. Verification:

```bash
cosign verify-blob \
  --certificate-identity-regexp '^https://github.com/pyde-net/otigen/.github/workflows/release.yml@.*$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --signature otigen-{version}-{triple}.tar.gz.sig \
  --certificate otigen-{version}-{triple}.tar.gz.pem \
  otigen-{version}-{triple}.tar.gz
```

This proves the binary was built by the `pyde-net/otigen` repo's own `release.yml` workflow, on a commit at the corresponding tag, without ever needing a long-lived signing key. Compromise of any single workflow run does not compromise prior releases.

**Versioning:**

Tag names are full semver (`v0.1.0-testnet.0` → `v1.0.0` for mainnet). Pre-release tags (`-testnet.N`, `-rc.N`) are explicitly marked as GitHub pre-releases. The tag commit's `git describe` output is recorded in the binary via `build.rs` (visible as `otigen --version`).

**Reproducibility:**

The pipeline pins the MSRV toolchain version and disables debug info to maximize byte-equality between independent rebuilds. The α.qual reproducibility test (still open) will verify two clean rebuilds of the same tag produce byte-identical tarballs (modulo the build timestamp embedded by `cargo`).

---

## 12. References

- [Chapter 5 — Otigen Toolchain](../chapters/05-otigen-toolchain.md) — narrative overview
- [Chapter 17 — Developer Tools](../chapters/17-developer-tools.md) — what tools authors use day-to-day
- [HOST_FN_ABI_SPEC.md](./HOST_FN_ABI_SPEC.md) — the chain-facing ABI this toolchain builds against
- [OTIGEN_TEST_SPEC.md](./OTIGEN_TEST_SPEC.md) — contract behaviour test framework (Foundry-grade TOML)
- [PARACHAIN_DESIGN.md](./PARACHAIN_DESIGN.md) — parachain-specific concerns (no-SDK rationale, governance, etc.)
- [Chapter 11 — Account Model](../chapters/11-account-model.md) — address derivation, tx wire format
- [`wasm-encoder` crate](https://docs.rs/wasm-encoder/) — the WASM section-writer `otigen` uses

---

**Document version:** 0.1 (draft for v1 mainnet)

**License:** See repository root
