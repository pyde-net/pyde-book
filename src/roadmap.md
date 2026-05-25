# Roadmap

Pyde's path from design-complete to mainnet, structured as **five phases (MC-0 through MC-5)** with **three parallel implementation streams** in the core phase (MC-1). Each phase ships when its bar is met — no calendar dates.

Coordination details (crate ownership, branching protocol, interface contracts, session handoff prompts for the three streams) live in [`companion/IMPLEMENTATION_PLAN.md`](companion/IMPLEMENTATION_PLAN.md). Read that first if you're implementing.

**Legend:**
- `[SEQ]` — sequential (must complete before the next phase starts)
- `[PAR]` — parallel (can run concurrently with siblings)
- `→` — explicit dependency
- `α` / `β` / `γ` — owning implementation stream (see `IMPLEMENTATION_PLAN.md` §4)

---

## Top-level shape

```
MC-0  INTERFACE FOUNDATION              [SEQ — main session]
  │   Create engine repo, lock types + interfaces crates, CI baseline.
  │   This is the prerequisite that makes parallelism safe.
  ▼
MC-1  PROTOCOL CORE                     [PAR — three streams]
  │   Stream α (Toolchain)   in pyde-net/otigen
  │   Stream β (Execution)   in pyde-net/engine on `execution-side` branch
  │   Stream γ (Consensus)   in pyde-net/engine on `consensus-side` branch
  ▼
MC-2  INTEGRATION                       [SEQ — γ owns]
  │   Merge β + γ branches; bring up local devnet end-to-end.
  ▼
MC-3  STATE SYNC + PARACHAIN ACTIVATION [SEQ — β + γ joint]
  │   Snapshot machinery, weak-subjectivity, parachain framework live.
  ▼
MC-4  PERFORMANCE + FAILURE HANDLING    [PAR within]
  │   Performance harness, chaos drills, soak.
  ▼
MC-5  VALIDATION + MAINNET LAUNCH       [SEQ]
      External audits, incentivized testnet, mainnet.
```

Old MC-1 through MC-7 numbering (pre-2026-05-23) collapses into this shape: old MC-1 + MC-2 → MC-0 + MC-1; old MC-3 → folded into Stream α; old MC-4 → folded into MC-3; old MC-5 → MC-3; old MC-6 → MC-4; old MC-7 → MC-5.

---

## MC-0 — INTERFACE FOUNDATION `[SEQ]` — main session ✅ shipped

The sequential prerequisite to parallelism. Without MC-0 complete, streams β and γ clash on shared types and interface drift. ~1 day of focused work; the main session owns it.

Tagged `phase-0-foundation` on `main` at `pyde-net/engine`. 92 unit/integration tests pass; `cargo clippy --workspace --all-targets -- -D warnings` clean; `cargo fmt --all -- --check` clean.

### 0.1 Engine repo creation

- [x] Create `pyde-net/engine` repo on GitHub (fresh; post-pivot)
- [x] Clone locally at `/pyde-net/engine/`
- [x] Initial commit: README + LICENSE (Apache-2.0) + `.gitignore` + `SECURITY.md` + `rust-toolchain.toml`

### 0.2 Workspace skeleton

- [x] `Cargo.toml` workspace with every crate stubbed:
  - `types`, `interfaces`
  - `account`, `state`, `tx`, `wasm-exec`, `mempool` (β-owned)
  - `consensus`, `net`, `dkg`, `slashing`, `node` (γ-owned)
- [x] Each crate stub: `Cargo.toml` + `src/lib.rs` with a placeholder function so the workspace compiles (node also has `src/main.rs` for the `pyde` binary)

### 0.3 `types` crate (frozen at end of MC-0)

- [x] `Address` ([u8; 32]) — full Poseidon2, no truncation
- [x] `SlotHash`, `Value` (state primitives)
- [x] `Balance` (u128), `Nonce` (u64), `NonceWindow` (16-slot bitmap)
- [x] `Tx` flat envelope + `TxType` discriminant (Ch 11 §11.6 wire format; tag 2 reserved-as-vacant)
- [x] `TxHash`, `Receipt`, `ReceiptStatus`, `FeePayer`, `AccessEntry`, `AccessType`
- [x] `StateRoot` (dual: Blake3 + Poseidon2)
- [x] `EventRecord` (with `wave_id` / `tx_index` / `event_index` primary key + `Vec<Topic>` for multi-topic v1) + `EventCursor` for `pyde_getLogs` pagination
- [x] `WaveId` (u64), `Round` (u64), `CommitId` (= WaveId)
- [x] `VertexHash`, `BatchHash`, `BatchRef`, `Vertex` (with `member_id` + `batch_refs` + `decryption_shares` per Ch 6 §3) + `Batch` (network gossip type)
- [x] `WaveCommitRecord` (with `anchor_round` / `prior_anchor_round` / `events_root` / `events_bloom` / `events_count` / `tx_count` / `gas_used: u128`)
- [x] `HardFinalityCert` with 85-of-128 quorum check
- [x] `FalconPubkey` (897 B fixed), `FalconSignature` (variable, ≤690 B cap)
- [x] `EventsBloom` — spec-aligned algorithm: 256 B / 3 hashes / `blake3(item)[..8/8..16/16..24]` mod 2048 (consumer-side blake3 — leaf-dep invariant preserved)
- [x] `ContractAbi` per HOST_FN_ABI_SPEC §3.7: `pyde_abi_version: u32`, `contract_type`, `state_schema_hash`, `constructor_index` / `fallback_index` / `receive_index` + `EventAbi` extension for §14.1 event signatures
- [x] `FunctionAttrs` (u32 bitfield: VIEW / PAYABLE / REENTRANT / SPONSORED / CONSTRUCTOR / FALLBACK / RECEIVE / ENTRY)
- [x] Error codes from `HOST_FN_ABI_SPEC §4` — `ERR_*` consts + typed `ErrorCode` enum (i32 wire format; round-trips via `as_i32` / `from_i32`)
- [x] `AuthKeys` (None / Single / MultiSig / Programmable-reserved at tag `0x03`) with `MAX_MULTISIG_SIGNERS = 16` and structural validation
- [x] 81 unit + property tests including wire-tag verification and field-order pin tests

### 0.4 `interfaces` crate (frozen at end of MC-0)

- [x] `trait StateView` — async; balance / nonce_window / slot / code_hash / code / account_type / auth_keys / state_root
- [x] `trait StateMutator: StateView` — async; `commit_wave(wave_id, txs)` → `WaveCommitRecord`, `rollback_wave`, `snapshot` → `SnapshotHandle`
- [x] `trait Executor` — async; `execute_tx(state, tx, gas_limit)` + `view_call(state, target, data)`
- [x] `trait MempoolView` — async; insert / drain_for_batch / contains / fetch_by_hash / pending_count
- [x] `trait NetworkView` — async; publish_vertex / publish_batch / fetch_vertex / fetch_batch (libp2p gossip surface)
- [x] `trait ConsensusEngine` — async; current_round / current_wave / get_finality_cert (read-only observation surface)
- [x] `InterfaceError` — boundary error enum with retryability classification
- [x] `mod mock` — `MockState` / `MockExecutor` / `MockMempool` / `MockNetwork` / `MockConsensus`, 11 tests each exercising at least one trait method per impl

### 0.5 CI + branching

- [x] `.github/workflows/ci.yml` running fmt + clippy (-D warnings) + test + doc on every PR with target/registry caching
- [x] Long-lived branches created: `execution-side` (β), `consensus-side` (γ)
- [x] Tag `phase-0-foundation` on `main`

### 0.6 IMPLEMENTATION_PLAN cross-link

- [x] `pyde-book/src/companion/IMPLEMENTATION_PLAN.md` already current
- [x] Cross-linked from this roadmap

**MC-0 BAR:** ✅ engine repo exists with all 12 crate stubs compiling; `types` + `interfaces` crates fully written and tested (92 tests, all green); CI green; branching protocol established; `IMPLEMENTATION_PLAN.md` committed.

---

## MC-1 — PROTOCOL CORE `[PAR — three streams] → MC-0`

The core protocol implementation. Three streams run in parallel: α (toolchain), β (execution), γ (consensus). Each owns disjoint crates per the ownership map in [`IMPLEMENTATION_PLAN.md §4`](companion/IMPLEMENTATION_PLAN.md). The session-handoff prompts for each stream are in [`IMPLEMENTATION_PLAN.md §7`](companion/IMPLEMENTATION_PLAN.md).

### MC-1 Stream α — Toolchain `[SEQ within α] → MC-0` — repo `pyde-net/otigen`

Implements [`OTIGEN_BINARY_SPEC.md`](companion/OTIGEN_BINARY_SPEC.md).

#### α.feat — Feature surface (spec §3 + §9 + supporting crates)

