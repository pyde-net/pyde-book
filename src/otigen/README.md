# Otigen Toolchain Guide

A linear walkthrough for writing, testing, building, deploying, and operating Pyde contracts. Reads top-to-bottom; each chapter ends where the next begins.

If you've used Foundry, the shape will feel familiar — `otigen` is Pyde's equivalent: one binary that owns scaffold → write → test → deploy → read → operate. The differences are Pyde-specific: WebAssembly contracts instead of Solidity, FALCON-512 post-quantum signatures instead of secp256k1, and four supported languages (Rust, AssemblyScript, TinyGo, C) instead of one.

---

## Who this guide is for

- **You've written contracts before** (Solidity / Vyper / Move / Ink! / CosmWasm / Stylus / Stellar Soroban). You know what `transfer`, `balance`, `caller`, and `revert` mean. You don't need a Computer-Science-101 detour.
- **You're new to WebAssembly** but you know one of the four languages we support. We won't walk you through the WASM bytecode; we will walk you through how Pyde's host ABI shapes the way you write code in your language.
- **You're a chain engineer evaluating Pyde.** Skim §1–§2 to anchor; then jump to [Your First Contract](./first-contract.md) for a working "deploy + read state" loop in 10 minutes.

If you're brand-new to programming, this isn't the entry point — see the [Get Started — for Users](../preface/get-started-for-users.md) page first.

---

## What the toolchain does

`otigen` is one binary that owns the entire authoring lifecycle:

| Subcommand | What it does |
| --- | --- |
| `otigen new` | Scaffold a single contract — minimal counter by default, or clone a canonical example (counter, erc20-token, vesting, dao-governance, …) with `--from <name>`. Run inside a workspace to add the contract as a new `contracts/<name>/` member (registered in `[workspace].members` + `order`). |
| `otigen init` | Scaffold a new multi-contract **workspace**: a root `otigen.toml` with a `[workspace]` table, root `.gitignore` / `README.md` / `Makefile`, and a starter member at `contracts/counter/`. See [Workspaces](./workspaces.md). |
| `otigen addresses` | List a workspace's deployed member addresses (from `artifacts/deployments/<network>.json`). |
| `otigen check` | Validate the project without packaging. Fast pre-commit gate. |
| `otigen build` | Validate + package the compiled `.wasm` into a deploy bundle. Injects the `pyde.abi` custom section. |
| `otigen test` | Run `.test.toml` declarations through the chain's `wasm-exec` engine. Same code path mainnet uses. |
| `otigen wallet` | Manage FALCON-512 keystore. `new` / `import` / `list` / `show` / `password` / `export` / `delete` / `sign` / `verify`. |
| `otigen deploy` | Sign + submit a deploy transaction, poll for the receipt. At a workspace root: builds every member, prints a deploy plan, deploys in `[workspace].order` resolving `@name` cross-references, skips already-deployed members, and caches addresses. `--contract <name>` (also on `build` / `test`) scopes to one member. |
| `otigen call` | Invoke a function on a deployed contract. Typed positional args (decoded per `[functions.<fn>].inputs`), wallet-name address resolution, optional `--value <quanta>` PYDE transfer. View mode is free; `--from` switches to a state-mutating signed tx. |
| `otigen send` | Native PYDE value transfer between accounts. `TxType::Standard`, 21,000-gas path; recipient accepts a `0x` address or a wallet name. |
| `otigen inspect` | Read contract / account metadata + state. `--state-field <name>` returns a typed scalar read from the `declare_storage!` substrate slot. |
| `otigen verify` | Reproducibility check: fetch the on-chain bytes, recompute locally, compare. Optional `--explorer` upload. |
| `otigen upgrade` / `pause` / `unpause` / `kill` | Lifecycle ladder. **Engine-gated in v1** — refused at the CLI until the chain ships `TxType::Lifecycle`. See [Lifecycle](./lifecycle.md) for the v1 patterns (proxy upgrades, author-declared pause/kill booleans). |
| `otigen console` | Interactive REPL against a Pyde node. Persistent history, view + write calls, live event subscriptions. |
| `otigen devnet` | Run a local devnet embedded in the `otigen` binary. Deterministic genesis pre-fund (10 accounts auto-imported into `~/.pyde/keystore.json` as `devnet-0..devnet-9`). `--fork` bootstraps state from a snapshot file or `pyde_getSnapshot` URL. |
| `otigen validator` | Read-only queries over the chain-side validator registry. `show <addr>` fetches one validator's full record (stake / status / jail / uptime); `by-operator <addr>` lists every validator an operator runs. |
| `otigen update` | Pull the latest release and replace the binary. Wraps the canonical curl install one-liner; `--check` prints latest-vs-installed without side effect. |

`otigen` is **the only binary you need**. There is no `otigen-deploy`, no `otigen-test`, no separate SDK. One tool, four languages, complete coverage.

For exhaustive flag + arg reference, see [Commands](./commands.md).

---

## What the toolchain is NOT

