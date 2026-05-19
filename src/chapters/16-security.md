# Chapter 16: Security

Security is the substrate on which every other property of Pyde rests.
This chapter catalogs the realistic attack surface at mainnet, the concrete
defense for each class, the invariants that make the BFT safety argument
work, and the operational hygiene that keeps a post-launch network
healthy.

The scope of this chapter is the *shipped* mainnet. Where a defense is on
the post-mainnet hardening list rather than live, the chapter says so.

---

## 16.1 Attack Surface

| Attack class                | Severity  | Primary defense                                           |
| --------------------------- | --------- | --------------------------------------------------------- |
| 51% / Byzantine takeover    | Critical  | BFT `f < n/3` with equal-vote committee, Mysticeti DAG safety|
| Long-range attack           | High      | Weak-subjectivity checkpoints; hard-finality irreversibility|
| Sybil attack                | High      | Two-tier staking (10M committee / 100K non-committee) + operator-identity cap |
| Eclipse attack              | High      | Layered discovery (no DHT) + FALCON peer auth + sentry pattern |
| DDoS (network-level)        | Medium    | Rate limiting, peer scoring, per-channel size caps, sentry  |
| Front-running / MEV         | High      | Optional threshold encryption + commit-before-reveal DAG (Ch 9)|
| State manipulation          | Critical  | JMT batched Merkle proofs, deterministic replay, 2 state roots (Blake3+Poseidon2) |
| Quantum attacks              | Critical  | Entire stack is post-quantum from genesis (Ch 8)            |
| Smart contract exploit       | High      | Otigen default safety (no reentrancy, checked arithmetic)   |
| VM / AOT exploit              | Critical  | 12 trap kinds, audit-verified bounds checks                 |
| Consensus persistence loss    | Critical  | `WriteOptions::set_sync(true)` + panic-on-persist-failure  |
| Replay across chains          | High      | Mandatory `chain_id` in every tx hash                       |
| Treasury drain                | Critical  | Multisig-only spend + `data_digest` audit trail             |
| Threshold crypto break        | Critical  | Hard halt + emergency pause + key rotation procedure        |

Each of these is covered in more detail below.

---

## 16.2 BFT Safety and Liveness

### The guarantee

**Safety (Mysticeti DAG):** no two conflicting subdag commits or state
roots ever achieve finality at the same wave, provided fewer than
`f = ⌊(n-1)/3⌋ = 42` committee members are Byzantine. At `n = 128`,
this is `f ≤ 42`, threshold `2f + 1 = 85`.

**Liveness:** the DAG advances and produces wave commits as long as
`85 of 128` committee members are honest and online.

### Why it holds

Each vertex carries ≥ 85 parent vertex references. An anchor commit at
round R+3 requires Mysticeti 3-stage support — at least 85 round-(R+1)
vertices that reference the anchor as a parent. Two conflicting commits
of contradictory subdags at the same wave would each need 85+ signing
vertices; the total exceeds `n = 128`, so at least `85 + 85 − 128 = 42`
honest members would have had to equivocate (sign in both forks). Under
the Byzantine bound, at most 42 are adversarial. Equivocation is
slashable evidence at `100% of stake`, so the cost is total. ∎

State-root divergence (two contradictory Blake3 state roots both signed
by 85 members) is detected automatically and triggers a **hard halt**
(Chapter 7 / `docs/CHAIN_HALT.md`).

### What if more than 1/3 are Byzantine

The protocol cannot promise safety above the 1/3 threshold; that's a
mathematical limit of BFT consensus. Defenses:

1. **Raise the cost.** 10M PYDE per committee validator × 43 = 430M PYDE
   at stake minimum for a safety violation, all slashable at 100%.
   Slashing evidence can be submitted with a 10% finder's fee, creating
   economic incentive for whistleblowers.
2. **Weak-subjectivity checkpoints.** If an adversary somehow accumulated
   ≥ 1/3 and started forking, nodes that sync from a recent checkpoint
   reject the fork outright (§16.3).
3. **Hard halt on detected divergence.** State root divergence (two
   signed contradictory roots) triggers an automatic chain halt; the
   network stops producing wave commits until the divergence is resolved
   (Chapter 7).
