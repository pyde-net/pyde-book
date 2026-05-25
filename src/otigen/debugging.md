# Debugging

Errors you'll hit, in the order you typically hit them. Each entry has the symptom (verbatim error message), the cause, and the fix.

If your error isn't here, the `-vvvv` verbosity ladder ([§3](#3-the-verbosity-ladder)) usually exposes the root cause.

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

**Cause:** Go isn't installed alongside TinyGo. TinyGo bundles its own compiler fork but still needs Go for module resolution + stdlib path resolution.

**Fix:** `brew install go`. Then `tinygo version` should report the Go version inline.

### `error obtaining VCS status: exit status 128` when running `tinygo build`

**Cause:** TinyGo's underlying Go compiler stamps the binary with VCS info and refuses to build outside a git repo.

**Fix:** `git init -q` in the project directory. The next revision of the generated `Makefile` does this automatically.

### `asc: command not found` after `npm install -g assemblyscript`

**Cause:** npm's global bin directory isn't on `$PATH`.

**Fix:** add `<npm prefix>/bin` to `PATH`:

```bash
echo "export PATH=\"$(npm config get prefix)/bin:\$PATH\"" >> ~/.zshrc
source ~/.zshrc
```

Or skip the global install — use the local install via `npm run build` (each scaffolded AS project lists `assemblyscript` in its `devDependencies`).

### `error[E0463]: can't find crate for std` (Rust)

**Cause:** you forgot `rustup target add wasm32-unknown-unknown`.

**Fix:**

```bash
rustup target add wasm32-unknown-unknown
```

---

## 2. Build errors

### `BuildRejected: ForbiddenImport(<module>.<name>)`

**Cause:** the WASM imports a function outside `pyde::*`. Common offenders:

| Import | Cause |
|---|---|
| `env.abort` | AssemblyScript's default panic handler. See [§4 AssemblyScript aborts](#4-assemblyscript-aborts). |
| `wasi_snapshot_preview1.fd_write` | Compiling with `-target=wasi` instead of `-target=wasm-unknown` (TinyGo) or `--target=wasi` instead of `--target=wasm32` (C). Use the WASI-free target. |
| `env.<libc-fn>` | Linking against libc. C contracts must use `-nostdlib`. |

**Fix:** track down which language toolchain emitted the offending import and disable / substitute the source.

### `BuildRejected: ExportedButNotDeclared("<name>")`

**Cause:** the WASM exports a function not declared in `otigen.toml`'s `[functions.<name>]` table.

