# Roadmap

This roadmap is a tree of work in **seven massive chunks**, from zero to mainnet. Each chunk is a coherent body of work that can be owned and tracked as a unit. Within each chunk, sub-streams can run in parallel where their interfaces are stable.

There are no calendar dates. Each chunk ships when its bar is met.

**Legend:**
- `[SEQ]` — sequential within its parent (must complete in order)
- `[PAR]` — can run in parallel with siblings
- `[FOUNDATION]` — blocks downstream work; do early
- `→` — explicit dependency

---

## Top-level shape

```
MC-1 FOUNDATIONS  ──▶  MC-2 PROTOCOL CORE  ──▶  MC-4 STATE SYNC + SNAPSHOTS  ──┐
                                              ▼                                  │
                                       MC-3 APPLICATION TOOLING  ────────────────┼──▶  MC-5 PARACHAIN FRAMEWORK
                                                                                 │              │
                                       MC-6 PERFORMANCE + FAILURE HANDLING ─────┼──────────────┤
                                                                                 ▼              ▼
                                                              MC-7 VALIDATION + MAINNET LAUNCH
```

---

## MC-1 — FOUNDATIONS `[SEQ] [FOUNDATION]`

The sequential prerequisites before any code stream can begin in earnest.

### 1.1 Pivot foundations

- [x] Pivot story doc (`preface/pivot.md`)
- [x] Roadmap (this document — restructured 2026-05-22)
- [x] Pivot folder (`src/pivot/`) with historical design records
- [x] Companion specs moved under `src/companion/`
- [x] All chapters rewritten / swept for WASM era
- [x] All PIPs reframed; PIP-4 drafted
- [x] All cross-references updated
- [x] Org-level READMEs reflect pivot
- [x] mdbook builds cleanly
- [x] Memory entries locked: WASM pivot, gas-no-refund-v1, ai-wallet-preview-direction
- [ ] Whitepaper updates reflected across `companion/WHITEPAPER.md` + alliance-application copies
- [ ] Pitch deck updated
- [ ] All edits committed and pushed across the 10 repos with pending changes

### 1.2 Engine repo restructure

Old engine work lives in `archive/`. New engine repo starts fresh post-pivot.

- [ ] Confirm `archive/` has the engine's pre-pivot state preserved (it does)
- [ ] Update all doc references that say `engine/...` (for historical / pre-pivot context) to point at `archive/...`
- [ ] Mark the old `pyde-net/engine` GitHub repo as archived (read-only) OR rename to `pyde-net/engine-prepivot`
- [ ] Create fresh `pyde-net/engine` repo + local `/pyde-net/engine/` workspace
- [ ] Initial commit on new repo: a single README explaining "post-WASM-pivot engine workspace; pre-pivot work in `pyde-net/engine-prepivot` (or archive)"
- [ ] Cargo workspace skeleton with placeholder crates: `wasm-exec`, `state`, `consensus`, `mempool`, `network`, `accounts`, `tx`, `node`

### 1.3 Foundational specifications

These specs unblock the most parallel work downstream.

- [ ] **Host Function ABI v1.0 spec** → `companion/HOST_FN_ABI_SPEC.md`
  - Complete v1 function catalog with signatures
  - Memory layout conventions (pointer + length passing, return value protocol)
  - Gas cost table per function
  - Versioning rules
  - Parachain-extension allowlist
  - Forbidden imports list
  - Examples per language (Rust, AS, Go, C)
- [ ] **otigen binary design spec** → `companion/OTIGEN_BINARY_SPEC.md`
  - Subcommand surface
  - `otigen.toml` schema (per-function attribute form: `[functions.X] attributes = [...]`)
  - Build verification pipeline (10-step process)
  - ABI generation algorithm
  - Bundle format
  - Wallet protocol (ported from wright)

**MC-1 BAR:** specs are stable; new engine repo exists with workspace skeleton; all doc references migrated; old engine work safely preserved in archive.

---

## MC-2 — PROTOCOL CORE `[PAR within] → MC-1`

The heart of the chain. Multiple sub-streams running in parallel; converging at integration time.

### 2.1 WASM Execution Layer `[SEQ within] → MC-1`

