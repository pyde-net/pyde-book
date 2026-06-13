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
| `-v, --verbose` | Verbose logging. Counter flag — `-v` info, `-vv` debug. `otigen test` extends the ladder to `-vvv` (per-call traces) and `-vvvv` (storage diffs); see §3.10. |
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
3. Writes `<dir>/src/` containing a hello-world contract. The Rust scaffold uses the macro substrate (`#[pyde::entry]` + `pyde::declare_storage!()`) so authors get typed accessors + a `() -> ()` ABI shim with zero hand-written `extern "C"` boilerplate. Non-Rust scaffolds (`--lang as|go|c`) ship the raw `extern "C"` host-fn pattern — the macro substrate is Rust-only; community SDK authors targeting other languages reference `examples/counter-{as,go,c}/` and the `SDK_AUTHOR_GUIDE`.
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

Interactive REPL against a Pyde node. Foundry-`cast` shape;
line-edited via rustyline with persisted history at
`~/.otigen_console_history` and Ctrl-C / Ctrl-D handling that
matches every other shell.

```
otigen console [--network <name>] [--from <key>] [--password-stdin]
```

Session-scoped: `--network` and `--from` bind once at REPL
startup, every per-command call reuses the same `RpcClient`.
Wallet unlock is lazy — views never prompt; the first `tx` asks
for the password once (or reads it from stdin with
`--password-stdin` for CI / scripted flows) and the unlocked
signer is cached for the rest of the session.

REPL commands (MVP — shipping today):
- `help` / `?` — list the catalog
- `balance <addr>` — query native PYDE balance
- `nonce <addr>` — query next-acceptable nonce
- `call <addr> <fn> [hex]` — invoke a `view` function (free, off-chain via `pyde_call`)
- `tx <addr> <fn> [hex] [--value <decimal>]` — sign + submit + receipt poll
- `exit` / `quit` — leave the console

Address inputs accept either a `0x`-prefixed 32-byte hex address
or a registered name resolved via `pyde_resolveName`.

