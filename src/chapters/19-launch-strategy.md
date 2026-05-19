# Chapter 19: Launch Strategy

This chapter is the road from "code in a repo" to "live mainnet." It
mirrors the project's `MAINNET_PLAN.md` — ten ordered phases, each with
exit criteria. Some phases run in parallel; some are strictly sequential.

**Post-pivot reset (May 2026).** The pre-pivot HotStuff consensus
implementation hit a wall — repeated wedges, view-change cascades, and a
peak of ~4K TPS in lab tests (with full launch tests never run).
The May 2026 pivot to Mysticeti DAG consensus reset the consensus
critical path. Mainnet ships when the work below is complete and the
external audit + incentivized testnet pass — no public schedule.

The summary up front: Pyde mainnet ships **committee-only DAG consensus
with FALCON state-root attestation**, no STARK proving on the critical
path, with **optional** encrypted mempool and treasury multisig in scope
from genesis. ZK proving, parachain operator network, additional SDKs,
signed-mempool commitments, and other hardening items are **explicitly
post-mainnet**.

> **Honest framing for the "Done" rows below.** Many tables in this
> chapter list items completed against the pre-pivot HotStuff codebase
> (now in `legacy/`). Work in the PVM, AOT compiler, state layer (JMT),
> transaction pipeline, tokenomics, vesting, airdrop, and multisig
> **survives the pivot intact** — those "Done" rows still apply. Work in
> consensus, mempool, networking, and gossip describes **properties** —
> the test cases, invariants, and lessons stay; **the code does not** and
> the same properties must be re-established in the new Mysticeti DAG
> implementation. The "Done" status records progress on the property,
> not shipped DAG code. Phase 6 multi-node tests in particular were
> against the HotStuff implementation and must be redone post-pivot.

---

## 19.1 Launch Philosophy

Three principles that shape every phase:

1. **Audit before stake.** Every line of consensus, crypto, VM, and otic
   code goes through external audit before any user has serious skin in
   the game.
2. **Testnet exposure before mainnet.** Three months minimum of
   incentivized testnet, with reference dApps, before the genesis ceremony.
3. **Voluntary launch.** No one is forced onto Pyde mainnet. The genesis
   set is recruited and validated; users opt in by deploying contracts
   and bridging value.

The plan is conservative on purpose — bridge exploits and broken consensus
hard-forks have ended chains. A delayed launch is recoverable; a botched
launch is not.

---

## 19.2 The Ten Phases

The phase structure (from `MAINNET_PLAN.md`):

```
Critical path: Phase 1 -> 3 -> 6 -> 7 -> 9 -> 10
Parallel:      Phases 2, 4, 5, 8 piggyback on the critical path
```

| Phase | Focus                                            | Position    |
| ----- | ------------------------------------------------ | ----------- |
| 1     | Critical safety fixes                            | Critical    |
| 2     | Book reconciliation                              | Parallel    |
| 3     | MEV pipeline end-to-end                          | Critical    |
| 4     | Tokenomics + governance                          | Parallel    |
| 5     | Hardening + CI                                   | Parallel    |
| 6     | Devnet + multi-node test coverage                | Critical    |
| 7     | Testnet alpha                                    | Critical    |
| 8     | External audits (5 specialists)                  | Parallel late|
| 9     | Incentivized testnet                             | Critical    |
| 10    | Mainnet genesis ceremony                         | Critical    |

Each phase below has its goals and the exit-criteria conditions that have
to be true before the chain can move on.

---

## 19.3 Phase 1 — Critical Safety Fixes

**Goal.** Fix the issues that would make any later test or launch unsafe.

> **Pivot scoping note.** Most items in the table below were completed
> against the pre-pivot HotStuff codebase. After the May 2026 pivot,
> consensus / mempool / networking moved to `legacy/` and need to be
> re-built on Mysticeti DAG. **Items marked "Done (pre-pivot, applies)"
> are in code that survives the pivot (PVM, AOT, state, transaction
> pipeline). Items marked "Done (pre-pivot, redo for DAG)" describe
> properties that must be re-established in the new consensus
> implementation — the lessons are kept; the code is not.**

