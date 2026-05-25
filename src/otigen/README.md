# Otigen Toolchain Guide

A linear walkthrough for writing, testing, building, deploying, and operating Pyde contracts. Reads top-to-bottom; each chapter ends where the next begins.

If you've ever used Foundry, this guide will feel familiar — `otigen` is Pyde's equivalent. The toolchain has the same shape (init → write → test → deploy → inspect → verify), the same verbosity-ladder testing UX (`-v` / `-vv` / `-vvv` / `-vvvv`), the same fast inner loop. The differences are Pyde-specific: WebAssembly contracts instead of Solidity, FALCON post-quantum signatures instead of secp256k1, and four supported languages (Rust, AssemblyScript, Go, C) instead of one.

---

## Who this guide is for

- **You've written contracts before** (Solidity / Vyper / Move / Ink! / CosmWasm / Stylus / Stellar Soroban). You know what `transfer`, `balance`, `caller`, and `revert` mean. You don't need a Computer-Science-101 detour.
- **You're new to WebAssembly** but you know one of the four languages we support. We won't walk you through the WASM bytecode; we will walk you through how Pyde's host ABI shapes the way you write code in your language.
- **You're a chain engineer evaluating Pyde.** Skim §1-§2 to anchor; then jump to §3 for a working "deploy + read state" loop in 10 minutes.

If you're brand-new to programming, this isn't the entry point — see the [Get Started — for Users](../preface/get-started-for-users.md) page first.

---

## What the toolchain does

`otigen` is one binary that owns the entire authoring lifecycle:

| Subcommand | What it does |
|---|---|
| `otigen init` | Scaffold a new project in any of four languages. Generates `Cargo.toml` / `go.mod` / `package.json` / `Makefile` as appropriate + a counter contract + a complete `host_fns` reference + Foundry-style tests. |
| `otigen build` | Read the language compiler's WASM output, validate it (imports, exports, features), inject the `pyde.abi` custom section, write a deploy bundle. |
| `otigen test` | Run the contract's `.test.toml` declarations against a sandboxed `wasmtime` runtime with mock host functions. Foundry-style verbosity + gas tracking. |
| `otigen deploy` | Submit the deploy transaction to a network. Sign with FALCON-512, wait for receipt. |
| `otigen inspect` | Query a deployed contract's state + metadata via the chain's RPC. |
| `otigen verify` | Reproducibility check — fetches the on-chain bytes and compares against the local bundle. |
| `otigen upgrade` / `pause` / `unpause` / `kill` | The lifecycle ladder. Authority-gated by the contract owner. |
| `otigen wallet` | Manages the local keystore. FALCON-512 keys, AES-256-GCM-encrypted, single file. |

`otigen` is **the only binary you need**. There is no `otigen-deploy`, no `otigen-test`, no separate SDK. One tool, four languages, complete coverage.

---

## What the toolchain is NOT

- **It is not a smart contract language.** Pyde contracts are written in real Rust / Go / AssemblyScript / C, compiled to WebAssembly by each language's own compiler. `otigen` validates + packages the output. The chain runs the WASM.
- **It is not a runtime.** `otigen test` uses `wasmtime` directly with mock host functions; production execution happens inside Pyde's `wasm-exec` engine (the chain's executor). The two are designed to behave identically at the contract level, but the test runner is for fast iteration — chain-canonical behavior comes from devnet integration.
- **It is not an SDK.** Authors declare `pyde::*` host fn imports directly in their source language using the canonical FFI mechanism (`extern "C"`, `//go:wasmimport`, `@external`, or `__attribute__((import_module))`). There's nothing to `cargo add` or `npm install`. See [WASM Contract Author Guide](../companion/WASM_AUTHOR_GUIDE.md) for why this design.
- **It does not bundle a language compiler.** `otigen` invokes `cargo` / `tinygo` / `asc` / `clang` via the project's `Makefile`. You install the language toolchain yourself; `otigen build` picks up the produced `.wasm`.

---

## Supported languages

All four are first-class. Pick the one your team is most productive in; the size / gas deltas matter less than people-hours saved.

| Language | WASM size (counter) | Gas / `increment()` | When to pick |
|---|---|---|---|
| **C** | 1,002 B | **186 gas** | Smallest + fastest. Use when binary size or per-call gas is critical. Bare-metal feel, no runtime; you manage memory yourself. |
| **Rust** | **909 B** | 292 gas | Smallest binary. Most ergonomic of the low-level options. `#![no_std]` + manual `extern "C"` declarations. Default recommendation for production contracts. |
| **AssemblyScript** | 1,115 B | 4,686 gas | TypeScript-shaped syntax, type-safe. ~16× the gas of Rust because of runtime array-bounds checks. Pick when team familiarity with TS outweighs the cost. |
| **TinyGo** | 59 KB | 579 gas | Go ecosystem. Heavier binary due to runtime overhead. Pick when sharing code with off-chain Go services. |

All four implement the same counter contract in [`pyde-net/otigen/examples/counter-{rust,go,as,c}/`](https://github.com/pyde-net/otigen/tree/main/examples). Clone any of them, run `make build && make test`, see it work.

---

## The development arc

```text
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ 1. INIT          │→│ 2. WRITE         │→│ 3. TEST          │
│ otigen init <X>  │  │ src/lib.rs       │  │ otigen test      │
│ + language       │  │ otigen.toml      │  │  -vvvv for       │
│                  │  │                  │  │  traces          │
└──────────────────┘  └──────────────────┘  └──────────────────┘
                                                     ↓
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ 6. INSPECT       │←│ 5. DEPLOY        │←│ 4. BUILD         │
│ otigen inspect   │  │ otigen deploy    │  │ otigen build     │
│ otigen verify    │  │ to devnet/main   │  │ → bundle.tar.gz  │
└──────────────────┘  └──────────────────┘  └──────────────────┘
         ↓
┌──────────────────┐
│ 7. LIFECYCLE     │
│ otigen upgrade   │
│ otigen pause     │
│ otigen kill      │
└──────────────────┘
```

The remaining chapters walk each step:

- [Installation](./installation.md) — toolchain setup per language.
- [Your First Contract](./first-contract.md) — `init` → `write` → `test`.
- [Shipping](./shipping.md) — `build` → `deploy`.
- [Inspect & Verify](./inspecting.md) — `inspect` + reproducibility checks.
- [Lifecycle](./lifecycle.md) — `upgrade`, `pause`, `unpause`, `kill`.
- [Debugging](./debugging.md) — common errors + the verbosity ladder.

---

## Conventions in this guide

- **Command output** is shown in code blocks immediately after the command. If you run it locally and see something different, that's a bug — file an issue at <https://github.com/pyde-net/otigen/issues>.
- **`<placeholders>`** in shell commands need to be replaced with your values. `<name>` is the project name, `<addr>` is a 32-byte address (lowercase hex), and so on.
- **Cross-references**: `HOST_FN_ABI_SPEC §7.1` means [§7.1 of the Host Function ABI spec](../companion/HOST_FN_ABI_SPEC.md). Specs are normative; this guide is pedagogical.
- **The default language is Rust** for all examples in this guide. The patterns are identical across languages; the per-language README in each `examples/counter-*` carries the syntactic equivalent.