- **Not a smart contract language.** Pyde contracts are written in real Rust / TinyGo / AssemblyScript / C, compiled to WebAssembly by each language's own compiler. `otigen` validates + packages the output. The chain runs the WASM.
- **Not a runtime.** `otigen test` executes through the chain's `pyde-engine-wasm-exec::WasmExecutor` by default (same code path mainnet uses); the legacy in-process mock is opt-in via `--no-engine` for the handful of cases the engine can't yet host (parachains, today).
- **Not an SDK.** For Rust, the `#[pyde::entry]` macro + `pyde::declare_storage!()` substrate (pulled from crates.io — `pyde-host` plus the macro crates) is the canonical authoring path; for the other three languages, authors declare `pyde::*` host fn imports directly via the language's FFI mechanism (`//go:wasmimport`, `@external`, `__attribute__((import_module))`). See [WASM Contract Author Guide](../companion/WASM_AUTHOR_GUIDE.md) for the design rationale.
- **Does not bundle a language compiler.** `otigen build` invokes `cargo` / `tinygo` / `asc` / `clang` from your environment. You install the language toolchain yourself.

---

## Supported languages

All four are first-class. Pick the one your team is most productive in; the size / gas deltas matter less than people-hours saved.

| Language | WASM size (counter) | Notes |
| --- | --- | --- |
| **C** | ~1.0 KB | Smallest + fastest. Bare-metal feel, no runtime; you manage memory yourself. Pick when binary size or per-call gas is critical. |
| **Rust** | ~5.0 KB (with macro substrate) | Most ergonomic. `#![no_std]` + `#[pyde::entry]` macro + `pyde::declare_storage!()` for typed schema access. Default recommendation for production contracts. |
| **AssemblyScript** | ~3.0 KB | TypeScript-shaped syntax. Higher per-call gas because of runtime array-bounds checks. Pick when TS familiarity outweighs the cost. |
| **TinyGo** | ~60 KB | Go ecosystem. Heavier binary due to runtime overhead. Pick when sharing code with off-chain Go services. |

The counter contract ships in each language under [`otigen/examples/`](https://github.com/pyde-net/otigen/tree/main/examples). The `counter-rust`, `counter-go`, `counter-as`, and `counter-c` directories each carry a working build — clone any of them, run `make build && make test`, see it work.

---

## The development arc

```text
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ 1. SCAFFOLD      │→│ 2. WRITE         │→│ 3. TEST          │
│ otigen new       │  │ src/lib.rs       │  │ otigen test      │
│ otigen init      │  │ otigen.toml      │  │ otigen test -vv  │
│ --lang rust|as.. │  │                  │  │                  │
└──────────────────┘  └──────────────────┘  └──────────────────┘
                                                     ↓
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ 6. INSPECT       │←│ 5. DEPLOY        │←│ 4. BUILD         │
│ otigen inspect   │  │ otigen deploy    │  │ otigen build     │
│ otigen call      │  │ otigen verify    │  │ → bundle/        │
│ otigen verify    │  │                  │  │                  │
└──────────────────┘  └──────────────────┘  └──────────────────┘
         │                     │
         │                     ↓
         │            ┌──────────────────┐
         │            │ 7. LIFECYCLE     │  (engine-gated in v1
         │            │ proxy upgrades   │   — see Lifecycle)
         │            │ author-declared  │
         │            │ pause / kill     │
         │            └──────────────────┘
         ↓
┌──────────────────┐
│ Off-chain query  │
│ otigen call <fn> │
│ (view, no tx)    │
└──────────────────┘
```

The remaining chapters walk each step:

- [Installation](./installation.md) — toolchain setup per language.
- [Commands](./commands.md) — exhaustive subcommand + flag reference.
- [Your First Contract](./first-contract.md) — scaffold → write → test.
- [Shipping](./shipping.md) — build → deploy.
- [Inspect & Verify](./inspecting.md) — inspect + reproducibility checks.
- [Lifecycle](./lifecycle.md) — proxy upgrades, author-declared pause / kill, and the v2 chain-side plan.
- [Debugging](./debugging.md) — common errors + how to recover.
- [Examples](./examples.md) — the template catalog + on-disk reference contracts.

---

## Conventions in this guide

- **Command output** is shown in code blocks immediately after the command. If you run it locally and see something different, that's a bug — file an issue at <https://github.com/pyde-net/otigen/issues>.
- **`<placeholders>`** in shell commands need to be replaced with your values. `<name>` is the project name, `<addr>` is a 32-byte `0x`-prefixed lowercase-hex address, and so on.
- **Cross-references**: `HOST_FN_ABI_SPEC §7.1` means [§7.1 of the Host Function ABI spec](../companion/HOST_FN_ABI_SPEC.md). Specs are normative; this guide is pedagogical. Where the guide and the binary disagree, the binary's `--help` is the runtime truth and we treat the guide as the bug.
- **The default language is Rust** for all examples. The patterns are identical across languages; the per-language README in each `examples/counter-*` directory carries the syntactic equivalent.
- **Mappings in `[state]` schemas** accept both the canonical form (`type = "map", keys = ["address"], value = "uint128"`) and Solidity-style sugar (`type = "mapping(K => V)"` or `mapping(K -> V)`, including nested forms up to 3 keys). The build lowers the sugar to the canonical form.
- **Signed-tx commands** (`deploy` / `send` / `upgrade` / `pause` / `unpause` / `kill`) accept `--rpc-url <URL>` + `--chain-id <N>` as a paired one-shot override of the project's `[network.<name>]`. `otigen call` accepts `--rpc-url` alone (chain id is read from the resolved network). The pair is mandatory when used: a raw URL doesn't advertise a chain id, and signing against `chain_id = 0` silently bricks the FALCON signature.