- [ ] `wasm-exec` crate scaffold (wasmtime config, WasmExecutor type, linker setup)
- [ ] Host function implementations (each independent):
  - [ ] `[PAR]` `sload`, `sstore`, `sdelete` → §2.4 State Layer
  - [ ] `[PAR]` `transfer`, `balance` → §2.6 Accounts
  - [ ] `[PAR]` `caller`, `origin`, `block_height`, `wave_id`, `block_timestamp`, `chain_id`
  - [ ] `[PAR]` `emit_event`
  - [ ] `[PAR]` `keccak256`, `blake3`, `poseidon2` → §2.5 Crypto
  - [ ] `[PAR]` `threshold_encrypt`, `threshold_decrypt_share`, `falcon_verify` → §2.5 Crypto
  - [ ] `[PAR]` `cross_call` (smart contract → smart contract; → parachain; → foreign L1 stub)
  - [ ] `[PAR]` `consume_gas`
  - [ ] `[PAR]` `pyde_revert` (structured revert with message)
- [ ] Module compilation cache (per-contract LRU + serialized-Module persistence)
- [ ] Fuel-to-gas mapping (calibrated from gas table; no refunds per [[gas-no-refund-v1]])
- [ ] Deploy-time validation gate (module structure, import allowlist, deterministic-features check)
- [ ] Per-tx overlay execution model (snapshot-and-rollback at the DashMap layer)
- [ ] Linear memory cap enforced (64MB per instance, configurable)
- [ ] Native tx types (transfer, validator-register, system) — NO WASM for simple transfers
- [ ] wasm-exec benchmarks (workload parity with archived PVM benches)

### 2.2 Mysticeti Consensus `[SEQ within] → MC-1`

- [ ] Vertex + round structure (round, member_id, batch_refs, parent_refs, state_root_sigs, prev_anchor_attestation, decryption_shares, FALCON sig)
- [ ] Round advancement (peer-attestation triggered; data-driven)
- [ ] Local DAG view per validator (in-memory graph)
- [ ] Anchor selection (`anchor_member_id = Hash(beacon, round, recent_state_root) mod 128`)
- [ ] VRF beacon derivation (uses §2.5 Crypto)
- [ ] Mysticeti 3-stage support check
- [ ] Subdag traversal (BFS-for-set + canonical sort)
- [ ] Missing-vertex fetch protocol (async vertex pull by hash; retry with timeout; structural anchor-skip handling)
- [ ] Anchor-skip handling (when anchor's vertex absent or insufficient support, mark commit pending; next round's anchor absorbs)
- [ ] Piggybacked decryption shares in vertices (pipeline decryption with consensus)
- [ ] HardFinalityCert generation (committee FALCON-signs (wave_id, blake3_root, poseidon2_root))
- [ ] WaveCommitRecord write (synchronous; durability for consensus invariants)
- [ ] Committee management (epoch-bounded; uniform random from eligible stakers; equal-power voting)
- [ ] Equivocation detection + evidence collection → §2.7 Slashing

### 2.3 State Layer (PIPs + JMT) `[PAR within]`

- [ ] **PIP-2 clustered slot keys** (engine/crates/state/src/keys.rs migration)
- [ ] **PIP-3 scheduler-level prefetch** (wave-level MultiGet against access lists)
- [ ] **PIP-4 write-back cache** (DashMap, warm window, lazy flush + auto-tune, crash recovery)
- [ ] **Dual-hash JMT** (Blake3 + Poseidon2 per node; both state roots; dual-root signed in HardFinalityCert)
- [ ] **Two-table architecture**:
  - [ ] `state_cf` (flat `slot_hash → current_value` for O(1) reads)
  - [ ] `jmt_cf` (versioned `(version, NibblePath) → JmtNode` for state-root + proofs)
- [ ] JMT versioning (each wave commit increments version; old versions for archive nodes; GC for pruned)
- [ ] Snapshot generation (range-proof-based chunks; manifest publishing)

### 2.4 Cryptography (mostly in `pyde-crypto` polyrepo) `[PAR within]`

- [ ] FALCON-512 batch verification helpers
- [ ] DKG protocol implementation (Pedersen DKG each epoch)
- [ ] Threshold decryption share generation + batch aggregation
- [ ] PSS resharing (proactive secret sharing across epochs)
- [ ] VRF beacon derivation → §2.2 Consensus
- [ ] Blake3, Poseidon2 — already functional in pyde-crypto
- [ ] (v2 prep) ZK-aggregated FALCON research

