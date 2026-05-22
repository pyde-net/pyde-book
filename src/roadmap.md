# Roadmap

This roadmap is a tree of work, organized by what blocks what. The top of the tree is sequential foundations. Below that, multiple **parallel streams** can run independently as long as their interfaces are stable. The bottom of the tree is convergence: integration, testing, external validation, mainnet.

There are no calendar dates. Each item ships when its bar is met.

**Legend:**
- `[SEQ]` — sequential within its parent (must complete in order shown)
- `[PAR]` — can run in parallel with siblings under the same parent
- `[FOUNDATION]` — blocks downstream work; do early
- `→` — explicit cross-stream dependency

---

## Phase 0 — Pivot Foundations `[SEQ] [FOUNDATION]`

Mostly done. Remaining cleanup before code work begins.

- [x] Pivot story doc (`preface/pivot.md`)
- [x] Roadmap (this document)
- [x] Pivot folder (`src/pivot/`) with historical design records
- [x] Companion specs moved under `src/companion/`
- [x] All chapters rewritten / swept for WASM era
- [x] All PIPs reframed; PIP-4 drafted
- [x] All cross-references updated
- [x] Org-level READMEs (engine, otic, wright, .github/profile, website) reflect pivot
- [x] mdbook builds cleanly
- [ ] Whitepaper updates incorporated and ratified (companion doc updated; consumption confirmed)
- [ ] Pitch deck updated (companion + alliance-application copies)
- [ ] All edits committed and pushed across the 10 repos with pending changes

---

## Phase 1 — Engine Cleanup `[SEQ] [FOUNDATION]`

Remove the pre-pivot crates so the new work has a clean foundation.

- [ ] `engine/crates/pvm` — remove from workspace; move source to `archive/`
- [ ] `engine/crates/aot` — remove from workspace; move source to `archive/`
- [ ] Remove any crate that depends only on Otigen bytecode semantics
- [ ] Remove `otic` dependencies from any surviving crate
- [ ] Update `engine/Cargo.toml` workspace definition
- [ ] `cargo check` + `cargo build` + `cargo clippy` + `cargo fmt` — resolve fallout
- [ ] Run surviving test suite; flag tests broken by removals (open issues for fixes)
- [ ] Archive `pyde-net/otic` repo (read-only, link to pivot doc)
- [ ] Archive `pyde-net/wright` repo (read-only, link to pivot doc)

**Bar:** engine workspace compiles cleanly with the new crate layout. Pre-pivot benchmark code preserved in `archive` and still runnable from there.

---

## Phase 2 — Foundational Specs `[SEQ] [FOUNDATION]`

These specs unblock the most parallel work downstream. Both should land before any stream-level code begins in earnest.

- [ ] **Host Function ABI v1.0 spec** (`pyde-book/src/companion/HOST_FN_ABI_SPEC.md`)
  - Complete v1 function catalog with signatures
  - Memory layout conventions (pointer + length passing, return value protocol)
  - Gas cost table per function
  - Versioning rules (backward-compat policy)
  - Parachain-extension allowlist (separate from smart-contract allowlist)
  - Forbidden imports list
  - Examples per language (Rust, AS, Go, C) for each function
- [ ] **otigen binary design spec** (`pyde-book/src/companion/OTIGEN_BINARY_SPEC.md`)
  - Subcommand surface in detail
  - `otigen.toml` schema (all sections, validation rules)
  - Build verification pipeline (10-step process from chapter 5 §5.5)
  - ABI generation algorithm
  - Bundle format
  - Wallet protocol (ported-forward from wright)
  - Cross-references to Host Function ABI spec

**Bar:** both specs reviewable and stable enough that downstream streams can target them.

---

## Convergent Streams `[PAR]`

Once Phase 2 specs are stable, the following streams run in parallel. Within each stream, tasks have their own internal ordering — but streams don't block each other unless an explicit `→ Stream X` dependency is called out.

### Stream A — WASM Execution Layer

The new heart of the engine.

- [ ] **A1. `wasm-exec` crate scaffold** `[SEQ]`
  - `engine/crates/wasm-exec` Cargo skeleton
  - wasmtime dependency pinned to stable version
  - `WasmExecutor` type owning Engine + Module cache + linker
  - Deterministic feature-flag config (NaN canonicalization, no threads, no SIMD, no WASI, etc.)
