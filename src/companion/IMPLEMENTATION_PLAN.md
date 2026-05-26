# Pyde Implementation Plan

**Version 0.1** — written 2026-05-23 after design phase completion.

This document is the coordination artifact for **implementing** Pyde. The design phase is done (the rest of the book + the locked specs in this `companion/` directory define the protocol). This document defines:

- **Who builds what** — three parallel work streams, with strict crate ownership
- **In what order** — five sequential phases (MC-0 through MC-5)
- **Against what specs** — every stream points at its canonical authoritative doc
- **How to avoid clashes** — interface contracts frozen at Phase 0; branching protocol; coordination rules

If this document and any other artifact disagree on *implementation logistics* (who owns what, branching rules), this document wins. If this document and a *design spec* (HOST_FN_ABI_SPEC, etc.) disagree on protocol semantics, the design spec wins.

For the roadmap with checklist-level tracking, see [roadmap.md](../roadmap.md). For the design philosophy ("v1 ships interfaces, v2 ships implementations") see the memory entry [`v2_roadmap_and_room`](https://github.com/pyde-net/.github/blob/main/memory-references.md).

---

## 1. The three-session model

Pyde's v1 implementation is structured as three parallel work streams, each owning its own clear scope. The streams are designed to be independently parallelizable — the only synchronization point is at integration time (MC-2).

| Stream | Codename | Repository | Primary spec | What it builds |
|---|---|---|---|---|
| α | **Toolchain** | [`pyde-net/otigen`](https://github.com/pyde-net/otigen) (new) | [`OTIGEN_BINARY_SPEC.md`](./OTIGEN_BINARY_SPEC.md) | The `otigen` developer-tool binary: build, deploy, wallet, console |
| β | **Execution** | [`pyde-net/engine`](https://github.com/pyde-net/engine) (new), branch `execution-side` | [`HOST_FN_ABI_SPEC.md`](./HOST_FN_ABI_SPEC.md), Chapter 4, PIPs 2/3/4 | The WASM execution layer: state, account, tx, mempool, wasm-exec |
| γ | **Consensus** | [`pyde-net/engine`](https://github.com/pyde-net/engine), branch `consensus-side` | Chapter 6, [`SLASHING.md`](./SLASHING.md), [`VALIDATOR_LIFECYCLE.md`](./VALIDATOR_LIFECYCLE.md), [`STATE_SYNC.md`](./STATE_SYNC.md), [`CHAIN_HALT.md`](./CHAIN_HALT.md), [`NETWORK_PROTOCOL.md`](./NETWORK_PROTOCOL.md) | Consensus + networking + node binary |

Each stream is meant to be assignable to a single Claude session or a single human contributor and run independently for weeks at a time without coordination beyond the locked interface contracts (§4).

---

## 2. Five-phase execution timeline

```
MC-0 — INTERFACE FOUNDATION  [SEQ — me]
   │
   ▼
MC-1 — PROTOCOL CORE  [PAR — three sessions]
   │   ├─ Stream α (toolchain)
   │   ├─ Stream β (execution)
   │   └─ Stream γ (consensus)
   │
   ▼
MC-2 — INTEGRATION  [SEQ]
   │   Merge β + γ branches; bring up local devnet
   │
   ▼
MC-3 — STATE SYNC + PARACHAIN ACTIVATION  [SEQ]
   │
   ▼
MC-4 — PERFORMANCE + FAILURE HANDLING  [PAR within]
   │
   ▼
MC-5 — VALIDATION + MAINNET LAUNCH  [SEQ]
```

Phase summaries in §3 below. Detailed checklists per phase live in [roadmap.md](../roadmap.md).

---

## 3. Phase plan

### 3.1 MC-0 — Interface Foundation (sequential, ~1 day)

The prerequisite to safe parallelism. Without MC-0 complete, the three streams clash on shared types and interface drift.

**Deliverables:**

1. **Fresh `pyde-net/engine` repo** created on GitHub + cloned locally.
2. **Cargo workspace skeleton** with stubs for every crate listed in §5.
3. **`types` crate** fully written. Every type used across crate boundaries lives here, frozen at end of MC-0. Includes: `Address`, `SlotHash`, `Value`, `Balance`, `Nonce`, `Tx`, `TxHash`, `Receipt`, `StateRoot` (Blake3 + Poseidon2), `EventRecord`, `WaveId`, `Round`, `VertexHash`, `Vertex`, `WaveCommitRecord`, `HardFinalityCert`, `FalconPubkey`, `FalconSignature`, error codes per [HOST_FN_ABI_SPEC §4](./HOST_FN_ABI_SPEC.md).
4. **`interfaces` crate** fully written. The cross-crate traits that decouple β and γ:
   - `trait StateView` — read-only state access (used by mempool validation, view-call execution)
   - `trait StateMutator` — apply a wave's worth of writes atomically
   - `trait Executor` — invoke a tx (called by consensus when committing a wave)
   - `trait MempoolView` — what consensus reads from the mempool
   - `trait NetworkView` — gossipsub send/recv abstraction
   - `trait ConsensusEngine` — the consensus loop the node binary drives
   - Each trait ships with a **mock implementation** so β and γ can write tests in isolation.
5. **CI baseline** — `.github/workflows/ci.yml` runs `cargo build`, `cargo test`, `cargo clippy --workspace -- -D warnings`, `cargo fmt --all -- --check` on every PR.
6. **Branching protocol** documented (§6).
7. **Initial commit** tagged `phase-0-foundation`.

**Owner:** main session (current context). The user does not need to spin up parallel sessions until MC-0 ships.

**Bar to advance to MC-1:** `phase-0-foundation` tag landed on `main`; CI green; `types` and `interfaces` crates pass their own unit tests; all crate stubs compile.

### 3.2 MC-1 — Protocol Core (parallel, three streams)

The three streams (α, β, γ) work concurrently against the locked Phase 0 foundation.

#### Stream α — Toolchain (`pyde-net/otigen` repo)

Implements [`OTIGEN_BINARY_SPEC.md`](./OTIGEN_BINARY_SPEC.md) end-to-end. Independent of engine internals — only depends on the locked Host Function ABI spec to validate WASM modules. Specific deliverables in §3.2 of the spec; first milestone is `otigen build` working against the canonical Rust hello-world contract.

Crates (in `pyde-net/otigen` workspace):

- `otigen-cli` — the binary
- `otigen-toml` — config parser + schema validation
- `otigen-abi` — `pyde.abi` custom-section construction + injection (via `wasm-encoder`)
- `otigen-rpc` — JSON-RPC client
- `otigen-wallet` — keystore (Argon2id + AES-256-GCM) + FALCON-512 signing
- `otigen-test` — wasmtime-driven contract behaviour test runner (see [`OTIGEN_TEST_SPEC.md`](./OTIGEN_TEST_SPEC.md))
- (later) `otigen-console` — REPL

External dependencies:
- `pyde-crypto` (sibling polyrepo) — FALCON, Argon2id, AES-GCM, Borsh
- `wasmparser`, `wasm-encoder` (Bytecode Alliance) — WASM inspection + custom-section writing
- `clap` — CLI framework
- `serde`, `toml` — config parsing
- `reqwest`, `tokio-tungstenite` — HTTP + WebSocket

#### Stream β — Engine Execution (`pyde-net/engine`, branch `execution-side`)

Crates owned:
- `account` — 32-byte addresses, `AuthKeys` enum (with `Programmable` v2 reservation), 16-slot nonce window, name-registry interface
- `state` — JMT dual-hash, `state_cf` + `jmt_cf` + `events_cf` + `events_by_topic_cf` + `events_by_contract_cf`, PIP-2 clustered keys, PIP-3 prefetch, PIP-4 write-back cache, snapshot generation
- `tx` — transaction types (Transfer, ContractCall, ContractDeploy, ValidatorRegister, Multisig, etc.), canonical hashing, gas accounting, deploy/upgrade/lifecycle handlers
- `wasm-exec` — wasmtime engine config (deterministic feature subset), `WasmExecutor`, every host function from [HOST_FN_ABI_SPEC §7-§8](./HOST_FN_ABI_SPEC.md), module cache, fuel-to-gas mapping, per-tx overlay
- `mempool` — FALCON-verify pipeline, validation rules, gossip admission, gas-bond logic

Spec map:
- `HOST_FN_ABI_SPEC` — every host function this stream implements
- Chapter 4 — state model + dual-hash JMT
- PIPs 2, 3, 4 — state optimizations
- Chapter 11 — account model, tx wire format
- Chapter 10 — gas + fee model
- Chapter 3 — execution layer architecture, per-tx overlay

#### Stream γ — Engine Consensus + Networking (`pyde-net/engine`, branch `consensus-side`)

Crates owned:
- `consensus` — Mysticeti DAG, vertex/round/anchor/wave logic, BFS subdag walk, slashing evidence collection, equivocation detection, missing-vertex fetch
- `net` — libp2p + QUIC + Gossipsub, peer discovery (layered, no DHT), sentry-node pattern, vertex-fetch protocol
- `dkg` — Pedersen DKG protocol (or import from `pyde-crypto` if it lands there first)
- `slashing` — validator state machine, the 10-offense catalog, slashing escrow, jail mechanics, reward distribution
- `node` — the binary, JSON-RPC server, validator role, `consensus_store` with `set_sync(true)`, persistence

Spec map:
- Chapter 6 — Mysticeti DAG consensus
- `SLASHING.md` — full 10-offense catalog
- `VALIDATOR_LIFECYCLE.md` — registration, bonding, unbonding, jail
- `STATE_SYNC.md` — snapshot mechanics, chain-of-trust
- `CHAIN_HALT.md` — halt detection, recovery paths
- `NETWORK_PROTOCOL.md` — libp2p config, topics, peer scoring
- Chapter 12 — networking
- Chapter 16 — security (cross-references throughout)

**MC-1 BAR:** Each of α / β / γ runs `cargo build && cargo test` clean on their branch. The β + γ branches build and link against the frozen `types` + `interfaces` crates. Mock-based integration tests pass within each stream.

### 3.3 MC-2 — Integration (sequential)

Merge β and γ branches to `main`. Bring up a local devnet (4-7 validators on a single machine) producing sub-second commits with end-to-end tx flow:

1. Author writes a contract (with α's otigen), builds locally, deploys via `otigen deploy`.
2. Tx submitted to RPC, validated by mempool (β), batched, gossipped (γ), included in vertex (γ).
3. Anchor commits, subdag walks (γ), wasmtime executes (β).
4. State updates (β), state_root signed (γ), `HardFinalityCert` formed (γ).
5. Receipt queryable via RPC; event subscription pushes notifications.

Coordinated by the main session. Both β and γ contributors review the merge PRs. Owner of the integration milestone: γ (since `node` crate lives there).

**MC-2 BAR:** Local devnet running end-to-end. All MC-1 deliverables integrated. Performance is *correct* (functional), not yet *measured* (that's MC-4).

### 3.4 MC-3 — State Sync + Parachain Activation (sequential)

Add the two protocol-level extensions that depend on MC-2 being functional:

- **State sync** — snapshot generation, weak-subjectivity checkpoints, fresh-validator flow. Spec: `STATE_SYNC.md`.
- **Parachain framework activation** — parachain registry, deployment + lifecycle, cross-parachain messaging, governance flow. Spec: `PARACHAIN_DESIGN.md`.

Owner: shared between β and γ as the changes touch both sides. Coordinated by the main session.

### 3.5 MC-4 — Performance + Failure Handling (parallel within)

- **Performance harness build-out** — multi-region workload generation, soak testing, and the publishing discipline (publish only what the harness measures under sustained, production-realistic conditions — never lab extrapolations or microbenchmark peaks). Spec: `PERFORMANCE_HARNESS.md`.
- **Chaos / failure injection** — failure-scenarios catalog walkthroughs (`FAILURE_SCENARIOS.md`).
- **Chain halt recovery drills** — `CHAIN_HALT.md` playbooks executed in test environments.

### 3.6 MC-5 — Validation + Mainnet Launch (sequential)

- Five external audits (consensus, execution layer, cryptography, networking, otigen toolchain).
- Incentivized testnet (multi-month soak with reference dApps + bug bounty at mainnet tier).
- 128-validator genesis ceremony.
- Mainnet launch.

Spec map: Chapter 19 (Launch Strategy).

**Mainnet ships when the validation work passes — not before, not on a calendar.**

---

## 4. Crate ownership map

The load-bearing table of this document. Every crate has exactly one owning stream. No co-ownership.

### `pyde-net/engine` (one repo, β and γ collaborate via branches)

| Crate | Owner | Branch | Depends on |
|---|---|---|---|
| `types` | **MC-0** (frozen) | `main` | (none — leaf crate) |
| `interfaces` | **MC-0** (frozen) | `main` | `types` |
| `account` | **β** | `execution-side` | `types`, `pyde-crypto` |
| `state` | **β** | `execution-side` | `types`, `interfaces` |
| `tx` | **β** | `execution-side` | `types`, `account`, `state`, `pyde-crypto` |
| `wasm-exec` | **β** | `execution-side` | `types`, `interfaces`, `state`, `account`, `tx` |
| `mempool` | **β** | `execution-side` | `types`, `interfaces`, `account`, `tx` |
| `consensus` | **γ** | `consensus-side` | `types`, `interfaces`, `pyde-crypto` |
| `net` | **γ** | `consensus-side` | `types`, `interfaces` |
| `dkg` | **γ** | `consensus-side` | `types`, `pyde-crypto` |
| `slashing` | **γ** | `consensus-side` | `types`, `interfaces` |
| `node` | **γ** | `consensus-side` | (all of the above) |

### `pyde-net/otigen` (separate repo, α owns entirely)

| Crate | Owner | Depends on |
|---|---|---|
| `otigen-cli` | **α** | all otigen-* crates below |
| `otigen-toml` | **α** | `serde`, `toml` |
| `otigen-abi` | **α** | `wasmparser`, `wasm-encoder`, `borsh` |
| `otigen-rpc` | **α** | `reqwest`, `tokio-tungstenite` |
| `otigen-wallet` | **α** | `pyde-crypto` |
| `otigen-test` | **α** | `wasmtime`, `otigen-toml`, `otigen-abi`, `pyde-crypto` |

### `pyde-net/pyde-crypto` (existing polyrepo)

Already in place. Both engine streams + α import from it. Out of scope for new implementation work in MC-1 — only additions (DKG, PSS) added as needed.

### Top-level files in `pyde-net/engine`

| File | Owner | Notes |
|---|---|---|
| `Cargo.toml` (workspace) | **MC-0** initially; stream adds its own dep entries | Avoid editing other streams' sections |
| `README.md` | **γ** | Stream γ owns the binary so it owns documentation |
| `.github/workflows/ci.yml` | **MC-0** initially; both streams may extend their respective test stages | |
| `LICENSE`, `SECURITY.md`, `.gitignore` | **MC-0** initially | Edits via coordinated PR |

---

## 5. Interface contracts (high-level)

The traits in `engine/crates/interfaces/src/lib.rs`. **Frozen at end of MC-0.** Changes after that require a coordinated PR from both β and γ + main session approval.

```rust
// engine/crates/interfaces/src/lib.rs (sketch — full impl in MC-0)

use pyde_engine_types::{
    Address, SlotHash, Value, Balance, Tx, TxHash, Receipt,
    StateRoot, EventRecord, WaveId, WaveCommitRecord, Vertex, VertexHash,
    HardFinalityCert,
};

/// Read-only state access. Implemented by `state::StateStore`.
/// Used by `mempool` for validation, `wasm-exec` for sload, RPC for queries.
pub trait StateView {
    fn get_slot(&self, slot: &SlotHash) -> Option<Value>;
    fn get_balance(&self, addr: &Address) -> Balance;
    fn get_nonce(&self, addr: &Address) -> u64;
    fn get_code_hash(&self, addr: &Address) -> Option<[u8; 32]>;
    fn state_root(&self) -> StateRoot;
}

/// Wave-level state mutation. Implemented by `state::StateStore`.
/// Used by `consensus` to apply a committed wave's writes.
pub trait StateMutator: StateView {
    fn begin_wave(&mut self, wave_id: WaveId);
    fn execute_tx(&mut self, tx: &Tx) -> Receipt;
    fn finalize_wave(&mut self) -> WaveCommitRecord;
}

/// Tx invocation. Implemented by `wasm-exec::WasmExecutor`.
/// Used by `consensus` to execute committed txs.
pub trait Executor {
    fn execute(&mut self, tx: &Tx, state: &mut dyn StateMutator) -> Receipt;
}

/// Mempool query. Implemented by `mempool::Mempool`.
/// Used by `consensus` to pull txs into batches.
pub trait MempoolView {
    fn drain_for_batch(&mut self, max_bytes: usize) -> Vec<Tx>;
    fn insert(&mut self, tx: Tx) -> Result<TxHash, MempoolError>;
    fn contains(&self, hash: &TxHash) -> bool;
}

/// Network gossip. Implemented by `net::Network`.
/// Used by `consensus` for vertex / batch / share dissemination.
#[async_trait]
pub trait NetworkView: Send + Sync {
    async fn publish_vertex(&self, vertex: Vertex);
    async fn publish_batch(&self, batch: Batch);
    fn subscribe_vertices(&self) -> Receiver<Vertex>;
    fn subscribe_batches(&self) -> Receiver<Batch>;
    fn fetch_vertex(&self, hash: VertexHash) -> Future<Option<Vertex>>;
}

/// The consensus loop. Implemented by `consensus::ConsensusEngine`.
/// Driven by `node` binary.
#[async_trait]
pub trait ConsensusEngine: Send {
    async fn run(
        &mut self,
        state: &mut dyn StateMutator,
        executor: &mut dyn Executor,
        mempool: &mut dyn MempoolView,
        network: &dyn NetworkView,
    );
}
```

Each trait ships with a **mock implementation** in `interfaces/src/mock.rs` so each stream can write isolated tests:

```rust
// interfaces/src/mock.rs
pub struct MockStateView { /* HashMap-backed */ }
pub struct MockMempool { /* VecDeque-backed */ }
pub struct MockNetwork { /* channel-backed */ }
// ... etc.
```

---

## 6. Branching + coordination protocol

### 6.1 Branching

```
main                ← integration branch; both streams merge here
├── execution-side  ← stream β's long-lived branch
└── consensus-side  ← stream γ's long-lived branch
```

- Each stream merges to `main` **weekly minimum** (more often is fine).
- Each merge is a PR with CI green; one reviewer (the other stream's session or zarah).
- After every weekly merge, each stream rebases its branch onto the latest `main`.

### 6.2 Tagged checkpoints

- `phase-0-foundation` — end of MC-0
- `phase-1-α-milestone-N` — α stream milestones
- `phase-1-β-milestone-N` — β stream milestones
- `phase-1-γ-milestone-N` — γ stream milestones
- `phase-2-integration-bar` — local devnet running end-to-end
- `phase-3-state-sync-live`, `phase-3-parachain-activation`
- `phase-4-perf-harness-baseline`, `phase-4-chaos-drills-passed`
- `phase-5-audit-N-passed`, `phase-5-mainnet-launch`

### 6.3 Coordination rules

- **No edits to `types` or `interfaces` crates after MC-0** without a coordinated PR signed off by both other streams.
- **Crate ownership is exclusive.** β does not touch γ's crates; γ does not touch β's. If a need arises, raise it as an issue first, agree on which side owns the change, then PR.
- **Shared dependencies update via coordinated PR.** Bumping wasmtime, libp2p, etc. is a top-level PR reviewed by both streams.
- **Conflicts on `main`** that bisect crate ownership get reverted; original committer rebases.

### 6.4 Communication

- **GitHub issues** on `pyde-net/engine` and `pyde-net/otigen` for design questions, blocking dependencies, interface clarifications.
- **Spec ambiguity?** Update the relevant spec in `pyde-net/pyde-book` via PR. Both streams reference the updated spec.
- **Cross-stream blocker?** Tag both streams' owning agents in an issue.

---

## 7. Session handoff prompts (paste-ready)

The three prompts below are designed to be self-contained — each prompt initializes a new Claude session with full context to start work on its assigned stream.

### 7.1 Stream α — Toolchain session prompt

````
# Pyde Session α — Otigen Toolchain Implementation

You're joining the Pyde Layer 1 blockchain project. Three parallel
implementation streams are running concurrently; you own Stream α
(the developer toolchain).

## What Pyde is

Post-quantum L1 (FALCON-512 sigs, Kyber-768 threshold encryption,
Poseidon2+Blake3 hashing). Mysticeti DAG consensus with 128/85 quorum
and sub-second commits. WASM execution via wasmtime. MEV-resistant
by structure. Pre-mainnet, solo-founder-led (zarah). Workspace at
/Users/victorsamuel/Documents/zarah/systems/rust/pyde-net/.

## Your stream

Implement the `otigen` developer toolchain binary in a fresh repo
`pyde-net/otigen`. The toolchain:
- Reads `otigen.toml` configs
- Validates compiled `.wasm` artifacts against the Host Function ABI
- Injects a `pyde.abi` custom section into the WASM
- Signs and submits deploy / upgrade / lifecycle transactions
- Manages FALCON-512 keystores
- Offers an interactive REPL

## Authoritative specs

In priority order:
1. `pyde-book/src/companion/OTIGEN_BINARY_SPEC.md` — your canonical
   spec (>820 lines). Every command, every config key,
   every validation rule.
2. `pyde-book/src/companion/HOST_FN_ABI_SPEC.md` — the chain-facing
   ABI you validate WASM modules against.
3. `pyde-book/src/companion/OTIGEN_TEST_SPEC.md` — canonical spec for
   `otigen test`: TOML schema, name resolution (account → Blake3 addr,
   field → Poseidon2 slot), cheatcode catalogue, mock host-fn
   behaviour, limitations. Implements as the `otigen-test` crate.
4. `pyde-book/src/companion/IMPLEMENTATION_PLAN.md` — coordination
   doc; defines your scope + how to coordinate with streams β and γ.
5. `pyde-book/src/companion/PARACHAIN_DESIGN.md` — parachain-specific
   extension surface (parachain deploy + cross-parachain messaging).
6. `pyde-book/src/chapters/05-otigen-toolchain.md` — narrative
   overview (lighter; specs above are canonical).
7. `pyde-book/src/chapters/11-account-model.md` — transaction wire
   format, address derivation.

## Constraints

- **No AI attribution anywhere** (commits, code, PRs). Work reads
  as zarah's own.
- **No per-language SDK shipping with otigen** — by design (see
  PARACHAIN_DESIGN.md §10). Canonical example contracts only.
- **otigen does NOT invoke language compilers.** Author runs
  `cargo build` / `npx asc` / etc. themselves; otigen post-processes
  the resulting `.wasm`.
- **Apache-2.0 license**, clippy clean, fmt applied, no `unwrap()`
  on untrusted paths.
- **The `pyde.abi` custom section is the canonical ABI** — chain
  stores only the `.wasm`; the section travels with the code.

## Setup

1. Check `/pyde-net/otigen/` exists locally and on
   `github.com/pyde-net/otigen`. Create both if not.
2. Initialize a Rust workspace.
3. Sub-crates: `otigen-cli`, `otigen-toml`, `otigen-abi`,
   `otigen-rpc`, `otigen-wallet`. (Names suggested; adjust if you
   have a better structure.)
4. Depend on `pyde-crypto` (sibling polyrepo) for FALCON-512,
   Argon2id, AES-256-GCM, Borsh.

## First milestone

`otigen.toml` parsing + the `otigen build` validation pipeline
(spec §4 + §3.2). This is the foundation everything else builds on:
1. Parse `otigen.toml` with full schema validation (use `serde` + `toml`).
2. Locate the compiled `.wasm` at the declared path.
3. Walk the WASM via `wasmparser` and run every check in spec §3.2.
4. Build the `ContractAbi` struct from parsed config + WASM exports.
5. Borsh-encode + inject `pyde.abi` custom section via `wasm-encoder`.
6. Write the deploy bundle to `./artifacts/<name>.bundle/`.
7. Test against a canonical example Rust hello-world contract.

## Coordination

- You're independent of streams β and γ; only common dependency is
  the locked HOST_FN_ABI_SPEC.
- Open issues on `pyde-net/otigen` for spec ambiguity; ping zarah.
- When you reach `otigen deploy`, you'll need a devnet to test
  against. By then streams β + γ should have one running.

## First action

Read OTIGEN_BINARY_SPEC.md end-to-end. Read chapter 5 for context.
Verify the workspace setup. Begin first-milestone work.
````

### 7.2 Stream β — Engine Execution session prompt

````
# Pyde Session β — Engine Execution Layer

You're joining the Pyde Layer 1 blockchain project. Three parallel
implementation streams are running concurrently; you own Stream β
(the execution layer of the engine).

## What Pyde is

Post-quantum L1 (FALCON-512 sigs, Kyber-768 threshold encryption,
Poseidon2+Blake3 hashing). Mysticeti DAG consensus with 128/85 quorum
and sub-second commits. WASM execution via wasmtime. MEV-resistant
by structure. Pre-mainnet, solo-founder-led (zarah). Workspace at
/Users/victorsamuel/Documents/zarah/systems/rust/pyde-net/.

## Your stream

Implement the execution side of `pyde-net/engine`. Crates you own:
- `account` — 32-byte addresses, AuthKeys enum, 16-slot nonce window
- `state` — JMT dual-hash, state_cf + jmt_cf + events_cf×3,
  PIPs 2/3/4 (clustered keys, prefetch, write-back cache),
  snapshot generation
- `tx` — transaction types, canonical hashing, gas accounting,
  deploy/upgrade/lifecycle handlers
- `wasm-exec` — wasmtime config, every host function from
  HOST_FN_ABI_SPEC §7-§8, module cache, fuel-to-gas mapping,
  per-tx overlay execution model
- `mempool` — FALCON verify, validation rules, gossip admission

You work on branch `execution-side` of `pyde-net/engine`.

Stream γ (consensus side) works on branch `consensus-side` in the
same repo. **Do not touch γ's crates** (`consensus`, `net`, `dkg`,
`slashing`, `node`). Communicate cross-stream needs via GitHub
issues; do not edit interfaces or shared types unilaterally.

## Authoritative specs

In priority order:
1. `pyde-book/src/companion/HOST_FN_ABI_SPEC.md` — every host
   function you implement. 2,154 lines, 18 sections. The chain side
   of the WASM ⇄ chain boundary.
2. `pyde-book/src/companion/IMPLEMENTATION_PLAN.md` — coordination
   doc (this stream's scope, crate ownership, branching protocol,
   interface contracts).
3. `pyde-book/src/chapters/04-state-model.md` — JMT, two-table
   architecture, events_cf, PIP-2/3/4.
4. `pyde-book/src/chapters/03-virtual-machine.md` — execution
   layer architecture, per-tx overlay, native vs WASM tx types.
5. `pyde-book/src/chapters/11-account-model.md` — account types,
   address derivation, tx wire format, nonce window.
6. `pyde-book/src/chapters/10-gas-and-fee-model.md` — gas
   accounting, no-refund policy, EIP-1559 base fee.
7. `pyde-net/pips/pip-0002` (clustered keys), `pip-0003` (prefetch),
   `pip-0004` (write-back cache).

## Constraints

- **No AI attribution anywhere** (commits, code, PRs).
- **Apache-2.0 license**, clippy clean, fmt applied, no `unwrap()`
  on untrusted-input paths.
- Use the frozen `types` and `interfaces` crates (in MC-0) — do
  NOT change them without a coordinated PR.
- `mempool` is yours; consensus reads from it via the
  `MempoolView` trait. Do not let γ touch your crates.
- `wasm-exec` implements the host functions; the engine
  registers them with wasmtime's `Linker`. Authoritative gas
  costs in spec §10. Authoritative validation rules in spec §3.7.

## Setup

1. `pyde-net/engine` repo exists post-MC-0; clone it locally.
2. Check out the `execution-side` branch.
3. Verify the workspace skeleton with stub crates compiles.

## First milestone

Implement the `account` + `state` crates with full functionality
(no WASM execution yet — that comes next). Key deliverables:
- Address derivation: `Poseidon2(falcon_pubkey)` → 32-byte address.
- `AuthKeys` enum with `Single`, `MultiSig`, `Programmable`
  variants (Programmable v2-reserved per ch 11 §11.5).
- 16-slot nonce window per account.
- JMT dual-hash (Blake3 + Poseidon2) state tree.
- Two-table architecture (`state_cf` + `jmt_cf`).
- Atomic WriteBatch commits.
- Implement the `StateView` and `StateMutator` traits from the
  `interfaces` crate.
- Test against the mock implementations in interfaces/.

Once `account` + `state` are solid, move to `tx`, then `wasm-exec`,
then `mempool`.

## Coordination

- Open issues on `pyde-net/engine` for design questions.
- Merge to `main` weekly minimum after CI green + reviewer LGTM.
- Tag milestones: `phase-1-β-milestone-N` (1 = state, 2 = wasm-exec
  basics, 3 = full host fn catalog, etc.).
- Cross-stream blockers: tag both stream agents in the issue.

## First action

Read HOST_FN_ABI_SPEC.md end-to-end. Read IMPLEMENTATION_PLAN.md.
Read chapters 03, 04, 11, 10. Verify branch + workspace state.
Begin with `state` crate (foundational; everything else builds on it).
````

### 7.3 Stream γ — Engine Consensus + Network session prompt

````
# Pyde Session γ — Engine Consensus + Network Layer

You're joining the Pyde Layer 1 blockchain project. Three parallel
implementation streams are running concurrently; you own Stream γ
(the consensus + network + node binary side of the engine).

## What Pyde is

Post-quantum L1 (FALCON-512 sigs, Kyber-768 threshold encryption,
Poseidon2+Blake3 hashing). Mysticeti DAG consensus with 128/85 quorum
and sub-second commits. WASM execution via wasmtime. MEV-resistant
by structure. Pre-mainnet, solo-founder-led (zarah). Workspace at
/Users/victorsamuel/Documents/zarah/systems/rust/pyde-net/.

## Your stream

Implement the consensus + networking side of `pyde-net/engine`.
Crates you own:
- `consensus` — Mysticeti DAG, vertex/anchor/wave logic, BFS subdag
  walk, slashing evidence collection, equivocation detection,
  missing-vertex fetch, threshold-decryption coordination
- `net` — libp2p + QUIC + Gossipsub, peer discovery (layered, no
  DHT), sentry-node pattern, vertex-fetch protocol
- `dkg` — Pedersen DKG protocol (or thin wrapper if it lands in
  pyde-crypto first)
- `slashing` — validator state machine, 10-offense catalog,
  slashing escrow, jail mechanics, reward distribution
- `node` — the binary, JSON-RPC server, validator role,
  `consensus_store` with `set_sync(true)`, persistence,
  `panic = "abort"` on persist failure

You work on branch `consensus-side` of `pyde-net/engine`.

Stream β (execution side) works on branch `execution-side` in the
same repo. **Do not touch β's crates** (`account`, `state`, `tx`,
`wasm-exec`, `mempool`). Read from them via the locked
`interfaces` traits. Communicate cross-stream needs via GitHub
issues; do not edit interfaces or shared types unilaterally.

You own the `node` crate — it wires everything together at
integration time (MC-2).

## Authoritative specs

In priority order:
1. `pyde-book/src/companion/IMPLEMENTATION_PLAN.md` — coordination
   doc (your scope, crate ownership, branching protocol, interface
   contracts).
2. `pyde-book/src/chapters/06-consensus.md` — Mysticeti DAG,
   anchor selection, wave commit, BFS subdag walk, threshold
   decryption ceremony, HardFinalityCert.
3. `pyde-book/src/companion/SLASHING.md` — full 10-offense catalog.
4. `pyde-book/src/companion/VALIDATOR_LIFECYCLE.md` —
   registration, bonding, unbonding, jail mechanics, key rotation.
5. `pyde-book/src/companion/STATE_SYNC.md` — snapshot mechanics,
   chain-of-trust, weak-subjectivity checkpoints.
6. `pyde-book/src/companion/CHAIN_HALT.md` — halt detection, 5
   recovery paths, bounded rollback.
7. `pyde-book/src/companion/NETWORK_PROTOCOL.md` — libp2p config,
   Gossipsub topics, peer scoring, sentry pattern.
8. `pyde-book/src/chapters/12-networking.md` — networking detail.
9. `pyde-book/src/chapters/08-cryptography.md` — DKG, threshold
   decryption, VRF (your consumer; pyde-crypto is the impl).
10. `pyde-book/src/companion/THREAT_MODEL.md` — security context.

## Constraints

- **No AI attribution anywhere** (commits, code, PRs).
- **Apache-2.0 license**, clippy clean, fmt applied, no `unwrap()`
  on untrusted-input paths.
- Use the frozen `types` and `interfaces` crates from MC-0 — do
  NOT change them without a coordinated PR.
- `consensus` reads txs from `mempool` via `MempoolView` (β owns
  mempool). It invokes execution via `Executor` trait (β owns
  wasm-exec). Don't reach into β's crates directly.
- All consensus-store writes use `WriteOptions::set_sync(true)`
  per Chapter 16 §16.12. Persist failure = `panic = "abort"`.

## Setup

1. `pyde-net/engine` repo exists post-MC-0; clone it locally.
2. Check out the `consensus-side` branch.
3. Verify the workspace skeleton with stub crates compiles.

## First milestone

Implement the `consensus` crate with the Mysticeti DAG core:
- Vertex structure (round, member_id, parent_refs, batch_refs,
  state_root_sigs, decryption_shares, prev_anchor_attestation, sig).
- Local DAG view (in-memory graph with vertex insertion + lookup).
- Round advancement (peer-attestation triggered, data-driven —
  NOT clock-driven).
- Anchor selection: `Hash(beacon, round, prev_state_root) mod 128`.
- BFS subdag walk + canonical sort (round asc, member_id asc,
  batch_list_order).
- Missing-vertex fetch protocol (async pull from peers).
- Anchor-skip handling (when anchor vertex absent).
- Test in isolation using `MockStateView`, `MockMempool`,
  `MockNetwork` from the `interfaces` crate.

Then move to `net` (libp2p + Gossipsub topics), then `slashing`,
then wire it all up in `node`.

## Coordination

- Open issues on `pyde-net/engine` for design questions.
- Merge to `main` weekly minimum after CI green + reviewer LGTM.
- Tag milestones: `phase-1-γ-milestone-N` (1 = consensus core,
  2 = network, 3 = slashing + lifecycle, 4 = node binary).
- Cross-stream blockers: tag both stream agents in the issue.
- You own integration: when MC-2 begins, you drive the merge +
  devnet bring-up.

## First action

Read IMPLEMENTATION_PLAN.md. Read chapter 6 end-to-end (the spec
is dense and the BFS / anchor / threshold-decryption mechanics
are subtle). Read SLASHING.md + VALIDATOR_LIFECYCLE.md +
CHAIN_HALT.md. Verify branch + workspace state. Begin with
`consensus` crate (foundational for everything else in γ).
````

---

## 8. Risks + mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **Interface drift during MC-1** — β or γ realizes a needed change to `interfaces` mid-implementation | High | Both sides write tests against the locked traits early. If a change is genuinely required, both sides + main session co-sign the PR. |
| **`types` crate creep** — new fields added ad-hoc as implementation reveals needs | High | All type additions are PRs against `types` crate, reviewed by both other streams. Pre-MC-1 we lock the "v1 type set" via thorough walk-through. |
| **One stream lags substantially** | Medium | Weekly merges to `main` make lag visible early. If γ lags, β still ships; integration happens when both are ready. No artificial gating. |
| **Spec ambiguity blocks implementation** | Medium | Open a PR against the relevant spec in `pyde-net/pyde-book`; both streams read updated spec from there. Treat spec as the contract. |
| **Cross-stream blocker not surfaced** | Medium | GitHub issue tags both stream agents; weekly merge reviews catch silent blockers. |
| **Integration (MC-2) bigger than expected** | Medium | γ owns the `node` crate from day one — eliminates a "who integrates" question. β provides clean trait implementations + tests that γ wires in. |
| **Stream α blocked waiting on devnet** | Low | α first milestone (`otigen build`) needs no chain; second milestone (`otigen deploy`) is when chain matters. By then β+γ should have devnet running. If not, α can mock-deploy against a stub RPC. |

---

## 9. Glossary of agreements

Quick reference for things the implementation must hold to:

- **`types` crate is FROZEN** at end of MC-0. No additions without coordinated PR.
- **`interfaces` crate is FROZEN** at end of MC-0. Same rule.
- **No co-ownership of crates.** Each crate has one owning stream. Period.
- **Weekly merges minimum.** No long-lived branches diverging silently.
- **No AI attribution.** Anywhere. Per `no_ai_attribution` memory.
- **Apache-2.0 + clippy-clean + no untrusted `unwrap()`**. CI enforces.
- **Specs are authoritative.** When code and spec disagree, the spec is right; either fix the code or update the spec via PR.
- **Multi-topic events native at v1.** Not a v2 deferral (per recent locked decision).
- **View calls are free** (RPC pyde_call AND on-chain cross_call_static). Bounded by `VIEW_FUEL_CAP`.
- **Gas refunds: zero in v1.** No exceptions.

---

## 10. References

- [HOST_FN_ABI_SPEC.md](./HOST_FN_ABI_SPEC.md) — chain-facing ABI
- [OTIGEN_BINARY_SPEC.md](./OTIGEN_BINARY_SPEC.md) — toolchain spec
- [OTIGEN_TEST_SPEC.md](./OTIGEN_TEST_SPEC.md) — contract behaviour test framework
- [PARACHAIN_DESIGN.md](./PARACHAIN_DESIGN.md) — parachain framework
- [STATE_SYNC.md](./STATE_SYNC.md), [CHAIN_HALT.md](./CHAIN_HALT.md), [SLASHING.md](./SLASHING.md), [VALIDATOR_LIFECYCLE.md](./VALIDATOR_LIFECYCLE.md), [NETWORK_PROTOCOL.md](./NETWORK_PROTOCOL.md), [THREAT_MODEL.md](./THREAT_MODEL.md), [FAILURE_SCENARIOS.md](./FAILURE_SCENARIOS.md), [PERFORMANCE_HARNESS.md](./PERFORMANCE_HARNESS.md) — operational specs
- [roadmap.md](../roadmap.md) — phase-by-phase checklist tracking
- The 20 book chapters + 4 PIPs — full design

---

**Document version:** 0.1 (draft for v1 mainnet)

**License:** Apache-2.0 + CC BY-SA 4.0 (per repository root)
