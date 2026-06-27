# Commands reference

Every subcommand the `otigen` binary exposes — what it does, what it accepts, what it prints. For the formal contract on flag values, exit codes, and event streams, see [`OTIGEN_BINARY_SPEC.md`](../companion/OTIGEN_BINARY_SPEC.md). (The spec is the authoritative source; where this chapter and the spec disagree, the binary's `--help` output is the runtime truth and the spec is the one being chased.)

Global flags apply to every subcommand:

| Flag | Default | What it does |
| --- | --- | --- |
| `-v` / `-vv` | off | Verbose / debug-level log output. `-v` enables `INFO`, `-vv` adds `DEBUG`. |
| `-q` / `--quiet` | off | Suppress non-error output. |
| `--json` | off | Emit structured NDJSON events to stdout (one event per line) — for CI / scripting consumers. |
| `--network <NAME>` | `[network.default]` in `otigen.toml` | Override the network selected by the manifest. |
| `--keystore <PATH>` | `~/.pyde/keystore.json` | Override the default keystore path. |
| `--config <PATH>` | `./otigen.toml` | Override the default config path. |

Path defaults that say `<config-dir>/...` are resolved against the parent of `--config`, not the cwd. Invocations from outside the project tree therefore find / write bundles next to the project.

---

## `otigen new`

Scaffold a new project by cloning a canonical template. The fastest path from zero to a green test run.

```text
otigen new [OPTIONS] [NAME]
otigen new --list           # show the template catalog
```

| Argument / flag | Type | Default | What it does |
| --- | --- | --- | --- |
| `[NAME]` | string | prompt on TTY | Project name (ENS-style: lowercase + hyphens, 1–32 chars). |
| `--lang <LANG>` | enum | prompt on TTY | Target language (`rust`, `as`, `go`, `c`). Non-Rust scaffolds fall through to the same minimal-counter starter as `otigen init --lang <lang>`; only Rust currently has canonical example templates. |
| `--from <TEMPLATE>` | name | prompt on TTY | Canonical template to clone. `otigen new --list` shows what's available (currently 8: counter, erc20-token, erc721-token, simple-multisig, upgradeable-proxy, merkle-claim-airdrop, vesting, dao-governance). |
| `--list` | — | — | Print the template catalog and exit. Mutually exclusive with `<NAME>` / `--lang` / `--from` / `--dir`. |
| `--dir <DIR>` | path | `./<name>` | Target directory. Created if missing; refuses to overwrite an existing path. |

```bash
otigen new --list
otigen new my-counter --from counter
otigen new my-token --from erc20-token --dir ./projects/my-token
```

The cloned scaffold preserves the template's full file tree (Cargo.toml, otigen.toml, src/, tests/, Makefile). For `--lang go` / `--lang as` / `--lang c`, `new` falls through to the same minimal counter scaffold as `otigen init --lang <lang>` (no canonical Rust-equivalent examples ship in those languages yet).

---

## `otigen init`

Scaffold a new minimal project for a specific language. Use this when you want the canonical counter contract in TinyGo / AssemblyScript / C; for Rust prefer `otigen new --from counter`.

```text
otigen init [OPTIONS] [NAME]
```

| Argument / flag | Type | Default | What it does |
| --- | --- | --- | --- |
| `[NAME]` | string | prompt on TTY | Project name (ENS-style: lowercase + hyphens, 1–32 chars). |
| `--lang <LANG>` | enum | prompt on TTY | Target language: `rust`, `as` (AssemblyScript), `go` (TinyGo), `c` (clang `--target=wasm32`). |
| `--type <TYPE>` | enum | `contract` | `contract` or `parachain`. Parachain projects add the §8 parachain-only host fns to the imports surface. |
| `--dir <DIR>` | path | `./<name>` | Target directory. Created if missing; refuses overwrite. |

```bash
otigen init my-counter --lang rust
otigen init my-parachain --lang go --type parachain
otigen init my-c-contract --lang c --dir ~/projects/my-c-contract
```

The scaffold ships a minimal counter (`increment` + `get`), a language-aware Makefile, an `otigen.toml`, and a `tests/contract.test.toml` with 3 behaviour tests. Run `otigen test` immediately to confirm the toolchain is wired.

---

## `otigen check`

Validate the project without packaging. Fast alternative to `otigen build` for pre-commit hooks and IDE integrations.

```text
otigen check [OPTIONS]
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--no-compile` | off | Skip the language compiler invocation. Validates the existing `.wasm` as-is. |

Runs the `otigen.toml` parser + WASM validator + ABI extractor. Skips the bundle write. Typical latency on a small contract: tens of milliseconds.

```bash
otigen check
otigen check --no-compile
```

---

## `otigen build`

Validate + package the compiled `.wasm` into a deploy bundle.

```text
otigen build [OPTIONS]
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--release` | (currently no-op) | Reserved for future release-build validation. Today both `--release` and bare `otigen build` produce the same bundle; the debug-vs-release split is enforced at deploy time only. |
| `--debug` | off | Compile with debug profile. Reject at deploy time, useful for inspection only. |
| `--no-compile` | off | Skip the language compiler — package the existing `.wasm` as-is. |
| `--no-strict` | off | Disable the production gate that rejects test-only host fns (e.g. `pyde::debug_log`). Default is strict so the bundle is chain-deploy-safe. Escape hatch for bundling chain-unsafe wasm for local inspection / fuzzing; never use for a bundle that will reach a network. |
| `--out <PATH>` | `<config-dir>/artifacts/` | Override the bundle output **directory** — `<name>.bundle/` is created inside it. Anchored on the parent of `--config` so invocations from outside the project dir (`otigen --config path/to/otigen.toml build`) write next to the project, not the cwd. |

Output bundle lands at `--out` (default `<config-dir>/artifacts/<name>.bundle/`) with:

- `contract.wasm` — the compiled binary (blake3-checksummed).
- `abi.json` — the contract's ABI extracted from `[functions.*]`.
- `manifest.json` — canonical manifest snapshot (build-deterministic apart from a `build_timestamp` field).
- `metadata.json` — JSON-extracted `[metadata]` section (the project's source URL, license, description). Hashed into `manifest.metadata_hash_blake3` for explorer verification.
- `otigen.toml` — the source manifest copied verbatim so `otigen deploy` / `verify` / `test` can re-read declarations from a bundle without the source tree.

Exits non-zero on validation failure (`VALIDATION_FAILURE` = 1). Scripts can rely on the exit code.

```bash
otigen build
otigen build --json              # NDJSON event stream for CI
otigen build --no-compile        # repackage existing wasm
```

---

## `otigen test`

Run contract behaviour tests declared in `tests/*.test.toml`.

```text
otigen test [OPTIONS]
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--dry-run` | off | Parse + resolve only — no WASM execution. Useful for validating a `.test.toml` against the contract's `[state]` schema. |
| `--filter <SUBSTR>` | none | Substring filter — only tests whose name contains this pattern run. Repeating the flag last-wins. |
| `--bundle <DIR>` | `./artifacts/<name>.bundle/` | Override the bundle directory. Parity with `deploy --bundle` / `verify --bundle`. |
| `--watch` | off | Re-run on file change. Debounced 300 ms; ignores `target/`, `artifacts/`, `.git/`, `node_modules/`, `build/`, `dist/`. |
| `--no-engine` | off | Use the legacy in-process mock host-fn surface instead of `pyde-engine-wasm-exec::WasmExecutor`. The engine path is the default and source of truth. |
| `--no-compile` | off | Skip the per-language compiler. Run the test suite against the existing `.wasm` as-is. |

Verbosity is the standard global `-v` flag, repeated for more detail:

```bash
otigen test                # default — per-test pass/fail + duration
otigen test -v             # + INFO logs
otigen test -vv            # + DEBUG (host-fn calls, slot derivations)
otigen test --json         # NDJSON event stream
```

For per-call assertions + storage-diff rendering, declare them in `[tests.expect]` / `expect.*` in the test TOML; failures print the expected-vs-actual. See [`OTIGEN_TEST_SPEC.md`](../companion/OTIGEN_TEST_SPEC.md) for the test DSL.

---

## `otigen wallet`

Manage FALCON-512 signing accounts in `~/.pyde/keystore.json`.

```text
otigen wallet <ACTION> [OPTIONS]
```

Subactions: `new`, `import`, `list`, `show`, `delete`, `password`, `export`, `sign`, `verify`.

### `wallet new`

Create a fresh keypair, prompt for a password, encrypt + store.

```text
otigen wallet new [NAME] [--password-stdin]
```

`[NAME]` is positional and optional — omitted prompts on a TTY (errors under `--json` or piped stdin). `--password-stdin` reads the encryption password from stdin (two consecutive lines — password + confirmation — or a single line treated as both).

```bash
otigen wallet new deployer
printf 'pw\npw\n' | otigen wallet new alice --password-stdin
```

### `wallet import`

Import an existing keypair into the keystore. Three modes:

```text
otigen wallet import [NAME]                              # interactive: paste pubkey + secret key
otigen wallet import --from-file <PATH> <NAME>           # restore a wallet export
otigen wallet import --from-devnet [--prefix <P>] [--count <N>] [--password-stdin]
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--from-file <PATH>` | none | Read a backup JSON (`otigen wallet export` output). The original password still decrypts it. |
| `--from-devnet` | off | Bulk-import the 10 deterministic prefunded `pyde devnet` accounts (`Blake3("pyde-devnet-v1/" \|\| i)`). Public secrets — good for tests, bad for real value. |
| `--prefix <PREFIX>` | `devnet-` | Name prefix used when `--from-devnet` is set. Imports as `<prefix>0`..`<prefix>9`. |
| `--count <N>` | `10` | Number of prefunded accounts to import under `--from-devnet`. |
| `--password-stdin` | off | Read the encryption password from stdin. Currently honoured under `--from-devnet` only; interactive imports still use the rpassword prompt. |

```bash
printf 'pw\npw\n' | otigen wallet import --from-devnet --password-stdin
otigen wallet import --from-file ./alice.backup.json alice
```

### `wallet list`

```text
otigen wallet list
```

Print every account name + address in the keystore. Touches no encrypted material.

### `wallet show`

```text
otigen wallet show <NAME>
```

Print one account's address + public key. No password needed.

### `wallet delete`

```text
otigen wallet delete <NAME> [--yes]
```

Remove an account. Asks for confirmation (re-type the account name) unless `--yes`.

### `wallet password`

```text
otigen wallet password <NAME>
```

Re-encrypt the account under a new password. The keypair itself is unchanged. Password rotation requires a real PTY today — no `--password-stdin` on this subcommand yet.

### `wallet export`

```text
otigen wallet export <NAME> [--out <PATH>]
```

Export the account as a portable encrypted backup. Same Argon2id + AES-256-GCM ciphertext as the in-keystore entry; the original password decrypts it. **No password prompt** — the export ciphers-as-is. Restore later with `wallet import --from-file`.

```bash
otigen wallet export alice --out ./alice.backup.json
otigen wallet export alice > ./alice.backup.json
```

### `wallet sign`

FALCON-512 sign arbitrary message bytes. For off-chain attestations / signing challenges. **Don't use for chain transactions** — `deploy` / `upgrade` / `call` sign the canonical Poseidon2 tx hash, which is what the chain verifier expects.

```text
otigen wallet sign [OPTIONS] --message <MESSAGE> [NAME]
```

| Flag | Default | What it does |
| --- | --- | --- |
| `-m`, `--message <MSG>` | required | Message to sign. UTF-8 by default; with `--hex` decoded as hex. |
| `--hex` | off | Decode `--message` as hex (`0x`-prefix optional). |
| `--password-stdin` | off | Read the wallet password from stdin. |

```bash
otigen wallet sign devnet-0 --message "hello world"
otigen wallet sign devnet-0 --message 0xdeadbeef --hex --password-stdin <<< pw
```

### `wallet verify`

Verify a signature against a message + public key. Exit code is the verdict: 0 on valid, 1 on invalid.

```text
otigen wallet verify [OPTIONS] [NAME] --message <MSG> --signature <HEX>
```

| Flag | Default | What it does |
| --- | --- | --- |
| `[NAME]` | none | Wallet name whose public key signs. Mutually exclusive with `--pubkey`. |
| `--pubkey <HEX>` | none | Verify against an arbitrary public key (e.g. a counterparty's). |
| `--message <MSG>` | required | Message that was signed. UTF-8; pass `--hex` for binary. |
| `--signature <HEX>` | required | The signature output by `wallet sign`. |
| `--hex` | off | Decode `--message` as hex. |

```bash
otigen wallet verify devnet-0 --message "hello world" --signature 0x...
otigen wallet verify --pubkey 0x09... --message 0xdeadbeef --hex --signature 0x...
```

---

## `otigen deploy`

Sign and submit a deploy transaction.

```text
otigen deploy [OPTIONS]
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--bundle <PATH>` | `<config-dir>/artifacts/<name>.bundle/` | Bundle directory to deploy. Anchored on the parent of `--config` so deploys from outside the project dir find the bundle next to the project. |
| `--from <WALLET>` | `[wallet.default_account]` | Signing account. |
| `[ARGS...]` | none | Typed positional constructor args, marshalled per `[functions.init].inputs` in declaration order. Same encoder + wallet-name address resolution as `otigen call`. Mutually exclusive with `--args`. |
| `--args <HEX>` | empty | Pre-encoded borsh calldata for the constructor (`init`), hex-encoded. Renamed from `--init-arg` to match `otigen call --args`. Mutually exclusive with positional constructor args. |
| `--value <QUANTA>` | `0` | Optional native PYDE transfer to the freshly-deployed contract account (decimal quanta — 1 PYDE = 10⁹ quanta). The constructor sees it via `pyde::ctx::value()`; forfeited per PIP-4 if the constructor reverts. |
| `--dry-run` | off | Build + sign the tx but don't submit. Useful for inspecting the wire bytes. |
| `--no-wait` | off | Submit and exit without polling for the receipt. |
| `--password-stdin` | off | Read wallet password from stdin. |
| `--rpc-url <URL>` | from `otigen.toml` | One-shot RPC URL override. Bypasses the bundle's baked `[network.<name>]`. **REQUIRES `--chain-id`.** |
| `--chain-id <N>` | from `otigen.toml` | Required when `--rpc-url` is set; the chain's tx-hash domain. The CLI refuses `--rpc-url` without `--chain-id` (signed tx against `chain_id = 0` silently bricks the FALCON signature). |

Receipt poll timeout is 60 s (constant, not CLI-configurable). On success the contract address appears in the receipt; the CLI prints it.

```bash
otigen deploy --from devnet-0 --password-stdin <<< pw
otigen deploy --from devnet-0 \
              --rpc-url http://127.0.0.1:29933 \
              --chain-id 31337 \
              --password-stdin <<< pw
otigen deploy --dry-run     # print wire bytes, don't submit
```

There is no `--gas-limit` / `--gas-price` flag today; values come from `[deploy]` in `otigen.toml` (`gas_limit = 10_000_000`, `gas_price = "auto"`).

---

## `otigen upgrade`

Replace a contract's WASM via the upgrade flow (spec §3.4).

> **Status (v1):** The chain has no `TxType::Lifecycle` handler yet. The CLI refuses to submit by default (`EngineNotReady`). See [Lifecycle](./lifecycle.md) for the v1 proxy-pattern alternative and the `--i-know-engine-rejects` bypass.

```text
otigen upgrade [OPTIONS] <TARGET>
```

| Flag | Default | What it does |
| --- | --- | --- |
| `<TARGET>` | required | Contract name (registered) or `0x`-prefixed address. |
| `--bundle <PATH>` | `./artifacts/<name>.bundle` | Bundle directory containing the new `contract.wasm`. Mutually exclusive with `--wasm`. |
| `--wasm <PATH>` | none | Explicit path to the new `.wasm`. Mutually exclusive with `--bundle`. |
| `--from <WALLET>` | `[wallet.default_account]` | Signing account. |
| `--no-wait` | off | Submit and exit without polling. |
| `--password-stdin` | off | Read wallet password from stdin. |
| `--i-know-engine-rejects` | off | Bypass the `EngineNotReady` gate. See `deploy --help`-style warning above. |
| `--rpc-url <URL>` | from `otigen.toml` | One-shot RPC URL override. REQUIRES `--chain-id`. |
| `--chain-id <N>` | from `otigen.toml` | Required when `--rpc-url` is set. |

---

## `otigen pause` / `unpause` / `kill`

Lifecycle controls (spec §3.5). Same `EngineNotReady` gate as `upgrade`.

```text
otigen pause   [OPTIONS] <TARGET>
otigen unpause [OPTIONS] <TARGET>
otigen kill    [OPTIONS] <TARGET> [--yes]
```

All three share the same flag surface as `upgrade`:

| Flag | Default | What it does |
| --- | --- | --- |
| `<TARGET>` | required | Contract name or `0x`-prefixed address. |
| `--from <WALLET>` | `[wallet.default_account]` | Signing account. |
| `--no-wait` | off | Submit and exit without polling. |
| `--password-stdin` | off | Read wallet password from stdin. |
| `--i-know-engine-rejects` | off | Bypass the `EngineNotReady` gate. |
| `--rpc-url <URL>` | from `otigen.toml` | RPC override. REQUIRES `--chain-id`. |
| `--chain-id <N>` | from `otigen.toml` | Required when `--rpc-url` is set. |
| `--yes` (kill only) | off | Skip the interactive "re-type the contract name" confirmation. |

```bash
otigen pause   my-counter --from devnet-0 --i-know-engine-rejects --password-stdin <<< pw
otigen unpause my-counter --from devnet-0 --i-know-engine-rejects --password-stdin <<< pw
otigen kill    my-counter --from devnet-0 --i-know-engine-rejects --yes --password-stdin <<< pw
```

---

## `otigen call`

Invoke a function on a deployed contract. View vs mutating is decided by the presence of `--from`: with a signing wallet the call submits a tx; without one it runs in view mode via `pyde_call`.

```text
otigen call [OPTIONS] <TARGET> <FUNCTION> [ARGS...]
```

| Arg / Flag | Default | What it does |
| --- | --- | --- |
| `<TARGET>` | required | Contract name or `0x`-prefixed address. |
| `<FUNCTION>` | required | Function name from the contract's ABI. |
| `[ARGS...]` | none | Typed positional args. Marshalled per `[functions.<FUNCTION>].inputs` in declaration order. Mutually exclusive with `--args`. See "Typed arguments" below. |
| `--args <HEX>` | none | Pre-encoded borsh calldata, hex-encoded. Escape hatch when typed args don't fit (e.g. calling a contract without a local `otigen.toml`). Mutually exclusive with positional `ARGS`. |
| `--raw` | off | Preserve raw hex output for view-call returns. Default behaviour decodes per `[functions.<FUNCTION>].outputs`. |
| `--value <QUANTA>` | `0` | Native PYDE to attach to a mutating call (quanta = 10⁻⁹ PYDE). |
| `--from <WALLET>` | none (view mode) | Signing account. Presence flips the call to a state-mutating signed tx. |
| `--no-wait` | off | For mutating calls: submit + exit without polling. |
| `--password-stdin` | off | Read wallet password from stdin. |
| `--rpc-url <URL>` | from `otigen.toml` | RPC override. View-mode `--rpc-url` does NOT require `--chain-id` (no tx signed). Mutating-mode calls reject `--rpc-url` outright (the CLI exits with `CfgRequired` — state-mutating calls need a local `otigen.toml` so the resolver can find the chain id + wallet defaults). Use `--rpc-url` only for view queries. |

### Typed arguments

Positional `ARGS` are marshalled per `[functions.<fn>].inputs` in declaration order. Per type:

- **Primitives** (`u8`..`u128`, `i8`..`i128`, `bool`, `address`, `hash32`, `bytes`, `string`) — bare values. `address`-typed inputs accept either a `0x`-prefixed 64-char hex literal OR a wallet name from the local keystore (`devnet-0`, `alice`, …) — wallet names resolve to the keystore entry's address.
- **`vec(T)`** — JSON array literal: `'[1,2,3]'` (standard borsh `Vec<T>` wire shape).
- **Struct from `[types.<Name>]`** — JSON5 object literal: `'{maker:devnet-0,amount:100,paid:false}'`. Field order does not matter; the marshaller looks fields up by name.
- **Enum from `[types.<Name>]`** — variant name as a bare string: `Pending`. v1 enums are unit-only.
- **Unquoted `0x` hex literals** of 16+ chars are auto-quoted before JSON5 parse, so 32-byte hash + address values don't need surrounding quotes inside struct + array literals.

```bash
# View mode (free, no tx, no gas, no signing):
otigen call my-counter get
otigen call my-token balance_of devnet-0          # wallet-name address
otigen call my-token balance_of 0x9b8c...         # explicit hex address
otigen call my-pool   echo_amounts '[100,200,300]'

# Struct + enum
otigen call my-orders create '{maker:devnet-0,amount:100,paid:false}'
otigen call my-orders set_status Active

# Raw hex view return (default decodes)
otigen call my-token balance_of devnet-0 --raw    # 0x40420f00000000000000000000000000

# Mutating mode (signed tx):
otigen call my-counter increment --from devnet-0 --password-stdin <<< pw
otigen call my-token   transfer 0x9b8c... 1000 --from devnet-0 --password-stdin <<< pw
otigen call my-token   transfer devnet-1 1000  --from devnet-0 --password-stdin <<< pw

# Escape hatch — pre-encoded calldata when no local otigen.toml is available
otigen call my-contract some_fn --args 0x0100000000000000
```

### Auto-decoded view returns

By default, view-call returns are decoded per `[functions.<fn>].outputs`:

- Single output → bare value (`1000000` for a `uint128`).
- Multi-output → tuple syntax (`(true, 1000000)`).
- Compound shapes (`vec(T)`, `struct(<Name>)`, enum) → JSON5-style.

`--raw` preserves the on-wire hex — useful for piping into external decoders or for contracts the CLI doesn't have an `outputs` schema for. In `--json` mode the `call_result` event carries `return_data` (raw hex) alongside a separate `decoded` field with the decoded form (see [`crates/otigen-cli/src/commands/call.rs`](https://github.com/pyde-net/otigen/blob/main/crates/otigen-cli/src/commands/call.rs) for the exact event shape).

---

## `otigen send`

Native PYDE transfer between accounts. The simplest tx the chain processes — `TxType::Standard` against a recipient with no `data`, the cheapest gas budget the engine accepts (`MIN_GAS_LIMIT = 21000`).

```text
otigen send [OPTIONS] <RECIPIENT> <AMOUNT>
```

| Arg / Flag | Default | What it does |
| --- | --- | --- |
| `<RECIPIENT>` | required | `0x`-prefixed 32-byte address OR a wallet name from `~/.pyde/keystore.json` (e.g. `devnet-1`). Omitted ⇒ prompt on a TTY. |
| `<AMOUNT>` | required | Amount in quanta (1 PYDE = 10⁹ quanta). Decimal with `_` separators (`100_000_000`) or `0x`-hex. Omitted ⇒ prompt on a TTY. |
| `--from <WALLET>` | `[wallet.default_account]` | Sender wallet account name. |
| `--no-wait` | off | Skip the receipt poll — return immediately after submission with the tx hash. |
| `--password-stdin` | off | Read wallet password from stdin. |
| `--rpc-url <URL>` | from `otigen.toml` | One-shot RPC URL override. **REQUIRES `--chain-id`.** |
| `--chain-id <N>` | from `otigen.toml` | Required when `--rpc-url` is set; the chain's tx-hash domain. |
| `--gas-limit <N>` | `MIN_GAS_LIMIT` (21000) | Override the default gas budget. Rarely needed for an EOA-to-EOA transfer; raise it when the recipient is a contract that performs work in its receive hook. |

```bash
otigen send devnet-1 100_000_000 --from devnet-0 --password-stdin <<< pw
otigen send 0xabc... 0x5f5e100  --from devnet-0 --password-stdin <<< pw
otigen send devnet-1 100 --from devnet-0 \
            --rpc-url http://127.0.0.1:29933 --chain-id 31337 \
            --password-stdin <<< pw
```

---

## `otigen inspect`

Read contract / account metadata + storage (spec §3.6).

```text
otigen inspect [OPTIONS] <TARGET>
```

| Flag | Default | What it does |
| --- | --- | --- |
| `<TARGET>` | required | Contract name or `0x`-prefixed address. |
| `--state-field <NAME>` | none | Substrate-typed storage read. Slot = `Poseidon2(self_address ‖ field_name)`; decoded per the `[state].schema` type token. Use this for any contract built with `#[pyde::declare_storage]`. |
| `--field <NAME>` | none | Legacy pre-substrate raw-slot read. Slot = `Poseidon2(name.as_bytes())`. Mutually exclusive with `--state-field`. |
| `--at-wave <N>` | none | Read state as of a specific wave. Honored only by archive nodes. |
| `--rpc-url <URL>` | from `otigen.toml` | One-shot RPC override. Skips `otigen.toml` network resolution entirely. |

Default mode prints the account snapshot: address, account type, balance, nonce, code hash, code size, state root. `--state-field` / `--field` short-circuit to a single-slot read.

```bash
otigen inspect 0xabc...                            # full account snapshot
otigen inspect 0xabc... --state-field counter      # substrate field
otigen inspect 0xabc... --field counter            # legacy raw-slot field
otigen inspect my-token --rpc-url https://rpc.example
```

---

## `otigen verify`

Verify that a deployed contract's bytes match a local bundle (spec §3.9).

```text
otigen verify [OPTIONS] <TARGET>
```

| Flag | Default | What it does |
| --- | --- | --- |
| `<TARGET>` | required | Contract address or name. |
| `--bundle <PATH>` | `<config-dir>/artifacts/<target>.bundle/` (name TARGET) or `<config-dir>/artifacts/<contract.name>.bundle/` (hex TARGET) | Local bundle to compare against. |
| `--strict-toolchain` | off | Also compare the toolchain version pin in `manifest.json` against the running rustc / TinyGo / asc / clang. Mismatch fails verify even when bytes match. |
| `--explorer <URL>` | none | Submit the bundle to an external verifying explorer. Posts `(contract.wasm, manifest.json, metadata.json)` to `<URL>/api/v1/contracts/<addr>/verify`. |
| `--api-key-env <VAR>` | `EXPLORER_API_KEY` | Read the explorer API key from an env var (bearer token). Default `EXPLORER_API_KEY` — set the env var and you can omit the flag. |
| `--api-key-stdin` | off | Read the explorer API key from stdin. |

```bash
otigen verify 0xabc...
otigen verify 0xabc... --bundle ./snapshot/my-token.bundle
otigen verify 0xabc... --explorer https://explorer.pyde.network --api-key-env PYDE_EXPLORER_KEY
otigen verify 0xabc... --strict-toolchain
```

---

## `otigen devnet`

Run a local devnet. The chain runtime is embedded in the `otigen` binary — no separate `pyde` download. Single validator, deterministic genesis pre-fund, Ctrl-C for graceful shutdown.

```text
otigen devnet [OPTIONS]
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--rpc-listen <ADDR>` | none (banner-only) | JSON-RPC server bind address. Pass `127.0.0.1:9933` to enable RPC so `deploy` / `call` / `console` have a target. |
| `--prefund-count <N>` | `10` | Number of pre-funded accounts (`devnet-0`..`devnet-N-1`). |
| `--prefund-amount <QUANTA>` | engine default | Per-account genesis balance. |
| `--chain-id <ID>` | `31337` | Chain id this devnet signs against. |
| `--tick-ms <MS>` | `1000` | Idle-wave tick interval. Empty waves still commit every `--tick-ms` so `wave_id` advances. |
| `--fork <FILE_OR_URL>` | none | Bootstrap state from an existing chain snapshot. Local borsh file or HTTP(S) URL pointing at `pyde_getSnapshot`. Mutually exclusive with `--prefund-*`. *(See [Lifecycle](./lifecycle.md) — there is a known state-root-mismatch issue forking a live devnet; the file path is the more reliable mode today.)* |
| `--no-auto-import-wallets` | off | Skip the startup auto-import of `devnet-0..devnet-9` into the local keystore (password `"devnet"`). Default is to import — the anvil-style one-command UX. Set this when running against a pre-populated keystore or in CI. |

On startup, `devnet` auto-imports `devnet-0..devnet-9` into the local keystore with password `"devnet"` so `otigen deploy --from devnet-0` works without a separate `wallet import --from-devnet` step. Pass `--no-auto-import-wallets` to skip this when running against a populated keystore or in CI.

```bash
otigen devnet --rpc-listen 127.0.0.1:9933
otigen devnet --rpc-listen 127.0.0.1:9933 --tick-ms 500
otigen devnet --fork ./snapshot.borsh --rpc-listen 127.0.0.1:9934
```

Validator + full-node roles still ship via the engine's own `pyde` binary — operator concerns, not author concerns.

---

## `otigen console`

Interactive REPL against a Pyde node (spec §3.8).

```text
otigen console [OPTIONS]
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--from <WALLET>` | `[wallet.default_account]` | Account name for `tx` commands. Views work without a sender bound. |
| `--password-stdin` | off | Read wallet password from stdin (cached for the session after first `tx`). |

Drops into a `pyde>` prompt with line editing and persistent history. The MVP surface today:

| Command | What it does |
| --- | --- |
| `help` | Show the catalog. |
| `balance <ADDR>` | PYDE balance. |
| `nonce <ADDR>` | Next nonce. |
| `call <ADDR> <FN> [HEX]` | View call (free, no tx). |
| `tx <ADDR> <FN> [HEX] [--value <DEC>]` | Sign + submit + receipt poll. Wallet unlocked once, cached. |
| `state <ADDR> <FIELD>` | Substrate-typed scalar storage read. |
| `events <ADDR> [--from N] [--to N] [--limit N]` | Pull `pyde_getLogs` with optional wave bounds. |
| `subscribe <ADDR>` | WebSocket subscription to live events emitted by a contract (blocks until Ctrl-C). |
| `exit` / `quit` | Leave. |

Addresses accept either `0x...` hex or registered names (resolved via `pyde_resolveName`).

```bash
otigen console --network devnet --from devnet-0
```

---

## `otigen validator`

Read-only queries over the chain-side validator registry.

```text
otigen validator <ACTION> [OPTIONS]
```

| Subaction | Usage | What it returns |
| --- | --- | --- |
| `show <ADDR>` | `otigen validator show 0x...` | One validator's full record: operator, pubkey, stake, status, jail/unbond timeline, last-claimed rps, uptime. |
| `by-operator <ADDR>` | `otigen validator by-operator 0x...` | Every validator an operator runs. |

Exits non-zero with `NotAValidator` for unregistered addresses so scripts can branch on exit code without parsing stdout.

```bash
otigen validator show 0xabc...
otigen validator by-operator 0xdef...
```

Registration / stake / unbond / unjail flows live on the engine's `pyde` binary — those are tx submission, not introspection.

---

## `otigen update`

Pull the latest release and replace the binary. Wraps the canonical curl install one-liner so you don't have to copy the URL each time.

```text
otigen update [OPTIONS]
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--version <V>` | `latest` | Install a specific tag instead of the freshest one. Accepts either `v0.1.0-alpha.4` or the mirror's full `otigen-v0.1.0-alpha.4`. |
| `--check` | off | Print the latest version + the currently installed one and exit. No filesystem side-effect. Exit code 0 = up-to-date, non-zero = drift. Handy for pre-commit hooks. |
| `--no-verify-sig` | off | Skip the install script's sigstore verification. Use only on locked-down machines that can't install `cosign`. |

```bash
otigen update                          # latest
otigen update --version v0.1.0-alpha.3 # pin a tag
otigen update --check                  # poll without side effect
```

Under the hood: `curl -fsSL <install-url> | bash -s -- <flags>`. Same URL the [installation page](./installation.md) documents; `otigen update` is just sugar so the flow stays inside the CLI.