| Item                                                                  | Status |
| --------------------------------------------------------------------- | ------ |
| Vote / vertex persistence durability (sync writes + crash safety)     | Done (pre-pivot, redo for DAG)   |
| Define `TransactionType::Slash` variant                                | Done (pre-pivot, applies)   |
| Slash-tx handler drains pending evidence                              | Done (pre-pivot, evidence format updates for DAG) |
| Reporter field in evidence + 10% finder's fee                          | Done (pre-pivot, applies)   |
| Evidence gossip channel                                               | Done (pre-pivot, redo for DAG)   |
| PVM jump/call bounds check (`CODE_START <= pc < code_end`)            | Done (pre-pivot, applies)   |
| Set `witness.post_state_root` after execution                          | Done (pre-pivot, applies)   |
| Lock 70/20/10 fee split in code + comments + README                    | Done (pre-pivot, applies; recipient renamed to reward pool) |
| Bootstrap seed lists for mainnet/testnet                               | Pending (depends on final genesis ceremony) |
| Config safeguard: `chain_id == 31337` sig-bypass cannot apply elsewhere | Done (pre-pivot, applies) |
| Trap on invalid wide-register index `>= 8`                            | Done (pre-pivot, applies)   |
| Propagate store errors in AOT host                                    | Done (pre-pivot, applies)   |
| `WriteOptions::set_sync(true)` on consensus writes                    | Done (pre-pivot, redo for DAG) |
| Halt validator on persist failure (panic = "abort")                    | Done (pre-pivot, redo for DAG) |
| Persist evidence state across restarts                                | Done (pre-pivot, redo for DAG) |
| Peer-score + rate-limit evidence ingest                                | Done (pre-pivot, redo for DAG) |
| Microbenchmark fsync overhead                                          | Done (pre-pivot, applies — ~25.5 µs per write) |
| Unify slashing constants into shared crate                       | Done (task 014g) |

**Exit criterion.** No critical-severity items remaining; the consensus
store is fsync-durable and the validator panics rather than continuing
with lost vote state.

---

## 19.4 Phase 2 — Book Reconciliation

**Goal.** Match the documentation to the shipped scope.

Earlier drafts of this book described a three-role network with STARK
proving, prover economics, and a two-chamber governance model. The shipped
mainnet is committee-only with FALCON-quorum finality, on-chain multisig
treasury governance, and no provers. This phase is the rewrite — what
you're reading.

**Exit criterion.** Every chapter reflects the shipped code; deferred
items are clearly tagged "post-mainnet."

---

## 19.5 Phase 3 — MEV Pipeline End-to-End

**Goal.** The encrypted mempool, ordering commitment, and mandatory
inclusion all work across nodes under load.

| Item                                                                  | Status |
| --------------------------------------------------------------------- | ------ |
| Pre-decryption ordering commitment (proposer broadcasts before shares) | Done   |
| Validator verification: decrypted ordering matches commitment          | Done   |
| Mandatory-inclusion invariant on local view                            | Done   |
| Per-sender mempool rate limit (10 tx/s, 100 concurrent)                | Done   |
| Bind ciphertext to sender FALCON pubkey                                | Done   |
| FALCON P2P handshake on peer connect                                   | Done (task 029) |
| Bind libp2p PeerId to FALCON pubkey                                    | Done (task 030) |
| Multi-node test: submit-encrypt → commit → decrypt → seal              | Done   |
| Multi-node front-run test: attempted front-run fails                   | Done   |
| Wire PSS epoch refresh trigger on committee rotation                   | Done   |
| Committee handoff + in-flight tx re-encryption                         | Done   |

**Exit criterion.** Multi-node tests demonstrate that the four MEV-protection
layers (encryption, commitment, mandatory inclusion, no-tip) all hold under
real network conditions.

---

## 19.6 Phase 4 — Tokenomics + Governance

**Goal.** PYDE token, vesting, airdrop, multisig, emergency pause —
everything required at genesis to actually fund and govern a network.