- [ ] **A2. Host function implementations** `[PAR]` — each function can be implemented independently
  - `[PAR]` `sload`, `sstore`, `sdelete` → Stream D
  - `[PAR]` `transfer`, `balance` → Stream G
  - `[PAR]` `caller`, `origin`, `block_height`, `wave_id`, `block_timestamp`, `chain_id`
  - `[PAR]` `emit_event`
  - `[PAR]` `keccak256`, `blake3`, `poseidon2` → Stream E
  - `[PAR]` `threshold_encrypt`, `threshold_decrypt_share`, `falcon_verify` → Stream E
  - `[PAR]` `cross_call`
  - `[PAR]` `consume_gas`
- [ ] **A3. Module compilation cache** `[SEQ]` — LRU per contract address, serialized-Module persistence
- [ ] **A4. Fuel-to-gas mapping** `[SEQ]` — read gas table from spec, instrument wasmtime fuel
- [ ] **A5. Deploy-time validation gate** `[SEQ]` — module structure, import allowlist, feature-flag enforcement
- [ ] **A6. Integration with tx pipeline** `[SEQ]` — replace old dispatcher, wire `WasmExecutor` into wave processing → Stream G (tx types)
- [ ] **A7. wasm-exec benchmarks** `[SEQ]` — workload parity with archived PVM benches; capture WASM-era numbers

**Bar:** end-to-end — deploy a Rust WASM contract, call an entry function, observe state changes, verify state_root.

### Stream B — Consensus Layer (Mysticeti DAG)

The post-pivot consensus rebuild.

- [ ] **B1. Vertex + round structure** `[SEQ]`
  - `Vertex` struct (round, member_id, batch_refs, parent_refs, state_root_sigs, prev_anchor_attestation, decryption_shares, FALCON sig)
  - Round advancement (peer-attestation triggered; data-driven)
  - Local DAG view per validator
- [ ] **B2. Anchor selection** `[SEQ]`
  - `anchor_member_id = Hash(beacon, round, recent_state_root) mod 128`
  - VRF beacon derivation (uses Stream E)
- [ ] **B3. Commit decision + subdag traversal** `[SEQ]`
  - Mysticeti 3-stage support check
  - Causal-closure walk to build subdag
  - Canonical ordering (round, member_id, list order)
- [ ] **B4. Missing-vertex fetch mechanism** `[PAR]` — async vertex pull by hash
  - Request/response over the dedicated consensus channel
  - Retry on timeout
  - Bounded wait + commit-skip if vertex truly unavailable
- [ ] **B5. Anchor-skip handling** `[PAR]` — when anchor's vertex absent, mark commit pending and roll forward to next round
- [ ] **B6. HardFinalityCert generation** `[SEQ]` — committee signs (wave_id, blake3_state_root, poseidon2_state_root)
- [ ] **B7. Committee management** `[SEQ]` — epoch-bounded membership, uniform-random selection from eligible stakers, VRF rotation
- [ ] **B8. Equivocation detection + evidence collection** `[PAR]` → Stream H

**Bar:** local devnet (4-7 validators) producing commits with sub-second latency. Adversarial simulation — offline anchors handled gracefully, equivocators detected.

### Stream C — Otigen Developer Toolchain

The verifier + packager binary.

- [ ] **C1. Create `pyde-net/otigen` repo + Rust workspace** `[SEQ]`
- [ ] **C2. Subcommand framework** `[SEQ]` — clap-based dispatch for init/build/deploy/upgrade/pause/kill/inspect/wallet/console
- [ ] **C3. `otigen.toml` schema + parser** `[SEQ]` — serde structs with validation
- [ ] **C4. `otigen build` verification pipeline** `[SEQ]` → Stream A (host fn ABI) + Phase 2 spec
  - Wasm path resolution
  - Module structural validation (wasmtime parser)
  - Import allowlist check
  - Function-export cross-check
  - Attribute combination validation
  - State schema validation
  - ABI generation
  - Bundle packaging