4. **Social consensus.** As with every BFT chain, the final backstop is
   human coordination: if the chain demonstrably goes off the rails, the
   honest majority forks away and the broken chain loses social
   legitimacy.

---

## 16.3 Long-Range Attacks and Weak Subjectivity

### The attack

An attacker buys (or otherwise acquires) a majority of validator keys
that were active at some point in the past. They create a long
alternative chain starting from that point — completely different history,
potentially different token holders. If a fresh node syncs without any
reference point, it cannot distinguish the real chain from the alternative.

### The defense: weak-subjectivity checkpoints

When a wave commit collects ≥ 85 FALCON state-root signatures, the
validator writes a `FinalityCheckpoint` to the consensus store:

```rust
struct FinalityCheckpoint {
    wave_id:    u64,
    blake3_state_root:    Hash,
    poseidon2_state_root: Hash,
}
```

(Stored under `FINALITY_CHECKPOINT_KEY` in
`crates/node/src/consensus_store.rs`.)

A node that's currently synced will **refuse to reorg past the latest
checkpoint**. `FinalityTracker::can_reorg(wave_id)` returns false for any
wave at or before the checkpoint's `wave_id`.

For a cold-syncing node, the protocol doesn't pick a checkpoint on its
own — the node's operator provides a **trusted recent block hash** from a
source they trust (the Foundation website, a public explorer, a known
good peer). This is called "weak subjectivity" because new nodes must
trust *something* outside pure protocol to anchor their sync.

The human-trust assumption is narrow: all you need is any one honest,
recent observation of the chain. Once anchored, the node enforces its own
local checkpoint going forward.

### Bootstrap peers

The genesis block hash is built into the client binary — no external
trust needed for it. The `MAINNET_BOOTSTRAP` and `TESTNET_BOOTSTRAP` lists
(`crates/net/src/discovery.rs`) provide starting peers, which provide the
current chain state. A new node combines:

1. Genesis block hash (hard-coded).
2. Recent weak-subjectivity checkpoint (operator-provided).
3. Current peer set (from `bootstrap_peers`).

—to pin down which chain is real without requiring a full replay from
genesis.

---

## 16.4 Sybil Resistance

### The attack

An adversary creates thousands of validator identities to dominate
consensus — bypassing the `f < n/3` bound by simply *being* the majority.

### The defense

The two-tier staking model (10M PYDE committee floor, 100K non-committee
floor), combined with equal voting in the committee, means:

- Each committee identity costs 10M PYDE locked.
- No stake weighting in voting — holding more PYDE than the floor doesn't
  give more votes within the committee.
- Committee selection is uniform random over all eligible validators
  (filtered by min-stake and operator-identity cap), not stake-weighted
  proportional sampling.
- **Operator identity cap:** the same KYC operator cannot hold more than
  N committee seats (configurable, typically 3-5 at launch). Prevents
  one operator running 100 "different" validators.

Economic cost of overwhelming consensus:

```
f + 1 = 43 validators needed for a Byzantine fork
43 × 10M PYDE = 430M PYDE locked
Plus: each one is slashable at 100% on equivocation evidence.
Plus: operator-identity cap prevents 43 from being the same operator.
```

At any reasonable PYDE price, that's a major capital commitment — and the
returns from a detected Byzantine attack are negative (all 43 are
slashed, stake burned, 10% goes to the whistleblower).

### Genesis Sybil resistance

The initial 128-validator set is Foundation-curated at genesis (Phase 10
of the launch plan, recruited + validated across 3+ regions). This is a
"trusted launch" assumption — not that the Foundation is trusted forever,
but that the initial set is diverse and honest. After genesis, committee
rotation and permissionless stake-based registration do the rest.

---

## 16.5 Eclipse Attacks

### The attack

An adversary surrounds a single target validator with only-adversary
peers. The target sees whatever the adversary wants them to see: fake
proposals, faked votes, a fake chain. If the adversary can eclipse enough
validators, they can force consensus on a fake state (though safety still
holds under the 1/3 rule, liveness can be hurt).

### The defense

1. **Peer diversity.** The peer manager
   (`crates/net/src/peer.rs`) caps connections per `/24` subnet. An
   adversary would need to control IP addresses across many subnets, not
   just spin up lots of VMs on one provider.