- [x] `pyde-net/otigen` repo + Rust workspace
- [x] `otigen-toml`: config parser + schema validation (spec §4)
- [x] `otigen-abi`: `ContractAbi` construction + Borsh encoding + custom-section injection via `wasm-encoder` (spec §6)
- [x] `otigen-cli`: subcommand framework via `clap` (spec §3)
- [x] `otigen build`: full validation pipeline (spec §3.2 step-by-step)
- [x] `otigen-wallet`: keystore (Argon2id + AES-256-GCM, single-file multi-account per spec §7.1), FALCON-512 signing, secret-key zeroisation on drop — ported from archived `wright` repo
- [x] `otigen wallet new` / `import` / `list` / `show` / `delete` / `password` — single-file `~/.pyde/keystore.json` (override via `--keystore`), confirmation prompt before destructive ops, NDJSON event stream under `--json`
- [x] `otigen-rpc`: JSON-RPC client per Ch 17.4 — sync `reqwest::blocking` `Client` + 15 typed method wrappers (account / call / send / receipt / gas / wave / logs / snapshot), typed error envelope, wiremock-driven e2e tests. WebSocket subscriptions deferred to v2.
- [x] `otigen deploy` — full §3.3 pipeline (bundle → re-validate → resolve network + wallet → fetch nonce → build canonical tx → FALCON-sign → `pyde_sendRawTransaction` → poll receipt). `--dry-run` for offline inspection, `--no-wait` for fire-and-forget scripts. Wire format (`Tx` envelope + `TxType` / `FeePayer` / `AccessType` discriminant tags + canonical Poseidon2 hash) pinned to Ch 11 §11.6 / §11.8 / §"Transaction hash" on the toolchain side until Stream β's `tx` crate lifts beyond its current scaffold.
- [x] `otigen upgrade` / `pause` / `unpause` / `kill` — shared lifecycle pipeline via `TxType::Standard` with `data = borsh(LifecyclePayload)`. Name-or-address targeting (auto-resolves via `pyde_resolveName`). `kill --yes` skips the retype-the-target confirmation. `LifecyclePayload` discriminants (0x00..=0x03) pinned to spec §8.3 until Stream β's `tx` crate formalises.
- [x] `otigen inspect` — read-only metadata + state via the rpc client (`pyde_getAccount` + `pyde_getContractCode`). `--field <name>` queries `Poseidon2(name)`-derived storage slots; `--at-wave <id>` forwarded for archive nodes (v1 RPC catalog surfaces current state with a notice).
- [x] `otigen verify` — reproducible-build check (spec §3.9). Compares local bundle's `contract.wasm` against chain-stored bytes via `pyde_getContractCode`, surfaces blake3 hashes + size delta + first-diff offset on mismatch. Fail-fast: local checks before RPC.
- [x] Canonical example contracts: Rust ✅, AssemblyScript ✅, Go (TinyGo) ✅, C/C++ ✅ — all four `otigen init --lang X` templates render valid hello-world projects with a `ping` entry point + commented host-fn import example. Rust end-to-end (init → build → bundle) exercised by `tests/hello_rust_e2e.rs`; AS/Go/C source→wasm compilation deferred to per-language external toolchains (`asc` / `tinygo` / `clang --target=wasm32`). Init's "next:" message picks the right build command per language.
- [ ] `otigen test` — Foundry-grade contract behaviour test framework. Spec: [`OTIGEN_TEST_SPEC.md`](companion/OTIGEN_TEST_SPEC.md). Ships in three sequential PRs:
  - [x] **Phase 1 — parser + name resolution + spec validation.** `crates/otigen-test` crate; TOML schema types for `[accounts]` / `[cheats]` / `[[tests]]`; account-name → Blake3 address + state-field → Poseidon2 slot derivation; `otigen test --dry-run` lists tests + resolved hashes without executing; e2e tests against a hand-written `.test.toml` fixture. — PR [otigen#30](https://github.com/pyde-net/otigen/pull/30) — 28 unit + 1 doctest + 9 e2e tests; workspace total 261 → 299 passing.
  - [x] **Phase 2 — wasmtime runner + read/write/event/revert mocks.** Mock host fns: `sload` / `sstore` / `sdelete` / `caller` / `value` / `emit_event` / `revert` / `now` / `current_wave` / `chain_id`; single-call execution + per-call `expect`; return-value + storage-after + events + revert assertions; sample `tests/contract.test.toml` in `examples/hello-rust`. — PR [otigen#31](https://github.com/pyde-net/otigen/pull/31) — 17 new tests (7 runner unit + 9 e2e + 1 doctest); workspace total 299 → 316 passing. wasmtime 36 (security-patched).
  - [x] **Phase 3 — full Foundry surface.** Multi-call `[[tests.calls]]` chains, native-balance mocks (`balance_of` / `transfer_native`), final-state `[tests.expect]` assertions, per-test cheat overrides, named event matching against `[events.*]`, `--filter` flag + per-test timing, plus --json NDJSON test events (test_suite_start / test_start / test_pass / test_fail / test_suite_done) and --bundle override. — PR [otigen#32](https://github.com/pyde-net/otigen/pull/32) — 9 new e2e tests; workspace 316 → 325+ passing; `make all` byte-equivalent to GitHub CI now serves as local pre-push gate while Actions billing is blocked.
- [ ] `otigen console` REPL (spec §3.8)

#### α.qual — Quality bar (production-readiness gate)

Every item below clears before α ships. Documented separately from the feature surface so the gate is unambiguous.

**Testing infrastructure**

- [x] Criterion benchmarks for every hot path with baselines committed to `benches/baseline/*.json`:
  - `otigen-toml`: TOML parse + cross-cutting validation ✅ (pyde-net/otigen#6)
  - `otigen-abi`: `ContractAbi` build, Borsh encode/decode round-trip, `pyde.abi` custom-section inject + extract, validators, full pipeline ✅ (pyde-net/otigen#6)
  - `otigen-cli`: full `otigen build` pipeline end-to-end — measured via the otigen-abi full_pipeline bench (parse→validate→build→encode→inject = 14.5 µs on the reference machine); the wall-clock `otigen build` invocation is dominated by file I/O, not validator work
- [x] `cargo-fuzz` targets shipped across the workspace (24h+ cumulative run still required before α release):
  - `otigen-toml` parser: `fuzz_toml_parser` (malformed input, deep nesting, huge fields) — PR [otigen#39](https://github.com/pyde-net/otigen/pull/39)
  - `otigen-abi` WASM validator: `fuzz_wasm_validator` (malformed binaries, edge cases in section structure) — PR [otigen#39](https://github.com/pyde-net/otigen/pull/39)
  - `otigen-abi` custom-section injection: `fuzz_section_injection` (extreme WASM module shapes) — PR [otigen#39](https://github.com/pyde-net/otigen/pull/39)
  - `otigen-test` parser + storage paths: `fuzz_test_toml` + `fuzz_storage_path` — PR [otigen#39](https://github.com/pyde-net/otigen/pull/39)
- [x] Property-test coverage audit: 21 proptest groups across `otigen-toml` and `otigen-abi` (was ~10, 11 new groups added) — PR [otigen#37](https://github.com/pyde-net/otigen/pull/37)
- [x] Adversarial corpus: 34 hand-rolled `otigen.toml` files under `crates/otigen-toml/tests/corpus/{pass,fail}/` each verified by the corpus harness to pass / fail with the expected diagnostic (20 new fixtures landed in PR [otigen#38](https://github.com/pyde-net/otigen/pull/38))
- [ ] Reproducibility test: two clean builds of the canonical hello-rust example produce byte-identical `contract.wasm` and `abi.json` (modulo `manifest.build_timestamp`)

**CI + supply chain**

- [ ] Multi-platform CI matrix: `ubuntu-latest` x86_64 + aarch64, `macos-latest` arm64, `windows-latest` x86_64 — build / test / clippy / fmt on every PR
- [ ] `cargo-audit` (RustSec advisories) gate on every PR
- [ ] `cargo-deny` (license policy + version policy + duplicate-version checks) gate on every PR
- [ ] `cargo-machete` (unused dep detection) on every PR
- [ ] MSRV check: workspace `rust-version = "1.87"` enforced in CI on a 1.87 toolchain *(bumped from 1.75 → 1.87 in 2026-05 when `wasmtime 28 → 36` cleared 7 RUSTSEC advisories and `pyde-crypto`'s Plonky3 transitive started using `unsigned_is_multiple_of` — stabilized in 1.87)*
- [ ] cargo-about generated 3rd-party attribution report shipped with every binary release
- [x] Signed binary releases via GitHub Actions: Linux x86_64/aarch64 + macOS arm64 + Windows x86_64 tarballs, sha256sums, sigstore-keyless OIDC signatures, attached to GitHub Releases — `.github/workflows/release.yml` shipped via PR [otigen#42](https://github.com/pyde-net/otigen/pull/42). Workflow triggers on `v*` tag push. v0.1.0-testnet.0 smoke tag exists; first successful run blocked on GitHub Actions billing upgrade (per-org plan needed)

**UX completeness**

- [x] `--json` NDJSON output wired across every subcommand per OTIGEN_BINARY_SPEC §10.2 — `InspectStart`, `VerifyStart`, `DeployFailed`, `LifecycleFailed` plus the existing build / wallet / test event streams, all emitted to stdout as one event per line — PR [otigen#34](https://github.com/pyde-net/otigen/pull/34)
- [x] `--verbose` / `-vv` actually emits the documented log levels — tiny `log::info` / `log::debug` wrapper on `eprintln!`; `-v` enables info, `-vv` enables info + debug; threaded through `Cli` → `Args` → commands — PR [otigen#35](https://github.com/pyde-net/otigen/pull/35)
- [ ] Signal handling: `Ctrl-C` mid-build cleans up partial bundle artifacts
- [x] `otigen --version` includes git-sha + build profile — `build.rs` captures git sha + dirty marker + cargo `PROFILE` at compile time; re-runs on `.git/HEAD` change — PR [otigen#33](https://github.com/pyde-net/otigen/pull/33)

**Spec + documentation**

- [x] Toolchain threat model document at `companion/TOOLCHAIN_THREAT_MODEL.md`: 12 threat IDs (T-01 to T-12) covering malicious `otigen.toml`, malicious WASM, `pyde.abi` injection corruption, substituted `.wasm`, RPC MITM, keystore tampering, phished password, supply-chain attacks, dependency confusion, build-time code execution, path traversal, tx replay. Coverage table cross-references the roadmap items where each gap is tracked.
- [x] Performance numbers committed in `README.md`, Chapter 5 (otigen-toolchain), Chapter 17 (developer tools); baselines on a documented reference machine + how to reproduce ✅ (README in pyde-net/otigen#6; Chapters 5 §5.11 + 17 §17.1 in this PR)
- [ ] Architecture chapter (`chapters/05-otigen-toolchain.md`) cross-links every public function in the implementation to the spec section it satisfies
- [x] No new `unsafe` blocks anywhere in the workspace — audited at `SAFETY.md`; 0 `unsafe` blocks in production source (the one `#[unsafe(no_mangle)]` hit is inside a string literal in `crates/otigen-cli/src/templates/rust.rs`, i.e. boilerplate that `otigen init --lang rust` writes into a new contract project, not otigen code) — PR [otigen#41](https://github.com/pyde-net/otigen/pull/41)
- [x] No `unwrap()` / `expect()` on untrusted-input paths — `SAFETY.md` documents 9 production `.expect()` sites; each is infallible by construction (Borsh / `serde_json` on owned types, `u32::try_from` on bounded lengths) — PR [otigen#41](https://github.com/pyde-net/otigen/pull/41)

#### α.live — Live tests (blocked on MC-2 devnet)

- [ ] `otigen deploy` against a running devnet — end-to-end transaction submission + receipt fetch
- [ ] `otigen inspect` against a deployed contract on the devnet
- [ ] `otigen verify` reproducibility round-trip via the devnet's `pyde_getContractCode` RPC
- [ ] Multi-validator stress: deploy + call from 7 distinct keystore identities concurrently

**α BAR (production-ready):** every checkbox in `α.feat`, `α.qual`, and `α.live` ticked; CI green on every platform; fuzz targets have run ≥24h cumulative with no surviving crashes; two independent builds of the canonical hello-rust produce byte-identical artifacts; performance baselines committed and tracked on every PR.

**α BAR (pre-devnet, demonstrable today as of pyde-net/otigen#5):** ✅ — the `init → cargo build → otigen build → bundle` flow is exercised end-to-end by `tests/hello_rust_e2e.rs` against the real Rust toolchain. The full BAR adds the `α.qual` quality gate plus the `α.live` devnet items.

### MC-1 Stream β — Engine Execution `[PAR within] → MC-0` — `pyde-net/engine` branch `execution-side`

Implements [`HOST_FN_ABI_SPEC.md`](companion/HOST_FN_ABI_SPEC.md) (chain side), Chapter 4, PIPs 2/3/4.

**Crates owned:** `account`, `state`, `tx`, `wasm-exec`, `mempool`.

#### β.1 `state` crate `[SEQ within β]` — foundational
- [x] RocksDB scaffold + six column families declared (`state_cf`, `jmt_cf`, `events_cf`, `events_by_topic_cf`, `events_by_contract_cf`, `wave_commits_cf`); `StateStore` + `StateConfig` + open/close lifecycle. Foundation for the items below. — PR [#34](https://github.com/pyde-net/engine/pull/34)
- [x] Dual-hash JMT (Blake3 for internal nodes via `jmt::SimpleHasher`; Poseidon2 reserved on `HybridJmtHasher` for the state-root + address-derivation surfaces per Chapter 4 §4.1). `PersistentJmt` exposes `update / get / root_hash_option / leaf_count` over `jmt_cf`. — PR [#35](https://github.com/pyde-net/engine/pull/35)
- [x] Two-table architecture: `state_cf` (flat `slot_hash → value`) + `jmt_cf` (versioned tree). `StateCommitter::commit` writes both CFs in one RocksDB `WriteBatch` (atomic across families); live reads via `StateStore::read_slot` (single `state_cf` get, JMT not consulted). — PR [#38](https://github.com/pyde-net/engine/pull/38)
- [x] PIP-2 clustered slot keys (contract-prefix layout). `slot_key.rs` ships `account_meta_key`, `storage_slot_key`, `map_entry_key`, `nested_map_entry_key`, `system_key` over `address[..16] || Poseidon2(...)[..16]`. PIP graduated Draft → Accepted in [pyde-net/pips#1](https://github.com/pyde-net/pips/pull/1); validation bench at `crates/state/benches/clustered_keys.rs`. — PR [#38](https://github.com/pyde-net/engine/pull/38)
- [x] PIP-3 wave-level state prefetch (state-side). `prefetch_slots(store, &[SlotHash])` issues one `multi_get_cf` against `state_cf`; dedup + 10K-slot budget cap; per-key errors warn-logged and swallowed. Validation bench at `crates/state/benches/prefetch.rs`. PIP graduated Draft → Accepted in [pyde-net/pips#2](https://github.com/pyde-net/pips/pull/2). The tx-pipeline wire-up that calls this primitive before wave dispatch is deferred to β.3. — PR [#41](https://github.com/pyde-net/engine/pull/41)
- [x] PIP-4 write-back cache (DashMap + warm window + lazy flush). PIP graduated Draft → Accepted in [pyde-net/pips#3](https://github.com/pyde-net/pips/pull/3) with the "JMT writes are lazy too" resolution baked in (cache spans `state_cf` + `jmt_cf` via parallel `JmtPendingQueue`). Shipped across 5 PRs.
  - [x] **PR-5a** primitives — `CacheStore`, `CacheEntry`, `EntryState` machine, `JmtPendingQueue` — landed in PR [#44](https://github.com/pyde-net/engine/pull/44)
  - [x] **PR-5b** read-path integration — `StateStore::read_slot` now does cache → `state_cf` → None with cache-fill on disk hit (no fill on miss); gains `wave_id: WaveId` parameter for `last_read_at_wave` tracking. Landed in PR [#46](https://github.com/pyde-net/engine/pull/46)
  - [x] **PR-5c** write-path integration — `StateCommitter::commit` now writes slot values to `CacheStore` (Dirty / tombstone) + enqueues the wave's `TreeUpdateBatch` on `JmtPendingQueue`. No RocksDB writes per wave. New `CacheAwareJmtReader` lets `put_value_set` see preceding unflushed waves' tree state. `CacheEntry.value` becomes `Option<SmallVec>` to distinguish tombstones from empty values. Landed in PR [#48](https://github.com/pyde-net/engine/pull/48)
  - [x] **PR-5d** background flush task — `flush_once` is the atomic cross-CF drain primitive (snapshots dirty cache + drains JMT pending queue → single RocksDB `WriteBatch` → Pending → Clean on ack). `FlushPolicy` + `should_flush` hold the three-signal trigger logic (100K dirty / 5s wall clock / 16 waves). `FlushTaskHandle::spawn` runs a tokio loop polling on a 100 ms tick; `shutdown().await` runs a final flush and returns cumulative `FlushStats`. Auto-tune is a no-op stub for v1; fixed-threshold defaults match PIP-4. Landed in PR [#54](https://github.com/pyde-net/engine/pull/54)
  - [x] **PR-5e** crash recovery — `last_flushed_wave` checkpoint persisted in `jmt_cf` under a new `TAG_META = 0x03` (written in the same atomic `WriteBatch` as the flush data, so partial-flush is structurally impossible). `StateStore::last_flushed_wave()` exposes it; `recovery::replay_wave` re-runs a historical wave through the cache + JMT layer. `kill_9` integration test exercises the full PIP-4 §"Crash recovery" flow against a synthetic chain log. Chain-log walking itself (extracting per-wave updates from the consensus log) lives at higher layers — β.3/β.4/γ. Landed in PR [#55](https://github.com/pyde-net/engine/pull/55)
- [x] events_cf + events_by_topic_cf + events_by_contract_cf (per `HOST_FN_ABI_SPEC §15.3`). New `EventsBuffer` on `StateStore`; `StateCommitter::commit_with_events` enqueues per-wave events; `flush_once` drains the buffer alongside cache + JMT into the same atomic `WriteBatch` (5 CFs land together or none does). Query helpers in `events.rs`: `events_for_wave`, `events_for_topic` (prefix scan + primary fetch with `from..=to` + limit), `events_for_contract` (same shape). An event with N topics writes N rows to the topic index per §15.3. Landed in PR [#57](https://github.com/pyde-net/engine/pull/57)
- [ ] Atomic wave-commit WriteBatch (state + events + wave commit record in one transaction)
- [x] events_root (Blake3 binary Merkle) + events_bloom (256-byte, 3-hash) computation. `compute_events_root` and `compute_events_bloom` in `events.rs`; both pure functions over `&[EventRecord]`, deterministic, reproduced exactly on crash-recovery replay. `StateCommitter::commit_with_events` now returns `WaveCommitment { state_root, events_root, events_bloom }` — the trio consensus signs in the `HardFinalityCert`. `events_bloom` wraps `EventsBloom::insert_digest` from the types crate (state crate brings blake3; types crate preserves its leaf-dep invariant). Landed in PR [#59](https://github.com/pyde-net/engine/pull/59)
- [x] Implement `StateView` + `StateMutator` traits (from `interfaces`) — partial impl on `StateStore`. Wired through: `StateView::get_slot` → `StateStore::read_slot` at `last_flushed_wave`, `StateView::state_root` → `PersistentJmt::root_hash_option` (Blake3 only; Poseidon2 surface stays zero until the `HybridJmtHasher` Poseidon2 output is exposed), and `StateMutator::snapshot` → opaque `SnapshotHandle` keyed by `last_flushed_wave` (chunks reached via `Snapshotter::build` directly). Account-shaped reads (`get_balance` / `get_nonce_window` / `get_auth_keys` / `get_code` / `get_code_hash` / `get_account_type`) return `InterfaceError::NotImplemented` until β.2 ships the account encoding; `commit_wave` / `rollback_wave` return `NotImplemented` until β.4 (wasm-exec) wires through `StateCommitter::commit_with_events` at MC-2. Landed in PR [#62](https://github.com/pyde-net/engine/pull/62)
- [x] Snapshot generation (chunks + manifest). `Snapshotter::build` walks `state_cf` under a pinned `rocksdb::Snapshot` at `last_flushed_wave`, partitions entries into `SnapshotChunk`s of configurable size (default 1024), and produces a `SnapshotManifest` with `wave_id`, `state_root`, per-chunk Blake3 hashes, and `total_keys`. State-sync consumers fetch the manifest first, stream chunks in order (hashes verify chunk integrity), rebuild a fresh JMT, and confirm the recomputed root matches the manifest's `state_root` (which the committee signed in the wave's `HardFinalityCert`). Per-chunk JMT inclusion proofs deferred to v2 (rebuild-and-compare is correct and simpler for v1). Landed in PR [#61](https://github.com/pyde-net/engine/pull/61)

#### β.2 `account` crate `[PAR within β]`
- [x] On-disk `Account` record per Ch 11 §11.1 — `address`, `nonce_window`, `balance`, `code_hash` (Poseidon2), `storage_root` (Blake3, kept zero in v1 per §11.11's single-global-JMT resolution), `account_type`, `auth_keys`, `gas_tank`, `key_nonce`. Constructors for EOA / Contract / System; `is_eoa` / `is_contract` / `is_system` / `has_code` accessors. Borsh layout pinned by a 144-byte all-zero-EOA test plus a bitmap-offset pin. The actual encoding adds 2 bytes vs the §11.1 summary text (which elides `NonceWindow.bitmap` but §11.4 requires it for replay protection) — flagged in the module docs for a spec-text touch-up. Landed in PR [#64](https://github.com/pyde-net/engine/pull/64)
- [x] `AccountStore` — PIP-2 bridge from account record to state slot storage. Allocates discriminator `0x10` (`ACCOUNT_RECORD`) under the account-crate's owned `0x10..=0x1F` namespace; `account_slot(addr) = addr[..16] || Poseidon2(0x10)[..16]` clusters every account's record by address prefix in RocksDB's lex order. `AccountStore::get` / `write` / `delete` thread borsh encode/decode through `StateStore`; field-level helpers (`balance`, `nonce_window`, `auth_keys`, `code_hash`, `storage_root`, `account_type`) match the state-crate `StateView::get_*` contracts so the state-side `NotImplemented` stubs (PR-9) can route through. One-blob-per-account encoding follows Ch 11 §11.1; per-field split deferred to v2. Landed in PR [#68](https://github.com/pyde-net/engine/pull/68)
- [x] `AccountStateView` — full `StateView` + `StateMutator` impl over `&StateStore` that routes account-shaped reads through `AccountStore`. Closes the β.1 PR-9 `NotImplemented` stubs without forcing a state→account dep cycle (the impl lives in the account crate, which already depends on state). `AccountError` → `InterfaceError` maps storage failures to retryable `Storage`, decode failures to non-retryable `Internal` ("corruption"). Callers pick: `StateStore` for slot-only access (cheap), `AccountStateView` for full account-shaped reads. `get_code` stays `NotImplemented` until code storage lands (separate slot family or `code_cf`); `commit_wave` / `rollback_wave` stay `NotImplemented` until β.4 ships the executor and MC-2 wires `WaveCommitRecord` storage. Landed in PR [#69](https://github.com/pyde-net/engine/pull/69)
- [x] 32-byte address derivation (`Poseidon2(falcon_pubkey)`) — `eoa_address`, `create_address` (deployer ‖ nonce_le, 40 B), `create2_address` (`0xFF` ‖ deployer ‖ salt ‖ code_hash, 97 B), `system_address` (`Poseidon2(name_bytes)`). Distinct input lengths + `0xFF` prefix on CREATE2 give structural cross-path collision resistance; Poseidon2's 128-bit Goldilocks collision resistance handles random inputs. 14 unit tests cover determinism + per-field sensitivity + cross-path distinctness. Landed in PR [#65](https://github.com/pyde-net/engine/pull/65)
- [x] `AuthKeys` enum with `Single`, `MultiSig`, `Programmable` (Programmable v2-reserved) — the wire-level enum lives in the (frozen) `types` crate; `Account::rotate_keys` is the record-bound helper: validates `new_keys` (NoSigners / TooManySigners / InvalidThreshold), swaps `auth_keys`, and saturating-increments `key_nonce` so in-flight signatures under the previous key fail inclusion (§11.5 "Key rotation"). Programmable round-trips at the record layer for replay/state-sync survivability even though tx handlers reject it at v1. Landed in PR [#66](https://github.com/pyde-net/engine/pull/66)
- [x] 16-slot nonce window — `NonceWindow` (base + 16-bit bitmap) lives in the frozen `types` crate; `Account::accepts_nonce` / `Account::commit_nonce` are the record-bound helpers per Ch 11 §11.4. Sole mutation path for the window from the account-crate layer. Landed in PR [#66](https://github.com/pyde-net/engine/pull/66)
- [x] Name registry as a system contract (ENS-style, unique names) — bidirectional `name ↔ address` mapping at system slots `NAME_TO_ADDRESS=0x40` + `ADDRESS_TO_NAME=0x41` so wallets can display "pyde-treasury" without an external index. `validate_name` enforces ASCII alphanumeric + `-` + `_`, length 3..=64, no edge `-`/`_` (Unicode-look-alike protection). `register_name` writes both directions atomically; uniqueness enforced both ways; idempotent against same (name, address) re-registration. `unregister_name` atomic tombstone for v2 governance flows. No dedicated `NameRegister` tx-type in v1 — Ch 11 §11.8's frozen 13-variant `TxType` has none; reachable only via genesis + future governance. Subdomain / expiry / resolver records / sale-transfer / squatting protection all deferred to v2. 17 tests including Unicode rejection + edge-char rules + cross-direction uniqueness. Landed in PR [#89](https://github.com/pyde-net/engine/pull/89)

#### β.3 `tx` crate `[PAR within β]`
- [ ] Native tx types: `Transfer`, `ValidatorRegister`, `Stake`, `Unstake`, `NameRegister`, `Multisig`, `RotateKeys`. Per-type state-effect handlers under `crates/tx/src/handlers/`:
  - [x] **`Standard` (value-transfer half)** — `handle_standard` runs the §10.1 charge-up-front / debit-after-execution pipeline: load sender → `verify_tx_against_auth` dispatch → nonce-in-window → recipient code-hash check (contract-call path returns `HandlerError::ContractCallDeferred` until β.4) → balance vs `value + gas_limit×base_fee` reservation → debit fee `gas_used × base_fee` → commit nonce → move `value` sender→recipient (auto-creates `AuthKeys::None` funded-but-unregistered EOA per §11.8 row 13 if missing; self-transfer short-circuits the loop). Returns `HandlerOutput { gas_used, fee_distribution }` for wave-level fee aggregation. Per-tx fee crediting deferred (per §10.5 reward pool is lazy-accrued per-epoch + burn is a counter); vesting deferred (needs subsystem outside β.3). 17 tests across all 9 failure modes + happy path + self-transfer. Landed in PR [#77](https://github.com/pyde-net/engine/pull/77)
  - [ ] `Deploy` (needs β.4 wasm-exec for init bytecode)
  - **Staking trio per Ch 14 §14.5:**
    - [x] **`StakeDeposit`** + validator-registry primitive — `ValidatorRecord` (operator, pubkey, stake, status, unbond_at_wave, last_claimed_rps, uptime_bps), Active/Unbonding/Exited status machine, system slots `REWARDS_PER_STAKE_UNIT=0x14` / `TOTAL_ACTIVE_STAKE_WEIGHTED=0x15` / `VALIDATOR_REGISTRY=0x20` / `OPERATOR_VALIDATORS=0x21`. Constants: `MIN_VALIDATOR_STAKE=10K PYDE`, `OPERATOR_CAP=3` (anti-Sybil), `UPTIME_FULL_BPS=10_000`. `handle_stake_deposit` derives validator_address = `eoa_address(data_pubkey)`, checks cap + no-duplicate + sig + balance + nonce, locks stake, writes record with **`last_claimed_rps = current_rps`** (critical: NOT 0 — prevents draining via retroactive accrual). Bumps `TOTAL_ACTIVE_STAKE_WEIGHTED` by `stake × uptime / UPTIME_FULL_BPS`. `bootstrap_validator` genesis helper. 21 tests including the security-critical RPS-snapshot test. Landed in PR [#84](https://github.com/pyde-net/engine/pull/84)
    - [x] **`StakeWithdraw`** — validator-self-signed (tx.from = validator_address, signed by `record.pubkey` installed at StakeDeposit time via the auto-create-validator-account retrofit). Active → Unbonding transition, records `unbond_at_wave`, decrements `TOTAL_ACTIVE_STAKE_WEIGHTED` by the validator's stake×uptime contribution. One-shot (double-withdraw rejected). Landed in PR [#86](https://github.com/pyde-net/engine/pull/86)
    - [x] **`ClaimReward`** — validator-self-signed lazy-accrual claim per §14.5: `owed = (current_rps - last_claimed_rps) × stake × uptime / UPTIME_FULL_BPS`. Updates `last_claimed_rps` to current RPS after payout so a second claim only pays incremental delta. **Folds in the §14.5 "explicit follow-up" unbonding sweep**: when called past `unbond_at_wave + UNBONDING_PERIOD_WAVES` (= 5,184,000 = 30 days × 172,800 waves/day at 500 ms median), additionally refunds the stake to validator balance and transitions Unbonding → Exited. No dedicated tx type for the sweep was named in the spec — folding into ClaimReward is the cleanest fit. Exited validators that claim again get `ValidatorWrongStatus`. Landed in PR [#86](https://github.com/pyde-net/engine/pull/86)
  - [x] **`Slash` (safety-evidence partial scope)** — `handle_slash` accepts `SafetyEvidence { offender, round, view, msg_a+sig_a, msg_b+sig_b, reporter? }` for DoubleSign / Equivocation. Validates both FALCON sigs against `record.pubkey`, confirms `msg_a != msg_b`, applies `SAFETY_SLASH_BPS=1000` (10%) slash, credits `REPORTER_REWARD_BPS=1000` (10%) to reporter (sender==reporter merged to avoid clobber; self-reporting blocked), burns the rest, transitions offender to `Exited`, decrements `TOTAL_ACTIVE_STAKE_WEIGHTED`. **Honestly deferred** (with rationale in module docs): liveness/DKG evidence (need consensus + γ.3), 24h dispute escrow (needs governance multisig), escalating jail periods + repeat-offense scaling + correlation multiplier (need historical/cross-tx tracking), reporter cooldown, new-validator grace, DoubleSign 100%+ban distinction (treated as 10% Equivocation baseline in PR-12; v2 hardening with `BannedValidators` slot). 13 tests including frame-up-attack (claim address but sign with wrong key) + Exited-cannot-slash-again. Landed in PR [#87](https://github.com/pyde-net/engine/pull/87)
  - [x] **`ClaimAirdrop` / `SweepAirdrop`** — closes the airdrop subsystem per Ch 14 §14.7. System slots: `AIRDROP_ROOT=0x18` (Poseidon2 Merkle), `AIRDROP_DEADLINE=0x19` (`WaveId`), `AIRDROP_CLAIMED=0x1A` (per-leaf-index `bool` — one slot per leaf for v1 simplicity; v2 PIP can pack bits), `AIRDROP_EXPECTED_SUM=0x1B` (genesis sanity). Pool at `Poseidon2("pyde-airdrop-pool")`. Leaf hash = `Poseidon2(0x00 ‖ leaf_index_le8 ‖ address ‖ amount_le16)`; sibling-side bit at level `i` = `(leaf_index >> i) & 1` (prevents sorted-pair attacks). ClaimAirdrop verifies the Merkle path for `(leaf_index, tx.from, amount)`, debits pool → credits claimant, sets the claim bit. Gas: 30K + 5K × levels with **early-gas guard before state mutation** per the spec's "PR #212 fix" requirement. SweepAirdrop is permissionless (any sender) — moves the pool's residual to the treasury after the deadline. `bootstrap_airdrop` genesis helper seeds the trio atomically. 16 tests including leaf-tamper + sibling-swap proof-forgery attacks. Landed in PR [#83](https://github.com/pyde-net/engine/pull/83)
  - [x] **`MultisigTx` / `RotateMultisig`** — `handle_multisig_tx` (treasury spend) + `handle_rotate_multisig` (signer-set rotation) per §11.7. MultisigTx debits the treasury (at `treasury_address() = Poseidon2("pyde-treasury")`) and credits a target; bundle covers `borsh((target, amount))` so substituting target/amount post-sign fails verify. §11.7 invariants: `target != ZERO`, `target != treasury`, `target != tx.from` (pipeline-writeback clobber), `amount > 0`. Auto-creates the target as `AuthKeys::None` funded-but-unregistered EOA if missing. RotateMultisig replaces the signer set + threshold; bundle covers `borsh((new_signers, new_threshold))`; **nonce continues monotonically (never reset)** so a brief old-set compromise can't replay arbitrary old spend bundles after the rotation. `bootstrap_treasury` genesis helper seeds the treasury account; same canonical_msg + verify_bundle primitive reused from PR-7. New HandlerError variants: `MultisigEnvelopeShape { reason }` + `TreasuryUninitialised`. 27 tests across both handlers including payload-substitution attacks, replay-after-state-changed, post-rotation-old-sigs-no-longer-verify, multi-step rotation chain. Landed in PR [#81](https://github.com/pyde-net/engine/pull/81)
  - [x] **`EmergencyPause` / `EmergencyResume`** — flip the on-chain `IS_PAUSED` slot (system-key discriminator `0xF3`) gated on a treasury-multisig FALCON-512 signature bundle. Ships with the multisig primitive prerequisite: `MultisigState { signers, threshold, nonce }` at system slots `MULTISIG_SIGNERS=0xF0` / `MULTISIG_THRESHOLD=0xF1` / `MULTISIG_NONCE=0xF2`; `BundleEntry` wire shape; `canonical_msg = Poseidon2(domain ‖ nonce_le ‖ Poseidon2(payload))` with per-tx-type domain bytes (MultisigTx 0x09 / RotateMultisig 0x0A / Pause 0x0B / Resume 0x0C — separation prevents lifting a signature for one action into another); `verify_bundle` with cheap-path structural checks before any FALCON verify + short-circuit at threshold. Handlers do: load state → decode bundle → verify against canonical_msg(type, nonce, []) → idempotency guard (must actually flip) → set flag → bump nonce. No gas, no fee — multisig-signed protocol governance per §11.7. 35 tests across system_slots + multisig primitive + both handlers (replay-after-state-changed, all 4 transition guards, threshold short-circuit, duplicate-signer rejection). Landed in PR [#80](https://github.com/pyde-net/engine/pull/80)
  - [x] **`RegisterPubkey`** — `handle_register_pubkey` per §11.8 row 13. Allowed only when account exists with `balance > 0` and `auth_keys == AuthKeys::None`. Data carries the 897-byte FALCON pubkey; proof-of-ownership is the `eoa_address(pubkey) == tx.from` derivation check (Poseidon2 preimage resistance ⇒ submitter holds the secret). No signature, no value, no gas — the protocol gives the registration a free pass so the bootstrap path can't be blocked by empty balance. DoS bounded: at most one per address per lifetime; the funded-but-unregistered population is itself bounded by the funder's 21K-gas charge on the originating `Standard` transfer. One-shot install (key_nonce stays 0; subsequent changes use rotate-keys). 10 tests + Standard→RegisterPubkey bootstrap integration. Landed in PR [#78](https://github.com/pyde-net/engine/pull/78)
- [ ] WASM tx types: `ContractCall`, `ContractDeploy`
- [x] Canonical tx hashing — `tx_hash = Poseidon2(chain_id ‖ from ‖ to ‖ value ‖ Poseidon2(data) ‖ gas_limit ‖ nonce ‖ fee_payer_tag ‖ Poseidon2(access_list) ‖ deadline ‖ tx_type)` per Ch 11 §11.6. `data` and `access_list` pre-hashed to bound outer permutation; signature NOT included (it signs the hash). **Roadmap originally said "Blake3" — corrected to Poseidon2 here** because tx hashes cross the ZK boundary (light-client receipts, aggregated state proofs, future SNARK roll-ups). Tag encodings for `FeePayer` / `Option<deadline>` / `TxType` are spelt out, not just borsh-derived, to keep wire stability independent of derive output. Landed in PR [#71](https://github.com/pyde-net/engine/pull/71)
- [x] Tx signature verification — `verify_tx_signature(tx, pubkey)` FALCON-512-verifies `Tx.signature` against the canonical `tx_hash`. `verify_tx_against_auth(tx, AuthKeys)` dispatches by variant: `Single` → verify; `None` → `Err(NoAuth)`; `Programmable` → `Err(ProgrammableV1Reserved)` per §11.5 v1-reservation; `MultiSig` → `Err(MultisigDeferred)` (multisig sigs travel inside the `MultisigTx` handler's `data` envelope, not `Tx.signature`). Graceful-false on malformed sig/pubkey rather than panic. 11 tests including keygen→sign→verify round-trip + every dispatch path. Landed in PR [#74](https://github.com/pyde-net/engine/pull/74)
- [x] Gas accounting (EIP-1559 base fee; no refunds per `gas-no-refund-v1` memory) — constants frozen per Ch 10 §10.2: GAS_TARGET=400M, GAS_CEILING=1.6B (4×), GENESIS_BASE_FEE=50e9 quanta, MIN_BASE_FEE=1, ADJUSTMENT_DIVISOR=8 (±12.5% per commit). `adjust_base_fee` applies the proportional bump/drop with min-1-quanta upward jolt + MIN_BASE_FEE floor. `compute_fee` uses `checked_mul` overflow guard. `distribute_fee` / `distribute_total` implement 70/20/10 burn/reward-pool/treasury with remainder-to-treasury rounding recovery (no quanta lost). Zero refunds (EIP-3529 lesson + PIP-4 handles state cleanup at the engine layer). 20 tests cover constants pin, adjustment edges (full 4×, slight-over, busy min-1, empty drop, MIN_BASE_FEE floor, ±12.5% cap), overflow guard, distribution spec examples (§10.6 simple / high-congestion / low-demand) + dust-to-treasury. Landed in PR [#72](https://github.com/pyde-net/engine/pull/72)
- [x] Structural tx validators — ingress-time `validate_tx_structure(tx)` runs the §10.9 limit checks (MIN_GAS_LIMIT=21K, BLOCK_GAS_MAX=1.6B, MAX_TX_SIZE=128 KiB, MAX_CALLDATA=64 KiB — separate caps per audit task 055) plus §11.8 per-type shape rules: envelope-style `to == ZERO` for 10 affected types, empty-data for StakeWithdraw / ClaimReward / SweepAirdrop, non-empty data for Deploy / Slash / ClaimAirdrop / Multisig* / Emergency*, 897-byte FALCON pubkey for StakeDeposit + RegisterPubkey, the RegisterPubkey-only "no signature, no value" rule. Self-contained (no state access); `TxValidationError` per failure mode with actual/expected pairs for useful logs. 23 tests across all 11 invariant categories. Landed in PR [#75](https://github.com/pyde-net/engine/pull/75)
- [ ] Deploy / upgrade / lifecycle handlers (per `OTIGEN_BINARY_SPEC §8`)

#### β.4 `wasm-exec` crate `[SEQ within β] → β.1`
- [x] wasmtime engine config (deterministic feature subset per Ch 3 §3.2) — `deterministic_config()` builds `wasmtime::Config` with Cranelift at Speed opt, `consume_fuel=true`, `epoch_interruption=true`, `cranelift_nan_canonicalization=true` (cross-platform float determinism per Ch 3 — x86 SSE2 vs ARM NEON quiet-NaN encoding diverges otherwise), `wasm_simd/relaxed_simd/multi_memory/memory64=false`, `wasm_bulk_memory=true`. Threads / reference-types / function-references / GC / component-model are off via the wasmtime cargo-feature gate (proposal not compiled in → setter doesn't exist; the gate IS the off switch). 3 tests including AOT-output bit-equality across two engines. Landed in PR [#91](https://github.com/pyde-net/engine/pull/91)
- [x] `WasmExecutor` type — engine-level handle that owns the singleton `wasmtime::Engine` + `ModuleCache`. Cheap to clone (both internally `Arc`'d), safe to share across wave-execution threads. Exposes `compile_and_cache(bytes) → CodeHash` / `has_module(hash)` / `engine()` / `cache()`. Foundation type subsequent PRs extend with per-tx instance creation, host-fn bindings, and overlay. Landed in PR [#91](https://github.com/pyde-net/engine/pull/91)
- [ ] Module cache: LRU + max-size (1 GB default) + TTL (8 epochs default) (per `HOST_FN_ABI_SPEC §3.6`) — **basic scaffold shipped** (`ModuleCache` = `Arc<Mutex<HashMap<Blake3Hash, Module>>>` with `compile_and_cache` + `get`, idempotent against re-compilation), but LRU + max-size + TTL + disk-spill + pre-warm-on-deploy all deferred to PR-2+ as spec'd in the module docs.
- [x] Fuel-to-gas mapping (calibrated from spec §10 gas table) — `FUEL_PER_GAS=1000` chain spec constant (hard fork to change). `gas_to_fuel` saturating multiply (caps for u64 safety; realistic gas ≤ BLOCK_GAS_MAX = 1.6 × 10⁹ stays well below saturation). `fuel_to_gas` **ceiling** divide (rounds UP — floor-div would let attacker run FUEL_PER_GAS-1 fuel for free every tx; ceiling makes worst-case overcharge exactly 1 gas/tx, negligible against MIN_GAS_LIMIT=21K). `compute_consumed_gas(initial_fuel, remaining_fuel)` bundles saturating-sub + ceiling for the per-tx pipeline; clamps impossible `remaining > initial` to 0 consumed. Constant (not Config knob) so every node computes identical `gas_used` for identical txs — per-node knob would fork consensus. 14 tests covering saturation, ceiling at every boundary, round-trip identity, pathological u64::MAX. Landed in PR [#92](https://github.com/pyde-net/engine/pull/92)
- [x] Per-tx overlay execution model (snapshot-and-rollback; nested for cross-call) — `TxOverlay` wraps `&AccountStore` and maintains a stack of `OverlayLayer` frames. Reads scan layers top-down then fall through to the underlying store; writes go to the top layer. `push_layer` on cross-call entry; `pop_and_commit` merges sub-call writes into parent on success; `pop_and_discard` drops them on revert. `finalize` flattens the stack and applies all writes to the store (accounts via `AccountStore::write`, slots via `StateCommitter::commit`); drop-without-finalize is the tx-level revert path (underlying store untouched). Tombstones encoded as `Option<None>` slot values that mask deeper layers + the store. `BTreeMap` for write buffers (deterministic finalize order — wave-commits must be reproducible across nodes for state-root consensus). Three error variants (`OverlayUnderflow` / `OverlayLayersUnclosed` / `OverlayBackend`) guard the call sequence. 21 tests cover read fall-through, overlay shadowing, slot tombstones, push/pop balance, commit/discard, nested layer composition, underflow rejection, and finalize success/error paths. Landed in PR [#94](https://github.com/pyde-net/engine/pull/94)
- [x] Per-tx Store + Linker + entry-point dispatch — `HostContext` is plain owned data (BlockContext + TxContext + self_address + depth + in-flight `EmittedEvent` buffer); kept lifetime-free because wasmtime requires `T: Send + Sync + 'static` for `Store<T>` (overlay borrow would force lifetime-erasing tricks that aren't worth their cost until storage host fns actually need it — PR-7 picks the trait-object shape then). `linker::build_linker` builds a fresh `Linker<HostContext>` per tx (microsecond cost; sharing across txs deferred until profiling justifies it). `WasmExecutor::execute_call(code_hash, entry_point, ctx)` ties it together: cache lookup → linker build → `Store::new` with fuel-seeded budget from `gas_to_fuel(tx.gas_limit)` + `set_epoch_deadline(u64::MAX)` (epoch interruption is enabled at engine level as a cancellation primitive; gas/fuel is the sole stopping mechanism here) → instantiate → entry-point invoke → trap capture (walks `wasmtime::Error::source()` chain so host-fn-produced messages survive past the top-level "wasm backtrace" wrapper) → `compute_consumed_gas` → `CallOutcome { consumed_gas, trap, events }`. PR-4 supports only void-void entry points (full ABI dispatch in a later PR). Ships `pyde::panic` as a plumbing-exercise host fn (returns ptr/len as trap message; full memory-decode helper lands in PR-5a). Three new error variants: `HostFn` / `EntryPointMissing` / `Runtime`. 13 tests: HostContext construction + event push, panic register success + duplicate rejection, execute_call for void return + unknown module + missing entry point + unreachable trap + pyde::panic call + out-of-fuel + minimal-gas no-op. Landed in PR [#95](https://github.com/pyde-net/engine/pull/95)
- [ ] Host functions — each independent task:
  - [x] Storage: `sload`, `sstore`, `sdelete` (with access-list enforcement) — three host fns sharing the standard `(slot_ptr, ..., wave_id)` shape. Required infra: `HostContext` gained an `overlay: Option<Arc<Mutex<TxOverlay>>>` slot via `with_overlay` builder (Option keeps existing test surface untouched; storage host fns trap with `"storage host fn called without overlay backend"` if invoked without one) AND the β.2 `AccountStore<'a>` + β.4 `TxOverlay<'a>` types were Arc-refactored across 50+ test fixtures to drop their lifetime params so the Arc<Mutex<...>> handle could live inside the 'static-shaped HostContext that wasmtime's `Store<T>` requires (PR [#103](https://github.com/pyde-net/engine/pull/103)). `sload(slot_ptr, out_ptr, out_max_len) -> i32` reads via `TxOverlay::read_slot` (top-down layer scan + tombstone awareness), writes `min(actual, out_max_len)` bytes to `out_ptr`, returns actual length; returns `SLOAD_MISSING = -1` for missing slot (distinct from length-0 value). `sstore` buffers `(slot, value)` to the top overlay layer; `MAX_STORAGE_VALUE_BYTES = 16 KB` pre-allocation guard. `sdelete` writes a tombstone — per PIP-4 gas-no-refund: NO refund for deletes, sdelete metered like any host fn. Gas (EVM-shape): `GAS_SLOAD = 100 + 1/byte` copy, `GAS_SSTORE_BASE = 5_000 + 32/byte` value, `GAS_SDELETE = 5_000`. Warm-cold gap + zero-nonzero premium deferred to v2. Access-list enforcement (PIP-2 spec calls it out) is a wave-orchestrator concern — it pre-validates that the slot keys a tx will touch are in the tx's `access_list` before the tx runs; the host fns themselves don't enforce because they have no `&Tx`. v2 hardening. 8 end-to-end tests via in-WASM unreachable assertions (sstore + sload round-trip, sload-missing returns -1, sdelete makes subsequent sload return -1, sstore oversize trap, storage-without-overlay trap) + 3 unit tests (register + duplicate + constants pin). Landed in PR [#104](https://github.com/pyde-net/engine/pull/104)
  - [x] Balances: `balance`, `transfer` — `pyde::balance(addr_ptr, out_ptr) -> ()` reads the 32-byte address, looks up via `TxOverlay::read_account` (overlay-first, falls through to underlying `AccountStore`), writes 16-byte u128 LE balance to `out_ptr` (0 for missing accounts). `pyde::transfer(to_ptr, amount_ptr) -> i32` reads recipient + u128 amount, then: self-transfer short-circuits to `TRANSFER_OK = 1` (avoids writeback-clobber pattern from standard tx handler); otherwise loads self, checks `balance >= amount` (returns `TRANSFER_INSUFFICIENT = 0` on shortfall), debits self, loads or auto-creates recipient as `AuthKeys::None` funded-unregistered EOA per §11.8 row 13, credits recipient (overflow check), writes both back. Binary success/insufficient flag matches EVM `CALL`'s value-transfer semantics — natural failure case isn't a trap; overflow on the credit IS a trap because it's a programmer bug. Both fns require HostContext.overlay; trap with `"balance host fn called without overlay backend"` if absent. Gas matches EVM: `GAS_BALANCE = 700` (post-EIP-1884 BALANCE; full account-blob fetch), `GAS_TRANSFER = 9_000` (two BALANCE reads + cross-account-write coordination). 9 tests via in-WASM unreachable assertions (balance-unknown returns 0, balance-seeded LE bytes verified, self-transfer short-circuits, insufficient-balance returns 0, transfer-credits-recipient end-to-end with 1000→100 transfer + recipient balance read-back, balance-without-overlay traps) + 3 unit tests (register + duplicate + constants pin). Landed in PR [#106](https://github.com/pyde-net/engine/pull/106)
  - [x] Context: `caller`, `origin`, `self_address`, `block_height`, `wave_id`, `block_timestamp`, `chain_id` — shipped alongside the shared `mem::{caller_memory, write_to_memory, read_from_memory}` linear-memory I/O helpers (bounds-checked against the contract's exported `"memory"`; reused by every subsequent host fn). Address-shaped fns (`caller`, `origin`, `self_address`) write 32 bytes to a contract-supplied `out_ptr`; scalar fns (`wave_id`, `block_height`, `block_timestamp`, `chain_id`) return `i64`. `block_height` aliases `wave_id` for EVM-shape ABI portability. `caller` returns `tx.from` at the top-level call (cross-call PR pushes a per-frame caller stack later). Per-call gas charged via `Caller::get_fuel + set_fuel` (wasmtime exposes no single `consume_fuel`); `GAS_CONTEXT_ADDRESS = 5`, `GAS_CONTEXT_SCALAR = 2` per `HOST_FN_ABI §10` "very cheap" tier; out-of-budget surfaces as explicit `"out of fuel: needed N, have M"` trap. 11 tests: registration + duplicate-error path + gas-constant pin + end-to-end via in-WASM `unreachable`-on-mismatch assertions for each fn + 100-iteration loop verifies ≥200 gas tally + 1-gas budget triggers OOF trap inside host fn. Landed in PR [#96](https://github.com/pyde-net/engine/pull/96)
  - [ ] Tx context: `tx_hash`, `tx_value`, `tx_gas_remaining`, `calldata_size`, `calldata_copy` — **partial shipped**: `tx_hash(out_ptr)` (writes 32-byte Poseidon2 tx hash), `tx_value(out_ptr)` (writes u128 as 16 LE bytes — WASM has no native i128), `tx_gas_remaining() -> i64` (post-charge gas via `fuel_to_gas(get_fuel)`) all landed. `tx_hash` and `tx_value` charge `GAS_CONTEXT_ADDRESS = 5` (same shape as caller/origin/self_address); `tx_gas_remaining` charges `GAS_CONTEXT_SCALAR = 2`. **Deferred**: `calldata_size` + `calldata_copy` wait for `HostContext.tx.input: Vec<u8>` — that ships when the contract-call tx handler lands in β.3 and plumbs through. Landed in PR [#99](https://github.com/pyde-net/engine/pull/99)
  - [x] Events: `emit_event` (multi-topic; 1-4 topics; spec §7.5) — `pyde::emit_event(topics_ptr, topic_count, data_ptr, data_len) -> ()` reads `topic_count × 32` topic bytes from contract memory, then `data_len` data bytes, and appends `EmittedEvent { contract: self_address, topics, data }` to the in-flight `HostContext::events` buffer (returned via `CallOutcome::events`; higher-layer pipeline flushes to the state crate's `events_cf` on tx success, drops on revert). Validation: `MAX_TOPICS = 4` (matches EVM `LOG0..LOG4` indexing semantics — 5+ traps), `MAX_EVENT_DATA_BYTES = 8 KB` pre-allocation guard before the gas check fires. Gas: `GAS_EVENT_BASE = 375 + GAS_EVENT_PER_TOPIC = 375 × topic_count + GAS_EVENT_PER_BYTE = 8 × data_len` — same shape as EVM `LOG` so cross-chain devs have the same mental model. Cross-call revert semantics (sub-call frame drops its own events; parent's events survive) need stack-structured buffers; v1 flat buffer is fine because cross-call doesn't ship yet. 8 tests: register + duplicate-error, gas-cost components, constants pin, end-to-end via in-WASM fill-memory + emit verifies events.len() + topic + data + contract = self_address, too-many-topics trap, oversize-data trap. Landed in PR [#101](https://github.com/pyde-net/engine/pull/101)
  - [x] Hashing: `hash_blake3`, `hash_poseidon2`, `hash_keccak256` — three host fns sharing the `(in_ptr, in_len, out_ptr) -> ()` shape; each reads input from contract memory, computes a 32-byte digest, writes back. Kept distinct because each serves a different workload: Blake3 for high-throughput commitments (matches Pyde's internal JMT/snapshot/Merkle), Poseidon2 for SNARK-friendly digests (matches Pyde's address/tx-hash/state-root), Keccak-256 for EVM-shape interop. Shared `charge_and_read` preamble: rejects negative len, hard-caps at `MAX_HASH_INPUT_BYTES = 1 MB` (pre-allocation guard before the gas check fires), charges via `get_fuel + set_fuel`. Gas: `GAS_HASH_BASE = 30 + GAS_HASH_PER_WORD = 6` per 32-byte ceiling-divided word; same constants for all three (spec §10 anchors hashing at one tier so authors pick by suitability not gas). Adds `tiny-keccak` workspace dep; `pyde-crypto::poseidon2::poseidon2_hash` already available. 9 tests: register + duplicate-error path, gas-cost word-boundary table (0/1/32/33/64/1024), max-input cost pin (~197K gas), constants pin, end-to-end verification via in-WASM `unreachable`-on-mismatch with hand-computed expected digests for all 3 fns, oversize input traps. Landed in PR [#98](https://github.com/pyde-net/engine/pull/98)
  - [x] Crypto: `falcon_verify` — `pyde::falcon_verify(pk_ptr, msg_ptr, msg_len, sig_ptr, sig_len) -> i32` reads a 897-byte FALCON-512 pubkey + variable-len msg + variable-len sig from contract memory, calls `pyde_crypto::falcon::falcon_verify` natively (~1ms; ~50× faster than a WASM impl because Cranelift can't auto-vectorize the polynomial arithmetic), returns `i32` (1 = valid, 0 = invalid). Length contracts: pk fixed at 897 (no parameter — invariant), `MAX_FALCON_MSG_BYTES = 64 KB`, `MAX_FALCON_SIG_BYTES = 1000` (matches pyde-crypto's accepted upper bound — sigs average ~666 with real-world max 800-900). Gas: flat `GAS_FALCON_VERIFY = 50_000` charged up front (verification cost dominated by polynomial inverse + FFT, both message-length-independent). Invalid-input vs invalid-signature semantics: malformed pubkey, malformed sig (length outside `[500, 1000]`), or oversize inputs all **trap** with descriptive messages; well-formed inputs whose signature doesn't verify return `0` (no trap). The contract gets a binary "valid or not" only when both inputs are structurally well-formed. 8 tests: register + duplicate-error, constants pin, real-keypair end-to-end (keygen + sign + WAT data segments with inlined bytes + in-WASM unreachable on != 1 + ≥50K gas charge), tampered-sig returns 0, oversize-msg trap, oversize-sig trap, malformed-sig-length trap. Landed in PR [#102](https://github.com/pyde-net/engine/pull/102)
  - [ ] Cross-call: `cross_call`, `cross_call_static` (FREE; bounded by `VIEW_FUEL_CAP`), `delegate_call`
  - [ ] Halt: `return`, `revert`
  - [x] Gas: `consume_gas` — explicit manual gas burn. `consume_gas(amount: i64)` charges `amount` gas immediately; no-op on negative/zero (spec treats negative as "ignore"); out-of-fuel trap if budget can't cover. No host-fn dispatch surcharge — `consume_gas` IS the metering primitive, not an instance of metered code. Useful for contracts that want to deliberately spend gas (e.g., delay loops, fairness mechanisms). Landed in PR [#99](https://github.com/pyde-net/engine/pull/99)
  - [ ] Randomness: `beacon_get`
  - [ ] Parachain extensions (gated): `parachain_storage_read`/`write`/`delete`, `parachain_emit_event`, `parachain_id`, `parachain_version`, `send_xparachain_message`, `threshold_encrypt`, `threshold_decrypt`
- [ ] Deploy-time validation (3-layer per `HOST_FN_ABI_SPEC §3.7`)
- [ ] Attribute application + `pyde.abi` custom-section extraction
- [ ] Implement `Executor` trait (from `interfaces`)

#### β.5 `mempool` crate `[PAR within β] → β.3`
- [ ] FALCON-512 verify pipeline (batchable)
- [ ] Validation rules: chain_id, nonce window, balance, gas bounds, calldata size, attribute coherence
- [ ] Gossip admission (integration with γ's `net` crate via `NetworkView` trait)
- [ ] Per-sender rate limit + concurrent cap (DDoS protection)
- [ ] Implement `MempoolView` trait (from `interfaces`)

**β BAR:** `cargo test` clean on `execution-side` branch; mock-based integration tests (using `interfaces::mock`) pass for state + execution + mempool; can replay a tx end-to-end against the in-memory `MockNetwork`.

### MC-1 Stream γ — Engine Consensus + Network `[PAR within] → MC-0` — `pyde-net/engine` branch `consensus-side`

Implements Chapter 6, `SLASHING.md`, `VALIDATOR_LIFECYCLE.md`, `STATE_SYNC.md`, `CHAIN_HALT.md`, `NETWORK_PROTOCOL.md`.

**Crates owned:** `consensus`, `net`, `dkg`, `slashing`, `node`.

#### γ.1 `consensus` crate `[SEQ within γ]` — foundational
- [x] `Vertex` structure (round, member_id, parent_refs, batch_refs, state_root_sigs, prev_anchor_attestation, decryption_shares, sig) — landed in `types` crate at MC-0
- [x] Local DAG view per validator (`VertexStore`: hash + round + slot indexes, equivocation-aware, `parking_lot::RwLock` guarded) — PR [#1](https://github.com/pyde-net/engine/pull/1)
- [x] Canonical `vertex_hash = Blake3(borsh(vertex_sans_falcon_sig))` centralised — PR [#1](https://github.com/pyde-net/engine/pull/1)
- [x] Equivocation flagging on insert (`InsertOutcome::Equivocation { prior_at_slot }`; full slashing flow lives in γ.4)
- [x] Vertex production pipeline (`VertexBuilder` + `Signer` trait + `select_parents` helper that skips equivocating slots; returns `(VertexHash, Vertex)` so callers get the dedup key free) — PR [#2](https://github.com/pyde-net/engine/pull/2)
- [x] Vertex validation pipeline (`validate_vertex` + `Verifier` trait + `ValidationConfig`; cheapest-first checks: range → batch-dedup → parent quorum → parent-round homogeneity → FALCON sig; `MissingParent` returns hash so caller can fetch and retry) — PR [#3](https://github.com/pyde-net/engine/pull/3)
- [x] Round advancement (`RoundTracker`: monotonic counter, distinct-`member_id` quorum check, `try_advance` / `try_advance_to_max` for state-sync catch-up, equivocator-resistant via distinct-producer counting) — PR [#9](https://github.com/pyde-net/engine/pull/9)
- [x] Anchor selection: `select_anchor(beacon, round, lookback_state_root, committee_size)` — Blake3 over `beacon || round.le || state_root.blake3`, mod committee. Dual-hash aware (only Blake3 leg mixes in; Poseidon2 reserved for SNARK paths). Uniform at 128 = 2^7 (no rejection sampling needed). — PR [#4](https://github.com/pyde-net/engine/pull/4)
- [ ] VRF beacon derivation (uses pyde-crypto)
- [x] Mysticeti 3-stage support check (`check_anchor_support`: supporters at R+1 + certifiers at R+2; Committed / Pending / Skipped — Skipped prevents stall on bad proposer) — PR [#5](https://github.com/pyde-net/engine/pull/5)
- [x] BFS subdag walk + canonical sort (`walk_subdag`: BFS over parent_vertex_refs, skips already-committed, canonical (round, member_id, hash) order — wire-load-bearing) — PR [#7](https://github.com/pyde-net/engine/pull/7)
- [x] Missing-vertex bookkeeping (`PendingParents` queue: bounded, idempotent-duplicate, cascade-unblock, exposes `missing_parents()` for the network fetch loop). Network-fetch dispatch wired at node-binary level (MC-2). — PR [#10](https://github.com/pyde-net/engine/pull/10)
- [x] Anchor-skip handling: `AnchorSequencer` round-level outcome tracker (Committed / Skipped, idempotent + flip-rejecting); `last_committed_round` + `next_unrecorded_round(from)` for restart resumption; sorted enumeration for telemetry. Orchestrator wiring lands in γ.5. — PR [#37](https://github.com/pyde-net/engine/pull/37)
- [x] Piggybacked decryption shares: `EncryptedTx` + `produce_decryption_shares` (validator-side, FALCON-signs per spec) + `combine_decryption_shares` (commit-side threshold combine) + `verify_decryption_share` (slashing-side) + canonical `share_signature_pre_image`. Built on γ.3.1 `DkgProtocol` trait; tested with `MockDkg`. — PR [#52](https://github.com/pyde-net/engine/pull/52)
- [x] HardFinalityCert generation (`FinalityCertCollector`: cached pre-image, duplicate-before-verify, deterministic member_id-sorted finalize, FinalityError taxonomy) — PR [#8](https://github.com/pyde-net/engine/pull/8)
- [x] WaveCommitRecord assembly (`assemble_wave_commit_record`: canonical anchor_hash, u32 tx_count overflow check, WaveCommitInputs cross-stream boundary) — PR [#7](https://github.com/pyde-net/engine/pull/7)
- [x] Committee selection primitive: Fisher-Yates shuffle keyed off 32-byte beacon; rejection-sampled for bias-free draws; `member_id ↔ FalconPubkey` lookups; rejects insufficient-eligible / duplicate-pubkey inputs. — PR [#33](https://github.com/pyde-net/engine/pull/33)
- [x] `CommitteeRegistry` (epoch → Committee tracking): per-epoch insert/get/latest/known_epochs; rejects duplicate-epoch insertion (consensus diverges if two committees claim the same epoch); `Arc<Committee>` returned for cheap stable refs; `Arc<RwLock<_>>` for concurrent RPC + slashing readers. — PR [#36](https://github.com/pyde-net/engine/pull/36)
- [x] Equivocation detection + evidence collection → γ.4 Slashing — `VertexStore::insert` already detected equivocations and returned `InsertOutcome::Equivocation { prior_at_slot }`; this PR adds the event-channel side. New `EquivocationDetected` struct (member_id, round, new_hash, full new_vertex cloned in, prior_at_slot insertion-order list) emitted via an optional `tokio::sync::mpsc::UnboundedSender` attached through `set_equivocation_sink` / `clear_equivocation_sink`. Default = no sink (existing callers unaffected). Receiver-drop is silently swallowed — equivocation is *stored* regardless; only the notification is lost. Completes the consensus-side half of the loop opened by γ.5.equivocation (the node-side `EquivocationDetector::handle_equivocation` is already wired); a follow-up PR adds the main-loop drain task once a verifier + DKG + epoch + stake oracle is available. — PR [#85](https://github.com/pyde-net/engine/pull/85)
- [x] Implement `ConsensusEngine` trait via `Driver` (composed runtime: `VertexStore` + `RoundTracker` + `PendingParents` + finality history; Arc-shared, fine-grained locks, wave-monotonicity guard, object-safe trait impl) — PR [#11](https://github.com/pyde-net/engine/pull/11)

#### γ.2 `net` crate `[PAR within γ]`
- [x] libp2p + QUIC transport scaffold (libp2p 0.56, TCP+Noise+Yamux fallback + QUIC; `Keypair` newtype with secret-omitting Debug; `Network` host wrapper with `start_listening` + `dial`; dep scoped to the net crate so β/α don't pay the build cost). Behaviour replaced from `dummy` to real protocols in next γ.2 PRs. — PR [#40](https://github.com/pyde-net/engine/pull/40)
- [x] Gossipsub topic constants (`topics::ALL` — vertices, batches, decryption-shares, state-root-sigs, mempool, state-sync, evidence, governance, all `/v1` versioned per NETWORK_PROTOCOL.md), `PeerId` newtype, `NetError` taxonomy. Sets the wire-stable surface ahead of the libp2p transport PR. — PR [#39](https://github.com/pyde-net/engine/pull/39)
- [x] Gossipsub behaviour wired into `PydeBehaviour` (`#[derive(NetworkBehaviour)]`): 1s heartbeat, 4 MiB max-transmit, Strict validation, Signed authenticity. `Network::publish` + `next_event` typed pump (GossipsubMessage / Other), all 8 topics auto-subscribed at startup. — PR [#42](https://github.com/pyde-net/engine/pull/42)
- [x] `identify` protocol — peers exchange listen-address sets + agent versions over every connection (foundation for layered peer discovery). `IDENTIFY_PROTOCOL = /pyde/1.0.0` (wire-stable), `IDENTIFY_AGENT = pyde-engine/<crate-version>`. `NetworkEvent::PeerIdentified { peer, listen_addrs, agent_version, protocol_version }`. — PR [#43](https://github.com/pyde-net/engine/pull/43)
- [x] Layered peer discovery — **seeds + DNS layers shipped**: plain-text bootnodes file (one multiaddr per line; `#` comments; blank lines ignored) parsed by `pyde_engine_net::read_bootnodes` + the libp2p `dns` feature wired through `transport.rs`'s `.with_dns()` so `/dns/seed.pyde.network/...` multiaddrs resolve before dial. `pyde validator --bootnodes <PATH>` merges entries into the dial list; the runtime stays ignorant of where addrs came from. `BootnodesError` carries 1-based line numbers + raw line content for clean diagnostics. — PR [#82](https://github.com/pyde-net/engine/pull/82)
- [ ] Layered peer discovery — on-chain validator registry + PEX cache persisted across restarts (NO DHT). Validator-registry source lands once the registry is gossiped + queryable; PEX cache writes to disk for reconnect-on-restart.
- [ ] Sentry node pattern (committee primaries behind sentry proxies)
- [ ] Peer scoring + multi-layer DDoS protections
- [x] Vertex-fetch protocol: libp2p request-response with CBOR codec on `/pyde/vertex-fetch/1`. `VertexProvider` trait (sync getter from local store) services inbound requests; `Network::request_vertex` issues outbound + tracks in-flight hashes so `VertexFetchResponse` events echo the hash. `VertexFetchFailed` event for retry logic. — PR [#45](https://github.com/pyde-net/engine/pull/45)
- [x] Batch-fetch protocol (`/pyde/batch-fetch/1`) + `BatchProvider` trait, `request_batch` / `BatchFetchResponse` / `BatchFetchFailed`. `Network::new` consolidated to take a `NetworkProviders` bundle so future request-response protocols (decryption-share fetch, state-sync chunks…) extend the bundle instead of the constructor signature. — PR [#47](https://github.com/pyde-net/engine/pull/47)
- [x] PeerId persistence: `Keypair::save_to / load_from / load_or_generate` using libp2p protobuf encoding, atomic write via tmp→rename. PeerId stable across restarts. Threat-model documented (libp2p identity ≠ FALCON consensus key — unencrypted file). Known-peers cache lands in the layered-discovery PR. — PR [#50](https://github.com/pyde-net/engine/pull/50)
- [x] Implement `NetworkView` trait (from `interfaces`): channel-based `NetworkRunner` (owns the swarm) + clone-able `NetworkHandle` (sends commands, implements `NetworkView` for &self async-trait shape) + `NetworkEventStream` (raw event observation). Fetch-waiter coalescing (parallel `fetch_vertex(same_hash)` calls share one peer request), 10s fetch timeout, peer-selection-from-connected (round-robin + scoring later). — PR [#49](https://github.com/pyde-net/engine/pull/49)

#### γ.3 `dkg` crate `[PAR within γ]`
- [x] Type surface + `DkgProtocol` trait + `MockDkg`: `ShareKey` (secret) / `SharePubkey` (public) / `ThresholdKey` (committee-wide) / `DecryptionShareValue` / `Threshold(u32)`. Trait: `partial_decrypt`, `verify_partial`, `combine`. MockDkg gives `Blake3`-based deterministic mock for integration tests + bring-up before pyde-crypto is engine-CI accessible. — PR [#51](https://github.com/pyde-net/engine/pull/51)
- [ ] Production `DkgProtocol` impl wrapping pyde-crypto (blocked on pyde-crypto access for engine CI)
- [ ] Pedersen DKG ceremony orchestration (per-epoch key gen)
- [ ] PSS resharing (proactive secret sharing across epochs)

#### γ.4 `slashing` crate `[PAR within γ] → γ.1`
- [x] Validator state machine types (Registered / Active / Jailed / Unbonding / Withdrawn) with entry-epoch tagging; `occupies_operator_slot` predicate — PR [#28](https://github.com/pyde-net/engine/pull/28)
- [x] Operator-identity binding (`MAX_VALIDATORS_PER_OPERATOR = 3` cap; `MIN_STAKE_QUANTA = 10_000`; duplicate-pubkey rejection) — PR [#28](https://github.com/pyde-net/engine/pull/28)
- [x] `register` validator op — PR [#28](https://github.com/pyde-net/engine/pull/28)
- [x] `unbond` validator op (Registered/Active/Jailed → Unbonding; `UNBONDING_PERIOD_EPOCHS = 7`; slot held during window) — PR [#29](https://github.com/pyde-net/engine/pull/29)
- [x] `withdraw` validator op (Unbonding → Withdrawn after period elapses; returns stake; releases operator slot for re-registration) — PR [#29](https://github.com/pyde-net/engine/pull/29)
- [x] `rotate_key` validator op (operational key rotation; allowed from any non-Withdrawn state, including Jailed for compromised-HSM recovery; registry-consistent on rejection) — PR [#30](https://github.com/pyde-net/engine/pull/30)
- [x] `unjail` validator op (Jailed → Registered; caller gates on `Slasher::is_jailed` for jail-expiration so the registry stays decoupled from slasher internals) — PR [#30](https://github.com/pyde-net/engine/pull/30)
- [ ] Synced-only committee enforcement
- [x] 9-offense catalog (Equivocation + 4 Safety + 4 Liveness) per [`SLASHING.md`](companion/SLASHING.md) — `Offense` enum + `OffenseSpec` + `Distribution` (SAFETY_DEFAULT 50/30/20, ALL_BURN) — PR [#21](https://github.com/pyde-net/engine/pull/21)
- [x] Slash math: correlation multiplier (capped 2×) + repeat escalation (powers of 2) + exact burn-takes-remainder distribution sum — `compute_slash_amount` — PR [#21](https://github.com/pyde-net/engine/pull/21)
- [x] Evidence types: `Evidence` + `EvidencePayload` taxonomy + cross-validation; Equivocation verified cryptographically (slot match + distinct hashes + paired FALCON sigs) — PR [#22](https://github.com/pyde-net/engine/pull/22)
- [x] `Slasher` state machine: per-(epoch, accused, offense_type) repeat counters, per-(epoch, class) correlation counting excluding self, jail extends never shortens, strict `>` expiration — PR [#23](https://github.com/pyde-net/engine/pull/23)
- [x] Slashing escrow (24h dispute window): bonded → slashed_frozen → slashed_finalized with governance void/reduce hooks during the window, idempotent maturation — PR [#24](https://github.com/pyde-net/engine/pull/24)
- [x] New-validator grace period (50% reduction in first epoch; sum invariant preserved) — PR [#24](https://github.com/pyde-net/engine/pull/24)
- [x] InvalidVertexStructure evidence verification: `StructuralViolation` enum (`duplicate-batch-refs`, `insufficient-parent-quorum`) with stable kebab-case codes; producer's FALCON sig + envelope match + reason cross-check — PR [#25](https://github.com/pyde-net/engine/pull/25)
- [x] BadStateRootSignature evidence verification: `consensus::state_root_sig_pre_image` (canonical FALCON pre-image per Ch 6 §12); two contradictory roots, both sigs verify under accused's pubkey — PR [#26](https://github.com/pyde-net/engine/pull/26)
- [x] BadAnchorAttestation evidence verification (self-contained `honest_majority: Vec<Vertex>` payload; 85+ distinct-member witnesses must agree on a different prior anchor; ~290 KiB per evidence under 4 MiB gossipsub cap) — PR [#27](https://github.com/pyde-net/engine/pull/27)
- [x] BadDecryptionShare evidence verification: self-contained payload (`share`, `ciphertext`, `share_pubkey`); `verify_evidence` gains `&dyn DkgProtocol` parameter; checks signer match → FALCON sig over `share_signature_pre_image` → `verify_decryption_share` returns false. Caller pre-validates `share_pubkey` against chain state. **Safety-offense evidence catalog is now complete.** — PR [#53](https://github.com/pyde-net/engine/pull/53)
- [x] Evidence-to-escrow pipeline: `process_evidence(evidence, stake, verifier, slasher, escrow) → ProcessOutcome` — verify → slash → escrow in one call, plus convenience builders for the three verified Safety payloads + `preview_slash` for RPC dry-runs. Resolution of `InsertOutcome::Equivocation` → Vertex stays in node binary (γ.5) — slashing doesn't observe consensus state directly. — PR [#32](https://github.com/pyde-net/engine/pull/32)
- [ ] Persistence: Slasher + Escrow to RocksDB (lands at MC-2 alongside state-crate integration)
- [x] Reward distribution math: `distribute_rewards(pool, entries)` pure function (pool × stake × uptime, sum-invariant bit-exact, u128-overflow-safe fallback, 6-decimal `UPTIME_PRECISION`) — PR [#31](https://github.com/pyde-net/engine/pull/31)
- [ ] Reward distribution wiring: `UptimeTracker` from consensus attestation events + `RewardPool` epoch-accumulator (depends on γ.1 attestation surface)

#### γ.5 `node` crate `[SEQ within γ] → γ.1 + γ.2 + γ.4` — owned by γ; integration point
- [x] `EquivocationDetector` — node-level wiring between consensus's `InsertOutcome::Equivocation` and slashing's `process_evidence`. Composes Arc'd `VertexStore` + `Slasher` + `Escrow`; `handle_equivocation` looks up the prior, builds Evidence, runs the slash pipeline. Closes the resolution side noted in slashing.12. — PR [#56](https://github.com/pyde-net/engine/pull/56)
- [x] `ValidatorRuntime` composition: holds disk-backed libp2p `Keypair` + Arc'd `VertexStore` + `Slasher` + `Escrow` + `ValidatorRegistry` + `EquivocationDetector` + `NetworkHandle`. `ValidatorRuntime::build(config)` returns `{ runtime, network_runner, network_events }` so caller controls tokio spawn; main loop consumes the event stream + uses the runtime. Foundation for the validator binary. — PR [#58](https://github.com/pyde-net/engine/pull/58)
- [x] `ConsensusVertexProvider` + `BatchCache` + `BatchCacheProvider`: adapters that satisfy `pyde_engine_net::VertexProvider` / `BatchProvider` from `Arc<VertexStore>` + an in-memory `Arc<BatchCache>`. `ValidatorRuntime::build` wires real providers through `NetworkProviders` instead of the `new_null` placeholder; inbound vertex-fetch / batch-fetch requests now answer out of the runtime's authoritative storage. — PR [#60](https://github.com/pyde-net/engine/pull/60)
- [x] `ValidatorMainLoop` + `dispatch()` + `MainLoopMetrics`: long-running tokio task that drains `NetworkEventStream` into the runtime's `VertexStore` + `BatchCache`. Routes vertices (gossip + fetch responses → `VertexStore::insert`, counting `New` / `Duplicate` / `Equivocation`) and batches (gossip → cache by decoded hash; fetch response → cache by requested hash). 10 atomic counters surfaced via `MainLoopMetrics`. `tokio::select!` biased on a `watch::Receiver<bool>` shutdown signal. `NetworkEventStream::channel()` constructor added so tests drive the loop without a real libp2p swarm. Equivocation evidence dispatch deferred to follow-up (needs committee/DKG/stake oracle). — PR [#63](https://github.com/pyde-net/engine/pull/63)
- [x] `VertexProducer` solo-validator task — the chain's heartbeat. tokio task that ticks at a configurable interval (default 250 ms, `--producer-tick-ms <MS>`; `0`/omit = disabled), builds a fresh signed `Vertex` for the local validator's slot via `pyde_engine_consensus::VertexBuilder` + `select_parents`, FALCON-signs via the runtime's `FalconKeypair`, inserts into local `VertexStore`, publishes on `pyde/vertices/1`. `tokio::interval` with `MissedTickBehavior::Skip` so paused validators don't burst; `tokio::select!` biased on shutdown. Publish failures (no peers) bump a counter and the task keeps ticking. 2 new `MainLoopMetrics` counters (`vertices_produced`, `vertex_publish_failures`). End-to-end verified: `pyde validator --producer-tick-ms 100 …` produces ~10 vertices/sec observable via `pyde_getMetrics`. Anchor selection + wave-commit walking + threshold decryption + DKG + committee rotation all land in follow-ups. — PR [#93](https://github.com/pyde-net/engine/pull/93)
- [x] `WaveCommitter` task — **the chain commits + replicates**. tokio task that ticks at a configurable interval (default 125 ms, `--committer-tick-ms <MS>`; `0`/omit = disabled), scans the local `VertexStore` for new anchor rounds, walks the causal sub-DAG via `pyde_engine_consensus::walk_subdag`, calls `assemble_wave_commit_record` with empty β-side inputs (state_root, events, included_txs all empty for now — `StateMutator::commit_wave` populates these once β.3 ships), and persists via `consensus_store.put_wave`. `pick_anchor` selects the deterministic anchor for the round — among honest slots (single vertex per `(round, member_id)`), the lowest `member_id` wins; equivocating slots are skipped. `committed: HashSet<VertexHash>` excludes prior-wave ancestors from each new walk; `prior_anchor_round` threads through correctly. Transient missing-anchor (peer vertex still propagating) waits for the next tick without advancing state; hard failures (assemble overflow, store IO) advance to avoid spinning. 3 new `MainLoopMetrics` counters (`wave_commit_attempts`, `waves_committed`, `wave_commit_failures`). End-to-end verified solo (PR [#97](https://github.com/pyde-net/engine/pull/97)): `pyde validator --producer-tick-ms 100 --committer-tick-ms 50` produced 13 vertices + committed 12 waves in 2s with 0 failures; `pyde_getWave(0..N)` returns real `WaveCommitRecord`s. Multi-validator (PR [#100](https://github.com/pyde-net/engine/pull/100)): `--validator-id <N>` (default 0; range `[0, 128)` enforced) threads through to `VertexProducerConfig::member_id`; two `pyde validator` instances with distinct ids that dial each other share a DAG and commit identical wave records (deterministic anchor selection makes both sides agree without VRF). VRF anchor selection + N/3+1 quorum vote threshold + skip rules + sentry pattern land in follow-ups.
- [x] `pyde` binary — validator mode shipped: `pyde validator --keypair <path> [--listen <addr>]… [--dial <addr>]… [--dispute-window-epochs N]` builds a `ValidatorRuntime`, spawns the libp2p runner + `ValidatorMainLoop`, waits for Ctrl+C, drains, exits. `run_validator(config, shutdown: F)` takes the shutdown future as a parameter so tests drive the lifecycle without installing a real signal handler. Prints a stable post-shutdown summary (PeerId hex, listen/dial addrs, all 10 mainloop counters). Full-node + light-client modes wire in later. — PR [#67](https://github.com/pyde-net/engine/pull/67)
- [x] JSON-RPC server (per `HOST_FN_ABI_SPEC §15.4-15.5` + chapter 17 method list) — **scaffold + five read methods shipped**: spec-compliant JSON-RPC 2.0 dispatcher over axum 0.7 (single + batch, notifications excluded from responses, five standard error codes, HTTP 204 for all-notification batches), `RpcContext` with peer_id / falcon_pubkey / listen_addrs / agent_version (`pyde/<CARGO_PKG_VERSION>`) / protocol_version (`pyde/1`) / `Arc<MainLoopMetrics>` / `Arc<ConsensusStore>`, `bind_rpc_server` returns resolved `SocketAddr` synchronously so port-conflicts surface immediately, graceful shutdown via `watch::Receiver<bool>`. Wired into `pyde validator --rpc-listen <addr>` (optional; default disabled — no auth in v1). Methods: identity/telemetry — `pyde_getNodeInfo` + `pyde_getMetrics` (PR [#73](https://github.com/pyde-net/engine/pull/73)); persistent-store reads — `pyde_getReceipt(hash)` + `pyde_getTx(hash)` + `pyde_getWave(wave_id)` (PR [#79](https://github.com/pyde-net/engine/pull/79); hex hash params with or without `0x` prefix; misses return `null`; raw serde wire format until chapter 17 finalises). The remaining chapter-17 method set (`pyde_call`, `pyde_sendRawTransaction`, `pyde_getLogs`, etc.) lands in follow-up PRs as state + execution layers wire up.
- [x] `consensus_store` with `WriteOptions::set_sync(true)` (per Ch 16 §16.12) — **storage skeleton shipped**: `ConsensusStore` wraps `Arc<rocksdb::DB>` (cheap clone, thread-safe), opens three column families on first run (`receipts_cf` TxHash → Receipt, `txs_cf` TxHash → Tx, `waves_cf` WaveId BE → WaveCommitRecord — BE keys so iter ordering matches numeric order for future range scans). Every write builds a fresh `WriteOptions { sync: true }` so callers never accidentally share a non-sync handle. Typed helpers per CF + `highest_wave_id` (reverse iterator) + `flush`. `ConsensusStoreError` taxonomy (RocksDb / Decode / Encode / MissingColumnFamily). Wired into `ValidatorRuntime` + `pyde validator --consensus-store-path <dir>`. Main-loop write-through lands in a follow-up once the execution layer hands us wave-commit records. — PR [#76](https://github.com/pyde-net/engine/pull/76)
- [ ] `panic = "abort"` on persist failure
- [x] Validator role — FALCON-512 keypair management: `FalconKeypair` (disk-backed, atomic tmp→rename persistence, integrity-checked on load via re-derived pubkey, secret redacted in Debug). `impl Signer` for direct use in vertex production. Borsh-encoded `FalconKeypairFile` with `version: u8` so swapping in real `pyde-crypto` FALCON-512 bumps the version. v1 ships a deterministic mock that matches `MockSigner`'s Blake3-extension pattern; production crypto swaps in when `pyde-crypto` ships. Wired into `ValidatorRuntime` + `pyde validator --falcon-keypair <path>`. — PR [#70](https://github.com/pyde-net/engine/pull/70)
- [ ] Validator role — attestation + key rotation (depends on production `pyde-crypto` FALCON-512)
- [x] Persistence — **txs_cf write-through shipped**: validator main loop routes `pyde/mempool/1` gossip to `consensus_store.put_tx(canonical_tx_hash(tx), tx)`. New `pyde-engine-tx::canonical_tx_hash` ships ahead of β.3 — `TxHash = Blake3(canonical_pre_image(tx))` per Ch 11 §11.6, same bytes the producer FALCON-signs (β.3 will adopt the same function for mempool admission, receipt indexing, execution-side lookups, so the keys remain interoperable). 4 new `MainLoopMetrics` counters (received / persisted / decode-failures / persist-failures). Operator can now publish a tx on gossip and read it back via `pyde_getTx(hash)`. — PR [#88](https://github.com/pyde-net/engine/pull/88)
- [ ] Persistence — receipts_cf + waves_cf write-through (lands when execution layer commits waves)

**γ BAR:** `cargo test` clean on `consensus-side` branch; consensus loop runs end-to-end with `MockStateView` + `MockMempool` + `MockNetwork`; vertex production + anchor selection + commit work in isolation.

---

## MC-2 — INTEGRATION `[SEQ] → MC-1 all streams` — γ-owned

Merge `execution-side` and `consensus-side` branches to `main`. Bring up a local devnet.

### MC-2 spike ✅ shipped (precedes full MC-2)

A **single-validator** devnet running the real consensus driver end-to-end with stubbed crypto / network / persistence. The "Pyde transfers value, today" demonstration — real Mysticeti 3-stage commit, real BFS subdag walk, real `WaveCommitRecord` assembly, real `HardFinalityCert` collection, for a real transfer transaction.

- [x] `DevnetState` — `StateMutator` impl with real transfer + fee + nonce-window logic — PR [#15](https://github.com/pyde-net/engine/pull/15)
- [x] `DevnetExecutor` — pure pre-flight `Executor` impl — PR [#16](https://github.com/pyde-net/engine/pull/16)
- [x] `Devnet` composer + `Wallet` — full single-validator commit loop — PR [#17](https://github.com/pyde-net/engine/pull/17)
- [x] `run_smoke` scenario + 8 integration tests — PR [#18](https://github.com/pyde-net/engine/pull/18)
- [x] `pyde devnet --smoke` CLI subcommand — PR [#19](https://github.com/pyde-net/engine/pull/19)
- [x] README "Try the demo" + bench baseline link — PR [#20](https://github.com/pyde-net/engine/pull/20)

Reproduce: `cargo run --bin pyde -- devnet --smoke`. Full bench baseline: [`crates/consensus/benches/baseline.md`](https://github.com/pyde-net/engine/blob/main/crates/consensus/benches/baseline.md).

### Full MC-2 (ahead — needs real β + real γ libs wired)

- [ ] Final merges of β and γ to `main` (γ owns this)
- [ ] Local devnet config (4-7 validators on a single machine, real libp2p networking)
- [ ] End-to-end test flow with real crypto + real persistence + real WASM:
  - Author writes contract (with α's otigen)
  - `otigen deploy` against the devnet
  - Tx submitted, validated by mempool (β), included in vertex (γ)
  - Anchor commits, wasmtime executes (β), state updates (β)
  - HardFinalityCert formed (γ), receipt queryable via RPC
  - Event subscription pushes notifications
- [ ] Smoke tests: simple transfer, contract deploy, view call, cross-contract call, event emission, event subscription

**MC-2 BAR:** local devnet running with sub-second commits and successful end-to-end tx flow. Three smoke contracts deploy and operate correctly. All MC-1 deliverables integrated.

---

## MC-3 — STATE SYNC + PARACHAIN ACTIVATION `[SEQ] → MC-2` — β + γ joint

### 3.1 State sync (γ-led, β co-owns snapshot generation)

- [ ] Snapshot generation (background on archive nodes + volunteer-served)
  - Walk JMT at target wave version
  - Chunk into ~50MB pieces with range proofs
  - Persist chunks; publish SnapshotManifest
- [ ] `pyde_getSnapshotManifest` RPC handler
- [ ] Snapshot chunk serving over libp2p streams (parallel from multiple peers)
- [ ] Weak-subjectivity checkpoint format (wave_id + dual state_roots + committee threshold sig)
- [ ] WS checkpoint distribution
- [ ] New-validator sync flow (download manifest, parallel chunk fetch, verify, write, replay tail)
- [ ] Sync time target (~40 min for fresh sync)
- [ ] Three-tier node model: archive / pruned / light client

### 3.2 Parachain framework activation (β + γ joint)

- [ ] Parachain account structure (versions, balance, config, state_root, owner deposit, status)
- [ ] Parachain ID derivation (`Poseidon2("pyde-parachain:" || name)`)
- [ ] Deploy flow (owner deposit, WASM validation, registry write)
- [ ] Upgrade flow (proposal, equal-power voting, scheduled activation)
- [ ] Pause / kill (operational lifecycle)
- [ ] State subtree partitioning (`parachain_id[..16]` PIP-2 prefix)
- [ ] Cross-parachain messaging (rate-limited, threshold-signed; γ networking; β host fn)
- [ ] `cross_call` callback mechanism (success / error / timeout flows)
- [ ] Version manifest in wave-commit records (replay correctness)
- [ ] Reference parachains: price-feed oracle + confidential-vote parachain

**MC-3 BAR:** fresh validator can sync to current head in under 1 hour and become committee-eligible. An author deploys a parachain; validators opt in; cross_call from a smart contract to the parachain works with a callback returning a result.

---

## MC-4 — PERFORMANCE + FAILURE HANDLING `[PAR within] → MC-2 + MC-3`

### 4.1 Performance harness

Spec: [`PERFORMANCE_HARNESS.md`](companion/PERFORMANCE_HARNESS.md).

- [ ] Workload generators (compute / IO / crypto / mixed-realistic)
- [ ] Multi-region topology framework (US-East, EU-West, AP-Southeast)
- [ ] Chaos scenarios (validator drops, network partitions, slow disks, equivocating actors)
- [ ] Soak-test scheduler (1h / 4h / 24h / 7-day)
- [ ] Metrics: TPS, p50/p99/p999 latency, memory, CPU breakdown, gas accounting
- [ ] "Claim 1/3 of measured peak" publication discipline
- [ ] Per-host-function micro-benchmarks (calibrate gas cost table against real hardware)
- [ ] Sequential vs parallel execution scaling tests

### 4.2 Failure handling drills

Spec: [`FAILURE_SCENARIOS.md`](companion/FAILURE_SCENARIOS.md) + [`CHAIN_HALT.md`](companion/CHAIN_HALT.md).

- [ ] Walk through all 12 catalogued failure scenarios in a testnet
- [ ] Soft-stall / hard-halt / emergency-pause drills
- [ ] 1-epoch bounded rollback drill
- [ ] Validator key compromise + rotation drill

**MC-4 BAR:** performance numbers published per the harness discipline; failure-handling runbooks battle-tested in a controlled environment.

---

## MC-5 — VALIDATION + MAINNET LAUNCH `[SEQ] → MC-4`

Spec: Chapter 19 (Launch Strategy).

### 5.1 External audits (5 specialist tracks)

- [ ] Consensus layer (Mysticeti DAG, anchor selection, finality, slashing)
- [ ] WASM execution layer (host functions, fuel-to-gas, validation gate, hybrid scheduler)
- [ ] Cryptography (FALCON, Kyber, Blake3, Poseidon2, threshold, PSS) — `pyde-crypto`
- [ ] Networking (libp2p config, gossipsub, peer discovery, sentry pattern, DDoS)
- [ ] `otigen` toolchain (codegen, ABI extraction, deploy flow, wallet)

### 5.2 Incentivized testnet

- [ ] Reference dApps: DEX, lending market, NFT marketplace
- [ ] Funded bug bounty at mainnet tier
- [ ] Multi-month soak with real user traffic
- [ ] Remediate community-found issues before launch

### 5.3 Mainnet candidate

- [ ] Final genesis configuration
- [ ] Initial validator set (≥32 validators, geographically distributed)
- [ ] Day-one ecosystem partners (≥3-5 parachains/dApps)
- [ ] Token distribution finalized
- [ ] Bug bounty scaled to mainnet tier
- [ ] Mainnet launch

**MC-5 BAR:** mainnet live. All MC-0 through MC-4 work integrated, audited, stress-tested, soak-passed.

---

## Beyond V1 `[PAR]` — post-mainnet research/dev directions

- ZK-aggregated FALCON signatures (the path to dramatic signature-verification throughput gains)
- zk-WASM proven execution
- Cross-chain bridges (Ethereum, Bitcoin, others) with proven-security mechanisms
- **Programmable accounts + native session keys** — scoped, bounded, revocable dApp delegation. Native at the protocol (vs Ethereum's ERC-4337 retrofit). See Chapter 11 *Session keys (v2)* and `companion/DESIGN.md` for the design + v1 reservations the surfaces depend on.
- State-expiration policy
- Tier 2/3 wallet preview (heuristics + LLM analysis) per [[ai-wallet-preview-direction]]

### V1 reservations that create room for v2 features

V1 ships *interfaces*; v2 ships *implementations*. Discipline: don't reach into v2 while v1 is shipping, but reserve the protocol surfaces v2 needs so contracts written today survive the upgrade unchanged.

| v2 feature | v1 reservation | Cost at v1 |
| --- | --- | --- |
| Programmable accounts | `AuthKeys::Programmable` enum tag `0x03` | Enum variant, unused — ~zero |
| Programmable accounts | Account `code_hash` + `storage_root` (unified with contracts) | Already shipped (account/contract account shape unified) |
| Session keys | WASM "policy mode" execution flag | Reserved-but-not-implemented — ~zero |
| Session keys | Multisig signature pipeline | Already shipped (serves multisig + future session-key flows) |
| ZK light clients | Poseidon2 state root + ZK-friendly primitives | Already shipped (dual-hash JMT, no Blake3 in proof-bearing paths) |
| Parachains (further depth) | `cross_call` host fn, `HardFinalityCert` primitive, async callback slots | Already shipped (Chapter 13, `companion/PARACHAIN_DESIGN.md`) |

The discipline: every entry above is something the v1 protocol can ship for ~zero marginal cost, but skipping any one of them would force a hard-fork rewrite when v2 lands. Reserving them now is cheap insurance.

---

## End-to-end flow: user → execution → user

For context on what all this protocol work enables, here's the full E2E flow once all chunks are landed:

```text
1. USER: opens wallet, builds tx (function call, args, gas budget)
2. WALLET: runs local wasmtime preview → shows state changes, gas estimate, events
3. USER: reviews preview, signs (FALCON-512)
4. WALLET: optionally encrypts under committee threshold key (Kyber-768)
5. WALLET → RPC: pyde_sendRawTransaction(signed_tx)
6. RPC: validates ingress (sig, balance, nonce, gas, chain_id)
7. RPC → MEMPOOL WORKER: forwards via libp2p
8. WORKER: adds to pending batch
9. WORKER: seals batch, gossipps to other workers, collects ≥85 certifications
10. WORKER → PRIMARY: certified batch_hash available for inclusion
11. PRIMARY: produces vertex with batch_hash in batch_refs (+ decryption shares if applicable)
12. VERTEX: gossipped via libp2p/gossipsub on pyde/vertices/1 topic
13. DAG: grows; each round adds 128 vertices
14. ANCHOR: deterministically selected via Hash(beacon, round, prev_root) mod 128
15. SUPPORT: round R+2's 85+ vertices transitively reference anchor → 3-stage support
16. COMMIT: subdag walk (BFS-for-set + canonical sort)
17. DECRYPT: batch threshold-decrypt all encrypted txs in subdag (shares already piggybacked)
18. SCHEDULE: hybrid scheduler (static access + Block-STM) partitions for parallel execution
19. EXECUTE: wasmtime runs each tx (per-tx overlays for isolation; success → merge, trap → discard)
20. STATE: changes accumulate in DashMap → JMT update → new state_root
21. SIGN: committee FALCON-signs (wave_id, blake3_root, poseidon2_root)
22. PERSIST: WaveCommitRecord synchronously to disk; vertices/batches/receipts lazily
23. FINALITY: 85+ sigs collected → HardFinalityCert formed
24. USER ← RPC: pyde_getTransactionReceipt(tx_hash) returns success/revert + state changes + gas used
25. USER: sees confirmation in wallet UI

Total wall-clock from step 5 (submit) to step 25 (confirmation visible): ~500ms-1s under normal conditions.
```

Each step maps to specific chunks in the roadmap. The full path traverses MC-2 (consensus, execution, state, crypto, network, accounts, slashing) end-to-end, with MC-3 (otigen, SDKs, wallet) at the boundaries.

---

## Stream dependency matrix (cross-MC view)

| Item | Owning stream | Depends on | Used by |
|------|---------------|------------|---------|
| MC-0 Interface foundation | main session | (none) | All MC-1 streams |
| MC-1 α Toolchain | α | MC-0 + `HOST_FN_ABI_SPEC` | Contract authors; MC-2 deploy testing |
| MC-1 β.1 State | β | MC-0 | β.4 (wasm-exec); γ.1 (consensus reads state_root); MC-3 state sync |
| MC-1 β.2 Account | β | MC-0 + `pyde-crypto` | β.3 (tx sender validation); β.4 (host context); γ.4 (validator txs) |
| MC-1 β.3 Tx | β | MC-0 + β.2 + `pyde-crypto` | β.4 (tx dispatch); β.5 (mempool); γ (consensus orderable items) |
| MC-1 β.4 WASM Execution | β | MC-0 + β.1 + β.2 + β.3 | MC-1 α (`pyde.abi` consumers); γ (consensus invokes via `Executor`); MC-3 parachain runtime |
| MC-1 β.5 Mempool | β | MC-0 + β.3 | γ.1 (reads via `MempoolView`); γ.2 (gossip submission) |
| MC-1 γ.1 Consensus | γ | MC-0 + `pyde-crypto` | γ.5 (node binary drives consensus); MC-2 integration |
| MC-1 γ.2 Net | γ | MC-0 | γ.1 (gossip transport); β.5 (tx propagation) |
| MC-1 γ.3 DKG | γ | MC-0 + `pyde-crypto` | γ.1 (threshold decryption keys); β.4 (threshold_encrypt/decrypt) |
| MC-1 γ.4 Slashing + Validator Lifecycle | γ | MC-0 + γ.1 + β.3 | γ.5 (RPC validator endpoints); consensus integrity |
| MC-1 γ.5 Node binary | γ | All β + γ crates via traits | The deployable artifact |
| MC-2 Integration | γ-led | All MC-1 streams done | Devnet & all of MC-3-5 |
| MC-3 State Sync + Parachain | β + γ joint | MC-2 | New validators (sync); parachain authors |
| MC-4 Performance + Failure | shared | MC-2 + MC-3 functional | Mainnet readiness |
| MC-5 Validation + Launch | main | All preceding | Mainnet live |

---

## Operating principle

The bias of this roadmap is **honesty over optimism**. No chunk ships before its bar is met. No item is checked off until the work behind it is actually done. If something turns out to be wrong, it gets honestly rewritten — including this roadmap.

The work is the work. It ships when it is ready.