### 2.5 Networking Layer `[PAR within]`

- [ ] libp2p + QUIC transport (pinned versions, deterministic config)
- [ ] Gossipsub topic configuration (pyde/vertices/1, pyde/batches/1, pyde/state-root-sigs/1, pyde/evidence/1, pyde/governance/1, pyde/discovery/1)
- [ ] Bootstrap-based peer discovery (hardcoded seeds + on-chain validator registry; NO DHT)
- [ ] Peer Exchange protocol
- [ ] Sentry node pattern (committee members behind sentry proxies)
- [ ] Peer scoring + multi-layer DoS protections
- [ ] Vertex-fetch protocol (used by §2.2 missing-vertex handling)
- [ ] PeerId persistence to local disk
- [ ] Known-peers cache on disk for fast restart

### 2.6 Account + Transaction Model `[PAR within]`

- [ ] Address derivation (32-byte, full Poseidon2(pubkey), no truncation)
- [ ] Name registry as a system contract (ENS-style unique names; tiered fees; yearly renewal; grace period; transfer; governance claw-back)
- [ ] 16-slot nonce window per account
- [ ] Transaction types: Transfer (native), ContractCall (WASM), ContractDeploy (WASM), ValidatorRegister (system), Multisig (system)
- [ ] FALCON-512 signature verification on every tx
- [ ] Mempool admission rules (validate sig, balance, nonce, gas bounds, calldata size, chain_id replay protection)
- [ ] JSON-RPC server (used by SDKs and `otigen` toolchain)

### 2.7 Slashing + Validator Lifecycle `[PAR within] → §2.2 Consensus + §2.6 Tx`

- [ ] Validator state machine (registered → active → jailed → unbonding → withdrawn)
- [ ] Validator registration/unbond/withdraw/rotate-key/unjail txs
- [ ] Operator-identity binding (anti-Sybil; max 3 validators per operator)
- [ ] **Synced-only committee enforcement** (validators must be synced-to-recent-wave to be committee-eligible)
- [ ] Each of the 10 slashing offenses (detection logic, evidence flow, slash amount, correlation multipliers)
- [ ] Slashing escrow + grace period
- [ ] Reward distribution (pool-based, by stake × uptime)

**MC-2 BAR:** local devnet (4-7 validators on a single machine) producing sub-second commits with end-to-end tx flow:
- Author writes contract, builds locally, deploys via otigen
- Tx submitted to RPC, batched, gossipped, included in vertex
- Anchor commits, subdag walks, wasmtime executes
- State updates, state_root signed, finality cert formed
- Receipt queryable via RPC

---

## MC-3 — APPLICATION TOOLING `[PAR within] → MC-1 specs`

Everything authors and end users touch.

### 3.1 otigen developer toolchain (`pyde-net/otigen` repo) `[SEQ within]`

- [ ] Create `pyde-net/otigen` repo + Rust workspace
- [ ] Subcommand framework (clap-based)
- [ ] `otigen.toml` schema + parser (with per-function `[functions.X] attributes = [...]` form)
- [ ] `otigen build` verification pipeline:
  - [ ] Wasm path resolution
  - [ ] Module structural validation
  - [ ] Import allowlist check
  - [ ] Function-export cross-check
  - [ ] Attribute combination validation
  - [ ] State schema validation
  - [ ] ABI generation
  - [ ] Bundle packaging
- [ ] `otigen deploy`, `upgrade`, `pause`, `kill`
- [ ] `otigen inspect`
- [ ] `otigen wallet` (port from wright: FALCON keypair, AES-256-GCM keystore, Argon2id KDF)
- [ ] `otigen console` (REPL)
- [ ] Canonical example projects (`[PAR]` Rust, AssemblyScript, Go (TinyGo), C/C++ hello-worlds)

### 3.2 Client-side wasmtime SDK pattern (Tier 1 wallet preview) `[PAR within] → MC-2 §2.1 + Host Fn ABI`

Built into the SDKs; lets wallets simulate txs locally before signing.