2. **Layered discovery (no DHT).** Pyde explicitly chose not to use a
   Kademlia DHT (Chapter 12). Discovery is layered: hardcoded seeds, DNS,
   on-chain validator registry, PEX, local cache. This eliminates the
   DHT-poisoning eclipse vector — an attacker can't pollute a routing
   table that doesn't exist.
3. **FALCON peer authentication** (§12.4). After the libp2p connection,
   peers run a FALCON-signed attestation that binds PeerId to a
   post-quantum identity. An adversary can't clone a validator's PeerId
   without their FALCON secret key.
4. **Sentry node pattern (Chapter 12).** Committee validators are
   reachable only through trusted sentry proxies — their real IPs are
   not in the public peer set. Eclipsing a committee validator requires
   compromising the sentry layer, not just the public network.
5. **Validator-channel filtering.** The vertex channel only accepts
   messages from peers whose attested FALCON pubkey is in the current
   committee. A non-validator eclipse peer can inject garbage on gossip
   topics but cannot fake vertex signatures.

### What isn't defended (yet)

The current peer-scoring system is deliberately simple (reputation =
`messages_received - 10 * invalid_messages`). A more sophisticated
gossipsub score with per-topic weights, decay parameters, and gray-listing
is on the post-mainnet hardening list. The current model is enough for
the DDoS-shaped threats at mainnet scale; more sophisticated Eclipse
attacks against one specific validator would show up as anomalous peer
behavior that operators could see in their metrics.

---

## 16.6 DDoS Resistance

### Connection-level

```rust
DEFAULT_RATE_LIMIT_PER_IP = 5 conns/sec
DEFAULT_MAX_PEERS         = 50
DEFAULT_MAX_INBOUND       = 30
DEFAULT_MAX_OUTBOUND      = 20
```

Per-IP rate limiter throttles new connections; per-subnet limit prevents
one network from hogging peer slots. An attacker flooding an RPC endpoint
bumps against `conn_rate_limit_per_ip` and saturates at 5 new connections
per second per source address.

### Evidence-ingest rate limiting (task 014d)

A non-validator peer can submit evidence messages to validators that then
verify them. Naive validators would FALCON-verify every evidence message
at ~60 µs each — enough for a flood of invalid evidence to saturate CPU.

The fix: token-bucket rate limit on evidence messages, applied per-peer.
Repeat offenders are dropped after the first failed verification instead
of verifying indefinitely. Lives in `crates/net/src/ddos.rs`.

### Per-channel message size limits

Each gossipsub channel has its own max message size:

| Channel        | Max size |
| -------------- | -------- |
| Vertices       | 256 KB   |
| Transactions   | 128 KB   |
| Batches        | 4 MB     |
| Sync           | 16 MB    |
| Evidence       | 64 KB    |

Oversized messages are rejected and the sender takes a reputation hit.

### RPC ingress validation (task P7a-3)

Invalid transactions never enter the mempool. The ingress validator
(`crates/node/src/rpc.rs::ingress_validate`) checks chain_id, FALCON sig,
nonce window, balance, gas bounds, deadline, access-list duplicates, tx
size, calldata size — all before returning Ok or gossipping. Pollution is
isolated to the single ingress node.

### Mempool per-sender caps

```
DEFAULT_MAX_TX_PER_WINDOW_PER_SENDER = 10  (per 1-sec window)
DEFAULT_MAX_CONCURRENT_PER_SENDER    = 100 (concurrent txs in pool)
```

A single spammer cannot flood the mempool. If they try, their per-sender
quota blocks further submissions until the window slides.

---

## 16.7 Front-Running and MEV

Covered in detail in Chapter 9. The short version:

- **Optional threshold-encrypted mempool.** Tx payload hidden from
  everyone until 85-of-128 Kyber shares combine. Users opt in per tx.
- **Commit-before-reveal DAG ordering.** The DAG anchor commit at round
  R+3 fixes the canonical order; decryption shares are released only at
  R+4. No actor has both "can read contents" and "can alter order" at
  any single round.
- **Structural inclusion.** No single proposer to censor; censoring a tx
  requires ≥ 44 colluding committee members.
- **No tips.** The wire format has no priority-fee field.

