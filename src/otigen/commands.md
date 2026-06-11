# Commands reference

Every subcommand the `otigen` binary exposes — what it does, what it accepts, what it prints. For the formal contract on flag values, exit codes, and event streams, see [`OTIGEN_BINARY_SPEC.md`](../companion/OTIGEN_BINARY_SPEC.md).

Global flags apply to every subcommand:

| Flag | Default | What it does |
|---|---|---|
| `-v` / `-vv` | off | Verbose / debug-level log output. `-v` enables `INFO`, `-vv` adds `DEBUG`. |
| `-q` / `--quiet` | off | Suppress non-error output. |
| `--json` | off | Emit structured NDJSON events to stdout (one event per line) — for CI / scripting consumers. |
| `--network <NAME>` | `[network.default]` in `otigen.toml` | Override the network selected by the manifest (e.g. `--network devnet`). |
| `--keystore <PATH>` | `~/.pyde/keystore.json` | Override the default keystore path. |
| `--config <PATH>` | `./otigen.toml` | Override the default config path. |

---

## `otigen init`

Scaffold a new project from a language template.

```text
otigen init [OPTIONS] --lang <LANG> <NAME>
```

| Argument / flag | Type | Default | What it does |
|---|---|---|---|
| `<NAME>` | string | required | Project name. Used for the directory and the contract identity. ENS-style: lowercase + hyphens, 1–32 chars. |
| `--lang <LANG>` | enum | required | Target language. One of: `rust`, `as` (AssemblyScript), `go` (TinyGo), `c` (C / C++ via `clang --target=wasm32`). |
| `--type <TYPE>` | enum | `contract` | `contract` or `parachain`. Parachain projects get the §8 parachain-only host fns added to the imports surface. |
| `--dir <DIR>` | path | `./<name>` | Target directory. Created if missing; must be empty if it exists. |

The scaffolded project ships a minimal counter contract (`increment` + `get`), a `Makefile` with the language-specific build commands, an `otigen.toml` manifest, and a `tests/contract.test.toml` with 3 behaviour tests. Run `otigen test` immediately to confirm the toolchain is wired.

```bash
otigen init --lang rust my-token
otigen init --lang go --type parachain my-parachain
otigen init --lang c --dir ~/projects/my-c-contract my-c-contract
```

---

## `otigen new`

Scaffold a new project by cloning a canonical example.

```text
otigen new [OPTIONS] <TEMPLATE> [DIR]
```

| Argument / flag | Type | Default | What it does |
|---|---|---|---|
| `<TEMPLATE>` | name | required | Canonical example to copy. `erc20-token`, `erc721-token`, `amm-uniswap-v2`, `nft-marketplace`, etc. — anything under `pyde-net/otigen/examples/`. |
| `[DIR]` | path | `./<template>` | Target directory. |

Useful for starting from a working multi-file project instead of the minimal `init` scaffold. The clone preserves the example's full file tree, including tests + Makefile.

```bash
otigen new amm-uniswap-v2
otigen new erc20-token ./my-token
```

---

## `otigen check`

Validate the project without packaging. Fast alternative to `otigen build` for pre-commit hooks and IDE integrations.

```text
otigen check [OPTIONS]
```

Runs the same `otigen.toml` parser + WASM validator + ABI extractor as `build`, but skips the bundle write. Typical latency on a small contract: a few tens of milliseconds.

```bash
otigen check
```

---

## `otigen build`

Validate + package the compiled `.wasm` into a deploy bundle.

```text
otigen build [OPTIONS]
```

Expects the language toolchain has already produced the `.wasm` at the path declared in `[contract.lang].output` (run `make build` first for go/as/c, or `cargo build --target wasm32-unknown-unknown --release` for Rust).

Output bundle lands at `./artifacts/<name>.bundle/` with:
- `contract.wasm` — the compiled binary (sigstore-checksummed via blake3)
- `abi.json` — the contract's ABI extracted from `[functions.*]`
- `manifest.json` — canonical manifest snapshot (`build_timestamp` is the only non-deterministic field — `make reproducibility` confirms byte-identity modulo this field)

```bash
otigen build
otigen build --json     # NDJSON event stream for CI
```

---

## `otigen test`

Run contract behaviour tests declared in `tests/*.test.toml`.

```text
otigen test [OPTIONS]
```

| Flag | Default | What it does |
|---|---|---|
| `--watch` | off | Auto-rerun on file change. Useful for tight TDD loops. |
| `-vv` / `-vvv` / `-vvvv` | off | Increase verbosity. `-vv` shows gas; `-vvv` adds events; `-vvvv` adds full traces + storage diffs. |
| `--no-engine` | off | Run against the legacy mock executor instead of the embedded engine. For debugging executor drift; the engine is the default and the spec-compliant path. |