- [ ] Rust SDK: `pyde-rust-sdk` with embedded wasmtime for local simulation
- [ ] TS SDK: `pyde-ts-sdk` with `wasmtime-js` (or wasmer-js) for browser preview
- [ ] WASM crypto bindings (`pyde-crypto-wasm`) — FALCON sign, Kyber encrypt, Poseidon2 hash for browser use
- [ ] Local state fetch (RPC reads + cache; access-list-driven prefetch)
- [ ] Tier 1 wallet preview features:
  - [ ] Gas estimation via local execution
  - [ ] Access list inference (run tx speculatively; record sload/sstore calls)
  - [ ] View function execution (no on-chain query needed)
  - [ ] Dry-run with state preview (show "this will spend X, transfer Y, emit Z event")
- [ ] Wallet adapter pattern for browser wallets (modeled on EVM wallet adapters)
- [ ] External signer protocol (HSM, hardware wallet, MPC integration extension point)

### 3.3 Tier 2/3 future direction (not v1; tracked)

- [ ] Reputation-list integration for known-malicious contract addresses
- [ ] Audit-database cross-reference
- [ ] LLM-augmented contract analysis (Blockaid-style integration when mature)
- [ ] See [[ai-wallet-preview-direction]] memory for full plan

### 3.4 Block explorer (post-MVP)

- [ ] Indexer that subscribes to chain events
- [ ] UI for tx lookup, contract inspection, validator metrics

**MC-3 BAR:** an author writes a Rust contract, runs their own `cargo build`, runs `otigen build` to validate + package, runs `otigen deploy`, and sees the contract live. A wallet user signs a tx, sees a complete preview (state changes, gas), submits, and watches it commit.

---

## MC-4 — STATE SYNC + SNAPSHOTS `[SEQ] → MC-2 §2.3 state + §2.2 consensus`

Mechanism for new validators to join without replaying genesis.

- [ ] Snapshot generation (background process on archive nodes + volunteer-served)
  - Walk JMT at target wave version
  - Chunk into ~50MB pieces with range proofs
  - Persist chunks; publish SnapshotManifest
- [ ] `pyde_getSnapshotManifest` RPC handler
- [ ] Snapshot chunk serving over libp2p streams (parallel from multiple peers)
- [ ] Weak-subjectivity checkpoint format (wave_id + dual state_roots + committee threshold sig)
- [ ] WS checkpoint distribution (Pyde website + multiple official sources)
- [ ] New-validator sync flow (download manifest, parallel chunk fetch, verify, write, replay chain log from checkpoint to head)
- [ ] Sync time target (~40 min for fresh sync)
- [ ] Three-tier node model: archive (full history), pruned (current + retention window), light client (checkpoints only)

**MC-4 BAR:** a fresh validator boots, gets a WS checkpoint, syncs to current head in under 1 hour, joins gossip mesh, becomes committee-eligible at next epoch boundary.

---

## MC-5 — PARACHAIN FRAMEWORK `[SEQ] → MC-2 + MC-3`

App-specific WASM execution contexts with their own governance.

- [ ] Parachain account structure (versions, balance, config, state_root, owner deposit, status)
- [ ] Parachain ID derivation (`Poseidon2("pyde-parachain:" || name)`)
- [ ] Deploy flow (owner deposit, WASM validation, registry write)
- [ ] Upgrade flow (proposal, equal-power voting, scheduled activation)
- [ ] Pause / kill (operational lifecycle)
- [ ] State subtree partitioning (`parachain_id[..16]` PIP-2 prefix)
- [ ] Cross-parachain messaging (rate-limited, threshold-signed)
- [ ] `cross_call` callback mechanism (success / error / timeout flows)
- [ ] Version manifest in wave-commit records (replay correctness)
- [ ] Reference parachains: price-feed oracle + confidential-vote parachain

**MC-5 BAR:** an author deploys a parachain, validators opt in, parachain runs its own consensus + state, smart contracts invoke it via cross_call, callbacks land.

---

## MC-6 — PERFORMANCE + FAILURE HANDLING `[PAR within] → MC-2 + MC-3`

Operational maturity. Can begin once MC-2 is mostly functional.

### 6.1 Performance harness