Each layer closes attacks the others cannot. Together, MEV is not
discouraged — it is structurally unexpressible.

---

## 16.8 State Manipulation

### The attack

A malicious vertex producer submits a wave-anchor candidate whose claimed
post-state root doesn't actually match the result of executing the wave's
transactions. Honest validators would incorrectly accept a bogus state.

### The defense

Every honest validator executes each committed wave themselves and
FALCON-signs `(wave_id, blake3_state_root, poseidon2_state_root)`. A
malicious vertex producer that claims a wrong root gets 0 honest
state-root sigs; the network cannot reach the 85-sig finality bar.

Two conflicting state claims can't both reach finality (same BFT
argument: > 1/3 would have to equivocate). State root divergence is
**hard-halt detectable** (Chapter 7) — the network stops automatically
once two contradictory signed roots appear.

### JMT Merkle proofs

For light clients that do not execute the wave, the JMT batched proof +
the signed `blake3_state_root` + the committee's FALCON signatures are
the authentication path. A light client verifies:

1. `HardFinalityCert` for the wave is valid (≥ 85 FALCON sigs).
2. The JMT proof from `blake3_state_root` to the specific leaf is valid.
3. The leaf value is what the light client was querying.

The chain of authentication is end-to-end cryptographic. ZK light clients
(post-mainnet) can use the parallel `poseidon2_state_root` for SNARK-based
verification at much lower cost.

---

## 16.9 Quantum Attacks

Every primitive in the protocol is post-quantum:

- **FALCON-512** signatures — NTRU lattice, not factoring.
- **Kyber-768 / ML-KEM** key exchange — lattice, not ECDH.
- **Poseidon2** hashing — algebraic, not affected by quantum.
- **Lattice VRF** — inherits FALCON security.
- **AES-256-GCM** — symmetric, 128-bit post-quantum security under
  Grover's algorithm.

The weakest link is Poseidon2's 64-bit post-quantum collision resistance
(Grover halves the exponent). 64-bit collision resistance requires
`2^64` quantum hash evaluations, which is far beyond any realistic near-
or mid-term quantum capability. If cryptanalytic advances tighten this,
a hash migration is a standard-shape protocol upgrade.

Pyde has **no elliptic-curve crypto** anywhere in the protocol. No
secp256k1, no ed25519, no BLS12-381. The libp2p transport layer uses
ed25519 for PeerId routing only; application-level authentication uses
FALCON.

---

## 16.10 Smart Contract Safety

Otigen's default-safe design (Chapter 5):

- **No reentrancy by default.** Every public function is guarded; opt out
  with `#[reentrant]`.
- **Checked arithmetic.** Overflow traps; wrapping is explicit.
- **Typed storage.** Every slot has a declared type; runtime enforces it.
- **No `tx.origin`.** The phishing vector simply doesn't exist.
- **Access-list enforcement.** `Sload`/`Sstore` against undeclared slots
  traps with `AccessListViolation`.

These defaults eliminate the most common smart-contract exploit classes
at the language level, not as library choices developers might forget.

### The otic audit surface

The compiler itself is part of the audit surface. A codegen bug could
emit bytecode that violates the source semantics. Mitigations:

- **Unit tests per codegen pattern.** The `crates/otic/tests` suite
  covers every lowering pattern.
- **Property tests** (slice 5.1) for core mechanics.
- **External audit** of the otic compiler is in Phase 8 of the mainnet
  plan (external audit: otic compiler, task 093).

---

## 16.11 VM / AOT Safety

PVM trap conditions (`crates/pvm/src/cpu.rs`):

```
Overflow, Underflow, DivisionByZero, InvalidOpcode, NarrowOverflow,
MemoryFault, StackOverflow, StackUnderflow, OutOfGas,
StaticModeViolation, Reentrancy, AccessListViolation
```

Each trap is a *clean* revert: state writes roll back, gas is consumed
up to the trap point, the transaction fails. There is no undefined
behavior path.

Post-audit hardening specific to the VM:

- **Wide register index check.** `read_wide_checked`/`write_wide_checked`
  trap on indices ≥ 8 instead of silently masking (task 013).
- **Jump/call bounds check.** The interpreter validates
  `CODE_START <= pc < code_end` on every jump (task 008).
