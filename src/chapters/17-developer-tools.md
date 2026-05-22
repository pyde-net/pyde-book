# Chapter 17: Developer Tools

Pyde's developer toolchain is the set of command-line programs, SDKs, and RPC endpoints that let people write, test, deploy, and interact with contracts. This chapter is the reference survey — what exists, what it does, where to find it.

For deep documentation on the primary developer-facing tool (the `otigen` binary), see [Chapter 5: Otigen Toolchain](./05-otigen-toolchain.md). This chapter does not duplicate that material; it summarizes and points outward.

## What's in scope

- **`otigen`** — the developer toolchain binary. Handles project scaffolding, builds in any supported language, state binding generation, deployments, wallet management, REPL access. The single tool most contract developers use day-to-day.
- **`pyde`** — the node binary (validator + full node) with JSON-RPC, libp2p networking, and the WASM execution layer.
- **`pyde-rust-sdk`** — the Rust client SDK for talking to a Pyde node programmatically.
- **`pyde-ts-sdk`** — the TypeScript / JavaScript client SDK.
- **`pyde-crypto-wasm`** — WASM bindings exposing post-quantum cryptography (FALCON signing, Kyber encryption, Poseidon2/Blake3 hashing) to browser and Node.js environments.

## What's **not** in scope at launch (tracked later)

- A dedicated Pyde block explorer frontend (the backend indexer is on the roadmap; the UI is community ecosystem work).
- A proprietary IDE. Standard editors with the language's standard tooling (rust-analyzer for Rust, the AssemblyScript LSP, gopls for Go, clangd for C/C++) are the intended path. No Pyde-specific IDE.
- Per-language testing wrappers. Contract authors use their language's native test runner (`cargo test`, `npm test`, `go test`, `clang` + your test framework of choice).

---

## 17.1 `otigen` — the developer toolchain

The Foundry / Hardhat / Cargo-equivalent for Pyde. Replaces the earlier `wright` toolchain that targeted the now-retired Otigen smart-contract language.

`otigen` is **language-agnostic**: the same binary handles projects authored in Rust, AssemblyScript, Go (via TinyGo), or C/C++. Authors declare their language in `otigen.toml`; `otigen` invokes the correct compiler with the correct WASM target and packages the resulting artifact for deployment.

### Subcommand summary

```
otigen init <name> --lang <language>   Scaffold a new project from the language template
otigen build                            Build the WASM module + ABI + bundle artifact
otigen deploy                           Sign and submit a deploy transaction
otigen upgrade                          Submit an upgrade proposal
otigen pause / kill                     Operational lifecycle (where supported)
otigen inspect <address-or-name>        Read deployed contract state, ABI, version history
otigen wallet                           Wallet management subcommands
otigen console                          REPL against a local or remote node
```

There is no `otigen test`. Authors use their language's native test runner.

For the full reference — `otigen.toml` schema, per-language workflows, state binding generation, deploy/upgrade flow internals — see [Chapter 5](./05-otigen-toolchain.md).

---

## 17.2 `pyde` — the node binary

The node binary that any full node or validator runs. Contains:

- The Mysticeti DAG consensus layer
- The WASM execution layer (wasmtime + Cranelift AOT)
- The JMT state layer (with PIP-2 clustering, dual-hash, PIP-3 prefetch, PIP-4 write-back cache)
- The libp2p + QUIC + Gossipsub network layer
- A JSON-RPC server for client interaction
- Validator-mode flags for committee participation, stake management, key rotation

```
pyde init                  Initialize a new node (creates keystore, config)
pyde start                 Run the node (validator if configured for committee participation, full node otherwise)
pyde config show           Print effective config
pyde keys rotate           Rotate FALCON keypair (validator-only)
pyde admin <subcommand>    Operational commands (drain, halt, recover)
```

A full operational reference for validators is published as a separate document (see Validator Operating Guide, post-public-testnet).

---

## 17.3 SDKs

Two first-class language SDKs at launch, with the WASM crypto bindings as a third-party-friendly bridge.

### `pyde-rust-sdk`

