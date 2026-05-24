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
- [ ] `otigen console` REPL (spec §3.8)

#### α.qual — Quality bar (production-readiness gate)

Every item below clears before α ships. Documented separately from the feature surface so the gate is unambiguous.

**Testing infrastructure**

- [x] Criterion benchmarks for every hot path with baselines committed to `benches/baseline/*.json`:
  - `otigen-toml`: TOML parse + cross-cutting validation ✅ (pyde-net/otigen#6)
  - `otigen-abi`: `ContractAbi` build, Borsh encode/decode round-trip, `pyde.abi` custom-section inject + extract, validators, full pipeline ✅ (pyde-net/otigen#6)
  - `otigen-cli`: full `otigen build` pipeline end-to-end — measured via the otigen-abi full_pipeline bench (parse→validate→build→encode→inject = 14.5 µs on the reference machine); the wall-clock `otigen build` invocation is dominated by file I/O, not validator work
- [ ] `cargo-fuzz` targets with 24h+ cumulative run before α release:
  - `otigen-toml` parser (malformed input, deep nesting, huge fields)
  - `otigen-abi` WASM validator (malformed binaries, edge cases in section structure)
  - `otigen-abi` custom-section injection (extreme WASM module shapes)
- [ ] Property-test coverage audit: ≥15 proptest groups across `otigen-toml` and `otigen-abi` (currently ~5)
- [ ] Adversarial corpus: 30+ hand-rolled `otigen.toml` files under `tests/corpus/` each verified to pass / fail with the expected diagnostic
- [ ] Reproducibility test: two clean builds of the canonical hello-rust example produce byte-identical `contract.wasm` and `abi.json` (modulo `manifest.build_timestamp`)

**CI + supply chain**

- [ ] Multi-platform CI matrix: `ubuntu-latest` x86_64 + aarch64, `macos-latest` arm64, `windows-latest` x86_64 — build / test / clippy / fmt on every PR
- [ ] `cargo-audit` (RustSec advisories) gate on every PR
- [ ] `cargo-deny` (license policy + version policy + duplicate-version checks) gate on every PR
- [ ] `cargo-machete` (unused dep detection) on every PR
- [ ] MSRV check: workspace `rust-version = "1.75"` enforced in CI on a 1.75 toolchain
- [ ] cargo-about generated 3rd-party attribution report shipped with every binary release
- [ ] Signed binary releases via GitHub Actions: Linux x86_64/aarch64 + macOS arm64 + Windows x86_64 tarballs, sha256sums, sigstore signatures, attached to GitHub Releases

**UX completeness**

- [ ] `--json` NDJSON output wired across every subcommand per OTIGEN_BINARY_SPEC §10.2 (today only the global flag is parsed; per-event JSON output not yet emitted)
- [ ] `--verbose` / `-vv` actually emits the documented log levels (today the flag is captured but most commands print fixed output)
- [ ] Signal handling: `Ctrl-C` mid-build cleans up partial bundle artifacts
- [ ] `otigen --version` includes git-sha + build profile

**Spec + documentation**

- [x] Toolchain threat model document at `companion/TOOLCHAIN_THREAT_MODEL.md`: 12 threat IDs (T-01 to T-12) covering malicious `otigen.toml`, malicious WASM, `pyde.abi` injection corruption, substituted `.wasm`, RPC MITM, keystore tampering, phished password, supply-chain attacks, dependency confusion, build-time code execution, path traversal, tx replay. Coverage table cross-references the roadmap items where each gap is tracked.
- [x] Performance numbers committed in `README.md`, Chapter 5 (otigen-toolchain), Chapter 17 (developer tools); baselines on a documented reference machine + how to reproduce ✅ (README in pyde-net/otigen#6; Chapters 5 §5.11 + 17 §17.1 in this PR)
- [ ] Architecture chapter (`chapters/05-otigen-toolchain.md`) cross-links every public function in the implementation to the spec section it satisfies
- [ ] No new `unsafe` blocks anywhere in the workspace (verified by grep + CI)
- [ ] No `unwrap()` / `expect()` on untrusted-input paths (verified manually + by lint where possible)

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
- [ ] JMT dual-hash (Blake3 + Poseidon2 per node)
- [ ] Two-table architecture: `state_cf` (flat `slot_hash → value`) + `jmt_cf` (versioned tree)
- [ ] PIP-2 clustered slot keys (contract-prefix layout)
- [ ] PIP-3 wave-level state prefetch (MultiGet against access lists)
- [ ] PIP-4 write-back cache (DashMap + warm window + lazy flush)
- [ ] events_cf + events_by_topic_cf + events_by_contract_cf (per `HOST_FN_ABI_SPEC §15.3`)
- [ ] Atomic wave-commit WriteBatch (state + events + wave commit record in one transaction)
- [ ] events_root (Blake3 binary Merkle) + events_bloom (256-byte, 3-hash) computation
- [ ] Implement `StateView` + `StateMutator` traits (from `interfaces`)
- [ ] Snapshot generation (range-proof chunks, manifest)

#### β.2 `account` crate `[PAR within β]`
- [ ] 32-byte address derivation (`Poseidon2(falcon_pubkey)`)
- [ ] `AuthKeys` enum with `Single`, `MultiSig`, `Programmable` (Programmable v2-reserved)
- [ ] 16-slot nonce window
- [ ] Name registry as a system contract (ENS-style, unique names)

#### β.3 `tx` crate `[PAR within β]`
- [ ] Native tx types: `Transfer`, `ValidatorRegister`, `Stake`, `Unstake`, `NameRegister`, `Multisig`, `RotateKeys`
- [ ] WASM tx types: `ContractCall`, `ContractDeploy`
- [ ] Canonical tx hashing (Blake3 over deterministic encoding)
- [ ] Gas accounting (EIP-1559 base fee; no refunds per `gas-no-refund-v1` memory)
- [ ] Deploy / upgrade / lifecycle handlers (per `OTIGEN_BINARY_SPEC §8`)

#### β.4 `wasm-exec` crate `[SEQ within β] → β.1`
- [ ] wasmtime engine config (deterministic feature subset per Ch 3 §3.2)
- [ ] `WasmExecutor` type
- [ ] Module cache: LRU + max-size (1 GB default) + TTL (8 epochs default) (per `HOST_FN_ABI_SPEC §3.6`)
- [ ] Fuel-to-gas mapping (calibrated from spec §10 gas table)
- [ ] Per-tx overlay execution model (snapshot-and-rollback; nested for cross-call)
- [ ] Host functions — each independent task:
  - [ ] Storage: `sload`, `sstore`, `sdelete` (with access-list enforcement)
  - [ ] Balances: `balance`, `transfer`
  - [ ] Context: `caller`, `origin`, `self_address`, `block_height`, `wave_id`, `block_timestamp`, `chain_id`
  - [ ] Tx context: `tx_hash`, `tx_value`, `tx_gas_remaining`, `calldata_size`, `calldata_copy`
  - [ ] Events: `emit_event` (multi-topic; 1-4 topics; spec §7.5)
  - [ ] Hashing: `hash_blake3`, `hash_poseidon2`, `hash_keccak256`
  - [ ] Crypto: `falcon_verify`
  - [ ] Cross-call: `cross_call`, `cross_call_static` (FREE; bounded by `VIEW_FUEL_CAP`), `delegate_call`
  - [ ] Halt: `return`, `revert`
  - [ ] Gas: `consume_gas`
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
- [ ] Anchor-skip handling
- [ ] Piggybacked decryption shares (pipeline decryption with consensus)
- [x] HardFinalityCert generation (`FinalityCertCollector`: cached pre-image, duplicate-before-verify, deterministic member_id-sorted finalize, FinalityError taxonomy) — PR [#8](https://github.com/pyde-net/engine/pull/8)
- [x] WaveCommitRecord assembly (`assemble_wave_commit_record`: canonical anchor_hash, u32 tx_count overflow check, WaveCommitInputs cross-stream boundary) — PR [#7](https://github.com/pyde-net/engine/pull/7)
- [ ] Committee management (epoch-bounded; uniform random from eligible stakers)
- [ ] Equivocation detection + evidence collection → γ.4 Slashing
- [x] Implement `ConsensusEngine` trait via `Driver` (composed runtime: `VertexStore` + `RoundTracker` + `PendingParents` + finality history; Arc-shared, fine-grained locks, wave-monotonicity guard, object-safe trait impl) — PR [#11](https://github.com/pyde-net/engine/pull/11)

#### γ.2 `net` crate `[PAR within γ]`
- [ ] libp2p + QUIC transport (pinned versions)
- [ ] Gossipsub topics: vertices, batches, decryption_shares, state_root_sigs, mempool, state_sync, evidence, governance
- [ ] Layered peer discovery: hardcoded seeds → DNS → on-chain validator registry → PEX → cache (NO DHT)
- [ ] Sentry node pattern (committee primaries behind sentry proxies)
- [ ] Peer scoring + multi-layer DDoS protections
- [ ] Vertex-fetch protocol (used by γ.1 missing-vertex handling)
- [ ] PeerId persistence + known-peers cache for fast restart
- [ ] Implement `NetworkView` trait (from `interfaces`)

#### γ.3 `dkg` crate `[PAR within γ]`
- [ ] Pedersen DKG protocol implementation (per epoch)
- [ ] PSS resharing (proactive secret sharing across epochs)
- [ ] May import from `pyde-crypto` if helpers land there first

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
- [ ] BadDecryptionShare evidence verification (gated on γ.3 DKG)
- [ ] Consensus integration: wire `InsertOutcome::Equivocation` → auto-build Evidence
- [ ] Persistence: Slasher + Escrow to RocksDB (lands at MC-2 alongside state-crate integration)
- [x] Reward distribution math: `distribute_rewards(pool, entries)` pure function (pool × stake × uptime, sum-invariant bit-exact, u128-overflow-safe fallback, 6-decimal `UPTIME_PRECISION`) — PR [#31](https://github.com/pyde-net/engine/pull/31)
- [ ] Reward distribution wiring: `UptimeTracker` from consensus attestation events + `RewardPool` epoch-accumulator (depends on γ.1 attestation surface)

#### γ.5 `node` crate `[SEQ within γ] → γ.1 + γ.2 + γ.4` — owned by γ; integration point
- [ ] `pyde` binary (cli, validator, full-node modes)
- [ ] JSON-RPC server (per `HOST_FN_ABI_SPEC §15.4-15.5` + chapter 17 method list)
- [ ] `consensus_store` with `WriteOptions::set_sync(true)` (per Ch 16 §16.12)
- [ ] `panic = "abort"` on persist failure
- [ ] Validator role (FALCON keypair management, attestation, key rotation)
- [ ] Persistence: receipts_cf, txs_cf, waves_cf

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
- [x] `pyde-node devnet --smoke` CLI subcommand — PR [#19](https://github.com/pyde-net/engine/pull/19)
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