**Fix:** either declare it (add a `[functions.<name>]` entry with appropriate `attributes`), or rename the symbol to start with `_` (the convention for internal helpers — they're excluded from the export-declaration check).

### `BuildRejected: DeclaredButNotExported("<name>")`

**Cause:** the inverse — `otigen.toml` declares a function but the WASM doesn't export it.

**Fix:** in your source, mark the function with the language's WASM-export attribute:

| Language | Attribute |
|---|---|
| Rust | `#[no_mangle] pub extern "C" fn <name>(...)` |
| TinyGo | `//go:wasmexport <name>` above the function |
| AssemblyScript | `export function <name>(...)` |
| C | `__attribute__((export_name("<name>")))` |

### `BuildRejected: ForbiddenFeature(<wasmparser diagnostic>)`

**Cause:** the WASM uses a feature outside Pyde's deterministic subset (threads, SIMD, GC, reference types, multi-memory, memory64, component model).

**Fix:** find the language compiler flag that disables the feature. Most languages don't emit these by default, so this typically means a non-default flag got added. For AssemblyScript, check `asconfig.json` — `simd: false`, `threads: false`.

### `BuildRejected: DebugBuildRejected`

**Cause:** you forgot the `--release` flag in your language build command.

**Fix:** rebuild with the release profile:

```bash
cargo build --target wasm32-unknown-unknown --release   # Rust
asc <args> --target release                              # AssemblyScript
tinygo build -target=wasm-unknown -o build/contract.wasm .  # TinyGo (uses release by default)
clang --target=wasm32 -nostdlib -O3 ...                  # C
```

---

## 3. The verbosity ladder

When a test fails, raise the verbosity:

```bash
make test           # default        ✗ failed_test (0.04 ms)
make test-v         # + gas+duration ✗ failed_test (0.04 ms, 8,234 gas)
make test-vv        # + events       Events: [0] topic0=0x... topics=2 data=8 bytes
make test-vvv       # + per-call     Calls:  [0] increment() -> 1 [292 gas]
                    #                        [1] decrement() revert("CounterAtZero")
make test-vvvv      # + storage diff Storage diff: 0x385c70...: 0x...01 → <unset>
```

For most test failures, `-vvv` reveals the cause: which call traps, what the return value was, what reason the revert carried. `-vvvv` adds storage diffs for state-mutation bugs.

---

## 4. AssemblyScript aborts

The single most common AS issue.

### Symptom

```text
BuildRejected: ForbiddenImport(env.abort)
```

### Cause

AssemblyScript's compiler emits `env.abort` calls for runtime checks (array bounds, integer overflow, `unreachable()`). The default is to import an `abort` function from the host environment. Pyde rejects non-`pyde::*` imports.

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

This substitutes the default `env.abort` with our in-contract `abort()` which traps via `unreachable()`. No env import, deterministic crash.

The function must NOT be `export`'d — exporting it makes it a public dispatch surface that Pyde then rejects as `ExportedButNotDeclared`.

---

## 5. Runtime errors

### `wasm trap: out of fuel`

**Cause:** the contract's wasmtime fuel ran out. Either an infinite loop, or the per-call gas budget is too low.

**Fix:**

- Increase the per-test fuel cap in the test's `[cheats]`:

  ```toml
  [cheats]
  gas_limit = 5_000_000_000   # 5B fuel — generous
  ```

- Or find + fix the infinite loop in the contract. Common cause: a loop with a wrong termination condition that never trips.

### `wasm trap: error while executing at wasm backtrace: 0: 0x123 - <unknown>!<wasm function N>`

**Cause:** a WASM trap during a call. Specific cause varies; the backtrace is usually unhelpful (no symbol info in release builds).

**Fix:** raise verbosity to `-vvv` to see which contract function was active. Then check that function's code:

- Array out-of-bounds (panics → trap)
- Integer overflow on a checked operation (in debug builds)
- `unreachable!()` or `core::arch::wasm32::unreachable()` called
- Stack overflow in deeply-nested calls

If you genuinely can't figure it out, compile with debug info (`--profile dev` or equivalent), re-run the test — the backtrace will carry function names.

### `instantiate: error while executing at wasm backtrace: ...`

**Cause:** the WASM's `start` section (if any) trapped during instantiation. Most often AS-related — the bump-allocator runtime's `~start` ran out of fuel because the test didn't seed fuel before instantiation.

**Fix:** updated runners (post-otigen#47) seed fuel before instantiation automatically. If you see this on an old version, upgrade `otigen`.

---

## 6. Deploy errors

### `ERR_NAME_TAKEN`

**Cause:** another contract on this network already deployed under this name.

**Fix:** pick a different name, or coordinate with whoever deployed the existing one. Note: contract names are global per chain (one mainnet "USDT" possible).

### `ERR_INSUFFICIENT_BALANCE`

**Cause:** the deployer wallet's PYDE balance < deploy fee.

**Fix:** fund the wallet (devnet faucet or testnet faucet or exchange withdraw, depending on network).

### `ERR_NONCE_TOO_LOW` / `ERR_NONCE_TOO_HIGH`

**Cause:** a stale tx is in the mempool; or your local nonce cache is out of sync with the chain.

**Fix:**

- `--nonce <N>` flag to override.
- Or wait — once the in-flight tx commits or expires, your next deploy proceeds.

### `RPC timeout`

**Cause:** the RPC endpoint didn't respond within the configured timeout.

**Fix:**

- Try a different RPC: `otigen deploy --rpc-url <url>` to override.
- If you're on devnet, check the local node is running.
- For testnet / mainnet, the canonical RPC URL is `https://rpc.<network>.pyde.network`.

---

## 7. Verify mismatches

### `verification failed — bytes differ`

**Cause:** the on-chain bundle doesn't match your local rebuild.

**Possible causes:**

1. **Contract was upgraded** between your build and the verify. Re-pull the latest source, re-build, re-verify.
2. **Build is non-deterministic.** Common cause: `Cargo.lock` differs (you didn't commit one). Run `cargo build --locked` to enforce the lock file.
3. **Toolchain version differs.** Your `otigen.toml` records the toolchain pin; if your local toolchain doesn't match, the build is reproducible-different. Verify with `rustup show` / `tinygo version` / etc.

If none of those apply, file an issue — reproducibility is a load-bearing property of the toolchain; a real divergence is a real bug.

---

## 8. Where to get help

- **Inline:** every `otigen <command> --help` gives subcommand-specific usage.
- **Spec docs:** [OTIGEN_BINARY_SPEC](../companion/OTIGEN_BINARY_SPEC.md) + [OTIGEN_TEST_SPEC](../companion/OTIGEN_TEST_SPEC.md) + [HOST_FN_ABI_SPEC](../companion/HOST_FN_ABI_SPEC.md). Normative; canonical when this guide and the spec disagree.
- **Examples:** [`pyde-net/otigen/examples/`](https://github.com/pyde-net/otigen/tree/main/examples) — every committed example works end-to-end via `make verify-examples` in the workspace.
- **Issues:** <https://github.com/pyde-net/otigen/issues> for toolchain bugs, <https://github.com/pyde-net/pyde-book/issues> for doc gaps.
