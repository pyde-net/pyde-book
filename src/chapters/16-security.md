# Chapter 16: Security

Security is the substrate on which every other property of Pyde rests.
This chapter catalogs the realistic attack surface at mainnet, the concrete
defense for each class, the invariants that make the BFT safety argument
work, and the operational hygiene that keeps a post-launch network
healthy.

The scope of this chapter is the *shipped* mainnet. Where a defense is on
the post-mainnet hardening list rather than live, the chapter says so.

> **Note.** This chapter is the *narrative* security reference. The
> canonical catalog — ~50 threats by ID, organized by layer, with
> mitigation cross-references and acknowledged residual risks — lives in
> [companion/THREAT_MODEL.md](../companion/THREAT_MODEL.md). External
> auditors should start with the threat model and use this chapter for
> context; readers building intuition should start here and dip into the
> threat model when they want the full catalog.

---

## 16.1 Attack Surface

| Attack class                | Severity  | Primary defense                                           |
| --------------------------- | --------- | --------------------------------------------------------- |
| 51% / Byzantine takeover    | Critical  | BFT `f < n/3` with equal-vote committee, Mysticeti-style safety|
| Long-range attack           | High      | Weak-subjectivity checkpoints; hard-finality irreversibility|
| Sybil attack                | High      | Layered: threshold encryption removes attack incentive + operator-identity cap (max 3/operator) + slashing + minimum stake floor |
| Eclipse attack              | High      | Layered discovery (no DHT) + FALCON peer auth + sentry pattern |
| DDoS (network-level)        | Medium    | Rate limiting, peer scoring, per-channel size caps, sentry  |
| Front-running / MEV         | High      | Optional threshold encryption + commit-before-reveal DAG (Ch 9)|
| State manipulation          | Critical  | JMT batched Merkle proofs, deterministic replay, 2 state roots (Blake3+Poseidon2) |
| Quantum attacks              | Critical  | Entire stack is post-quantum from genesis (Ch 8)            |
| Smart contract exploit       | High      | Default safety attributes (no reentrancy, checked arithmetic) enforced at runtime via the WASM execution layer |
| VM / runtime exploit         | Critical  | wasmtime sandbox (production-vetted at Microsoft / Fastly / Shopify), deterministic feature subset enforced, deploy-time import validation |
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

**Liveness:** the DAG advances and produces commits as long as
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
(Chapter 7 / [companion/CHAIN_HALT.md](../companion/CHAIN_HALT.md)).

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
   network stops producing commits until the divergence is resolved
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

When a commit collects ≥ 85 FALCON state-root signatures, the
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

An adversary creates many validator identities to dominate consensus —
bypassing the `f < n/3` bound by simply *being* the majority of the
active committee.

### The defense: layered, not stake-driven

Pyde's Sybil resistance is intentionally not anchored to stake size. The
chain's structural MEV resistance removes the primary attack incentive,
which lets the stake floor sit at a modest 10,000 PYDE (single tier) and
shifts the security burden onto a stack of qualitative defenses. Five
layers:

**1. Threshold encryption removes the attack incentive.**
The dominant reason adversaries attack BFT consensus on production
chains is MEV extraction — front-running, sandwich attacks, transaction
reordering. On Pyde, this attack value is structurally near-zero. Even
a Byzantine 1/3 cannot:
- Decrypt encrypted-mempool ciphertexts (requires 85 of 128 shares — see
  Chapter 8 §8.5);
- Reorder transactions after the DAG anchor commits the canonical order
  (Chapter 9 §9.4);
- Profitably front-run any opt-in-encrypted transaction.

This collapses the attack-profit equation that drives Ethereum-scale
stake floors (32 ETH → ~$80–120K). Pyde does not need to price stake
against MEV profits because there are no MEV profits to be made.

**2. Operator-identity cap (max 3 validators per operator).**
A Byzantine fork needs `f + 1 = 43` of 128 committee slots. Under a
3-per-operator cap, that translates to **≥ 15 distinct KYC'd operator
identities** — much harder to manufacture than capital. Identity binding
is enforced via the stake-account-to-operator mapping; high-stake
operators face additional KYC verification at registration.

**3. Slashing at 100% on safety violations.**
Equivocation and bad state-root signatures incur full-stake slashing
plus permanent ban (see Chapter 14 §14.5 / [companion/SLASHING.md](../companion/SLASHING.md)). The 10%
finder's fee creates an active whistleblower incentive — every honest
node has a financial reason to surface attacker evidence within the
21-day freshness window.

**4. Hard-halt detection on state-root divergence.**
Two contradictory signed state roots trigger an automatic chain halt
(Chapter 7 §Part 2). Attackers cannot quietly corrupt state — safety
violations are loud, visible, and immediately interrupt block
production. The 1-epoch bounded rollback policy contains damage to a
narrow window.