- [ ] **C5. `otigen deploy`** `[PAR after C4]` → Stream G (tx submission)
- [ ] **C6. `otigen upgrade`, `pause`, `kill`** `[PAR after C5]`
- [ ] **C7. `otigen inspect`** `[PAR]` → Stream G (RPC client)
- [ ] **C8. `otigen wallet`** `[PAR]` — port from wright (FALCON keypair, AES-256-GCM keystore, Argon2id KDF)
- [ ] **C9. `otigen console`** `[PAR]` → Stream G (RPC client)
- [ ] **C10. Canonical example projects** `[PAR]` (each can be done independently)
  - `[PAR]` Rust hello-world parachain
  - `[PAR]` AssemblyScript hello-world parachain
  - `[PAR]` Go (TinyGo) hello-world parachain
  - `[PAR]` C/C++ hello-world parachain

**Bar:** an author can `otigen init my_contract --lang rust`, write contract code, run their own `cargo build`, run `otigen build`, run `otigen deploy --network devnet`, and have a working contract on a local devnet.

### Stream D — State Layer

PIP work + dual-hash JMT.

- [ ] **D1. PIP-2 clustered slot keys** `[PAR]` — `engine/crates/state/src/keys.rs` migration
  - Survey all call sites
  - Migrate `balance_key`
  - Migrate account-metadata keys
  - Migrate storage-slot + map keys
  - Migrate validator + vesting keys
  - Add clustering-property tests
  - Benchmark cluster locality wins
- [ ] **D2. PIP-3 scheduler-level prefetch** `[SEQ after D1]` — wave-level MultiGet against access lists
- [ ] **D3. PIP-4 write-back cache** `[SEQ after D2]` — DashMap, warm window, lazy flush + auto-tune, crash recovery
- [ ] **D4. Dual-hash JMT update** `[PAR with D1]` — every node carries Blake3 + Poseidon2 fingerprints
  - Update node serialization
  - Update hash propagation logic
  - Update state_root computation (both roots)
  - Update HardFinalityCert to sign both
- [ ] **D5. JMT state sync protocol** `[PAR]` → Stream F
  - Snapshot generation (committee signs root cheaply, volunteers chunk daily)
  - Weak-subjectivity checkpoint emission
  - New-node sync flow (~40 min target)
  - Light-client mode

**Bar:** JMT operations correct under all PIPs. State sync end-to-end — a fresh node bootstraps from a weak-subjectivity checkpoint to current head.

### Stream E — Cryptography (mostly in `pyde-crypto` polyrepo)

- [ ] **E1. FALCON-512 batch verification helpers** `[PAR]` — wrap pyde-crypto's existing batch verify for use in commit pipeline
- [ ] **E2. DKG protocol implementation** `[SEQ]` — Pedersen DKG ceremony each epoch
- [ ] **E3. Threshold decryption share generation + aggregation** `[SEQ after E2]`
- [ ] **E4. PSS resharing** `[SEQ after E3]` — proactive secret sharing across epochs
- [ ] **E5. VRF beacon derivation** `[PAR]` → Stream B
- [ ] **E6. ZK-aggregated FALCON research prep** `[PAR]` — v2-direction; literature review + prototype, not v1 critical path

**Bar:** threshold encryption end-to-end — encrypted tx submitted, committee combines shares, decryption succeeds, commit executes. PSS rotation across epoch boundary tested.

### Stream F — Network Layer

- [ ] **F1. libp2p + QUIC transport** `[SEQ]` — pinned versions, deterministic config
- [ ] **F2. Gossipsub topic configuration** `[PAR after F1]` — Pyde-specific topics (tx, vertex, attestation, governance)
- [ ] **F3. Bootstrap-based peer discovery** `[PAR after F1]` — hardcoded seed nodes + on-chain validator registry; NO DHT
- [ ] **F4. Sentry node pattern** `[PAR]` — committee members reachable only via sentry proxies
- [ ] **F5. Peer scoring + DoS mitigations** `[PAR]`
- [ ] **F6. Vertex-fetch protocol** `[SEQ]` → Stream B (B4 depends on this)

**Bar:** multi-node mesh formation; vertex propagation observed under packet loss + latency injection.

### Stream G — Account + Transaction Model