- [ ] Workload generators (compute / IO / crypto / mixed-realistic)
- [ ] Multi-region topology framework (US-East, EU-West, AP-Southeast)
- [ ] Chaos scenarios (validator drops, network partitions, slow disks, equivocating actors)
- [ ] Soak-test scheduler (1h / 4h / 24h / 7-day)
- [ ] Metric collection + reporting (TPS, p50/p99/p999, memory, CPU breakdown, gas accounting)
- [ ] "Claim 1/3 of measured peak" publication discipline
- [ ] WASM execution layer benchmarks (parity with archived PVM benches; new wasm-era numbers)
- [ ] Per-host-function micro-benchmarks (calibrate gas cost table against real hardware)
- [ ] Sequential vs parallel execution scaling tests

### 6.2 Halt + recovery

- [ ] Halt detection (soft stall / hard halt / emergency)
- [ ] Bounded rollback (1 epoch maximum)
- [ ] Recovery paths (committee re-bootstrap, governance-driven restart)
- [ ] Drill playbooks (one per halt scenario)
- [ ] Halt-and-recovery simulation tests

**MC-6 BAR:** 7-day soak passes without regression. All halt scenarios drilled. Performance harness can produce defensible TPS numbers.

---

## MC-7 — VALIDATION + MAINNET LAUNCH `[SEQ] → MC-1 through MC-6`

The bar for going live.

### 7.1 Hardening + internal verification

- [ ] Property-based test suite (consensus invariants, state invariants)
- [ ] Fuzz testing (wasm-exec, tx parsing, signature verification, network layer, otigen toolchain)
- [ ] Formal verification of consensus safety properties (best-effort, peer-reviewed)
- [ ] Coverage measurement + gap closing
- [ ] Internal threat-model red-teaming

### 7.2 External audit

- [ ] External audit firm engagement (target: top-tier security firm with PQ-crypto experience)
- [ ] Audit scope: consensus, WASM execution layer integration, pyde-crypto, networking, otigen toolchain
- [ ] Resolve all critical + high findings
- [ ] Re-audit remediation

### 7.3 Public testnet

- [ ] Genesis ceremony for testnet
- [ ] 16+ validators across regions
- [ ] External developer onboarding (first real contracts on testnet)
- [ ] Sustained soak under real load
- [ ] Numbers published with methodology + raw data
- [ ] Bug bounty program open (testnet-scope first)

### 7.4 Mainnet candidate

- [ ] Final genesis configuration
- [ ] Initial validator set committed (≥32 validators, geographically distributed)
- [ ] Day-one ecosystem partners (≥3-5 parachains/dApps)
- [ ] Token distribution finalized
- [ ] Bug bounty scaled to mainnet tier
- [ ] Mainnet launch

**MC-7 BAR:** mainnet live. All MC-1 through MC-6 work integrated, audited, stress-tested, soak-passed.

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

| Item | Depends on | Used by |
|------|------------|---------|
| MC-1 Foundations | — | Everything |
| MC-2 §2.1 WASM Exec | MC-1, Host Fn ABI spec | MC-3 (toolchain), MC-5 (parachains) |
| MC-2 §2.2 Consensus | MC-2 §2.4 (crypto), §2.5 (network), §2.6 (tx) | Everything that needs finality |
| MC-2 §2.3 State Layer | — | MC-2 §2.1 (sload/sstore), MC-4 (sync) |
| MC-2 §2.4 Cryptography | — | MC-2 §2.1 (host fns), §2.2 (FALCON/VRF), §2.6 (sigs) |
| MC-2 §2.5 Network | — | MC-2 §2.2 (gossip), §2.6 (tx propagation) |
| MC-2 §2.6 Accounts/Tx | MC-2 §2.4 (sigs) | MC-2 §2.1 (deploy/call), §2.2 (mempool), §2.7 (slash txs) |
| MC-2 §2.7 Slashing | MC-2 §2.2 (evidence), §2.6 (tx types) | Consensus integrity |
| MC-3 Tooling | MC-1 specs, MC-2 §2.1, §2.6 | Authors, end users |
| MC-4 State Sync | MC-2 §2.3, §2.2 | New validators |
| MC-5 Parachains | MC-2, MC-3 | Application authors |
| MC-6 Perf + Halt | MC-2 mostly functional | Operational readiness |
| MC-7 Validation + Launch | All preceding | Mainnet |

---

## Operating principle

The bias of this roadmap is **honesty over optimism**. No chunk ships before its bar is met. No item is checked off until the work behind it is actually done. If something turns out to be wrong, it gets honestly rewritten — including this roadmap.

The work is the work. It ships when it is ready.
