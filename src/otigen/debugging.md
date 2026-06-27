# Debugging

Errors you'll hit, in the order you typically hit them. Each entry has the symptom (verbatim error message), the cause, and the fix.

If your error isn't here, raise the global verbosity (`-v` / `-vv`) — every subcommand emits INFO + DEBUG level logs that usually expose the root cause.

---

## 1. Installation errors

### `error: unable to create target: 'No available targets are compatible with triple "wasm32"'`

**Cause:** clang lacks the wasm32 backend. On macOS, Apple's bundled `/usr/bin/clang` doesn't include it.

**Fix:** `brew install llvm` then add brew's clang to `PATH`:

```bash
export PATH="/opt/homebrew/opt/llvm/bin:$PATH"
```

Verify with `clang -print-targets | grep wasm32`.

### `clang: error: unable to execute command: posix_spawn failed: No such file or directory`

**Cause:** clang found its wasm32 backend but `wasm-ld` (the LLVM WASM linker) is missing.

**Fix:** `brew install lld` then add to `PATH`:

```bash
export PATH="/opt/homebrew/opt/lld/bin:$PATH"
```

`lld` is a **separate** brew formula from `llvm`. Installing one doesn't install the other.

### `tinygo: command not found` after `brew install tinygo`

**Cause:** TinyGo isn't in default homebrew formulae. You need their tap first.

**Fix:**

```bash
brew tap tinygo-org/tools
brew install tinygo
```

### `(using go version <unknown>...)` when running `tinygo version`

**Cause:** Go isn't installed alongside TinyGo.

**Fix:** `brew install go`.

### `error obtaining VCS status: exit status 128` when running `tinygo build`

**Cause:** TinyGo's underlying Go compiler stamps the binary with VCS info and refuses to build outside a git repo.

**Fix:** `git init -q` in the project directory.

### ``ToolchainMissing: TinyGo requires `wasm-opt` (binaryen) for size optimisation``

