# Consensus: Mysticeti DAG

**Note: This chapter reflects the post-2026 pivot. The previous HotStuff variant is archived in `archive/`.**

Pyde's consensus is a **Mysticeti-style DAG protocol**. A committee of 128 validators participates each epoch; every round (~150ms), each member produces exactly one vertex; commits flow continuously at the round rate; finality lands at ~500ms median.

There is **no single proposer**, **no view changes**, and **no separate prove-then-commit pipeline**. Order emerges deterministically from the DAG by every honest validator independently.

## 1. Why DAG (Why Not HotStuff)

Pyde's previous architecture used a modified pipelined HotStuff with VRF proposer selection. Persistent wedges, head-divergence deadlocks, and view-change cascades motivated a rebuild.

The DAG approach removes the fragile parts:

| Problem in HotStuff | DAG resolution |
|---|---|
| Single proposer bottleneck | No proposer — every member contributes |
| View change protocol complexity | No view changes — eliminated entire failure class |
| Timing-driven slot pipeline | Data-driven rounds advance with quorum, not clock |
| Proposer can censor selectively | 127 honest can include; censorship requires near-unanimous |
| Proposer can extract MEV | No single party reorders; order emerges from DAG |
| Throughput limited by leader bandwidth | Scales with committee size |
| HotStuff bugs cluster in view-change code | DAG doesn't have view-change code |

The same lab/laptop devnet that hit ~4K TPS under pre-pivot HotStuff is the baseline against which DAG performance will be measured. The v1 honest throughput target (to be established by the multi-region performance harness) covers both the plaintext path and the commit-reveal private-mempool path (Chapter 9) under production-realistic conditions.

## 2. Worker / Primary Split (Narwhal Pattern)

Each validator runs:
- **Workers (1 or more processes):** handle high-volume transaction ingress, build batches, gossip batches peer-to-peer
- **Primary (1 process per validator):** handles consensus — produces vertices, gathers parents, signs state roots

```
┌──────────────────────────────────────────────────┐
│ Validator                                        │
│                                                  │
│  ┌───────────────┐   ┌────────────────────────┐ │
│  │   Workers     │   │       Primary          │ │
│  │  (N parallel) │   │                        │ │
│  │               │   │  - One vertex / round  │ │
│  │ - Tx ingress  │◄──┤  - Tracks local DAG    │ │
│  │ - Batches     │   │  - Anchor selection    │ │
│  │ - Gossip      │   │  - State root signing  │ │
│  │               │   │  - Beacon signing      │ │
│  │               │   └────────────────────────┘ │
│  └───────────────┘                                │
└──────────────────────────────────────────────────┘
```

This separation is load-bearing: it lets data flow at network-rate while consensus messages stay small (~few KB).

## 3. The Vertex

```rust
struct Vertex {
    round: u64,
    member_id: u32,                          // committee position
    batch_refs: Vec<BatchHash>,              // batches I have, by hash
    parent_vertex_refs: Vec<VertexHash>,     // ≥85 round-(N-1) hashes
    state_root_sigs: Vec<StateRootSig>,      // attestations on recent commits
    prev_anchor_attestation: VertexHash,     // attests prior anchor
    falcon_sig: FalconSig,                   // sig over the vertex
}
```

