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

## MC-0 — INTERFACE FOUNDATION `[SEQ]` — main session

The sequential prerequisite to parallelism. Without MC-0 complete, streams β and γ clash on shared types and interface drift. ~1 day of focused work; the main session owns it.

### 0.1 Engine repo creation

- [ ] Create `pyde-net/engine` repo on GitHub (fresh; post-pivot)
- [ ] Clone locally at `/pyde-net/engine/`
- [ ] Initial commit: README + LICENSE (Apache-2.0) + `.gitignore`

### 0.2 Workspace skeleton

- [ ] `Cargo.toml` workspace with every crate stubbed:
  - `types`, `interfaces`
  - `account`, `state`, `tx`, `wasm-exec`, `mempool` (β-owned)
  - `consensus`, `net`, `dkg`, `slashing`, `node` (γ-owned)
- [ ] Each crate stub: `Cargo.toml` + `src/lib.rs` with a placeholder function so the workspace compiles

### 0.3 `types` crate (frozen at end of MC-0)

- [ ] `Address` ([u8; 32])
- [ ] `SlotHash`, `Value` (state primitives)
- [ ] `Balance` (u128), `Nonce` (u64)
- [ ] `Tx` enum + per-variant payload types
- [ ] `TxHash`, `Receipt`
- [ ] `StateRoot` (dual: Blake3 + Poseidon2)
- [ ] `EventRecord` (with `topics: Vec<[u8; 32]>` for multi-topic v1)
- [ ] `WaveId` (u64), `Round` (u64)
- [ ] `VertexHash`, `Vertex`
- [ ] `WaveCommitRecord` (with events_root + events_bloom + events_count)
- [ ] `HardFinalityCert`
- [ ] `FalconPubkey`, `FalconSignature`
- [ ] Error codes from `HOST_FN_ABI_SPEC §4`

### 0.4 `interfaces` crate (frozen at end of MC-0)

- [ ] `trait StateView` — read-only state access
- [ ] `trait StateMutator` — atomic wave-level mutation
- [ ] `trait Executor` — invoke a tx
- [ ] `trait MempoolView` — what consensus reads from mempool
- [ ] `trait NetworkView` — gossipsub send/recv abstraction
- [ ] `trait ConsensusEngine` — the consensus loop the node binary drives
- [ ] `mod mock` — mock implementations of every trait for isolated testing

### 0.5 CI + branching

- [ ] `.github/workflows/ci.yml` running cargo build, test, clippy, fmt on every PR
- [ ] Create long-lived branches: `execution-side` (β), `consensus-side` (γ)
- [ ] Tag the MC-0 checkpoint: `phase-0-foundation`

### 0.6 IMPLEMENTATION_PLAN cross-link

- [ ] Verify `pyde-book/src/companion/IMPLEMENTATION_PLAN.md` is up to date
- [ ] Cross-link from this roadmap (above)

**MC-0 BAR:** engine repo exists with all crate stubs compiling; `types` + `interfaces` crates fully written and tested; CI green; branching protocol established; `IMPLEMENTATION_PLAN.md` committed.

---

## MC-1 — PROTOCOL CORE `[PAR — three streams] → MC-0`

The core protocol implementation. Three streams run in parallel: α (toolchain), β (execution), γ (consensus). Each owns disjoint crates per the ownership map in [`IMPLEMENTATION_PLAN.md §4`](companion/IMPLEMENTATION_PLAN.md). The session-handoff prompts for each stream are in [`IMPLEMENTATION_PLAN.md §7`](companion/IMPLEMENTATION_PLAN.md).

### MC-1 Stream α — Toolchain `[SEQ within α] → MC-0` — repo `pyde-net/otigen`

Implements [`OTIGEN_BINARY_SPEC.md`](companion/OTIGEN_BINARY_SPEC.md).

- [ ] `pyde-net/otigen` repo + Rust workspace
- [ ] `otigen-toml`: config parser + schema validation (spec §4)
- [ ] `otigen-abi`: `ContractAbi` construction + Borsh encoding + custom-section injection via `wasm-encoder` (spec §6)
- [ ] `otigen-cli`: subcommand framework via `clap` (spec §3)
- [ ] `otigen build`: full validation pipeline (spec §3.2 step-by-step)
- [ ] `otigen-wallet`: keystore (Argon2id + AES-256-GCM), FALCON-512 signing (spec §7)
- [ ] `otigen-rpc`: JSON-RPC client (spec §8)
- [ ] `otigen deploy` / `upgrade` / `pause` / `unpause` / `kill` / `inspect`
- [ ] `otigen wallet new` / `list` / `rotate` / `import` / `export` / `password`
- [ ] `otigen console` REPL (spec §3.8)
- [ ] `otigen verify` (spec §3.9)
- [ ] Canonical example contracts: Rust, AssemblyScript, Go (TinyGo), C/C++ hello-worlds

**α BAR:** an author runs `otigen init my_token --lang rust`, edits the source + `otigen.toml`, runs `cargo build --target wasm32-unknown-unknown --release`, runs `otigen build`, and ends with a valid `./artifacts/my_token.bundle/`. Once devnet is up (MC-2): `otigen deploy` succeeds against it.

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
- [ ] `Vertex` structure (round, member_id, parent_refs, batch_refs, state_root_sigs, prev_anchor_attestation, decryption_shares, sig)
- [ ] Local DAG view per validator (in-memory graph + lookup)
- [ ] Round advancement (peer-attestation triggered; data-driven, NOT clock-driven)
- [ ] Anchor selection: `anchor_member_id = Hash(beacon, round, recent_state_root) mod 128`
- [ ] VRF beacon derivation (uses pyde-crypto)
- [ ] Mysticeti 3-stage support check
- [ ] BFS subdag walk + canonical sort
- [ ] Missing-vertex fetch protocol (async pull by hash + retry with timeout)
- [ ] Anchor-skip handling
- [ ] Piggybacked decryption shares (pipeline decryption with consensus)
- [ ] HardFinalityCert generation (committee threshold-signs state_root + events_root + events_bloom)
- [ ] WaveCommitRecord write (synchronous; durability for consensus invariants)
- [ ] Committee management (epoch-bounded; uniform random from eligible stakers)
- [ ] Equivocation detection + evidence collection → γ.4 Slashing
- [ ] Implement `ConsensusEngine` trait (from `interfaces`)

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
- [ ] Validator state machine (registered → active → jailed → unbonding → withdrawn)
- [ ] Validator txs: register, unbond, withdraw, rotate-key, unjail
- [ ] Operator-identity binding (anti-Sybil; max 3 validators per operator)
- [ ] Synced-only committee enforcement
- [ ] 10-offense catalog implementation per [`SLASHING.md`](companion/SLASHING.md)
- [ ] Slashing escrow + grace period
- [ ] Reward distribution (pool-based, stake × uptime)

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

- [ ] Final merges of β and γ to `main` (γ owns this)
- [ ] Local devnet config (4-7 validators on a single machine)
- [ ] End-to-end test flow:
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