Idiomatic Rust client for Pyde nodes. Use cases:
- Backend services interacting with Pyde from Rust applications.
- Scripted deployment + interaction (alternative to `otigen`'s deploy/send commands when scripting in Rust).
- Tools building on top of Pyde (indexers, monitoring, custom validators).

Surface area:
- Transaction construction + signing
- RPC client (JSON-RPC over HTTP and WebSocket)
- Streaming subscriptions (new blocks, account changes, event filters)
- ABI encoding/decoding helpers
- Wallet integration (load keys from `~/.pyde/wallets/`, hardware wallets via external signer protocol)

### `pyde-ts-sdk`

TypeScript / JavaScript SDK. Ships at ethers-equivalent maturity from day one (lessons from EVM tooling baked in).

Surface area:
- Same primitives as `pyde-rust-sdk` but idiomatic TS
- Browser-friendly via tree-shaking + WASM crypto bridge
- Type-safe ABI generation from `abi.json` artifacts
- React hooks for common patterns (account, balance, contract calls)
- Wallet adapter pattern for browser-wallet integration

### `pyde-crypto-wasm`

WASM bindings exposing post-quantum cryptography to JavaScript. Used internally by `pyde-ts-sdk`, also usable directly by any project that needs PQ crypto in a browser or Node.js environment.

Surface area:
- FALCON-512 keypair generation, sign, verify
- Kyber-768 encryption / decryption
- Threshold-encryption shares (where used by client-side encrypted-tx submission)
- Poseidon2 and Blake3 hashing

---

## 17.4 JSON-RPC

The node exposes a JSON-RPC interface over HTTP and WebSocket. Method surface includes:

- Standard query methods (account state, balance, nonce, contract code, contract state)
- Transaction submission (plaintext and threshold-encrypted)
- Subscription methods (new heads, new blocks, account changes, event filters)
- Gas / fee estimation
- Wave + state-root queries (for light clients)
- Validator-specific methods (committee status, attestations) under an authorized-only namespace

The full method catalog is published as the JSON-RPC reference (lives alongside the node binary documentation).

---

## 17.5 What changed at the pivots

For readers coming from the pre-pivot world, the developer tooling has changed substantially:

| Pre-pivot (Otigen-language era) | Post-pivot (current) |
|-------------------------------|---------------------|
| `otic` — Otigen compiler | Retired; archived |
| `wright` — project CLI | Retired; archived. Role taken by the new `otigen` binary |
| `.oti` source files | Replaced by author's language of choice (`.rs`, `.ts`, `.go`, `.c`) |
| PVM bytecode artifacts | Replaced by WASM `.wasm` artifacts |
| Otigen-specific tests | Replaced by author's language's native test runner |
| `pyde.toml` config | Replaced by `otigen.toml` config with state schema declaration |

The `otigen` *name* survives, repurposed for the developer toolchain. See [The Pivot](../preface/pivot.md) for the full narrative, and [pivot/02-otigen-language-era.md](../pivot/02-otigen-language-era.md) for the design record of the retired language.

---

## 17.6 Where everything lives

| Tool | Repo |
|------|------|
| `otigen` developer toolchain | `pyde-net/otigen` |
| `pyde` node binary + engine | `pyde-net/engine` |
| `pyde-rust-sdk` | `pyde-net/pyde-rust-sdk` |
| `pyde-ts-sdk` | `pyde-net/pyde-ts-sdk` |
| `pyde-crypto-wasm` | `pyde-net/crypto-wasm` |
| Archived `otic` compiler | `pyde-net/otic` (archived) |
| Archived `wright` toolchain | `pyde-net/wright` (archived) |
| The Otigen Book (historical) | `pyde-net/otigen-book` (preserved as historical artifact) |

---

## 17.7 Reading on

- [Chapter 5: Otigen Toolchain](./05-otigen-toolchain.md) — the deep reference for the `otigen` binary.
- [Chapter 3: Execution Layer](./03-virtual-machine.md) — the WASM runtime that compiled contracts execute under.
- [Chapter 11: Account Model](./11-account-model.md) — the name registry the toolchain interacts with.
- [Chapter 18: Protocol Upgrades](./18-protocol-upgrades.md) — how contract and protocol upgrades flow.
- [Preface: The Pivot](../preface/pivot.md) — narrative on why the toolchain looks the way it does.
