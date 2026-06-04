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
- Per-language testing wrappers for pure helpers. Authors use their language's native test runner (`cargo test`, `npm test`, `go test`, `clang` + their test framework of choice) for function-internals tests. Contract *behaviour* tests — state changes, events, reverts — go through `otigen test`, a Foundry-style TOML-driven runner shared across all four supported languages. See [§17.1](#171-otigen--the-developer-toolchain) below and [Chapter 5 §5.12](./05-otigen-toolchain.md) for the split.

---

## 17.1 `otigen` — the developer toolchain

The Cargo-equivalent build-and-deploy toolchain for Pyde. Replaces the earlier `wright` toolchain that targeted the now-retired Otigen smart-contract language.

`otigen` is **language-agnostic**: the same binary handles projects authored in Rust, AssemblyScript, Go (via TinyGo), or C/C++. Authors declare their language in `otigen.toml`; `otigen` invokes the correct compiler with the correct WASM target and packages the resulting artifact for deployment.

### Subcommand summary

```
otigen init <name> --lang <language>   Scaffold a new project from the language template
otigen build                            Build the WASM module + ABI + bundle artifact
otigen check                            Validate without packaging (fast CI gate)
otigen deploy                           Sign and submit a deploy transaction
otigen upgrade                          Submit an upgrade proposal
otigen pause / unpause / kill           Operational lifecycle (owner-signed)
otigen inspect <address-or-name>        Read deployed contract state, ABI, version history
otigen verify <address-or-name>         Compare local bundle against chain-stored bytes
otigen wallet                           Wallet management subcommands
otigen test                             Run contract behaviour tests (tests/*.test.toml)
otigen console                          REPL against a local or remote node (post-v1)
```

The two test layers complement each other:

- `cargo test` / `npm test` / `go test` (the author's language-native runner) — pure helpers, math, parsing, formatting. Runs in-process, microseconds per test, no chain semantics.
- `otigen test` — contract behaviour. Spins up a wasmtime sandbox per test, mocks every `pyde::*` host function, drives the contract through TOML-declared scenarios with named accounts, named storage slots, time / wave / chain cheats, multi-call sequences, named event matching, and revert assertions. The same `.test.toml` runs against the contract regardless of source language. Spec: [`OTIGEN_TEST_SPEC.md`](../companion/OTIGEN_TEST_SPEC.md).

### Performance — what to expect from `otigen build`

The whole `otigen build` validation + packaging pipeline runs in **single-digit microseconds of CPU work** for a typical contract (parse `otigen.toml`, validate every cross-cutting rule, walk the compiled `.wasm` for imports + exports + deterministic-feature compliance, build the canonical `ContractAbi`, Borsh-encode, inject the `pyde.abi` custom section). Wall-clock invocations are dominated by file I/O — reading the `.wasm` + writing the four bundle files — which lands in the 1–5 ms range on commodity hardware. Validator work is essentially free against that.

The full in-memory pipeline measures **~14.5 µs** on an Apple M-series reference machine. Per-step numbers (Blake3 selector derivation, Borsh encode, custom-section injection, WASM-feature validation) are in [Chapter 5 §5.11](./05-otigen-toolchain.md#511-performance) with a reproduction recipe via `cargo bench`. Baselines are committed under `crates/<crate>/benches/baseline/` in the `pyde-net/otigen` repo; future regressions surface on every PR that runs `cargo bench --baseline=v1`.

For the full reference — `otigen.toml` schema, per-language workflows, state binding generation, deploy/upgrade flow internals, performance numbers — see [Chapter 5](./05-otigen-toolchain.md).

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

### Contract-side SDKs (community)

The SDKs above are **client-side** — they let backends, scripts, and front-ends talk to a Pyde node. Writing the **contract itself** is the other side of the boundary, and that's where the per-language community SDKs come in.

Pyde Network ships **one canonical contract-side SDK** — the Rust stack in [pyde-net/otigen](https://github.com/pyde-net/otigen) (`pyde-host`, `pyde-storage-macros`, `pyde-entry-macros`). Bringing your language to that surface is a community pathway: the chain holds a stable WASM ABI ([HOST_FN_ABI_SPEC](../companion/HOST_FN_ABI_SPEC.md)) and a stable bundle format ([OTIGEN_BINARY_SPEC](../companion/OTIGEN_BINARY_SPEC.md)); everything above is open to any language that targets `wasm32-unknown-unknown`.

If you're maintaining or proposing a language SDK, the contract you must satisfy lives in:

- [**SDK Author Guide**](../companion/SDK_AUTHOR_GUIDE.md) — the four invariants every SDK must hold (void-void entry signature, borsh-canonical calldata, host-fn signature parity, `pyde.abi` custom section), the reference implementation's surface, and the quality bar to ship.
- [`examples/storage-stress`](https://github.com/pyde-net/otigen/tree/main/examples/storage-stress) in otigen — the canonical acceptance contract. A community SDK is "ready" when its port of the 28-assertion `tests/stress_e2e.py` passes end-to-end against `pyde devnet`.

Community SDKs publish under their own org (e.g., `pyde-go/`, `pyde-ts-contracts/`) and are listed back here by PR against [pyde-net/pyde-book](https://github.com/pyde-net/pyde-book). No SDK is currently in the listing — this section will fill in as language communities ship.

---

## 17.4 JSON-RPC

The node exposes a JSON-RPC interface over HTTP and WebSocket. Method surface includes:

- Standard query methods — `pyde_getAccount`, `pyde_getBalance`, `pyde_getNonce`, `pyde_getContractCode`, `pyde_getContractState`, `pyde_resolveName`
- Transaction submission — `pyde_sendRawTransaction`, `pyde_sendRawEncryptedTransaction`, `pyde_estimateAccess`
- View-function calls — `pyde_call(contract, fn, calldata)` — **free**, off-chain execution against current state; no tx, no gas, no consensus. Mirrors EVM's `eth_call`. Bounded by RPC-layer rate limits + per-call instruction cap.
- Subscription methods (WebSocket) — `pyde_subscribe`:
  - `newHeads` — wave commits as they finalize
  - `accountChanges` — state changes to a specific account
  - `logs` — events matching an AND+OR filter (topic OR-list + optional contract); at-least-once delivery; each event carries `(wave_id, tx_index, event_index)` cursor for dedup; `pyde_resubscribe({from: cursor})` resumes after disconnect. Full mechanics: [Host Function ABI Spec §15.5](../companion/HOST_FN_ABI_SPEC.md).
- Historical event queries — `pyde_getLogs({from_wave, to_wave, topics, contract, cursor, limit})` — 5,000-wave cap per request, cursor pagination, ascending wave order. Per-wave bloom filter prefilters; three RocksDB indexes resolve exact matches. Full spec: [Host Function ABI Spec §15.4](../companion/HOST_FN_ABI_SPEC.md).
- Snapshot queries — `pyde_getSnapshotManifest(wave_id)` (light-client state sync)
- Gas / fee estimation — `pyde_estimateGas`, `pyde_getBaseFee`
- Wave + state-root queries (for light clients) — `pyde_getWave`, `pyde_getHardFinalityCert`
- Validator-specific methods — committee status, attestations, under an authorized-only namespace

The full method catalog is published as the JSON-RPC reference (lives alongside the node binary documentation).

---

## 17.4b Client-Side wasmtime + Wallet Preview Tiers

Pyde's TS and Rust SDKs embed wasmtime directly, so wallets can **simulate transactions locally** before signing. This unlocks honest pre-sign safety information without server-side round trips.

### Tier 1 — Deterministic local preview (v1 mainnet)

The default. Wallets ship with:

- **Gas estimation** — run the tx against current state locally; count consumed fuel; show user the expected gas cost
- **Access list inference** — speculatively execute; record every sload/sstore call's slot_hash; attach the inferred access list to the tx so the chain's parallel scheduler can use it
- **View function execution** — `view`-attributed functions execute locally, fetching state via RPC for any cache misses; no tx submitted, no gas
- **Dry-run preview** — show the user "this tx will spend X PYDE, transfer Y tokens to address Z, emit Transfer event, leave your balance at W"
- **Known-pattern decoding** — recognize standard ABI patterns (transfer, approve, etc.) and surface them in plain language

The user clicks Sign only after seeing exactly what the tx does in this moment.

```text
Wallet UX flow (Tier 1):

  User constructs tx in wallet
    ↓
  Wallet fetches contract WASM + relevant state via RPC
    ↓
  Wallet runs wasmtime locally with the tx
    ↓
  Wallet displays preview:
    "Calling Token.transfer(to=0xabc..., amount=100 PYDE)
     This tx will:
       - Send 100 PYDE from you (0xYOU) to 0xabc...
       - Your balance after: 900 PYDE
       - Emit event: Transfer(from=0xYOU, to=0xabc..., amount=100)
       - Cost: ~25,000 gas (~0.001 PYDE)
     [Sign] [Cancel]"
    ↓
  User signs (FALCON-512) → tx submitted
```

### Tier 2 — Reputation + heuristics (v2 direction)

Layers on top of Tier 1. Doesn't require AI — just curated data + pattern matching:

- Flag contracts on known-malicious lists (Blockaid, Pyde-community-maintained registries)
- Flag "approve unfamiliar contract for max amount" patterns
- Cross-reference with audit databases (was this contract audited? by whom?)
- Surface community reputation scores

### Tier 3 — LLM-augmented analysis (v3+ direction)

LLM reads contract WASM (or decompiled source) to summarize behavior, identify common risk patterns:

- approve+drain combos
- hidden auth modifiers
- timelocked backdoors
- liquidity-rug constructions

Rates confidence: "looks like a standard DEX trade" vs "matches wallet-drainer pattern X." Surfaces a graded warning to the user.

By the time Pyde mainnet matures, third-party services (Blockaid, Pocket Universe, etc.) will likely offer this as an API. Pyde wallets can integrate.

### Honest v1 framing

The marketing claim Pyde v1 can make:

> *Pyde wallets show you the immediate effects of every transaction before you sign — including exact state changes, events emitted, and gas cost. You see what your authorization does in this moment. Deeper analysis (downstream authorization implications, contract backdoors, signed-message replays) requires reading the contract code or using third-party safety tools.*

Honest, defensible, materially better than EVM wallet UX without overpromising.

### What Tier 1 cannot detect

Worth being explicit about:

- **Approval-then-drain patterns.** The approval looks innocuous (just a state write). The drain happens in a future tx that the malicious contract submits using that approval.
- **Time-locked backdoors.** Contract logic that activates after N waves.
- **Signed-message replay.** Signing arbitrary EIP-712-style messages off-chain that can be replayed.

These are application-layer risks. Tier 2/3 (when shipped) address them. v1 documents them honestly so users know to use third-party tools for those classes of analysis.

---

## 17.5 What changed at the pivots

For readers coming from the pre-pivot world, the developer tooling has changed substantially:

| Pre-pivot (Otigen-language era) | Post-pivot (current) |
|-------------------------------|---------------------|
| `otic` — Otigen compiler | Retired; archived |
| `wright` — project CLI | Retired; archived. Role taken by the new `otigen` binary |
| `.oti` source files | Replaced by author's language of choice (`.rs`, `.ts`, `.go`, `.c`) |
| PVM bytecode artifacts | Replaced by WASM `.wasm` artifacts |
| Otigen-specific tests | Two layers: author's language-native test runner for pure helpers (`cargo test`, etc.) + `otigen test` for contract behaviour (TOML-declared, language-agnostic) |
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
| `pyde-crypto-wasm` | `pyde-net/pyde-crypto-wasm` |
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
