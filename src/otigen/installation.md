# Installation

Two halves: the `otigen` binary itself, then the language toolchain for whichever of the four you'll write contracts in. Install both before continuing to the next chapter.

---

## 1. The otigen binary

### Install (curl one-liner)

The canonical install path is a single command. It detects your platform, downloads the latest signed release from the public mirror, verifies the sha256, drops the binary into `~/.otigen/bin`, and appends a marker-wrapped `export PATH=…` block to your shell rc:

```bash
curl -fsSL https://raw.githubusercontent.com/pyde-net/test-releases/main/otigen/install.sh | bash
```

No `gh` CLI required, no `GITHUB_TOKEN` setup, no auth dance — the release mirror at [`pyde-net/test-releases`](https://github.com/pyde-net/test-releases) is public and the install script fetches anonymously over plain curl + the GitHub CDN.

Supported targets: macOS arm64, Linux x86_64, Linux aarch64, Windows x86_64. Windows users run the same script from Git Bash or WSL.

Open a new terminal afterwards (so the PATH update takes effect), then confirm:

```bash
otigen --version
```

```text
otigen 0.1.0 (sha be73970a, release)
```

The version line carries the git SHA + build profile so two contributors can compare binaries when something looks wrong.

### Pin a specific version

```bash
curl -fsSL https://raw.githubusercontent.com/pyde-net/test-releases/main/otigen/install.sh \
  | bash -s -- --version v0.1.0-alpha.1
```

Pass either the bare version (`v0.1.0-alpha.1`) or the full mirror tag (`otigen-v0.1.0-alpha.1`) — both are accepted. Useful for testing, rollback, or reproducibility; pre-release tags work too.

### Update

Re-run the canonical one-liner. The script detects the existing install at `~/.otigen/bin/otigen` and replaces it with the latest release (same shape as `rustup-init` / `deno install` — no separate manager binary needed):

```bash
curl -fsSL https://raw.githubusercontent.com/pyde-net/test-releases/main/otigen/install.sh | bash
```

Idempotent — re-running over an up-to-date install is a no-op on the shell rc.

### Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/pyde-net/test-releases/main/otigen/install.sh \
  | bash -s -- --uninstall
```

Removes the binary, strips the marker-wrapped PATH block from every shell rc that has it (`~/.zshrc`, `~/.bashrc`, `~/.bash_profile`, `~/.config/fish/config.fish` are all scanned), and `rmdir`s `~/.otigen/bin` if empty.

### Install-script flags

Pass any of these via `bash -s -- <FLAGS>`:

| Flag | What it does |
|---|---|
| `--update` | Explicit alias for the default install-or-replace behavior. |
| `--uninstall` | Remove binary + clean shell rc + drop empty install dir. |
| `--version <TAG>` | Pin a specific release tag instead of the latest. Accepts `vX.Y.Z` or `otigen-vX.Y.Z`. |
| `--prefix <DIR>` | Install location override. Default `~/.otigen/bin`; also honours `OTIGEN_INSTALL_DIR` env var. |
| `--no-modify-path` | Skip the shell-rc PATH edit. For users with managed dotfile repos. |
| `--check-only` | Dry run — print what the script would do and exit. Works with any mode. |
| `-h` / `--help` | Full catalog. |

### Manual download

If you'd rather skip the script, grab the per-platform tarball directly from the public mirror's release page:

```bash
# Replace v0.1.0-alpha.1 with the current release tag, and the target triple
# (aarch64-apple-darwin / x86_64-unknown-linux-gnu / aarch64-unknown-linux-gnu /
#  x86_64-pc-windows-msvc) with your platform. The mirror prefixes every
# otigen release tag with `otigen-`, so the lookup is `otigen-<tag>`.
gh release download otigen-v0.1.0-alpha.1 --repo pyde-net/test-releases \
  --pattern 'otigen-v0.1.0-alpha.1-aarch64-apple-darwin.tar.gz' \
  --pattern 'otigen-v0.1.0-alpha.1-aarch64-apple-darwin.tar.gz.sha256'

shasum -a 256 -c otigen-v0.1.0-alpha.1-aarch64-apple-darwin.tar.gz.sha256
tar xzf otigen-v0.1.0-alpha.1-aarch64-apple-darwin.tar.gz
sudo install -m 0755 \
  otigen-v0.1.0-alpha.1-aarch64-apple-darwin/otigen \
  /usr/local/bin/
```

Anonymous `curl -L` against the asset's `browser_download_url` works the same way for users without `gh` installed.

Every release publishes binaries for all four platforms, each accompanied by:

- `.sha256` — checksum (auto-verified by the install script).
- `.sig` + `.pem` — sigstore-keyless OIDC signature + certificate. The install script doesn't currently verify these (cosign is an optional install on the user side); manual verification flow lives in the [mirror README](https://github.com/pyde-net/test-releases#verifying-a-download-manually) and is normatively specified in [`OTIGEN_BINARY_SPEC §11.4`](../companion/OTIGEN_BINARY_SPEC.md).

### Build from source

For contributors and bleeding-edge users. While the source repos are private during pre-mainnet engineering, sibling-clone access requires Contents:read on each:

```bash
git clone https://github.com/pyde-net/otigen
git clone https://github.com/pyde-net/engine          # sibling — path-dep'd by otigen-cli
git clone https://github.com/pyde-net/pyde-crypto    # sibling — also path-dep'd
cd otigen
cargo build --release -p otigen-cli
sudo install target/release/otigen /usr/local/bin/
```

Installs to `/usr/local/bin/otigen`. Requires Rust ≥ 1.93 (cranelift transitive dep). The three sibling repos are needed because the otigen workspace path-deps into both `engine/` and `pyde-crypto/`.

Once the source repo flips public for v1, the same `make install` (or `cargo install --path crates/otigen-cli`) flow works from a public clone with no auth.

---

## 2. Language toolchain

Install only the one(s) you'll use. Each language's `Makefile` (generated by `otigen init`) has a `make check-tools` target that verifies the chain is set up correctly.

### Rust

```bash
# rustup gives you the compiler + the wasm32 target.
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown
```

**Required version:** Rust ≥ 1.93 (matches the `rust-version` floor in the workspace `Cargo.toml`; raised from 1.87 when wasmtime 45's cranelift transitive deps pushed the MSRV up).

**Verify:**

```bash
rustup show | grep -E "active toolchain|wasm32"
```

**Common errors:** see [`install-gotchas`](./debugging.md#installation-errors) — TL;DR: forget the `wasm32-unknown-unknown` target and you get cryptic linker errors at the first `cargo build`.

### TinyGo

```bash
# macOS
brew tap tinygo-org/tools
brew install tinygo go

# Linux (apt)
apt install tinygo golang
```

TinyGo bundles its own Go compiler fork but **also** needs a standard Go install for module resolution. Without it, `tinygo version` reports `(using go version <unknown>)` and module resolution misbehaves silently.

**Required versions:** TinyGo ≥ 0.41, Go ≥ 1.21 (for `//go:wasmimport`).

The `wasm-unknown` target landed in TinyGo 0.31, but the otigen Go scaffold + canonical examples are tested against the 0.41 series — earlier versions hit `//go:wasmexport` codegen bugs that landed fixes in 0.34 / 0.36 / 0.41. The scaffold's `otigen.toml` pins `tinygo_version = "0.41.0"`; older toolchains aren't supported.

**Verify:**

```bash
tinygo version
```

```text
tinygo version 0.41.1 darwin/arm64 (using go version go1.26.3 and LLVM version 20.1.1)
```

**Common errors:**
- `brew install tinygo` (without the tap) fails with "no available formula." You must `brew tap tinygo-org/tools` first.
- First `tinygo build` after `otigen init` fails with `error obtaining VCS status: exit status 128` if the project dir isn't a git repo. Fix: `git init -q` inside the project. (Generated `Makefile` does this automatically in future revisions.)

### AssemblyScript

```bash
# macOS
brew install node

# Or any Node ≥ 18 install:
# https://nodejs.org/en/download

# Then, per-project:
cd <project-dir> && npm install
# (uses the local `assemblyscript` devDependency from package.json)
```

Or install globally:

```bash
npm install -g assemblyscript
```

**Required versions:** Node ≥ 18, AssemblyScript ≥ 0.28.

**Verify:**

```bash
node --version
asc --version
```

**Common errors:**
- `asc: command not found` after `npm install -g`: your npm global prefix isn't on `$PATH`. Check `npm config get prefix` and add `<prefix>/bin` to `PATH`. Or use the local install via `npm run build`.
- Compile fails with `env.abort import is forbidden`: someone removed the `use: ["abort=..."]` line in `asconfig.json`. See [Debugging](./debugging.md#assemblyscript-aborts).

### C / C++

```bash
# macOS — Apple's bundled clang lacks the wasm32 backend.
# Install brew's LLVM + lld:
brew install llvm lld

# Add to your shell profile (~/.zshrc or similar):
echo 'export PATH="/opt/homebrew/opt/llvm/bin:/opt/homebrew/opt/lld/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

# Linux: clang + lld from apt usually ships wasm32 ready.
apt install clang lld
```

**Required components:** clang with the `wasm32` backend (verify with `clang -print-targets | grep wasm32`) AND `wasm-ld` (LLVM's WASM linker, `lld` package).

**Verify:**

```bash
clang -print-targets | grep wasm32
which wasm-ld
```

**Common errors:**
- `error: unable to create target: 'No available targets are compatible with triple "wasm32"'`: you're using Apple's `/usr/bin/clang` which lacks the wasm32 backend. Install brew's LLVM and update `PATH`.
- `clang: error: unable to execute command: posix_spawn failed: No such file or directory` when linking: `wasm-ld` is missing. `brew install lld` separately — it's NOT pulled in by `brew install llvm`.
- `Makefile` uses `clang` from `PATH`. If `which clang` resolves to Apple's, the build fails. Either re-order your `PATH` or override per-build: `make CC=/opt/homebrew/opt/llvm/bin/clang build`.

---

## 3. Verify everything together

The fastest end-to-end smoke test — `otigen test` auto-invokes the per-language compiler before running the suite, so a single command covers build + test:

```bash
otigen new smoke --from counter
cd smoke
otigen test
```

```text
→ Compiling (rust) — cargo build --target wasm32-unknown-unknown --release
    Finished `release` profile [optimized] target(s) in 11.28s
✓ Compiled → ./target/wasm32-unknown-unknown/release/smoke.wasm

  Running 3 tests in ./tests/contract.test.toml (via engine)
    ✓ get_returns_zero_initially (29.55 ms)
    ✓ increment_advances_by_one (7.72 ms)
    ✓ three_increments_yield_three (6.82 ms)

  test result: ok. 3 passed; 0 failed; 0 skipped (3 ran)
```

First-run timings include the full release compile (~10–30 s on a small Rust contract); subsequent runs hit cargo's incremental cache and finish in <1 s.

If you get that output, you're ready for the [next chapter](./first-contract.md). If not, the error message tells you which piece is missing — most install issues route to a `command not found` or a clear missing-target message; cross-check against the per-language notes above.

---

## Reference

- Full per-language install gotchas with troubleshooting steps: [Debugging — installation errors](./debugging.md#installation-errors).
- Toolchain pinning for reproducible builds: each project's `otigen.toml` records `rust_channel` / `tinygo_version` / `asc_version` / `clang_version`. The chain doesn't enforce these, but your team should.
- The `make check-tools` target inside each scaffolded project verifies all four prerequisites are present + correct.
- Public release mirror: [`pyde-net/test-releases`](https://github.com/pyde-net/test-releases) — README covers the tag convention, manual sigstore verification, and the canonical surfaces for every Pyde toolchain.