Three categories of references in a vertex:
- **batch_refs:** point to data (batch blobs in worker storage)
- **parent_vertex_refs:** point to consensus structure (prior round's vertices)
- **state_root_sigs + prev_anchor_attestation:** point to consensus output (recent commits)

A vertex is dual-role: **header** (declaring what data I have) AND **attestation** (acknowledging prior-round work via parent refs). Parent refs ARE the implicit votes — no separate vote messages.

### Vertex Size

Compact-encoded (parent refs as bitmap, hash truncation):
- Minimal: ~830 bytes
- Heavy (50 batches + 5 sigs + state-root attestations): ~25 KB
- Hard limit: 64 KB

## 4. Rounds

A round is a layer in the DAG. The round counter is **data-driven**, not clock-driven:

A member ticks from round N to N+1 the moment they collect ≥85 valid round-N parent vertices in their local DAG view. Slow members lag behind in their counter; the slowest 43 of 128 don't block anyone (128 − 85 = 43 can lag without holding up the rest).

```
Round 5: [128 vertices, one per member]
            ↑↑↑↑↑ each refs ≥85 of layer 4 ↑↑↑↑↑
Round 4: [128 vertices]
            ↑↑↑↑↑ each refs ≥85 of layer 3 ↑↑↑↑↑
Round 3: [128 vertices]
... etc
```

**Parent rule:** parents must be strictly from prior round (`round_N - 1`). No skip edges in v1. This guarantees acyclicity; violations are slashable.

**Round rate:** ~5-10 rounds/sec depending on network conditions. Faster than 400ms slots while requiring no clock-based timeouts.

## 5. Anchor Selection

Each round has a deterministically-selected **anchor**:

```
anchor_member_id = Hash(beacon, round, prev_state_root) mod 128
```

Components:
- **beacon:** epoch-scoped randomness, published in last wave of prior epoch
- **round:** current round number
- **prev_state_root:** state root from N=3 rounds ago (limits anchor predictability to ~450ms)

Properties:
- **Deterministic:** every honest validator computes the same answer
- **Unpredictable:** depends on state root that wasn't known until recently
- **No single proposer authority:** anchor doesn't propose, it's just a starting point for the subdag walk

## 5b. Round vs Wave: terminology

The distinction matters because the two terms diverge under skips:

- **Round** = a horizontal layer in the DAG. Every committee member produces exactly one vertex per round. Round numbers **always advance** (~150ms each), never skip.
- **Wave** = a successful commit. Wave IDs only increment when an anchor commits. Wave IDs are **sparse** when rounds skip.

If round 5's anchor (`Hash(beacon, 5, prev_state_root) mod 128 = validator 88`) is missing:
- Round 5 still happens. The other 127 validators produce their round-5 vertices.
- No wave commits for round 5.
- Round 6 happens; its anchor is a **different** validator (probably).
- If round 6's anchor succeeds, that wave commits the subdag spanning rounds 5 + 6.

**Chain cannot get stuck on one missing anchor.** Each round picks a new anchor candidate via the formula, so consecutive failures require consecutive bad luck (or multi-validator outage). The protocol only enters hard-halt territory beyond ~20 consecutive failed anchors (per [Chain Halt & Recovery](../companion/CHAIN_HALT.md)).

### Skipped rounds in the chain log

Wave commit records carry both the current `anchor_round` and the `prior_anchor_round`. Skipped rounds are implicit from the gap:

```text
WaveCommitRecord(wave_id=6, anchor_round=10, prior_anchor_round=Some(9))   → no skips
WaveCommitRecord(wave_id=7, anchor_round=16, prior_anchor_round=Some(10))  → rounds 11-15 skipped (5 consecutive)
```

No separate `skipped_rounds[]` table. The gap IS the record.

---

## 5c. Missing-Vertex Handling

When a validator needs a vertex it doesn't have (either the anchor or any vertex in the subdag walk), it fetches the vertex from peers via the dedicated consensus channel.

```text
Validator's local processing:

  Walking anchor → parent V_a → V_a's parent V_b ...
  Hits a missing vertex V_x referenced by some V in the subdag.

  Issues fetch request: get_vertex(V_x_hash) to up-to-8 peers in parallel.
  
  Outcome 1 (typical, ~99.9% of cases):
    A peer responds within <500ms with V_x.
    Validator verifies V_x's FALCON sig, places it in local DAG.
    Continues subdag walk.
    Wave commits normally.

  Outcome 2 (rare):
    No peer responds within the structural timeout (~rounds R+3 materialized).
    Validator marks this commit as "cannot complete."
    Wave does NOT commit; same handling as anchor-skip.
    Vertices stay in DAG; next anchor will retry.
```

**Critical principle:** validators NEVER assume "the vertex wasn't gossipped" when missing it. They assume "I haven't received it yet" and fetch. Dropping waves on missing vertices would make the chain trivially censurable.

**The fetch protocol** lives in the network layer (Chapter 12 + [companion/NETWORK_PROTOCOL.md](../companion/NETWORK_PROTOCOL.md)) as a libp2p request-response stream, separate from gossipsub. The fetch is fire-and-retry — ask peer A, if no response in 500ms ask peer B, etc.

### Skipped-round recovery walkthrough

5 consecutive skips (rounds 11-15), commit at round 16:

```text
Round:    10      11      12      13      14      15      16
Outcome:  WAVE 6  skip    skip    skip    skip    skip    WAVE 7
                  (vertices still produced;
                   accumulate in DAG)
                                                          ↑
                                                          subdag walk goes back
                                                          to wave 6's frontier

At round 16's commit (wave 7):
  Subdag walk from v_r16_anchor:
    - v_r16_anchor's parents = 85+ round-15 vertices
    - each round-15 vertex's parents = 85+ round-14 vertices
    - ...continue back through rounds 14, 13, 12, 11
    - round-11 vertices' parents = 85+ round-10 vertices ← STOP
                                    (these were committed in wave 6)
  
  Subdag = vertices from rounds 11, 12, 13, 14, 15, 16
         ≈ 6 × 128 = 768 vertices total

  Execute all txs in canonical order (round ascending → member_id → list_order)
  Compute state_root after applying all changes
  Compute events_root (Blake3 Merkle tree over canonical-ordered events) + events_bloom
  Sign HardFinalityCert(wave_id=7, state_root, events_root, events_bloom)
  Wave 7 record: WaveCommitRecord(wave_id=7, anchor_round=16, prior_anchor_round=Some(10),
                                  state_root=..., events_root=..., events_bloom=...,
                                  events_count=..., tx_count=..., gas_used=...)
```

The wave commit record carries both state and events summaries; both are threshold-signed in the `HardFinalityCert` so light clients verify event inclusion identically to state. Full structure + indexing mechanics: [Host Function ABI Spec §15.2](../companion/HOST_FN_ABI_SPEC.md).

Properties:
- **Zero tx loss.** Every vertex produced eventually commits.
- **Bounded latency cost.** Each skip adds ~150-300ms to confirmation time.
- **No special "catch up" code.** The standard subdag-walk handles it. The BFS just walks more rounds when there's a wider gap.

---

## 6. Commit

When the anchor vertex collects sufficient support from later rounds (Mysticeti 3-stage support), a commit fires:

```
1. Anchor selected (deterministic by formula above)
2. Walk anchor's parent_vertex_refs transitively → collect "subdag"
3. Sort subdag deterministically:
     - primary key: round number ascending
     - secondary key: member_id
     - tertiary key: list order within vertex
4. For each vertex in sorted order, dereference batch_refs
5. Run the commit-reveal resolution pass: revealed inner txs splice into their DAG-fixed commit order (private mempool — Chapter 9)
6. wasmtime executes all transactions in canonical order
7. State root computed (Blake3 + Poseidon2 dual)
8. ≥85 committee FALCON-sign state root (piggybacked on next-round vertices)
9. ≥85 state-root sigs collected → finality declared
```

### Commit Rate

- ~95% of rounds commit successfully in steady state
- ~5% skip (anchor offline or insufficient support); next round absorbs the data
- Average finality: **~500ms median, ~1s p99**

### No Skip Penalty

When a round skips, its vertices aren't lost — the next round's commit absorbs them via parent-chain traversal. Slow validators just contribute slightly later.

## 7. Committee

### Size & Selection

- **128 active committee members per epoch**, selected from the global validator pool
- **Selection: uniform random** from all validators with stake ≥ `MIN_VALIDATOR_STAKE` = 10,000 PYDE (single-tier model; no separate committee vs non-committee stake floor)
- **Anti-Sybil:** operator identity binding, **max 3 validators per operator**
- **Epoch length:** ~3 hours wall-clock (commit count varies with network conditions — typically ~21,600 commits at the 500 ms median cadence)

```python
# T-30min in epoch N: beacon_N+1 has just been finalized (see §9).
# Every staked validator now derives the committee for epoch N+1:
eligible = [v for v in all_validators
            if v.stake >= MIN_VALIDATOR_STAKE and not v.jailed]
for slot in 0..128:
    seed = Hash(beacon_N+1, slot)
    member = uniform_random_pick(eligible, seed)
    committee[slot] = member
    eligible.remove(member)  # without replacement
# Committee N+1 is now fully determined and takes over at the boundary — see §10.
```

### Equal Power Within Committee

All 128 members have equal voting weight, equal vertex production rate, equal anchor probability (uniform over members). Stake influences only:
- (a) eligibility (must meet `MIN_VALIDATOR_STAKE` = 10,000 PYDE)
- (b) proportion of the stake-weighted reward pool (yield distributes by `stake × uptime`)

Activity rewards within the committee are **contribution-weighted, not stake-weighted**.

### Why No Stake-Weighted Voting

- Sybil attack mitigated by operator identity cap (not by stake weight)
- Within-committee equality aligns with classical BFT theory
- Reduces plutocracy pressure
- Simpler protocol math (no stake weights in BFT thresholds)

## 8. BFT Properties

For n=128 validators:
- `f = ⌊(n-1)/3⌋ = 42` (maximum Byzantine)
- `threshold = 2f+1 = 85` (quorum for commit / vertex cert / state-root finality)

The number 85 appears throughout the protocol:
- Vertex certification (parent refs in next round)
- Commit support
- State root signatures
- Beacon-share combine quorum

**Consistent across the protocol:** avoids attack edges from boundary mismatches.

### Safety

Holds under any network conditions assuming at most `f = 42` Byzantine members (the BFT tolerance `⌊(n-1)/3⌋` with n = 128). Safety property: no two conflicting commits.

### Liveness

Holds under partial synchrony (messages eventually delivered, bounded clock skew).

## 9. Randomness Beacon

Each epoch's beacon is produced by the **previous** epoch's committee. The beacon for epoch N+1 must be finalized with enough lead time for committee N+1 to be selected (via VRF on `beacon_N+1`) before the epoch boundary. The architectural target uses a threshold-signature primitive; v1 ships a FALCON-aggregate approximation (called out below).

### Target design (threshold-sig — long-term)

```
1. All 128 committee N members sign known message "epoch_N+1_beacon" with
   threshold-share keys (DKG'd at the start of epoch N)
2. ≥85 shares Lagrange-combine into ONE deterministic aggregated signature
3. beacon_N+1 = Hash(aggregated_signature) → 32 bytes
4. Finalized at T-30min (last 30 min of epoch N) — see §10 for why
```

Properties of the target design:
- **Deterministic** given any 85 of 128 shares (Lagrange invariance — same aggregated sig regardless of which 85 contribute)
- **Unpredictable** until ≥85 shares combine (no single party knows it)
- **Bias-resistant:** shares determined by DKG-derived keys, no individual member can grind by choosing whether to participate; the aggregated output doesn't depend on subset selection

### v1 implementation (FALCON-aggregate approximation)

`pyde-crypto` does not yet ship a post-quantum threshold-signature primitive — post-quantum threshold sigs are research-level (see WHITEPAPER §3 honest-tradeoffs section). v1 ships a `FalconBeaconScheme` that approximates the target by hash-concatenating individual FALCON sigs:

```
1. Each member i signs the epoch message with their own individual FALCON
   beacon keypair (persisted on disk, separate from consensus FALCON keypair)
2. Shares gossip via pyde/beacon-shares/1
3. Combine: lowest-member-id 85 shares are sorted, concatenated, and
   blake3-hashed → beacon_N+1
```

The v1 approximation deviates from the target design in two ways:

- **Subset disagreement is structurally possible** because the hash depends on *which* 85 shares are included, not just *that* 85 contributed. v1 fixes this by hardcoding a canonical-subset rule (`combine` MUST use exactly the lowest-`member_id` 85 shares) so every validator deterministically agrees on the same 85.
- **Last-signer grinding bias** (~1 bit per epoch): a member who signs late sees prior shares and could compute `beacon_if_I_sign` vs `beacon_if_I_withhold`. Bounded by the `prev_beacon` hash-chain (compounds against the adversary across epochs) and by the ≥85 honest sigs always inside the hash. Full elimination waits for true threshold sigs.

When `pyde-crypto` ships threshold-FALCON or an equivalent post-quantum threshold-sig primitive, the `BeaconScheme` trait swaps cleanly to the target design without consensus-side changes.

## 10. Epoch Transition & Committee Handover

Each epoch transition hands consensus from committee N to committee N+1. Because Pyde's private mempool is a **keyless commit-reveal** design (Chapter 9), there is **no threshold decryption key to generate** — so there is no DKG, no Shamir shares, and no per-epoch key ceremony. The handover is purely: publish the beacon, select the next committee, swap in.

```
T-30min (last 30 min of epoch N):
  ├── beacon_N+1 finalized (see §9 — old committee's combine ceremony)
  ├── every staked validator runs VRF(validator_sk, beacon_N+1)
  ├── lowest 128 VRF outputs become committee N+1
  └── committee N continues serving consensus

EPOCH BOUNDARY (T=3hr):
  ├── committee N+1 is fully determined and ready
  ├── committee N hands over instantly
  └── no key ceremony gates the boundary — consensus is continuous
```

Committee selection needs only the beacon and each validator's own VRF, so the handover has **no cryptographic dependency that can stall it**. Beacon production in v1 uses each member's individual FALCON `BeaconKeypair` (distinct from the consensus FALCON keypair); it does not depend on any distributed key setup.

> **Historical note.** Earlier drafts ran a Pedersen DKG here to produce a per-epoch threshold *decryption* key for an encrypted mempool. That mechanism has been removed from the protocol: trustless post-quantum threshold key generation is research-blocked (lattice public keys do not combine homomorphically the way BLS does, and there is no trustless DKG for ML-KEM). The keyless commit-reveal design (Chapter 9) needs no such key. A one-shot ciphertext lane remains a v2+ research direction ([Chapter 20](./20-future-direction.md)).

## 11. Private Mempool Resolution (Commit-Reveal)

Pyde's MEV protection is a **keyless commit-reveal private mempool** — there is no committee decryption key and no per-transaction decryption ceremony. Safety is unconditionally trustless: it never depends on any quorum of committee members declining to collude, because a commit is just a hash. [Chapter 9](./09-mev-protection.md) is the full specification; the consensus-relevant mechanics are:

- A **Commit** transaction (TxType `0x11`) carries only a Blake3 `commitment` plus a bond; the DAG fixes its position in the total order at commit time, before anyone knows the contents.
- A **Reveal** transaction (TxType `0x12`) later supplies the inner transaction. Any account may submit it, and it must land within `COMMIT_REVEAL_WINDOW_WAVES = 120` waves of the commit's inclusion wave, else the commit expires and the bond is forfeit.
- In the reveal wave's resolution pass, revealed inner transactions execute **in commit order** — the DAG-sequenced order of the commits — **not reveal order**. Order is locked before content is known, so front-running is structurally impossible.

Both primitives are already post-quantum: Blake3 for the commitment, FALCON for authorization. There is no lattice encryption, no Shamir split, and no share combine on this path.

### Pipelining

Because resolution is deterministic bookkeeping (match reveals to open commits, splice into commit order), it adds only a few milliseconds of post-commit work per wave. No shares propagate ahead of the commit and there is no ceremony to pipeline.

> **Future work.** A one-shot ciphertext ("Threshold-LWE") lane — an *optional* private-mempool alternative alongside the keyless commit-reveal default, gated on a trustless PQ threshold-keygen breakthrough — is a v2+ research direction documented in [Chapter 20](./20-future-direction.md). It is not part of the shipping protocol.

## 12. State Root Attestation

After wasmtime execution, each member computes the state root locally (deterministic from input). Members FALCON-sign the state root with explicit hash inclusion:

```rust
struct StateRootSig {
    commit_id: u64,
    state_root_hash: Hash,        // explicit — both Blake3 and Poseidon2
    signer_id: u32,
    falcon_sig: FalconSig,        // FALCON over (commit_id || root_hash)
}
```

Sigs piggyback on next-round vertices. Finality requires:
- ≥85 sigs
- All attesting the same root hash
- All FALCON sigs verify

If sigs attest different roots → fork detected → hard halt (see CHAIN_HALT.md).

## 13. Failure Detection & Halts

Three types of halts:

| Type | Trigger | Authority |
|---|---|---|
| Soft stall | Network / quorum issues | Emergent |
| Hard halt | Contradictory state roots, equivocation cluster, DAG fork | Protocol-detected automatic |
| Emergency halt | Off-chain bug report, active exploit | Governance multisig (7-of-12) |

See [CHAIN_HALT.md](../companion/CHAIN_HALT.md) for full halt + recovery procedures. Rollback is bounded to 1 epoch (~3 hours) — operational flexibility without arbitrary commit reversibility.

## 14. Slashing

Equivocation, bad state-root signatures, invalid vertices, extended downtime — all slashable. See [SLASHING.md](../companion/SLASHING.md) for the full catalog.

Correlated slashing applies a 2× multiplier when many validators offend simultaneously (punishes coordination, protects isolated failures).

## 15. Recovery Properties

- **Single validator offline:** other 127 continue normally. Validator catches up via gossip; loses activity rewards.
- **43+ validators offline (at the BFT quorum boundary, 85 active = 2f+1 with no margin):** soft stall; downtime slashing PAUSES (partition-aware); resumes when active count returns to 86+ (one above the quorum minimum).
- **Network partition:** majority-side continues if quorum maintained; minority stalls.
- **State root divergence:** hard halt; investigation; rollback within 1 epoch; slashing for wrong-root signers.

The chain self-heals from any subset failure that maintains ≥85 functional validators.

## 16. Comparison

| Property | HotStuff (pre-pivot) | Mysticeti DAG (current) |
|---|---|---|
| Slot/round timing | 400ms clock | Data-driven (~150ms/round) |
| Proposer model | Single per slot (VRF) | None |
| View changes | Yes (cascade-prone) | None |
| Finality | ~1s+ (chained QCs) | ~500ms (per-round) |
| Throughput ceiling | Leader bandwidth | Committee parallelism |
| Censorship resistance | Proposer-dependent | 127-of-128 can include |
| MEV resistance | Proposer + threshold-enc (planned, never shipped) | Structural (no proposer) + keyless commit-reveal (Ch 9) |
| Liveness under failure | View-change cascades | Graceful (lag, no halt) |

## 17. Implementation Status

🔴 **Mysticeti DAG implementation: not yet built.** Pre-pivot HotStuff archived in `archive/`.

Implementation strategies:
- **Option A: Fork Sui's Mysticeti** (open source) and adapt to FALCON sigs. Saves substantial consensus engineering — Mysten Labs has spent years getting the algorithm correct.
- **Option B: Write from scratch** for full control. Larger surface to audit, more bugs to find.

Recommendation: Option A for v1. The work is audit + adaptation for FALCON sigs; correctness of the core algorithm leverages Mysten Labs' existing engineering.

## References & Cross-References

- Full design: [DESIGN.md §Consensus](../companion/DESIGN.md#consensus-mysticeti-dag)
- Threat model (consensus threats): [THREAT_MODEL.md §Consensus Layer](../companion/THREAT_MODEL.md)
- Failure scenarios: [FAILURE_SCENARIOS.md](../companion/FAILURE_SCENARIOS.md)
- Chain halt: [CHAIN_HALT.md](../companion/CHAIN_HALT.md)
- Slashing: [SLASHING.md](../companion/SLASHING.md)
- Validator lifecycle: [VALIDATOR_LIFECYCLE.md](../companion/VALIDATOR_LIFECYCLE.md)
- Research papers:
  - Mysticeti (Babel et al., 2024): `https://arxiv.org/abs/2310.14821`
  - Bullshark (Spiegelman et al., 2022)
  - Narwhal (Danezis et al., 2021)