**5. Minimum-stake credibility deposit.**
The 10K PYDE floor is a credible-commitment deposit, not the
load-bearing economic defense. It ensures every validator has *some*
skin in the game and gives the slashing mechanism something to slash.
Combined with the operator cap, the lower bound on committed capital
for a 43-Byzantine attack is ≥ 15 operators × 3 validators × 10K PYDE =
**450K PYDE locked** plus the legal and reputational exposure of 15
KYC'd entities. Modest in dollar terms; meaningful in coordination terms.

### The honest framing

The single-number "you'd lose $N million in stake to attack" argument
that other chains lead with does not apply here. Pyde's claim is
different and stronger: **the protocol is designed such that there is no
profitable attack to fund.** Stake economics back this up at the
margin. Operator identity binding does the heavy lifting on Sybil
specifically. The threshold-encryption property does the work of
removing the attack value entirely.

This shifts the trust assumption from "stake is large enough to deter
attack" to "operator-identity binding + slashing + structural
MEV-resistance jointly make attack unprofitable and detectable." The
second is a substantively different argument and worth being explicit
about.

### Genesis Sybil resistance

The initial 128-validator set is Foundation-curated at genesis (Phase 10
of the launch plan, recruited + validated across 3+ regions). This is a
"trusted launch" assumption — not that the Foundation is trusted forever,
but that the initial set is diverse and honest. After genesis, committee
rotation and permissionless stake-based registration take over.

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

The default-safe properties Otigen the language provided are **preserved** in the WASM era. Mechanism changed; guarantees did not. See [Chapter 5 §5.6](./05-otigen-toolchain.md) for the full attribute surface.