Tests execute through the same `WasmExecutor::execute_call` path the chain runs, so behaviour matches deployment exactly. See [`OTIGEN_TEST_SPEC.md`](../companion/OTIGEN_TEST_SPEC.md) for the test DSL.

```bash
otigen test
otigen test -vvvv          # gas + events + traces + storage diffs
otigen test --watch
```

---

## `otigen wallet`

Manage FALCON-512 signing accounts in `~/.pyde/keystore.json`.

```text
otigen wallet <ACTION> [OPTIONS]
```

Subactions:

### `wallet new`

Create a fresh keypair, prompt for a password, encrypt + store.

```text
otigen wallet new <NAME>
```

```bash
otigen wallet new deployer
```

### `wallet import`

Import an existing keypair into the keystore. Two paths:

```text
otigen wallet import <NAME>                                # interactive — pastes pubkey + secret key on the prompts
otigen wallet import --from-file <PATH> <NAME>             # restore an exported backup
otigen wallet import --from-devnet [--prefix <P>] [--count <N>]  # bulk-import the 10 deterministic prefunded devnet accounts
```

| Flag | Default | What it does |
|---|---|---|
| `--from-file <PATH>` | none | Read backup JSON (`otigen wallet export` output) instead of prompting. |
| `--from-devnet` | off | Import the 10 prefunded `pyde devnet` accounts. Their secrets are public (derived via `Blake3("pyde-devnet-v1/" \|\| i)`); good for tests, bad for anything real. |
| `--prefix <PREFIX>` | `devnet-` | Name prefix when `--from-devnet` is set. |
| `--count <N>` | `10` | Number of devnet accounts to import. |
| `--password-stdin` | off | Read the wallet password from stdin instead of prompting. |

```bash
echo test123 | otigen wallet import --from-devnet --password-stdin
otigen wallet import --from-file ./alice.backup.json alice
```

### `wallet list`

Print every account name + address in the keystore.

```text
otigen wallet list
```

### `wallet show`

Print one account's address + public key. No password needed — the public material is unencrypted.

```text
otigen wallet show <NAME>
```

```bash
otigen wallet show devnet-0
```

### `wallet delete`

Remove an account. Asks for confirmation (re-type the account name) unless `--yes`.

```text
otigen wallet delete <NAME> [--yes]
```

```bash
otigen wallet delete alice
otigen wallet delete alice --yes      # skip prompt
```

### `wallet password`

Re-encrypt an account under a new password. The keypair is unchanged.

```text
otigen wallet password <NAME>
```

### `wallet export`

Export an account as a portable encrypted backup (same Argon2id + AES-256-GCM ciphertext as the in-keystore entry).

```text
otigen wallet export <NAME> [--out <PATH>]
```

| Flag | Default | What it does |
|---|---|---|
| `--out <PATH>` | stdout | Write the backup JSON to a file. If omitted, prints to stdout so the file can be redirected. |

```bash
otigen wallet export alice --out ./alice.backup.json
otigen wallet export alice > ./alice.backup.json
```

### `wallet sign`

FALCON-512 sign arbitrary message bytes. Use for off-chain attestations.

```text
otigen wallet sign [OPTIONS] <NAME> <MESSAGE>
```

| Flag | Default | What it does |
|---|---|---|
| `--hex` | off | Decode `<MESSAGE>` as hex (`0x`-prefix optional) instead of treating it as UTF-8 text. |
| `--password-stdin` | off | Read the wallet password from stdin. |

For chain transactions use `deploy` / `upgrade` / `call` instead — those sign the canonical Poseidon2 tx hash, which is what the chain verifier expects.

```bash
otigen wallet sign devnet-0 "hello world"
otigen wallet sign devnet-0 --hex 0xdeadbeef --password-stdin
```

### `wallet verify`

FALCON-512 verify a signature against a message + public key. Exit code is the verdict: 0 on valid, 1 on invalid.

```text
otigen wallet verify [<NAME>] [OPTIONS] --message <MSG> --signature <HEX>
```