- [ ] **G1. Address derivation (32-byte, full Poseidon2)** `[SEQ]`
- [ ] **G2. Name registry as a system contract** `[SEQ after G1]` — ENS-style unique names, tiered fees, renewal, grace period, transfer, governance claw-back
- [ ] **G3. 16-slot nonce window** `[PAR with G1]`
- [ ] **G4. Transaction types + signature verification** `[SEQ after G1]`
- [ ] **G5. Mempool admission rules** `[SEQ after G4]`
- [ ] **G6. JSON-RPC server** `[PAR after G5]` — surface for SDKs and `otigen` toolchain (used by Stream C5-C9)

**Bar:** transactions can be constructed by an SDK, signed, submitted to RPC, accepted into mempool, gossipped, included in a vertex, committed.

### Stream H — Slashing + Validator Lifecycle

- [ ] **H1. Validator state machine** `[SEQ]` — registered → active → jailed → unbonding → withdrawn
- [ ] **H2. Validator registration/unbond/withdraw/rotate-key/unjail txs** `[PAR after H1]` → Stream G (tx types)
- [ ] **H3. Operator-identity binding** `[PAR after H1]` — anti-Sybil mechanism
- [ ] **H4. Each of the 10 slashing offenses** `[PAR]` — each is its own subtask
  - `[PAR]` detection logic
  - `[PAR]` evidence flow
  - `[PAR]` slash amount + correlation multipliers
- [ ] **H5. Slashing escrow + grace period** `[SEQ after H4]`
- [ ] **H6. Reward distribution** `[SEQ]` — pool-based, by stake × uptime

**Bar:** each slashing scenario reproducible in a test; slash + jail mechanics verified end-to-end.

---

## Convergence Phase `[SEQ after streams converge]`

Once streams A through H have functional core, integration begins.

### Phase 3 — Parachain Framework `[SEQ after A, C, D, G, H]`

- [ ] **3.1. Parachain account structure** — versions, balance, config, state_root, owner deposit, status
- [ ] **3.2. Parachain ID derivation from name** — `Poseidon2("pyde-parachain:" || name)`
- [ ] **3.3. Deploy flow** — owner deposit, WASM validation, registry write
- [ ] **3.4. Upgrade flow** — proposal, equal-power vote (not stake-weighted), scheduled activation
- [ ] **3.5. Pause / kill** — operational lifecycle
- [ ] **3.6. State subtree partitioning** — `parachain_id[..16]` PIP-2 prefix
- [ ] **3.7. Cross-parachain messaging** — rate-limited, threshold-signed
- [ ] **3.8. cross_call callback mechanism** — success / error / timeout flows
- [ ] **3.9. Version manifest in commit records** — replay-correctness
- [ ] **3.10. Reference parachains** — at minimum a price-feed oracle + a confidential-vote parachain

### Phase 4 — Chain Halt + Failure Handling `[SEQ after Phase 3]`

- [ ] **4.1. Halt detection** — soft stall / hard halt / emergency
- [ ] **4.2. Bounded rollback** — 1 epoch maximum
- [ ] **4.3. Recovery paths** — committee re-bootstrap, governance-driven restart
- [ ] **4.4. Drill playbooks** — one per halt scenario
- [ ] **4.5. Halt-and-recovery simulation tests**

### Phase 5 — Performance Harness `[PAR with Phase 4]`

- [ ] **5.1. Workload generators** — compute / IO / crypto / mixed
- [ ] **5.2. Multi-region topology framework** — US-East, EU-West, AP-Southeast
- [ ] **5.3. Chaos scenarios** — validator drops, network partitions, slow disks, equivocating actors
- [ ] **5.4. Soak-test scheduler** — 1h / 4h / 24h / 7-day
- [ ] **5.5. Metric collection + reporting** — TPS, p50/p99/p999, memory, CPU breakdown, gas accounting
- [ ] **5.6. "Claim 1/3 of measured peak" publication discipline**

### Phase 6 — Hardening + Internal Verification `[SEQ after 3 + 4 + 5]`

- [ ] **6.1. Property-based test suite** — consensus invariants, state invariants
- [ ] **6.2. Fuzz testing** — wasm-exec, tx parsing, signature verification, network layer, otigen toolchain
- [ ] **6.3. Formal verification of consensus safety properties** — best-effort, peer-reviewed
- [ ] **6.4. Coverage measurement + gap closing**
- [ ] **6.5. Internal threat-model red-teaming**

### Phase 7 — External Validation `[SEQ after Phase 6]`