- **No reentrancy by default.** Every function is guarded by the WASM execution layer; opt out with the `reentrant` attribute (language-native: `#[pyde::reentrant]` / `@pyde.reentrant` / `//pyde:reentrant` / `PYDE_REENTRANT`).
- **Checked arithmetic.** Encouraged by per-language SDK helper patterns; wrapping ops require explicit opt-in (e.g., Rust's `wrapping_add` is explicitly named).
- **Typed storage.** Declared in `otigen.toml` `[state]` schema; the build tool emits type-safe accessors and the runtime enforces slot-hash uniqueness.
- **No `tx.origin`.** The host function ABI exposes only `caller()` (direct caller). The Solidity-style phishing vector is absent.
- **Access-list enforcement.** Slot accesses against slots not declared in the contract's state schema fail at the host-function layer.

These defaults eliminate the most common smart-contract exploit classes at the toolchain + runtime level, not as library choices developers might forget.

### The toolchain audit surface

The `otigen` developer toolchain — specifically its state binding generators and ABI extractor — is part of the audit surface. A codegen bug in a binding generator could emit accessor code that violates declared semantics. Mitigations:

- **Unit tests per binding-generator output pattern.** Each language target (Rust, AssemblyScript, Go, C/C++) has its own generator with its own test suite covering every accessor shape.
- **Property tests** for slot-hash determinism across languages — given the same `otigen.toml`, all four generators must produce identical runtime slot_hash values for identical inputs.
- **External audit** of the `otigen` toolchain before mainnet.
- **Wasmtime as a trust-minimized dependency.** The execution runtime itself is wasmtime, which inherits years of production fuzzing and Bytecode Alliance audit attention — we do not audit a VM we built ourselves.

---

## 16.11 WASM Execution Layer Safety

Pyde's execution layer is **wasmtime** (with Cranelift AOT). The trap surface is wasmtime's, augmented by host-function-specific traps Pyde injects through the ABI.

### WASM-native traps

wasmtime traps when the executing module violates its sandbox or its fuel budget. The canonical trap conditions:

```
OutOfFuel              IntegerOverflow         IntegerDivisionByZero
MemoryOutOfBounds      StackOverflow           UndefinedElement
IndirectCallToNull     BadSignature            UnreachableCodeReached
TableOutOfBounds       Interrupt               (host-function traps)
```

Each trap is a *clean* revert: state writes roll back, gas is consumed up to the trap point (computed from fuel actually consumed), the transaction fails. There is no undefined behavior path. wasmtime's sandbox guarantees structural safety: no buffer overflows, no control-flow hijacks, no type confusion.

### Pyde-specific traps via host functions

The host functions add another trap layer for Pyde-specific safety properties:

| Trap                       | When                                                            |
| -------------------------- | --------------------------------------------------------------- |
| `ReentrancyViolation`       | A cross_call re-enters a non-`reentrant` function               |
| `AccessListViolation`       | A slot access targets a slot outside the declared state schema  |
| `ViewFunctionStateModify`   | A state-modifying host call inside a `view`-attributed function |
| `NonPayableValueAttached`   | `tx.value > 0` on a non-`payable` function                      |
| `ConstructorReentrant`      | An attempt to call a `constructor`-attributed function post-deploy |
| `GasTankExhausted`          | A `sponsored` function's contract gas tank ran out               |
| `InsufficientBalance`       | `transfer` host call when sender balance is below amount         |
| `ForbiddenImport`           | (deploy-time only) module imports a function outside the ABI allowlist |

### Determinism enforcement

wasmtime is configured to reject any module that uses non-deterministic features. The config enforces (at module instantiation and at deploy validation):

- `cranelift_nan_canonicalization(true)` — floating-point NaN bit patterns canonicalized identically across all validators
- `wasm_threads(false)` — no threading (non-deterministic by definition)
- `wasm_simd(false)`, `wasm_relaxed_simd(false)` — SIMD disabled until a deterministic-only subset is vetted
- `wasm_reference_types(false)`, `wasm_gc(false)`, `wasm_function_references(false)` — complexity surface gated until needed
- `wasm_multi_memory(false)`, `wasm_memory64(false)` — explicit memory layout
- No WASI imports

A deploy-time validator (`crates/wasm-exec/src/validate.rs`) re-checks the module's import section against the allowlist and rejects anything that would slip past wasmtime's instantiation check.

### Trust-minimization of the runtime

We do not audit wasmtime itself — that work is done continuously by the Bytecode Alliance with years of production fuzzing under adversarial workloads. We pin a tagged wasmtime version per chain release, document the version in the protocol upgrade record, and require validators to upgrade in coordinated forks when we move it. This is a meaningfully smaller audit surface than maintaining a custom VM ourselves would have been (see [The Pivot preface](../preface/pivot.md) for the full reasoning).

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
signatures are always required.

### Same-chain replay

Each transaction has a nonce that must fit the sender's 16-slot bitmap
window (Chapter 11). Once used, the bitmap bit stays set until the window
slides past it. A replayed tx hits the bitmap and is rejected.

### Multisig replay

Treasury multisig spends include the current `MULTISIG_NONCE` in the
signing bytes. After a spend, the nonce bumps, so the same signed bytes
cannot be replayed.

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
   `tx.to == 0x00`. Prevents the post-execution pipeline from
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

Pre-mainnet hardening work tracked in the launch plan (chapter 19):

| Task   | Status                                                   |
| ------ | --------------------------------------------------------- |
| Clippy/fmt/audit/deny in CI | Hardening track; shipping             |
| `cargo-fuzz` on wasm-exec / tx / consensus / RPC / otigen toolchain | 72+ h runs           |
| Property tests on pipeline + tokenomics | Initial properties shipped; expanding |
| Witness 1 MB bound validation | Shipped                              |
| Separate `MAX_CALLDATA` cap | Shipped                                |
| `unsafe` block invariant docs | Being documented                     |
| `unwrap()` triage on untrusted paths | Ongoing                       |
| ml-kem 0.3.0-rc -> stable upgrade | Post-standards-release         |
| Persistent receipt store (archive mode) | Post-mainnet            |
| Signed-commitment mandatory inclusion | Post-mainnet (Ch 9)     |
| Pedersen / KZG commitments for PSS   | Post-mainnet                   |
| Algebraic batch FALCON verify         | Post-mainnet                   |

The honest shape at mainnet: a small, audited, heavily-tested core with a
well-scoped set of known future hardening items.

---

## 16.17 External Audits

The launch plan schedules five independent external audits before
mainnet:

| Audit scope                                                                       |
| --------------------------------------------------------------------------------- |
| Consensus layer (Mysticeti DAG, anchor selection, finality, slashing)             |
| Execution layer (Pyde's host-function ABI, the `wasm-exec` integration, fuel-to-gas mapping, Block-STM scheduler + MVCC layer + determinism contract) |
| Crypto implementations (FALCON, Kyber, Blake3, Poseidon2, threshold, PSS) — in `pyde-crypto` polyrepo |
| Networking layer (libp2p config, gossipsub, layered discovery, sentry pattern, DDoS) |
| `otigen` developer toolchain (binding generators, ABI extraction, deploy flow, wallet) |

Note: wasmtime itself is not separately audited — it is a vetted production dependency from the Bytecode Alliance. The Pyde audit focuses on the integration surface (host functions, fuel mapping, validation gate, module cache) and on the toolchain that emits the WASM modules.

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
| WASM sandbox (wasmtime, production-vetted)   | Inherited from wasmtime          |
| Deterministic-feature-subset enforcement     | Shipped (deploy-time validator)  |
| Host-function-level safety traps             | Designed; implementation in flight |
| Reentrancy guard (default-on)                | Designed; runtime in flight      |
| 1 MB witness size cap                         | Shipped                          |
| Separate MAX_CALLDATA cap                    | Shipped                          |
| Signed mempool commitments                   | Post-mainnet                     |
| Pedersen / KZG PSS commitments               | Post-mainnet                     |
| Algebraic batch FALCON verify                 | Post-mainnet                     |
| Archive-node receipt store                   | Post-mainnet                     |
| External audits (5 specialists)              | Pre-mainnet, Phase 8             |

The next chapter covers developer tools: the `otigen` developer toolchain, the `pyde` node binary, the Rust and TypeScript SDKs, the WASM crypto bindings, and the JSON-RPC surface.