- **AOT host error propagation.** Storage host calls return `1` on fault;
  the JITed code branches to its trap handler instead of silently
  succeeding (task 014).
- **Push-error propagation.** `host_push` now returns 1 on underlying
  store error — a stack push that hit a memory fault now traps cleanly.

The AOT compiler (Cranelift) is used as a trust-minimized component: Pyde
does not generate hand-written assembly, the Cranelift version is pinned
in `Cargo.lock`, and every compiled contract can be re-executed through
the interpreter for cross-verification.

---

## 16.12 Consensus-State Persistence

**The risk.** If a validator casts a vote, crashes before the vote is
durable, and restarts with a different view, it can double-vote on restart
— violating BFT safety.

**The defense.**

1. `WriteOptions::set_sync(true)` on every write to the consensus store
   (task 014a). A vote is not considered "cast" until `fsync` returns.
2. `panic!` + `panic = "abort"` on any persist failure (task 014b). The
   process terminates immediately. Continuing after a failed disk write
   is a BFT-unsafe operation; halting is the correct fail-safe.
3. Restart recovery reloads `seen_proposals`, `seen_votes`,
   `pending_evidence` from the consensus store (task 003, 014c).

Microbenchmark (task 014f) confirmed the per-vertex-sig fsync cost is
~25.5 µs on Apple Silicon NVMe — ~39K writes/sec headroom against the
~150 ms round cadence (≥ 1000× margin).

Gradeful drain-and-shutdown on persist failure is a post-mainnet
operational polish, not a launch blocker.

---

## 16.13 Replay Protection

### Cross-chain replay

Every transaction includes `chain_id` in the canonical hash. A
transaction signed for mainnet cannot be replayed on a testnet; a
testnet tx cannot be submitted to mainnet. Chain IDs:

| Network  | `chain_id` |
| -------- | ---------- |
| Mainnet  | 1          |
| Testnet  | TBD        |
| Devnet   | 31337      |

The chain_id is always enforced; the `dev_skip_signature` flag only
disables *signature* verification for chain_id 31337 (devnet), and only
if the config explicitly allows it. On any chain_id other than 31337,
signatures are always required (task 012).

### Same-chain replay

Each transaction has a nonce that must fit the sender's 16-slot bitmap
window (Chapter 11). Once used, the bitmap bit stays set until the window
slides past it. A replayed tx hits the bitmap and is rejected.

### Multisig replay

Treasury multisig spends include the current `MULTISIG_NONCE` in the
signing bytes. After a spend, the nonce bumps, so the same signed bytes
cannot be replayed (task 044).

### Emergency replay

`EmergencyPause` and `EmergencyResume` include the current
`MULTISIG_NONCE` in their signing context. A paused chain that auto-
expires cannot be re-paused by replaying the same signed payload.

---

## 16.14 Treasury Security

See Chapter 15 for the governance model. The treasury's on-chain
protections:

1. **Multisig-only spend.** No other transaction type drains the treasury
   account.
2. **Audit trail.** `data_digest = hash(pip_file_contents)` ties every
   spend to a published PIP.
3. **Rotation.** `RotateMultisig` can replace the signer set; no single
   signer is entrenched.
4. **Writeback-clobber protection.** `spend.target != tx.from`,
   `tx.to == 0x00` (task 045). Prevents the post-execution pipeline from
   accidentally overwriting the spend.
5. **Nonce-bound signatures.** Each spend bumps `MULTISIG_NONCE`; replays
   fail.

The multisig signer set is a trust assumption. The mitigation is scope:
the signers can spend the treasury and rotate themselves; they cannot
change consensus rules, supply, or fee distribution.

---

## 16.15 Operational Security

Aspects that are not cryptographic but matter at mainnet operation:

- **Key management.** Validator FALCON secret keys are kept in
  hardware-backed storage where possible. Key rotation transactions
  (`key_nonce` bump) exist for compromised-key recovery.
- **Sentry nodes.** Validators typically expose a sentry node for P2P
  traffic and keep the validator process unreachable directly. This is a
  deployment concern, not protocol-enforced.
- **Monitoring.** Every node exposes Prometheus metrics; operators run
  alerting on consensus participation rate, block inclusion rate, and
  peer churn.