**Cause:** the compile preflight detected that TinyGo is selected but `wasm-opt` (shipped in [binaryen](https://github.com/WebAssembly/binaryen)) is not on `PATH`. TinyGo invokes `wasm-opt` for its `-opt=z` size pass and fails without it.

**Fix:** install binaryen.

```bash
# macOS
brew install binaryen

# Debian / Ubuntu
sudo apt install binaryen

# Arch
sudo pacman -S binaryen
```

Or point TinyGo at a custom build: `export WASMOPT=/path/to/wasm-opt`.

### `asc: command not found` after `npm install -g assemblyscript`

**Cause:** npm's global bin directory isn't on `$PATH`.

**Fix:**

```bash
echo "export PATH=\"$(npm config get prefix)/bin:\$PATH\"" >> ~/.zshrc
source ~/.zshrc
```

### `error[E0463]: can't find crate for std` (Rust)

**Cause:** you forgot `rustup target add wasm32-unknown-unknown`.

**Fix:**

```bash
rustup target add wasm32-unknown-unknown
```

---

## 2. Build errors

`otigen build` and `otigen check` print `otigen [ERROR] BuildRejected: <N> validation issue(s)` followed by bullets — one bullet per violated rule. The variants below match the `Display` of the engine's [`ValidationError`](https://github.com/pyde-net/otigen/blob/main/crates/otigen-abi/src/validate.rs) enum.

### `import "<module>"."<name>" is forbidden; the only allowed module is "pyde"`

**Cause:** the WASM imports a function outside `pyde::*`. Common offenders:

| Import | Cause |
| --- | --- |
| `env.abort` | AssemblyScript's default panic handler. See [§4](#4-assemblyscript-aborts) below. |
| `wasi_snapshot_preview1.fd_write` | Compiling with `-target=wasi` instead of `-target=wasm-unknown` (TinyGo) or `--target=wasi` instead of `--target=wasm32` (C). |
| `env.<libc-fn>` | Linking against libc. C contracts must use `-nostdlib`. |

**Fix:** disable the source that emits the offending import.

### `import pyde.<name> is not in the host function allowlist`

**Cause:** the contract imports a `pyde::*` function not yet in the chain's host-fn surface (typo in the import name, or a v2-only fn).

**Fix:** check spelling against [`HOST_FN_ABI_SPEC §7`](../companion/HOST_FN_ABI_SPEC.md). If the fn is legitimately missing from v1, find an alternative pattern.

### `import pyde.<name> is parachain-only; this contract is not declared as a parachain`

**Cause:** the contract calls a §8 parachain-only host fn (`parachain_storage_*`, `parachain_id`, etc.) but `otigen.toml` has `[contract] type = "contract"`.

**Fix:** either drop the parachain-only call, or set `type = "parachain"` in `otigen.toml`.

### `function "<name>" exports the WASM signature ... but the spec requires () -> () for every entry point`

**Cause:** the entry point's WASM signature isn't void-void. Either a hand-rolled `#[no_mangle] pub extern "C" fn foo(args, ...) -> ret` (pre-spec shape), or your macro substrate didn't fire.

**Fix:** use `#[pyde::entry]` from `pyde-entry-macros`. The macro generates the spec's `() -> ()` shim that reads args from `pyde::calldata_*` and returns via `pyde::return`.

### `WASM module exports function "<name>" but it is not declared in otigen.toml`

**Cause:** the WASM exports a function not declared in `otigen.toml`'s `[functions.<name>]` table.

**Fix:** declare it (add a `[functions.<name>]` entry), or rename the symbol to start with `_` (internal helpers are excluded from the check).

### `function "<name>" is declared in otigen.toml but the WASM module does not export it`

**Cause:** the inverse — `otigen.toml` declares a function but the WASM doesn't export it.

**Fix:** in your source, mark the function with the language's WASM-export attribute. For Rust, `#[pyde::entry] fn <name>(...)` is the canonical shape (the macro adds `#[no_mangle] pub extern "C"` for you).

### `WASM module uses a forbidden feature outside Pyde's deterministic subset: <wasmparser diagnostic>`

**Cause:** the WASM uses a feature outside the deterministic subset (threads, SIMD, GC, reference types, multi-memory, memory64, component model).

**Fix:** find the language compiler flag that disables the feature. For AssemblyScript, check `asconfig.json` — `simd: false`, `threads: false`.

---

## 3. Increasing verbosity

The standard global `-v` flag, repeated:

```bash
otigen test           # default — per-test pass/fail + duration
otigen test -v        # + INFO logs from the runner
otigen test -vv       # + DEBUG logs (host-fn calls, slot derivations)
otigen test --json    # NDJSON event stream for CI / scripting
otigen test --dry-run # parse + resolve only, no execution
```

The same `-v` works on every subcommand. There is no Foundry-style four-level trace ladder today; failing assertions print expected-vs-actual; storage diffs live in `expect.storage.*` declarations in the test TOML.

For runtime-engine vs legacy-mock-runner bisection, `otigen test --no-engine` falls back to the legacy in-process mock host-fn surface (useful when you need parity to confirm an engine-runner-side issue).

---

## 4. AssemblyScript aborts

The single most common AS issue.

### Symptom

```text
otigen [ERROR] BuildRejected: 1 validation issue(s)
  - import "env"."abort" is forbidden; the only allowed module is "pyde"
```

### Cause

AssemblyScript's compiler emits `env.abort` calls for runtime checks (array bounds, integer overflow, `unreachable()`). The default is to import an `abort` function from the host environment. Pyde rejects non-`pyde` imports.

### Fix

`asconfig.json` must include:

```json
"options": {
  "use": ["abort=assembly/index/abort"]
}
```

And `assembly/index.ts` must define an `abort` function (the init template does this automatically):

```typescript
function abort(
  _message: string | null = null,
  _fileName: string | null = null,
  _line: u32 = 0,
  _column: u32 = 0,
): void {
  unreachable();
}
```

This substitutes the default `env.abort` with an in-contract `abort()` that traps via `unreachable()`. No env import, deterministic crash.

The function must NOT be `export`'d — exporting it makes it a public dispatch surface that Pyde then rejects as `ExportedButNotDeclared`.

---

## 5. Runtime errors

### `wasm trap: out of fuel`

**Cause:** the contract's wasmtime fuel ran out. Either an infinite loop, or the per-call gas budget is too low.

**Fix:**

- Raise the per-test fuel ceiling in the test's `[cheats]`:

  ```toml
  [cheats]
  gas_limit = 5_000_000_000   # 5B fuel (~ 5M gas at the 1000 fuel/gas conversion)
  ```

  Pyde maps gas → fuel at `FUEL_PER_GAS = 1000`. Today the legacy `otigen test` runner treats `cheats.gas_limit` as raw fuel units (default cap 1 B fuel ≈ 1 M gas); the engine path uses gas units (default 10 M gas, converted internally to 10 B fuel). When you see `wasm trap: out of fuel` and `cheats.gas_limit` is unset, you've hit the default cap. Raise it explicitly to the fuel budget you need.

- Or find + fix the infinite loop in the contract. Common cause: a loop with a wrong termination condition that never trips.

### `wasm trap: error while executing at wasm backtrace: ...`

**Cause:** a WASM trap during a call. Specific cause varies; the backtrace is usually unhelpful in release builds (stripped symbols).

**Fix:** raise verbosity to `-vv` to see the host-fn call sequence that preceded the trap. Then check the contract code for:

- Array out-of-bounds (panic → trap)
- `unreachable!()` or `core::arch::wasm32::unreachable()` called
- Stack overflow in deeply-nested calls

If you can't figure it out, compile with debug info (`--profile dev` or equivalent), re-run — backtraces will then carry function names. Deploy validation rejects debug builds, so don't ship them.

### `Reverted: <reason>`

**Cause:** the contract explicitly called `pyde::revert("<reason>")`. The runner classifies the halt as a revert (not a trap) — the receipt's `status` is `reverted` and the reason string surfaces in `return_data` / `revert_reason`.

**Fix:** this is the contract author's intentional path — confirm the revert is the one you meant. In a `.test.toml`, assert it with the substring matcher:

```toml
[[tests.calls]]
function   = "withdraw"
args       = ["1000"]
expect.revert = "InsufficientBalance"
```

If you're hitting a revert you don't expect, the reason string is your first signal — print it via `-v` to see it inline with the failed call.

---

## 6. Deploy + tx submission errors

### `EngineNotReady: <op> lifecycle ops are not yet wired on the chain side`

**Cause:** you ran `otigen upgrade` / `pause` / `unpause` / `kill`. The chain has no `TxType::Lifecycle` handler yet; the CLI refuses to submit a tx that's guaranteed to revert.

**Fix:** for v1 use the patterns in [Lifecycle](./lifecycle.md):

- **Upgrade**: the proxy pattern with `delegate_call` (see the `upgradeable-proxy` template).
- **Pause / Kill**: author-declared `paused: bool` / `killed: bool` in `[state]` + guard every entrypoint.

To exercise the CLI signing path against a stub engine (CI / development), pass `--i-know-engine-rejects` — the tx WILL revert on chain and burn gas, by design.

### `InvalidArgs: --rpc-url for deploy requires --chain-id (signed tx needs a chain id to verify)`

**Cause:** you passed `--rpc-url` without `--chain-id`. The resolver returns `chain_id = 0` on the raw-URL path, which silently bricks the FALCON signature against the chain's tx-hash domain.

**Fix:** pair them. Match `--chain-id` to what the running RPC reports via `pyde_chainId`:

```bash
otigen deploy --rpc-url http://127.0.0.1:9933 --chain-id 31337 --from devnet-0 --password-stdin <<< pw
```

### `RpcError(submitting deploy tx): storage backend: insufficient balance: have <N> need <M>`

**Cause:** the signing wallet's balance is below the deploy fee.

**Fix:** fund the wallet. On devnet, the canonical path is `otigen wallet import --from-devnet` — that imports the 10 prefunded devnet-0..devnet-9 accounts the embedded `otigen devnet` bootstraps at genesis. There is no `POST /faucet` HTTP endpoint on the devnet RPC; the prefund-at-genesis path is the only auto-funding the binary provides.

### `RpcError(submitting <op> tx): nonce <N> not acceptable (sender base=<M>)`

**Cause:** Pyde uses a 16-slot sliding nonce window per account. The tx's nonce is below `nonce_window.base` or ≥ `base + 16`. Either a stale tx is in the mempool, or your local nonce cache is out of sync with the chain.

**Fix:** wait for the in-flight tx to commit or expire, then retry. The CLI re-queries the nonce on each submission, so a retry after a few seconds usually unsticks it. There is no `--nonce` override flag today.

### `InclusionTimeout: tx 0x... not included after 60s (mempool may still hold it — re-query via pyde_getTransactionReceipt later)`

**Cause:** the receipt poll exceeded the 60-second timeout (constant — not CLI-configurable). The tx may still commit later.

**Fix:** re-query via `pyde_getTransactionReceipt` directly (or `otigen call <hash>` if you're checking a call). For chains under stress, this is informational; for an idle devnet it usually means the tx was rejected silently — check the devnet log.

### `RpcError(...): connection refused` / `connect timeout`

**Cause:** the RPC endpoint isn't reachable.

**Fix:**

- For devnet: confirm `otigen devnet --rpc-listen 127.0.0.1:9933` is running and listening on the port you're hitting.
- For testnet / mainnet: the canonical RPC URL is `https://rpc.<network>.pyde.network`. Use `--rpc-url` + `--chain-id` to override the project config.

### `UnknownNetwork: <name> not declared in [network.*]`

**Cause:** you passed `--network <name>` (or your `otigen.toml` has `[network.default] name = "<name>"`) but no `[network.<name>]` block declares the endpoint, and the name isn't a built-in.

**Fix:** add the entry to `otigen.toml`:

```toml
[network.<name>]
rpc_url  = "https://rpc.<name>.pyde.network"
chain_id = <id>
```

…or bypass the lookup with `--rpc-url <url> --chain-id <id>` for a one-shot run.

---

## 7. View-call debugging via `--json`

For programmatic consumers (CI, integration harnesses), `otigen call --json` emits NDJSON. View-mode calls include the contract's return value as `return_data` (hex):

```bash
otigen call <addr> get --json
```

```jsonc
{"event": "call_start", "target": "<addr>", "function": "get", "network": "devnet", "chain_id": 31337}
{"event": "call_included", "tx_hash": "", "status": "success", "return_data": "0x0300000000000000"}
```

For view-mode calls, `tx_hash` is the empty string (`""`) — view calls go via `pyde_call` and don't create a tx; the field is kept for JSON-shape symmetry with write-mode events.

Write-mode calls (with `--from`) omit `return_data` today — the receipt poll-helper doesn't surface success-path return data yet. The human-readable `Return: 0x...` line is view-mode only.

---

## 8. Verify mismatches

### `MISMATCH` (verify exits 1 with a hash + size + first-differing-byte diff)

**Cause:** the on-chain bundle doesn't match your local rebuild.

**Possible causes:**

1. **Contract was redeployed** between your build and the verify. Re-pull the latest source, re-build, re-verify.
2. **Build is non-deterministic.** Common cause: `Cargo.lock` differs (you didn't commit one). Run `cargo build --locked` to enforce the lock file.
3. **Toolchain version differs.** Your `otigen.toml` records the toolchain pin; if your local toolchain doesn't match, the build is reproducible-different. Verify with `rustup show` / `tinygo version` / etc., or add `--strict-toolchain` to fail loudly on mismatch.

If none of those apply, file an issue — reproducibility is a load-bearing property of the toolchain; a real divergence is a real bug.

### `StrictToolchainMismatch: bundle was built with <tool> <X>; host has <tool> <Y>. Reproducibility check failed.`

**Cause:** you passed `--strict-toolchain` and your host's rustc / TinyGo / asc / clang version doesn't match what the bundle's `manifest.json` recorded.

**Fix:** install + activate the matching toolchain, or rebuild without `--strict-toolchain` if you're knowingly working at a different pin.

---

## 9. Where to get help

- **Inline:** every `otigen <command> --help` gives subcommand-specific usage.
- **Spec docs:** [OTIGEN_BINARY_SPEC](../companion/OTIGEN_BINARY_SPEC.md) + [OTIGEN_TEST_SPEC](../companion/OTIGEN_TEST_SPEC.md) + [HOST_FN_ABI_SPEC](../companion/HOST_FN_ABI_SPEC.md). The spec is authoritative on documented behavior; the binary's `--help` is authoritative on shipped behavior. Where they disagree, the binary wins for "what runs today" and the spec describes the target.
- **Examples:** [`pyde-net/otigen/examples/`](https://github.com/pyde-net/otigen/tree/main/examples). The 8 scaffold-able templates that build cleanly today are listed in [Examples](./examples.md) and via `otigen new --list`.
- **Issues:** <https://github.com/pyde-net/otigen/issues> for toolchain bugs, <https://github.com/pyde-net/pyde-book/issues> for doc gaps.