- [ ] **7.1. External audit firm engagement**
- [ ] **7.2. Resolve all critical + high findings**
- [ ] **7.3. Bug bounty open (testnet tier first, then mainnet tier)**
- [ ] **7.4. Public testnet launch** — 16+ validators, multi-region
- [ ] **7.5. External developer onboarding** — first real contracts on testnet
- [ ] **7.6. Sustained soak under real load** — 24h, 72h, 7-day runs
- [ ] **7.7. Numbers published with methodology + raw data**

### Phase 8 — V1 Mainnet Candidate `[SEQ after Phase 7]`

- [ ] **8.1. Final genesis configuration**
- [ ] **8.2. Initial validator set committed** — ≥32 validators, geographically distributed
- [ ] **8.3. Day-one ecosystem partners (≥3-5 parachains/dApps)**
- [ ] **8.4. Token distribution finalized**
- [ ] **8.5. Mainnet launch**

---

## Beyond V1 `[PAR]` — post-mainnet research/dev directions

Not gating v1; tracked here so the work is visible.

- **ZK-aggregated FALCON signatures** — the path to dramatic signature-verification throughput gains
- **zk-WASM proven execution** — when upstream provers reach production quality
- **Cross-chain bridges** — proven-security mechanisms, post-mainnet
- **Programmable accounts** — sandboxed WASM policies for spend limits, recovery, etc.
- **Native session keys** — epoch-bounded, scope-limited delegation
- **State-expiration policy** — for state-bloat management

---

## Parallelization map

```
Phase 0 (Pivot Foundations — DONE) ── Phase 1 (Engine Cleanup) ── Phase 2 (Foundational Specs)
                                                                            │
                       ┌────────┬────────┬────────┬────────┬────────┬────────┼────────┬────────┐
                       ▼        ▼        ▼        ▼        ▼        ▼        ▼        ▼
                     Stream  Stream  Stream  Stream  Stream  Stream  Stream  Stream
                       A        B        C        D        E        F        G        H
                     (WASM   (Mysti- (otigen  (State  (Crypto) (Net-  (Acct + (Slash-
                      exec)   ceti    tool-   layer)            work)  Tx)     ing)
                              DAG)    chain)
                       │        │        │        │        │        │        │        │
                       └────────┴────────┴────────┼────────┴────────┴────────┴────────┘
                                                  ▼
                                        Phase 3 (Parachain Framework)
                                                  │
                                        Phase 4 (Halt + Recovery)  │  Phase 5 (Performance Harness) [PAR]
                                                  │
                                        Phase 6 (Hardening + Verification)
                                                  │
                                        Phase 7 (External Validation)
                                                  │
                                        Phase 8 (Mainnet Candidate)
```

Streams A through H can be picked up by parallel sessions / contributors. The interfaces between streams (host function ABI, vertex format, state root format, transaction format) are stable per Phase 2 specs — that's what keeps the streams from blocking each other.

---

## Stream dependency matrix

| Stream | Depends on | Used by | Notes |
|--------|------------|---------|-------|
| A — WASM Execution | Phase 2 (Host Fn ABI spec) | C, D (via host fns), G (via tx pipeline) | Heart of execution |
| B — Consensus | E (VRF + crypto), F (network), G (tx types) | All — provides finality | Heart of ordering |
| C — Otigen Toolchain | Phase 2 (specs), A (host fn ABI), G (tx submission) | Authors | Verify + package only |
| D — State Layer | — | A (sload/sstore), B (state roots) | Independent core |
| E — Cryptography | — | A (crypto host fns), B (FALCON, VRF, threshold) | Mostly in `pyde-crypto` |
| F — Network | — | B (gossip + fetch), G (tx propagation) | libp2p + QUIC |
| G — Account + Tx | E (signature schemes) | A (deploy/call), B (mempool input), C (deploy submit) | Foundation for all |
| H — Slashing | B (equivocation evidence), G (tx types) | Consensus integrity | Last to integrate |

---

## Operating principle

The bias of this roadmap is **honesty over optimism**. No phase ships before its predecessor's bar is met. No item is checked off until the work behind it is actually done. If something turns out to be wrong, it gets honestly rewritten — including this roadmap.

The work is the work. It ships when it is ready.