| Flag | Default | What it does |
|---|---|---|
| `<NAME>` | none | Wallet name whose public key signs. Mutually exclusive with `--pubkey`. |
| `--pubkey <HEX>` | none | Verify against an arbitrary public key (e.g. a counterparty's). Mutually exclusive with `<NAME>`. |
| `--message <MSG>` | required | The message that was signed. UTF-8 by default; pass `--hex` for binary. |
| `--signature <HEX>` | required | The signature output by `wallet sign`. |
| `--hex` | off | Decode `--message` as hex instead of UTF-8. |

```bash
otigen wallet verify devnet-0 --message "hello world" --signature 0x59...
otigen wallet verify --pubkey 0x09... --message "hello world" --signature 0x59...
```

---

## `otigen deploy`

Sign and submit a deploy transaction.

```text
otigen deploy [OPTIONS]
```

| Flag | Default | What it does |
|---|---|---|
| `--from <WALLET>` | `[wallet.default_account]` from `otigen.toml` | Signing account. |
| `--password-stdin` | off | Read wallet password from stdin. |
| `--network <NAME>` | `[network.default]` | Target network. |
| `--init-arg <HEX>` | empty | Hex calldata for the constructor (`init`). |
| `--bundle <PATH>` | `./artifacts/<name>.bundle` | Override the bundle path. |
| `--dry-run` | off | Build + sign the tx but don't submit. Useful for inspecting the wire bytes. |
| `--gas-limit <N>` | from `[deploy].gas_limit` | Override the gas limit. |
| `--gas-price <N>` | from `[deploy].gas_price` | Override the gas price. |

Prints the tx hash on submission, then polls for the receipt (60s timeout). On success, the contract address is in the receipt's `return_data`.

```bash
echo test123 | otigen deploy --from devnet-0 --password-stdin --network devnet
otigen deploy --dry-run     # print wire bytes, don't submit
```

---

## `otigen upgrade`

Replace a contract's WASM via the upgrade flow (spec §3.4). Sender must be the contract owner.

```text
otigen upgrade [OPTIONS] <ADDRESS>
```

| Flag | Default | What it does |
|---|---|---|
| `--bundle <PATH>` | `./artifacts/<name>.bundle` | New bundle to install. |
| `--from <WALLET>` | manifest default | Signing account (must be the contract owner). |
| `--password-stdin` | off | Read password from stdin. |

```bash
otigen upgrade 0xabc... --bundle ./artifacts/my-token.bundle --from devnet-0 --password-stdin
```

---

## `otigen pause` / `unpause` / `kill`

Lifecycle controls (spec §3.5).

```text
otigen pause   [OPTIONS] <ADDRESS>     # halt all entrypoints (reversible)
otigen unpause [OPTIONS] <ADDRESS>     # re-enable a paused contract
otigen kill    [OPTIONS] <ADDRESS> --yes   # irreversibly disable
```

`kill` requires `--yes` to confirm — future calls revert and the chain may garbage-collect the code slot.

| Flag | Default | What it does |
|---|---|---|
| `--from <WALLET>` | manifest default | Signing account (contract owner). |
| `--password-stdin` | off | Read password from stdin. |
| `--yes` (kill only) | required | Acknowledge the irreversibility. |

```bash
otigen pause   0xabc... --from devnet-0 --password-stdin
otigen unpause 0xabc... --from devnet-0 --password-stdin
otigen kill    0xabc... --from devnet-0 --password-stdin --yes
```

---

## `otigen call`

Invoke a function on a deployed contract. Auto-detects view-vs-mutating from the contract's ABI: views go through `pyde_call` (free, senderless when possible); mutating calls sign + submit a tx and poll the receipt.

```text
otigen call [OPTIONS] <ADDRESS> <FUNCTION>
```

| Flag | Default | What it does |
|---|---|---|
| `--args <HEX>` | empty | Borsh-encoded calldata, hex-encoded. |
| `--from <WALLET>` | manifest default | Signing account for mutating calls. |
| `--password-stdin` | off | Read wallet password from stdin. |
| `--value <QUANTA>` | `0` | Native PYDE to attach to a mutating call (quanta = 10⁻¹⁰ PYDE). |
| `--network <NAME>` | manifest default | Target network. |

```bash
otigen call 0xabc... balance_of --args 0xdeadbeef... --network devnet     # view
echo test123 | otigen call 0xabc... transfer \
  --args 0xfeedface... \
  --from devnet-0 --password-stdin --network devnet
```

---

## `otigen inspect`

Read contract / parachain metadata + storage (spec §3.6).

```text
otigen inspect [OPTIONS] <ADDRESS_OR_NAME>
```

| Flag | Default | What it does |
|---|---|---|
| `--state-field <FIELD>` | none | Read a single substrate-typed storage scalar by name. Slot derivation = `Blake3(self_address \|\| field_name)`. |
| `--field <FIELD>` | none | Legacy raw-storage path. `Poseidon2(name)` derivation. Mutually exclusive with `--state-field`. |
| `--network <NAME>` | manifest default | Target network. |

Default mode prints the account snapshot: address, account type (`eoa` / `contract`), nonce, balance, code size + hash. `--state-field` short-circuits to a focused storage read.

```bash
otigen inspect 0xabc...                            # full account snapshot
otigen inspect 0xabc... --state-field total_supply
otigen inspect my-token                            # resolve by registered name
```

---

## `otigen validator`

Read-only queries over the chain-side validator registry.

```text
otigen validator <ACTION> [OPTIONS]
```

| Subaction | Usage | What it returns |
|---|---|---|
| `show <ADDR>` | `otigen validator show 0x…` | One validator's full record: operator, pubkey, stake, status, jail/unbond timeline, last-claimed rps, uptime. |
| `by-operator <ADDR>` | `otigen validator by-operator 0x…` | Every validator an operator runs. |

Exits non-zero with `NotAValidator` for unregistered addresses so scripts can branch on exit code without parsing stdout.

```bash
otigen validator show 0xabc...
otigen validator by-operator 0xdef...
```

Registration / stake / unbond / unjail flows live on the engine binary's `pyde stake` CLI — those are tx submission, not introspection.

---

## `otigen verify`

Verify that a deployed contract's bytes match a local bundle (spec §3.9).

```text
otigen verify [OPTIONS] <ADDRESS>
```

| Flag | Default | What it does |
|---|---|---|
| `--bundle <PATH>` | `./artifacts/<name>.bundle` | Local bundle to compare against. |
| `--network <NAME>` | manifest default | Target network. |

Useful for confirming reproducible builds: two builders running `otigen build` from the same source + toolchain pins should produce bundles that verify byte-identical against the same deployment.

```bash
otigen verify 0xabc...
otigen verify 0xabc... --bundle ./snapshot/my-token.bundle
```

---

## `otigen devnet`

Run a local devnet.

```text
otigen devnet [OPTIONS]
```

The chain runtime is embedded in the `otigen` binary — no separate `pyde` download. Single validator, instant-wave, deterministic genesis pre-fund. Ctrl-C for graceful shutdown.

| Flag | Default | What it does |
|---|---|---|
| `--rpc-listen <ADDR>` | none (banner-only) | JSON-RPC server bind address. Pass `127.0.0.1:9933` to enable RPC so `deploy` / `call` / `console` have a target. |
| `--prefund-count <N>` | `10` | Number of pre-funded accounts the banner enumerates. |
| `--prefund-amount <QUANTA>` | engine default | Per-account genesis balance. |
| `--chain-id <ID>` | `31337` | Chain ID this devnet signs against. The canonical "dev chain, don't replay" sentinel. |
| `--tick-ms <MS>` | `1000` | Idle-wave tick interval. Empty waves still commit every `--tick-ms` so `wave_id` advances. |
| `--fork <FILE_OR_URL>` | none | Bootstrap state from an existing chain snapshot. Local borsh file or HTTP(S) URL pointing at `pyde_getSnapshot`. Mutually exclusive with `--prefund-*`. |

```bash
otigen devnet --rpc-listen 127.0.0.1:9933
otigen devnet --rpc-listen 127.0.0.1:9933 --tick-ms 500
otigen devnet --fork http://my-validator:9933 --rpc-listen 127.0.0.1:9934
```

Validator + full-node roles still ship via the engine's own `pyde` binary — operator concerns, not author concerns.

---

## `otigen console`

Interactive REPL against a Pyde node (spec §3.8).

```text
otigen console [OPTIONS]
```

| Flag | Default | What it does |
|---|---|---|
| `--from <WALLET>` | `[wallet.default_account]` | Account name for `tx` commands. Views work without a sender bound. |
| `--network <NAME>` | manifest default | Network to connect to. |

Drops into a `pyde>` prompt with line editing, persistent history (`~/.otigen_console_history`), and per-session network + sender bindings. The MVP surface:

| Command | What it does |
|---|---|
| `help` | Show the catalog. |
| `balance <ADDR>` | PYDE balance. |
| `nonce <ADDR>` | Next nonce. |
| `call <ADDR> <FN> [HEX]` | View call (free, no tx). |
| `tx <ADDR> <FN> [HEX] [--value <DEC>]` | Sign + submit + receipt poll. Wallet unlocked once, cached for the session. |
| `state <ADDR> <FIELD>` | Substrate-typed scalar storage read. |
| `events <ADDR> [--from N] [--to N] [--limit N]` | Pull `pyde_getLogs` with optional wave bounds. |
| `inspect <ADDR>` | Account snapshot. |
| `exit` / `quit` | Leave. |

Addresses accept either `0x…` hex or registered names (resolved via `pyde_resolveName`).

```bash
otigen console --network devnet --from devnet-0
```