| Item                                                            | Status |
| --------------------------------------------------------------- | ------ |
| PYDE native token + 1B genesis allocation                       | Done   |
| Inflation schedule 5%→3%→2%→1%                                  | Done   |
| Block reward distribution (validator + treasury, two-tier)       | Done (slice 4.1) |
| Active-validator divisor + unified `ValidatorEntry::decode`     | Done (slice 4.2) |
| Validator staking (pre-pivot 10K; needs migration to 10M/100K tiers)| Pre-pivot done; tier migration pending |
| Unbonding period (30 days)                                       | Done   |
| Slashing wired to slash-tx handler                              | Done   |
| Total burned counter + audit trail                              | Done (slice 4.1) |
| Weak-subjectivity checkpoint enforcement + bootstrap + gossip   | Done (slice 4.3, PR #208) |
| Genesis vesting schedules + tx validation against locked balance | Done (slice 4.4, PR #209) |
| Genesis supply caps + per-bucket caps + validator subsidy stream | Done (slice 4.4a, PR #210) |
| Airdrop Merkle claim + sweep                                    | Done (slice 4.4b, PR #211 + gas-guard fix #212) |
| Governance approach decided: PIPs + on-chain multisig            | Done (task 043) |
| Multisig treasury spend (`MultisigTx` = 9, `RotateMultisig` = 10) + nonce-bound sigs | Done (slice 4.5, PR #213) |
| Writeback-clobber protection in multisig handlers               | Done (audit fix, same PR) |
| Emergency pause + resume with auto-expiry (max 30 days)          | Done (slice 4.6, PR #214) |
| Treasury account + spend flow with `data_digest = hash(pip)`     | Done (slice 4.7) |

**Exit criterion.** All tokenomics state types are implemented, property-
tested, and integration-tested with pause/resume/multisig flows.

---

## 19.7 Phase 5 — Hardening + CI

**Goal.** Buy back the "clean code" claims that CI will enforce, and make
the codebase production-grade.

| Item                                                       | Status   |
| ---------------------------------------------------------- | -------- |
| `cargo clippy --workspace -- -D warnings` in CI             | Pending  |
| `cargo fmt --check` in CI                                   | Pending  |
| `cargo audit` for CVE scanning                              | Pending  |
| `cargo deny` for license + advisory checks                   | Pending  |
| Property tests on Phase 4 code (vesting, airdrop, multisig, emergency, pipeline) | Done (slice 5.1, PR #215; 31 properties) |
| Integration property tests for `execute_transaction_inner`   | Pending (slice 5.2) |
| `cargo-fuzz` harnesses for PVM, tx validation, consensus, RPC, otic | Pending |
| Fuzz each target 72+ hours; fix all crashes                  | Pending  |
| Separate `MAX_CALLDATA` (64 KB) from `MAX_TX_SIZE` (128 KB)  | Done (task 055) |
| Witness 1 MB bound at validation time                        | Done (task 056) |
| Upgrade `ml-kem` from 0.3.0-rc when stable releases          | Pending  |
| Persistent receipt-store backend for archive-node mode       | Post-mainnet (task 058) |
| Document `unsafe` block invariants                           | Pending  |
| Triage `unwrap()` calls on untrusted-input paths             | Pending  |

**Exit criterion.** CI is enforcing clippy, fmt, audit, and deny. All
fuzz targets have run 72+ hours with no unaddressed crashes.

---

## 19.8 Phase 6 — Devnet + Multi-Node Tests

**Goal.** Exercise everything from Phases 1-4 across multiple nodes.

| Item                                                       | Status |
| ---------------------------------------------------------- | ------ |
| Devnet genesis-config generator                            | Done   |
| `pyde testnet` CLI for local N-validator + M-full-node networks | Done |
| 4-node consensus reaches finality                           | Done (#222) |
| Tx propagation end-to-end                                   | Done (#223) |
| Tx via full node reaches validator                          | Done (#224) |
| New node syncs from network (cold-start)                    | Done (#225) |
| Leader failure tolerated by multi-proposer VRF              | Done (#226) |
| Double-sign debits stake + ejects validator                 | Done (#227) |
| Committee rotation at epoch boundary                        | Done (#228) |
| Partition → heal → no fork                                  | Done (#229) |
| 2/7 validators offline survives                             | Done (#228) |
| Real FALCON sigs + contract deploy + call at chain_id=1     | Done (#230) |
| Docker multi-node devnet                                    | Deferred (operational, not behavioral) |

**Acknowledged Phase 6 gaps** (documented; not blocking unit-test sign-off):

- StakeDeposit / StakeWithdraw end-to-end across nodes (only unit-tested).
- Encrypted mempool roundtrip across nodes (multi-node MEV headline).
- PSS share rotation at epoch boundary (only verified the log message fires).
- ClaimAirdrop / MultisigTx / EmergencyResume / RotateMultisig multi-node.
- Paymaster / sponsored gas multi-node.
- Cross-contract calls multi-node.
- N > 8 committee dynamics (harness cap on a laptop).
- Long-running stability (> 3 min).

These get covered by Phase 7 testnet runs.

**Exit criterion.** Every consensus-critical scenario has a passing multi-
node test. The acknowledged gaps are tracked for Phase 7.

### Phase 7a — Mempool / ingress / gossip bug batch

A separate sub-phase that emerged during Phase 7 work — the loadgen tests
surfaced multiple mempool-path bugs interacting. They get fixed together:

| Item                                                       | Status |
| ---------------------------------------------------------- | ------ |
| `pending_txs` O(1) removal (HashMap by tx hash)             | Done (#231) |
| Proposer clones instead of drains pending mempool           | Done (#231) |
| RPC ingress validation                                      | Done (task P7a-3) |
| Synchronous broadcast (publish before returning OK)         | Done (task P7a-4) |
| Gossip retry for uncommitted pending txs                    | Pending (task P7a-5) |
| Stuck-sender diagnostic                                     | Pending (task P7a-7) |
| Re-run loadgen against the full batch                       | Pending (task P7a-8) |

Phase 7 is blocked on completing P7a-5 and the retry loop.

---

## 19.9 Phase 7 — Testnet Alpha

**Goal.** First public exposure. Real users, real load, real bugs.

| Item                                                       | Status |
| ---------------------------------------------------------- | ------ |
| Stress: 1,000 TPS plaintext sustained 10 min                 | Pending |
| Stress: 5,000 TPS plaintext sustained 10 min                 | Pending |
| Stress: 10,000 TPS plaintext sustained 10 min (v1 lower target) | Pending |
| Stress: 30,000 TPS plaintext burst 30 sec (v1 upper target)  | Pending |
| Stress: 500 TPS encrypted sustained                          | Pending |
| Deep call chain: 50 nested calls; 1,000 non-conflicting transfers | Pending |
| Testnet genesis config + validator registration flow         | Pending |
| Deploy 16 validators across 3+ regions                       | Pending |
| Deploy 8 full nodes with public RPC endpoints                | Pending |
| Prometheus + Grafana stack (already in `docker/`)             | Pending |
| Testnet faucet service                                       | Pending (binary done) |
| Block explorer backend (indexer + REST + frontend)           | Pending |
| Connect-to-testnet docs + quickstart                          | Pending |
| Run testnet alpha 30+ days continuously                       | Pending |
| Bug bounty program (testnet tier)                            | Pending |

**Exit criterion.** 30 days of continuous operation with public load.
Performance harness (`docs/PERFORMANCE_HARNESS.md`) measures real TPS.
Under the **"claim 1/3 of measured peak"** rule, the headline number is
~1/3 of what the harness sustained. v1 honest target: **10-30K plaintext
TPS, 0.5-2K encrypted TPS** on commodity committee hardware. Critical
bugs from external participants triaged and fixed.

---

## 19.10 Phase 8 — External Audits

**Goal.** Independent expert eyes on every part of the protocol.

| Audit scope                                                      | Status   |
| ---------------------------------------------------------------- | -------- |
| Audit scope document                                             | Pending  |
| Threat model + crypto assumptions + trust boundaries + invariants| Pending  |
| External audit: consensus layer                                  | Pending  |
| External audit: PVM + execution                                  | Pending  |
| External audit: crypto (FALCON, Kyber, Poseidon2, threshold, PSS, VRF) | Pending |
| External audit: networking layer                                 | Pending  |
| External audit: otic compiler                                    | Pending  |
| Penetration testing: P2P flooding, RPC DoS, eclipse attacks       | Pending  |
| Remediate all critical + high findings; re-audit remediation      | Pending  |

Note: Pyde does **not** combine audits. Each scope gets a specialist
audit firm. Budget: ~$500K-$1M per scope.

**Exit criterion.** All critical and high findings remediated, with
re-audit confirmation. Audit reports published.

---

## 19.11 Phase 9 — Incentivized Testnet

**Goal.** Three months of "this is real" exposure with reference dApps,
real PYDE-equivalent rewards, and a wide validator + user base.

| Item                                                       | Status |
| ---------------------------------------------------------- | ------ |
| Deploy incentivized testnet with reward tracking            | Pending |
| Mainnet-scale bug bounty                                    | Pending |
| Reference dApps: DEX, lending, NFT marketplace              | Pending |
| Run 3+ months continuously                                  | Pending |
| Headline TPS (v1 target band 10-30K plaintext) sustained under incentivized load, harness-measured | Pending |
| 7-day no-restart sustain test                                | Pending |
| Document all community-found issues                         | Pending |
| Fix all critical + high severity before launch              | Pending |

**Exit criterion.** 90+ days of public operation under incentivized
load. No critical / high bugs outstanding. Reference dApps stable.

---

## 19.12 Phase 10 — Mainnet Genesis

**Goal.** Launch.

| Item                                                       | Status |
| ---------------------------------------------------------- | ------ |
| Finalize mainnet genesis config                             | Pending |
| Finalize token distribution                                 | Pending |
| Recruit + validate 128+ genesis validators (hardware bench + Phase 7/9 participation) | Pending |
| Geo-distributed genesis full nodes + public RPC              | Pending |
| Mainnet block explorer deployed                              | Pending |
| 24/7 monitoring + alerting                                   | Pending |
| Incident response process + on-call rotation                | Pending |
| Operator docs published; status page live                    | Pending |
| Genesis ceremony: validator DKG -> threshold pubkey -> genesis block signed -> chain hash published | Pending |
| Network launch                                              | Pending |

**Exit criterion.** Mainnet block 1 exists, hard-finalized, with the
genesis state matching the published spec.

---

## 19.13 What's Out of Scope for Mainnet

Tracked but explicitly **not** required for genesis:

| Item                                                       | Tracked as            |
| ---------------------------------------------------------- | --------------------- |
| ZK-proven execution (STARK validity proofs)                 | Post-mainnet research |
| Parachain SDK (Rust/Go/C++)                                 | Post-mainnet          |
| TypeScript SDK (dedicated package)                          | Post-mainnet          |
| Native bridge to Ethereum                                   | Post-mainnet          |
| Native bridge to Bitcoin                                    | Post-mainnet (per demand)|
| Signed-mempool commitments + censorship slashing            | Post-mainnet hardening|
| Pedersen / KZG commitments for PSS                          | Post-mainnet hardening|
| Algebraic batch FALCON verification                          | Post-mainnet hardening|
| Persistent receipt archive (archive-node mode)              | Post-mainnet (task 058)|
| Graceful drain-and-shutdown on persist failure              | Post-mainnet (task 014e)|
| Two-dimensional gas (exec + prove)                           | Post-mainnet (depends on ZK) |
| Sentry-node validator hiding (built into protocol)          | Operational pattern   |
| Sophisticated peer-scoring (multi-topic, decay)              | Post-mainnet hardening|

Each of these is a known direction, with explicit reasoning for why it
isn't on the launch critical path. None are blockers; all are improvements
the network can adopt over time.

---

## 19.14 Risk and Mitigation

The honest list of what could go wrong.

| Risk                                          | Mitigation                                          |
| --------------------------------------------- | --------------------------------------------------- |
| Audit finds a critical bug late in Phase 8     | Phase 9 buffer + emergency-pause window + re-audit  |
| Phase 7 testnet hits a perf wall under load    | Tune mempool / gossipsub / VM / state commit; iterate|
| Genesis validator set fails to assemble        | Validator-bootstrap fund seeds operators; recruit broadly|
| Network divergence on first hard fork after launch | Conservative activation window; emergency pause   |
| ml-kem 0.3.0-rc has a CVE before stable        | Pin version; upgrade as soon as stable releases     |
| Treasury multisig signer compromise            | Rotate via `RotateMultisig`; bound scope keeps damage |
| Validator-key compromise                       | Key rotation + slashing makes operator response a clear path|

The plan assumes things will go wrong. The structure — extended
incentivized testnet, five external audits, voluntary upgrade path — is
about giving the chain enough visibility and recovery margin that no
single failure ends it.

---

## 19.15 Sequencing

Pyde mainnet is **gated on completion, not on a date**. The phases above
have clear exit criteria; the chain ships when every gate is passed.

Strict prerequisites:
- Phase 1 (safety fixes) must complete before any testnet load.
- Phase 3 (MEV pipeline + DAG consensus) must complete before Phase 6
  multi-node tests.
- Phase 7 (testnet alpha) must demonstrate the headline numbers before
  Phase 8 audits begin.
- Phase 8 audits must remediate all critical + high findings before
  Phase 9 incentivized testnet.
- Phase 9 must run for an extended period without critical incidents
  before Phase 10 mainnet genesis.

Phases 2, 4, 5, and 8 can overlap with the critical path. Phase 5
(hardening + CI) is continuous from Phase 4 onward.

Public progress lives in `MAINNET_PLAN.md` at the repo root. No external
timeline is published — the chain ships when it's ready.

---

## Summary

| Phase | What it produces                                                |
| ----- | --------------------------------------------------------------- |
| 1     | A safe consensus core (no lost votes, no silent slash failures) |
| 2     | A book that matches the shipped scope                            |
| 3     | The MEV protection pipeline working end-to-end                   |
| 4     | A real on-chain economic system (token, vesting, multisig, pause) |
| 5     | CI-enforced quality, fuzz coverage, property tests                |
| 6     | Multi-node test coverage of consensus + tx flow                   |
| 7     | Public testnet, real load, headline TPS demonstrated              |
| 8     | Independent audits across 5 scopes, critical findings remediated  |
| 9     | 90+ days of incentivized exposure with reference dApps             |
| 10    | Mainnet genesis ceremony and live network                         |

The next chapter is the appendix — glossary, reference tables, and the
post-mainnet roadmap in one place.