- **Bug bounty.** A permanent bug bounty program is part of the community
  allocation (Chapter 14). The Phase 7 testnet tier has its own bounty;
  the mainnet tier will be funded at launch.
- **Incident response.** Phase 10 of the mainnet plan specifies on-call
  rotation and incident response SOPs. The emergency-pause mechanism
  gives operational response a real lever during a live exploit.

---

## 16.16 Hardening Work In-Flight

Post-audit but pre-mainnet work being tracked (from the mainnet plan):

| Task   | Status at launch                                          |
| ------ | --------------------------------------------------------- |
| Clippy/fmt/audit/deny in CI | Phase 5 hardening; shipping          |
| `cargo-fuzz` on PVM/tx/consensus/RPC/otic | Phase 5; 72+ h runs |
| Property tests on pipeline + tokenomics | Slice 5.1 shipped; 5.2 in flight |
| Witness 1 MB bound validation | Shipped (task 056)                    |
| Separate `MAX_CALLDATA` cap | Shipped (task 055)                       |
| `unsafe` block invariant docs | Phase 5; being documented              |
| `unwrap()` triage on untrusted paths | Phase 5; ongoing                |
| ml-kem 0.3.0-rc -> stable upgrade | Post-standards-release         |
| Persistent receipt store (archive mode) | Post-mainnet (task 058)  |
| Signed-commitment mandatory inclusion | Post-mainnet (Ch 9)         |
| Pedersen / KZG commitments for PSS   | Post-mainnet                   |
| Algebraic batch FALCON verify         | Post-mainnet                   |

The honest shape at mainnet: a small, audited, heavily-tested core with a
well-scoped set of known future hardening items.

---

## 16.17 External Audits

Phase 8 of the mainnet plan schedules five independent external audits
before launch:

| Audit scope                                                                       |
| --------------------------------------------------------------------------------- |
| Consensus layer (Mysticeti DAG, anchor selection, finality, slashing)             |
| PVM + execution (ISA, traps, AOT, gas accounting, hybrid scheduler)               |
| Crypto implementations (FALCON, Kyber, Blake3, Poseidon2, threshold, PSS)         |
| Networking layer (libp2p config, gossipsub, layered discovery, sentry pattern, DDoS) |
| Otigen compiler                                                                    |

Critical + high findings are remediated before mainnet; audit
remediations themselves are re-audited. Penetration testing (P2P
flooding, RPC DoS, eclipse simulations) runs in parallel.

---

## Summary

| Property / defense                          | Status at mainnet                |
| ------------------------------------------- | -------------------------------- |
| BFT safety `f < n/3`                        | Shipped                          |
| Liveness `85/128 honest + online` (2f+1)    | Shipped                          |
| Weak-subjectivity checkpoints                | Shipped                          |
| FALCON peer authentication                   | Shipped                          |
| Validator-channel filtering                  | Shipped                          |
| Evidence-ingest rate limit                   | Shipped                          |
| Per-sender mempool rate limit                | Shipped                          |
| RPC ingress validation                       | Shipped                          |
| `chain_id` replay protection                 | Shipped                          |
| Multisig-only treasury drain                 | Shipped                          |
| `panic = "abort"` on persist failure          | Shipped                          |
| Set-sync(true) consensus writes              | Shipped                          |
| 12 VM trap kinds                             | Shipped                          |
| Audit-driven wide-reg bounds check           | Shipped                          |
| Audit-driven PVM jump/call bounds check      | Shipped                          |
| Audit-driven AOT host error propagation      | Shipped                          |
| 1 MB witness size cap                         | Shipped                          |
| Separate MAX_CALLDATA cap                    | Shipped                          |
| Signed mempool commitments                   | Post-mainnet                     |
| Pedersen / KZG PSS commitments               | Post-mainnet                     |
| Algebraic batch FALCON verify                 | Post-mainnet                     |
| Archive-node receipt store                   | Post-mainnet                     |
| External audits (5 specialists)              | Pre-mainnet, Phase 8             |

The next chapter covers developer tools: the `pyde-dev` CLI, the RPC API,
the Rust and WASM SDKs, and the testnet quickstart.