Deferred (each 2-3× MVP scope, follow-up PRs):
- `events <addr> [--topic <hash>] [--from <wave>]` — needs `pyde_getLogs` typing + filter wiring.
- `state <addr> <field>` — needs ABI-aware decoding from the contract's `pyde.abi` section.
- `subscribe <addr> --logs --topic <hash>` — needs websocket / long-poll plumbing the devnet doesn't currently expose.
- ABI-aware calldata typing (Foundry's `cast send --json-abi` shape).

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
            [--watch] [--no-engine] [-v|-vv|-vvv|-vvvv]
```

| Flag | Default | Description |
|---|---|---|
| `--filter <pattern>` | none | Run only tests whose name contains the pattern (substring). Multiple `--filter` flags OR together. |
| `--bundle <path>` | `./artifacts/<name>.bundle/` (resolved against `--config`) | Bundle whose `contract.wasm` is executed. |
| `--watch` | off | Re-run on every file change. Watches the project directory recursively; ignores `target/`, `artifacts/`, `.git/`, `node_modules/`, `build/`, `dist/`. Debounces rapid keystrokes within a 300 ms window. Foundry parity with `forge test --watch`; Ctrl-C to exit. |
| `--no-engine` | off | Opt OUT of the engine path and fall back to the legacy in-process mock host-fn surface. See "Runtime selection" below. |
| `--no-color` | off | Disable terminal colour escapes (CI logs). |
| `--show-output` | off | Print captured stdout / stderr per test (for mock-host debugging). |
| `--json` (global) | off | Emit NDJSON test events (`test_suite_start` / `test_start` / `test_pass` / `test_fail` / `test_suite_done`) instead of plain text. For CI / scripting consumers. |
| `-v` (global) | off | Append gas-used + duration to each pass/fail line. |
| `-vv` (global) | off | Above, plus per-test list of emitted events (topic-0 + topic count + data length). |
| `-vvv` (global) | off | Above, plus per-call trace: function name, args, return value / revert reason, gas. |
| `-vvvv` (global) | off | Above, plus per-test storage diff: every slot whose value changed (before → after). |

Verbosity follows Foundry's `forge test -vvvv` ladder. Each level surfaces strictly more information; consumers paging through `forge` output will find the same mental model.

**Runtime selection.** `otigen test` runs through `pyde-engine-wasm-exec::WasmExecutor` by default — the same execution code path mainnet uses. Per the project principle "same crypto / same VM everywhere across mainnet / testnet / devnet" the engine path is the source of truth; the legacy in-process mock surface still ships behind `--no-engine` for two cases:

- **Parachain contracts** (`contract.type = "parachain"`) — parachain host fns live behind engine v2; until then `otigen test` against a parachain bundle requires `--no-engine` and gets the legacy mock surface with `parachain_*` mocks (see "Legacy mock surface" below). `otigen test --engine` against a parachain pre-flights with `ParachainEngineUnsupported` pointing at `--no-engine`.
- **Bisection / debugging** — running both paths against the same test and comparing surfaces which side is misbehaving.

Discovery order:
1. `tests/*.test.toml` (canonical)
2. `tests/*.toml`
3. `./contract.test.toml` (single-file projects)

Each file's `[[tests]]` array contributes to the total count. Tests run sequentially; each starts from a fresh state store backed by a tempdir — no state leaks between cases. The engine path builds a fresh `EngineRunner` per test case; the legacy path builds a fresh in-process `TestEnv` per case.

Per-test pipeline (engine path):

1. Apply `[cheats]` (and per-test `[tests.cheats]` overrides).
2. Resolve account names → 32-byte Blake3 addresses; resolve storage field names → slot hashes per the contract's `[state]` schema (the chain derives `Blake3(self_address || field_name || keys...)` host-side for the typed-storage path; Poseidon2 host-side for the legacy raw-host-fn path).
3. Pre-populate storage from `[tests.setup].storage` + balances from `[tests.setup].balances`.
4. Record start time.
5. For each `[[tests.calls]]` entry: marshal typed args (`address` / `uint128` / `int128` / `bytes32` / `bytes` / primitive ints) into wasm linear memory + params, invoke the WASM export through the engine's `WasmExecutor::execute_call`, capture the return value + emitted events + revert reason. On trap, the per-call `TxOverlay` discards (so a reverting call mid-test doesn't roll back state from earlier successful calls — matching mainnet semantics). Check per-call `expect`.
6. After the call sequence, check `[tests.expect]` (final-state assertions: storage values, balances, event totals).
7. Record end time; compute `duration_ms`.
8. Emit pass / fail (with `duration_ms` included in the NDJSON event under `--json`).

**Engine path host-fn surface.** The engine path links the **real** `pyde::*` ABI — same host fns mainnet runs (HOST_FN_ABI_SPEC §7). The runner stubs nothing beyond the test-only `debug_log` (printf-style; not registered chain-side, see "Test-only host fns" below). Authors writing contracts that hit `tx_hash`, `calldata_copy`, `consume_gas`, `cross_call_static`, `return`, `hash_keccak256`, `beacon_get`, or `origin` get them at chain-fidelity behaviour.

**Legacy mock surface (`--no-engine` only).** The legacy path runs each contract in an in-process wasmtime instance wired to test-runner mocks. Useful for parachain contracts (whose chain runtime ships in v2) and for runner-side debugging. Mocked host fns:

- **Storage** (variable-length): `sload`, `sstore`, `sdelete`
- **Account & balance**: `balance`, `transfer`
- **Execution context**: `caller`, `self_address`, `wave_id`, `wave_timestamp`, `chain_id`
- **Transaction context**: `tx_value`
- **Events + halt**: `emit_event`, `revert`
- **Hashing**: `hash_blake3`, `hash_poseidon2`, `hash_keccak256`
- **Post-quantum crypto**: `falcon_verify` — real verification via the runner's bundled `pyde-crypto`; pairs with the `@sig:NAME:args.IDX` DSL (see [`OTIGEN_TEST_SPEC §6`](./OTIGEN_TEST_SPEC.md))
- **Cross-contract**: `cross_call`, `delegate_call` — multi-contract topology declared via `[[contracts]]`; each secondary instance gets its own Store + storage namespace
- **Parachain §8** (when `[contract].type = "parachain"`): `parachain_id`, `parachain_version`, `parachain_storage_read`, `parachain_storage_write`, `parachain_storage_delete`, `parachain_emit_event`

**Test-only host fns (both paths).** `debug_log(msg_ptr, len) -> ()` — printf-style; writes `[debug] <fn_name>: <msg>` to stderr and captures into the test report's `debug_logs`. Not registered chain-side; `otigen build` and `otigen deploy` reject contracts that import it (HOST_FN_ABI_SPEC §9.1).

Exit codes: `0` all-pass; `1` any failure; `2` resource failure (test file unreadable, bundle missing); `4` schema error (malformed TOML, reference to undeclared `[state]` field, parachain contract attempted on engine path).

**Gas tracking.** Both paths enable wasmtime's `consume_fuel(true)` and seed each call with the test's `cheats.gas_limit` (default 1,000,000,000 fuel). Per-call gas usage is `fuel_cap - remaining_fuel` after the call returns. Total gas per test is the sum across calls.

  - Reported in the NDJSON `test_pass` / `test_fail` events as `gas_used`.
  - Surfaced at `-v` and above in the plain-text output.
  - Optionally asserted via `expect.gas` (exact) or `expect.gas_max` (upper bound) per call. See [`OTIGEN_TEST_SPEC §4.5`](./OTIGEN_TEST_SPEC.md).

Note: the runner's fuel units correlate to but are not bit-identical with on-chain Pyde gas. Foundry has the same caveat — gas reports under `forge test` are estimates, not chain billing.

The full TOML schema, name resolution rules, cheatcode catalogue, host-function behaviour, and limitations are documented in [`OTIGEN_TEST_SPEC.md`](./OTIGEN_TEST_SPEC.md). That spec is authoritative.

### 3.11 `otigen new`

Scaffold a project by cloning a canonical example from the [`pyde-net/otigen` example catalogue](https://github.com/pyde-net/otigen/tree/main/examples). Where `otigen init` writes a minimal hello-world, `otigen new` produces a fully-working contract with a passing TOML test suite — the fastest path from zero to a green `otigen test` run.

```
otigen new <name> --from <template> [--dir <path>]
otigen new --list
```

| Arg | Required | Description |
|---|---|---|
| `<name>` | yes (unless `--list`) | Project name. Lowercase + hyphens (ENS-style, 1–32 chars). Used for the contract identity and the directory. |
| `--from` | yes (unless `--list`) | Template to clone. Run `otigen new --list` for the catalogue. |
| `--list` | no | List available templates and exit. Mutually exclusive with `<name>`, `--from`, and `--dir`. |
| `--dir` | no | Target directory (default: `./<name>`). |

Canonical templates (frozen at v1). Templates on the macro substrate (`#[pyde::entry]` + `pyde::declare_storage!()` + `pyde::declare_events!()`) are flagged; the remainder ship the raw host-fn pattern (still supported; the right shape for contracts that want full control over slot derivation).

| Template | Substrate | Highlights |
|---|---|---|
| `counter-rust` | macro | Minimum viable contract — single `u64` slot via typed `storage::counter()` accessor. |
| `erc20-token` | macro | Canonical real-contract reference. Scalar + map + 2-key-map storage shapes, indexed-field event encoding, typed-arg calldata. |
| `erc721-token` | macro | ERC721-shape NFT. Per-token ownership + balance_of + single-spender approval. |
| `nft-marketplace` | macro | `pyde::call::execute<T>` cross-calls into ERC721; per-frame `caller_address` semantics. |
| `dao-governance` | macro | Proposal lifecycle + cross-call execution + categorized `CallError` propagation. |
| `escrow` | macro | `#[payable]` + `tx_value` + `wave_timestamp`-gated release / claim / refund. |
| `upgradeable-proxy` | macro | `delegate_call`-based upgrade; state survives v1→v2; logic-contract state untouched. |
| `payment-channel` | macro | Metered withdrawal + per-call cap + cumulative cap + close-on-deadline. |
| `multisig-wallet` | macro | M-of-N owner approvals + value-forwarding cross-call (on-chain approval bookkeeping). |
| `storage-stress` | macro | Every `ScalarType` × every arity round-tripped. The substrate-coverage stress reference. |
| `struct-storage` | macro | `struct(<Name>)` storage values via borsh round-trip (scalar + map<addr,struct>). |
| `borsh-coverage` | macro | `#[pyde::entry]` calldata + return marshalling for `Vec<T>`, `Option<T>`, tuples, nested vecs, custom struct, unit enum. |
| `counter-{as,go,c}` | raw | Alt-language counter contracts demonstrating the raw `sload` / `sstore` pattern. The macro substrate is Rust-only; community SDK authors targeting other languages reference these + `SDK_AUTHOR_GUIDE`. |
| `simple-multisig` | raw | 3-signer FALCON-512 multisig demonstrating the in-contract PQ-verify + off-chain-signed-claim pattern (complements `multisig-wallet`'s on-chain approval bookkeeping). |
| `merkle-claim-airdrop` | raw | Off-chain Merkle commitment + on-chain inclusion verification via `hash_blake3`. |
| `vesting` | raw | Linear vesting with cliff. Time-locked allocation using `wave_timestamp`. |
| `profile-registry` | raw | Parachain example. Parachain runtime ships in v2; scaffolds the surface for authors to start exploring early. |

Side effects:

1. Creates `<dir>/` and copies every file from the template into it.
2. Rewrites identity fields to `<name>` in `otigen.toml` (`[contract].name`), `Cargo.toml` / `package.json` / `go.mod` (per-language idiom), and the `Makefile`'s display strings.
3. Preserves every other file byte-for-byte — `src/`, `tests/`, the per-template `README.md`, the build config — so `cd <name> && make test` produces an identical result to running the template in-tree.

Exit codes: `0` on success, `1` if `<dir>` already exists, `2` if the template is unknown (run with `--list` to see the catalogue).

### 3.12 `otigen devnet`

Run a local devnet (thin wrapper around the engine's `pyde devnet` binary so authors drive devnet bootstrapping from one toolchain entry point instead of remembering the engine binary path).

```
otigen devnet [--fork <FILE_OR_URL>] [--rpc-listen <ADDR>]
              [--prefund-count <N>] [--prefund-amount <QUANTA>]
              [--chain-id <ID>] [--tick-ms <MS>] [--engine-bin <PATH>]
```

| Flag | Default | Description |
|---|---|---|
| `--fork <FILE_OR_URL>` | none | Fork the devnet's state from an existing snapshot. Accepts either a local borsh snapshot file (`./snapshot.bin`, produced by the engine's `Snapshotter::build`) OR an HTTP(S) URL pointing at a running validator's `pyde_getSnapshot` RPC endpoint (e.g. `http://127.0.0.1:9933`; once they ship, mainnet / testnet validator URLs). Mutually exclusive with `--prefund-count` and `--prefund-amount`. |
| `--rpc-listen <ADDR>` | engine default (banner-only mode) | JSON-RPC server bind address. Pass `127.0.0.1:9933` to enable RPC. Forwarded as-is to `pyde devnet --rpc-listen`. |
| `--prefund-count <N>` | engine default (10) | Number of pre-funded accounts the banner enumerates. Each is derived deterministically from the canonical devnet seed. Cannot be combined with `--fork`. |
| `--prefund-amount <QUANTA>` | engine default | Per-account genesis balance in quanta. Cannot be combined with `--fork`. |
| `--chain-id <ID>` | engine default (31337) | Chain id this devnet signs against. |
| `--tick-ms <MS>` | engine default (1000) | Idle-wave tick interval in milliseconds. Even with no pending txs the devnet commits an empty wave every `--tick-ms` so `wave_id` advances. |
| `--engine-bin <PATH>` | `PYDE_BIN` env → `pyde` on `PATH` | Path to the `pyde` binary to run. Useful for running against a locally-built engine: `--engine-bin ../engine/target/release/pyde`. |

stdin/stdout/stderr inherit from the parent so the engine's startup banner + any `RUST_LOG=info` traces flow straight through; Ctrl-C from the terminal hits both processes (same fg pgrp) and the engine handles its own graceful shutdown.

Mutual-exclusion check between `--fork` and the `--prefund-*` flags fires before spawning the engine so authors get a fast clear error instead of mid-startup engine-side rejection.

Exit codes: forwarded from the underlying `pyde devnet` process.

### 3.13 `otigen check`

Validate the project without packaging. Same checks as `otigen build` steps 1–7 (read + schema-validate `otigen.toml`, locate `.wasm`, every WASM-level validator, ABI build) minus the bundle write. Intended for pre-commit hooks, IDE integrations, and tight iteration loops where the bundle write is wasted I/O.

```
otigen check [--compile]
```

| Flag | Default | Description |
|---|---|---|
| `--compile` | off | Run the per-language build command first (same dispatch table as `otigen build --compile`). |

Exit codes: `0` on clean validation, `1` on validation failure (with per-violation diagnostics on stderr), `2` if the `.wasm` was not found at the declared `[contract.lang.output]` path.

Coverage parity with `otigen build`: any contract that passes `otigen check` will pass `otigen build`'s validators identically (steps 8+ are I/O-only). Likewise any contract that fails `otigen build` validation fails `otigen check` with the same diagnostic. The two commands share the validation core; `check` is `build` with the writer disabled.

### 3.14 `otigen validator`

Read-only validator-introspection over the engine's
`pyde_getValidator` + `pyde_getOperatorValidators` RPCs.
Backs explorers, off-chain indexers, and operator dashboards
without scripting raw JSON-RPC. **Registration / stake /
unbond / unjail / key-rotation are out of scope** — those tx
flows live on the `pyde stake` CLI shipped with the engine
binary.

```
otigen validator show <address>
otigen validator by-operator <operator-address>
```

| Subcommand | Description |
|---|---|
| `show <address>` | Fetch one validator's full chain-side record: operator + pubkey + stake (u128 hex) + status (`active` / `unbonding` / `exited` / `jailed`) + `unbond_at_wave` (only when `unbonding`) + `jail_until_wave` (only when `jailed`) + `last_claimed_rps` (u128 hex reward checkpoint) + `uptime_bps` (basis points). |
| `by-operator <addr>` | List every validator the queried operator runs, in registration-order. Empty list for unknown operators. |

Both subcommands accept a 32-byte `0x`-prefixed hex address.
Address validation is local — typos don't burn an RPC round
trip.

**Wire shapes** match the engine handlers landed in
`pyde-net/engine#255`:

  - `pyde_getValidator(addr) → ValidatorRecord | null`
  - `pyde_getOperatorValidators(addr) → [address]`

`--json` (per [§10.2](#102-json-event-stream)) emits one
NDJSON event per invocation (`validator_show` or
`validator_by_operator`).

Exit codes:

| Code | Cause |
|---|---|
| `0` | Success: `show` rendered a record; `by-operator` rendered the (possibly empty) list. |
| `1` | `show` only — the queried address is not a registered validator (engine returned `null`). Diagnostic on stderr: `NotAValidator: 0x… is not registered as a validator`. Scripts can branch on this without parsing stdout. |
| `2` | Validation failure: malformed address, missing `[network.<name>]`, RPC client construction failed. |
| `4` | RPC transport / decode failure (chain unreachable, response shape didn't decode). |

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

Declares the contract's storage schema. Embedded in the bundle and used for type-safe inspection (`otigen inspect --field`), explorer UI rendering, the `state_schema_hash` value in the deployed ABI, AND — for Rust contracts on the macro substrate — by `pyde::declare_storage!()` at compile time to generate typed accessors. Non-Rust contracts call the chain's typed-storage host fns (`sstore_scalar` / `sload_scalar` / `sstore_map1`…`map3`) directly; the chain derives the slot internally as `Blake3(self_address || field_name || keys...)`.

`schema` is an ordered array of `{ name, type, ... }` entries.

Field type vocabulary:

| Token | Width | Notes |
|---|---|---|
| `u8` / `u16` / `u32` / `u64` / `u128` | 1 / 2 / 4 / 8 / 16 | Little-endian. Aliases `uint8`…`uint128` accepted. |
| `i8` / `i16` / `i32` / `i64` / `i128` | 1 / 2 / 4 / 8 / 16 | Two's-complement LE. Aliases `int8`…`int128` accepted. |
| `bool` | 1 | 0 = false, anything non-zero = true. |
| `address` / `hash32` | 32 | Raw 32-byte array. `bytes32` is an alias for `hash32` (Solidity migration ergonomics). |
| `bytes` | variable | u32-len-prefix + bytes. |
| `string` | variable | u32-len-prefix + UTF-8 bytes. |
| `vec(<inner>)` | variable | u32-len-prefix + N × fixed-width inner. Inner must be fixed-width — `vec(bytes)` / `vec(string)` / `vec(vec(...))` rejected at parse time. |
| `struct(<Name>)` | variable | Borsh round-trip. Author declares `#[derive(BorshSerialize, BorshDeserialize)]` on `<Name>`; the macro emits typed accessors that borsh-encode/decode through the chain's variable-length storage host fns. Chain-side maps to `ScalarType::Bytes`. |

Map shape (replaces the single `type = "..."` form for keyed slots):

```toml
{ name = "balances",   type = "map", keys = ["address"], value = "uint128" }
{ name = "allowances", type = "map", keys = ["address", "address"], value = "uint128" }
```

Map keys: up to 3, each a fixed-width scalar (primitives / `address` / `hash32`) or a variable-length scalar (`bytes` / `string`). `vec(...)` and `struct(...)` keys are rejected up-front to avoid slot collisions on variable-length encodings.

Map values: any scalar type from the vocabulary above, including `struct(<Name>)`.

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

### 4.11 `[paths]` table (Foundry-style project layout overrides)

Optional. Every key has a sensible default, so the table is only needed when an author's project tree diverges from the conventional layout. Declared keys override individually — undeclared keys keep their default.

```toml
[paths]
src       = "src"               # language source root
tests     = "tests"             # `.test.toml` discovery root for `otigen test`
target    = "target"            # language compiler intermediate output
artifacts = "artifacts"         # `otigen build` bundle output root
cache     = ".otigen/cache"     # reserved for future module / manifest cache
```

| Key | Default | Used by |
|---|---|---|
| `src` | `"src"` | `otigen check`, reproducibility tooling |
| `tests` | `"tests"` | `otigen test` (discovers `<tests>/*.test.toml`) |
| `target` | `"target"` | `make clean` in scaffolded `Makefile`; reproducibility tooling |
| `artifacts` | `"artifacts"` | `otigen build` (writes `<artifacts>/<contract.name>.bundle/`) |
| `cache` | `".otigen/cache"` | reserved for v1.1+ (module cache + manifest replay) |

Foundry parity. Authors moving Solidity projects to Pyde recognise the shape from `foundry.toml`'s `[profile.default] src / out / libs / test / cache_path`. The defaults assume the conventional layout (everything where a `cargo new` would put it); the table is purely for overrides.

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

### 8.2 Upgrade transaction — **v2-deferred; v1 uses the proxy pattern**

v1 does NOT ship a chain-side `UpgradeContractTx` tx type or an `Account::Contract.owner` field. The frozen `TxType` enum has 14 variants (`crates/types/src/tx.rs`); none of them are contract upgrade.

The v1 upgrade story is the proxy / `delegate_call` pattern, demonstrated by the `upgradeable-proxy` acceptance contract:

- Deploy a thin `proxy` contract that holds `logic: Address` + `admin: Address` in its state.
- Every entry on the proxy is `forward(function: String, calldata: Vec<u8>)` which `delegate_call`s into `logic` — the delegated code runs in the proxy's frame, so state writes land in the proxy's slots.
- Admin-gated `upgrade_to(new_logic)` swaps `logic` on the proxy. State survives the swap because it lives at the proxy's address; the new logic's code is unchanged code at its own address.

Why deferred rather than shipped:

- Chain-blessed contract ownership (an `Account::Contract.owner` field) competes with the deliberately-ownerless [`address-naming-collision`](../chapters/11-account-model.md) model — addresses are `Poseidon2(name)`, ownership is contract-internal.
- Chain-level upgrade is less flexible than the proxy pattern: the proxy can hold multiple logic versions, time-lock swaps, gate them on governance, expose multi-sig admin, etc. — all expressible in contract code.
- Versioning, code-cf GC, owner-rotation semantics, and parachain-governance-cert-gated upgrades all hang off the chain-side variant; none of them earn their keep before v1 mainnet.

For parachains: governance-cert-gated runtime upgrades remain documented in [PARACHAIN_DESIGN §6.2](./PARACHAIN_DESIGN.md) as a v2 deliverable; v1 parachains are pinned to a fixed runtime.

### 8.3 Pause / Unpause / Kill — **contract-internal in v1; no chain-side tx types**

v1 does NOT ship `PauseContractTx`, `UnpauseContractTx`, or `KillContractTx`. Contract-level pause / kill are not protocol surface; any author can declare a `paused: bool` (or `killed: bool`) field in `[state]` and gate their entry points on it:

```toml
[state]
paused = { type = "bool" }
admin  = { type = "address" }
```

```rust
#[pyde::entry]
pub fn do_thing(...) {
    if storage::paused_get() {
        pyde::revert("contract paused");
    }
    // ...
}

#[pyde::entry]
pub fn pause() {
    if pyde::ctx::caller() != storage::admin_get() {
        pyde::revert("not admin");
    }
    storage::paused_set(true);
}
```

Note that `TxType::EmergencyPause` / `TxType::EmergencyResume` (`0x0B` / `0x0C`) are chain-wide — they freeze block production via the treasury multisig per Chapter 15 governance. They are NOT per-contract.

#### Migration note for `otigen-cli`

The `otigen pause / unpause / kill / upgrade` CLI subcommands currently build a `Standard` tx with `data = borsh(LifecyclePayload::{Pause, Unpause, Kill, Upgrade})`. The chain decodes contract-call `data` as `CallPayload { function, calldata }` and reverts on the unrecognised envelope. These CLI subcommands need to be rewritten (or removed) in a separate otigen ticket so contract authors aren't pointed at a broken path. The replacement story for upgrade is the proxy contract pattern documented above; pause / kill are author-defined entries the CLI can call generically via `otigen call <contract> pause`.

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
  "bundle_format_version": 1,
  "name": "my-token",
  "contract_type": "contract",
  "build_timestamp": "2026-05-23T16:42:00Z",
  "otigen_version": "1.0.0",
  "pyde_abi_version": 1,
  "target_chain_id": 1,
  "wasm_hash_blake3": "0xabcd...",
  "wasm_size_bytes": 152384,
  "pyde_abi_hash_blake3": "0x1234...",
  "pyde_abi_size_bytes": 1840,
  "language": "rust",
  "language_toolchain": {
    "rust_channel": "stable",
    "rust_toolchain": "1.75.0"
  }
}
```

Field semantics — three distinct version fields, separately governed:

| Field | What it versions | Authoritative source |
|---|---|---|
| `bundle_format_version` | On-disk layout of `<contract>.bundle/` (directory structure, file names, field shapes inside `manifest.json` / `abi.json`). | §9.3 below + `otigen_abi::BUNDLE_FORMAT_VERSION` constant |
| `pyde_abi_version` | Chain-facing `pyde.abi` custom section embedded inside the WASM. Bumped on every breaking schema change to `ContractAbi`. | [`HOST_FN_ABI_SPEC.md`](./HOST_FN_ABI_SPEC.md) §3 + `otigen_abi::PYDE_ABI_VERSION_V1` constant |
| `otigen_version` | Toolchain build that produced the bundle. SemVer; informational (used by `otigen verify` diagnostics, not by gating). | `Cargo.toml` `[package].version` of the `otigen-cli` crate |

The contract's own semantic version lives in `[contract].version` in the source `otigen.toml`; it's not in `manifest.json` because it's already in the verbatim-copied `otigen.toml` shipped alongside.

### 9.3 Bundle format version + forward-compat

`bundle_format_version` is a monotonic integer stamp on the bundle layout. Frozen at v1 mainnet under a one-way ratchet:

- **`otigen verify` rejects unknown bundles.** A bundle declaring `bundle_format_version > BUNDLE_FORMAT_VERSION` (the constant this otigen build was compiled against) is rejected with `BundleFormatTooNew` + an "upgrade your otigen" diagnostic + exit code 2 (`RESOURCE_FAILURE`). Mirrors the chain's `MAX_SUPPORTED_ABI_VERSION` gate for `pyde_abi_version`.
- **Older bundles never break.** Every prior `bundle_format_version` is accepted forever. Subsequent toolchain releases that change the bundle layout bump the constant and document the delta here.
- **Legacy bundles read cleanly.** Bundles built before the `version` → `bundle_format_version` rename (manifest still has `"version": 1`) are accepted; verify falls back to reading the unnamed field with the same semantics. Both decode to `bundle_format_version = 1`.

The constant lives in `otigen-abi`, re-exported as `otigen_abi::BUNDLE_FORMAT_VERSION`. Tooling that wants to introspect bundles without depending on the full toolchain reads the JSON field directly.

### 9.4 `abi.json`

The same `ContractAbi` data structure as the embedded `pyde.abi` custom section, but serialized as JSON for human inspection and IDE / explorer tooling. Authoritative source is the embedded custom section; `abi.json` is a mirror.

### 9.5 Reproducibility

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

`--json` causes every subcommand to emit one JSON object per logical event, one per line (NDJSON-style). CI / scripting consumers parse this stream; human readers see a friendlier format by default (omit `--json`).

```json
{"event":"build_start","config_path":"otigen.toml"}
{"event":"config_validated","contract_name":"my-token","language":"rust"}
{"event":"wasm_loaded","path":"target/wasm32-unknown-unknown/release/my_token.wasm","size_bytes":152384}
{"event":"validation_passed","checks":["wasm_well_formed","imports_allowed","abi_consistent"]}
{"event":"abi_built","function_count":6,"event_count":2}
{"event":"abi_injected","bytes_added":1840}
{"event":"bundle_written","path":"./artifacts/my-token.bundle"}
{"event":"build_success","duration_ms":248}
```

#### Stability contract (`otigen-events-v1`)

This is `otigen-events-v1` — the JSON event surface as of `bundle_format_version = 1`. The stability guarantees:

- **Existing event variants never disappear.** `build_start`, `test_pass`, `verify_result`, etc., emit forever with their existing required fields. Older parsers keep working.
- **New fields may be added** to existing events. Parsers MUST tolerate unknown keys (the standard "don't break on additions" JSON discipline).
- **Required fields keep their types.** A `duration_ms` that's `u64` today won't become a string. A `size_bytes` that's `usize` today won't go signed.
- **New event variants may be added** in later toolchain releases. Parsers SHOULD tolerate unknown `event` values (typically by logging + skipping).
- **Breaking changes** (renamed field, type change, removed variant) bump the schema to `otigen-events-v2`. The bundle's `bundle_format_version` bumps simultaneously so consumers can gate by either.

`--quiet` × `--json` interaction: `--quiet` wins. Both flags together emit nothing on stdout (only structured errors go to stderr via the regular error path). Useful for CI that only cares about exit codes.

#### Event catalog (v1, complete)

Grouped by subcommand. Each row lists the `event` discriminant and the fields the variant carries.

**`otigen init`**

| Event | Fields |
|---|---|
| `init_start` | `name`, `lang`, `kind` |
| `init_success` | `name`, `lang`, `path`, `files_written` |

**`otigen new`**

Currently piggy-backs on `init_start` (see [`commands/new.rs`](https://github.com/pyde-net/otigen/blob/main/crates/otigen-cli/src/commands/new.rs)) for parity with the canonical-template path. Dedicated `new_*` events land in a follow-up.

**`otigen build` / `otigen build --compile`**

| Event | Fields |
|---|---|
| `build_start` | `config_path` |
| `config_validated` | `contract_name`, `language` |
| `compile_start` | `language`, `command` (only with `--compile`) |
| `compile_success` | `language`, `output` (only with `--compile`) |
| `compile_failed` | `language` (only with `--compile`) |
| `wasm_loaded` | `path`, `size_bytes` |
| `validation_passed` | `checks` (array of check names) |
| `abi_built` | `function_count`, `event_count` |
| `abi_injected` | `bytes_added` |
| `bundle_written` | `path` |
| `build_success` | `duration_ms` |

**`otigen check`**

| Event | Fields |
|---|---|
| `check_start` | `config_path` |
| `check_success` | `function_count`, `event_count`, `duration_ms` |
| `check_failed` | `violations` (count) |

**`otigen wallet`**

| Event | Fields |
|---|---|
| `wallet_created` | `name`, `address`, `keystore` |
| `wallet_imported` | `name`, `address`, `keystore` |
| `wallet_listed` | `keystore`, `accounts` (array of `{name, address}`) |
| `wallet_shown` | `name`, `address`, `keystore` |
| `wallet_deleted` | `name`, `keystore` |
| `wallet_password_rotated` | `name` |
| `wallet_exported` | `name`, `path`, `keystore` |
| `wallet_signed` | `name`, `tx_hash`, `signature` |

**`otigen deploy`**

| Event | Fields |
|---|---|
| `deploy_start` | `name`, `network`, `from`, `bundle` |
| `deploy_dry_run` | `tx_hash`, `bytecode_hash`, … |
| `deploy_submitted` | `tx_hash` |
| `deploy_included` | `tx_hash`, `status` |
| `deploy_failed` | `reason`, `detail` |

**`otigen upgrade` / `pause` / `unpause` / `kill`** (lifecycle ops)

| Event | Fields |
|---|---|
| `lifecycle_start` | `op`, `target`, `network`, `from` |
| `lifecycle_submitted` | `op`, `tx_hash` |
| `lifecycle_included` | `op`, `tx_hash`, `status` |
| `lifecycle_failed` | `op`, `reason`, `detail` |

**`otigen inspect`**

| Event | Fields |
|---|---|
| `inspect_start` | `target`, `network` |
| `inspect_result` | `target`, `address`, `account_type`, `balance`, `nonce`, `code_hash`, `code_size_bytes`, `state_root`, plus optional ABI summary fields |

**`otigen test`**

| Event | Fields |
|---|---|
| `test_suite_start` | `file`, `total` |
| `test_start` | `name` |
| `test_pass` | `name`, `duration_ms`, `gas_used` |
| `test_fail` | `name`, `duration_ms`, `gas_used`, `reason` |
| `test_suite_done` | `passed`, `failed`, `skipped` |

**`otigen verify`**

| Event | Fields |
|---|---|
| `verify_start` | `target`, `network`, `bundle` |
| `verify_result` | `target`, `network`, `address`, `local_wasm_size`, `chain_wasm_size`, `local_wasm_hash`, `chain_wasm_hash`, `matches`, optional `first_diff_offset`, `bundle` |

Authoritative source is the `Event` enum in [`crates/otigen-cli/src/events.rs`](https://github.com/pyde-net/otigen/blob/main/crates/otigen-cli/src/events.rs); if the table above ever disagrees with the enum, the enum wins (and the spec is the bug).

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
6. Upload to the GitHub Release for the tag. Releases are published cross-repo to the public mirror at [`pyde-net/test-releases`](https://github.com/pyde-net/test-releases) under a product-prefixed tag (`otigen-vX.Y.Z`) so the same mirror can host every Pyde toolchain release (`engine-vX.Y.Z`, …) anonymously without per-product asset name collisions. Authors install via the canonical `curl -fsSL https://raw.githubusercontent.com/pyde-net/test-releases/main/otigen/install.sh | bash` one-liner.

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
