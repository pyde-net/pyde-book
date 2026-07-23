# Get Started: for Developers

You're here because you want to build something on Pyde. This page is
the on-ramp: enough orientation to land you on the right specs,
without reproducing them.

---

## What you can build

Pyde supports two contract surfaces:

1. **Smart contracts**: sandboxed WASM modules deployed to the chain.
   Standard L1 contract development; read [Chapter 3: Execution
   Layer](../chapters/03-virtual-machine.md) for the runtime model.
2. **Parachains** (v2): permissionless decentralized networks that do
   one job the base chain cannot — foreign-chain adapters, data feeds,
   real-world IO — with their own staked validators and their own
   state, anchored to and re-validated by Pyde, and an extended ABI
   for declared IO + cross-parachain messaging.
   Read [Chapter 13: Parachains](../chapters/13-cross-chain.md).

Both compile to WebAssembly. Pyde executes them via
[wasmtime](https://wasmtime.dev) + Cranelift AOT — deterministic
feature subset, per-tx overlay isolation, fuel-metered gas.

---

## What language?

Whatever targets `wasm32`. Pyde doesn't ship per-language SDKs;
authors compile their `.wasm` themselves and use the `otigen`
toolchain to package + deploy it. First-class examples ship for:

- **Rust**: `cargo build --target wasm32-unknown-unknown --release`
- **AssemblyScript**: `npx asc contract.ts -o contract.wasm`
- **Go (TinyGo)**: `tinygo build -target wasm-unknown -o contract.wasm`
- **C / C++**: `clang --target=wasm32 -nostdlib -Wl,--no-entry`

The chain only sees the bytes. Pick what fits your team.

---

## The five things to read

In order:

1. **[Chapter 1: Introduction](../chapters/01-introduction.md)**:
   10-minute orientation. Why Pyde exists, what it's not.
2. **[Chapter 3: Execution Layer](../chapters/03-virtual-machine.md)**:
   the runtime, the per-tx overlay, the determinism contract.
3. **[Host Function ABI v1.0](../companion/HOST_FN_ABI_SPEC.md)**:
   every `pyde::*` function your WASM can import. Signatures,
   semantics, gas costs, error codes. This is the contract the chain
   stands on.
4. **[Chapter 5: Otigen Toolchain](../chapters/05-otigen-toolchain.md)**:
   how `otigen` builds, tests, deploys, and manages wallets.
5. **[Otigen Binary Spec v1.0](../companion/OTIGEN_BINARY_SPEC.md)**:
   the CLI surface. Every command, every flag.
6. **[Otigen Test Spec v1.0](../companion/OTIGEN_TEST_SPEC.md)**:
   the contract-behaviour test framework (Foundry-grade, TOML).
   Read once you have a working contract.

Bookmark these. The rest of the book (state model, gas, accounts,
consensus, networking, parachains, slashing, governance) you read on
demand.

---

## The minimum loop (once mainnet ships)

```sh
# 1. Scaffold a project
otigen init my-token --lang rust

# 2. Edit src/lib.rs + otigen.toml; write tests/contract.test.toml

# 3. Build (you run cargo; otigen post-processes)
cargo build --target wasm32-unknown-unknown --release
otigen build

# 4. Run the behaviour tests
otigen test

# 5. Deploy to devnet / testnet / mainnet
otigen deploy --network devnet
```

This loop is detailed in
[`OTIGEN_BINARY_SPEC` §3.2 + §3.10](../companion/OTIGEN_BINARY_SPEC.md).
The TOML format for `tests/contract.test.toml` is documented in
[`OTIGEN_TEST_SPEC.md`](../companion/OTIGEN_TEST_SPEC.md).

---

## Pre-mainnet status (today)

Pyde is **pre-mainnet**. What's already shippable:

- The protocol spec (everything in this book).
- The post-quantum cryptography crate: [pyde-crypto](https://github.com/pyde-net/pyde-crypto).
- The engine workspace's interface layer (MC-0 — `phase-0-foundation`
  tag on `pyde-net/engine`).
- The marketing site you arrived from.

What's in active build-out:

- The engine (execution + consensus + node binary). MC-1 in flight
  across two parallel streams — see [Implementation Plan §3.2](../companion/IMPLEMENTATION_PLAN.md).
- The otigen toolchain. MC-1 Stream α — see `pyde-net/otigen`.

What you can do right now:

- Read the spec, file issues, propose PIPs.
- Watch the repos.
- Track [the launch plan](../chapters/19-launch-strategy.md).

---

## Where to ask

- **[GitHub Discussions](https://github.com/pyde-net)**: design
  questions, spec ambiguities.
- **[Telegram](https://t.me/pydenet)**: quick chat, anything that
  doesn't need a paper trail.
- **[PIPs](https://github.com/pyde-net/pips)**: propose a protocol
  change.

Welcome aboard.
