# Consensus: Mysticeti DAG

**Note: This chapter reflects the post-May-2026 pivot. The previous HotStuff variant is archived in `archive/`.**

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

The same lab/laptop devnet that hit ~4K TPS under pre-pivot HotStuff is the baseline against which DAG performance will be measured. Honest target: 10K-30K TPS in production-realistic conditions for v1.

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
│  │ - Encryption  │   │  - Anchor selection    │ │
│  │   (if needed) │   │  - State root signing  │ │
│  │ - Batches     │   │  - DKG participation   │ │
│  │ - Gossip      │   └────────────────────────┘ │
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
    decryption_shares: Vec<DecryptionShare>, // piggybacked partials
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
- Heavy (50 batches + 5 sigs + 85 partials): ~25 KB
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
anchor_member_id = Hash(beacon, round, recent_state_root) mod 128
```

Components:
- **beacon:** epoch-scoped randomness, published in last wave of prior epoch
- **round:** current round number
- **recent_state_root:** state root from N=3 rounds ago (limits anchor predictability to ~450ms)

Properties:
- **Deterministic** — every honest validator computes the same answer
- **Unpredictable** — depends on state root that wasn't known until recently
- **No single proposer authority** — anchor doesn't propose, it's just a starting point for the subdag walk

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
5. For each batch, threshold-decrypt (pipelined ceremony — partials already in flight)
6. wasmtime executes decrypted batches in canonical order
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
# At epoch boundary, derive committee:
eligible = [v for v in all_validators
            if v.stake >= MIN_VALIDATOR_STAKE and not v.jailed]
for slot in 0..128:
    seed = Hash(beacon, slot)
    member = uniform_random_pick(eligible, seed)
    committee[slot] = member
    eligible.remove(member)  # without replacement
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
- `threshold = 2f+1 = 85` (quorum for commit / vertex cert / threshold decrypt)

The number 85 appears throughout the protocol:
- Vertex certification (parent refs in next round)
- Commit support
- Threshold decryption shares
- State root signatures
- DKG share threshold

**Consistent across the protocol** — avoids attack edges from boundary mismatches.

### Safety

Holds under any network conditions assuming at most `f = 42` Byzantine members (the BFT tolerance `⌊(n-1)/3⌋` with n = 128). Safety property: no two conflicting commits.

### Liveness

Holds under partial synchrony (messages eventually delivered, bounded clock skew).

## 9. Randomness Beacon

Each epoch's beacon is produced by the previous epoch's committee:

```
1. All 128 members sign known message "epoch_N_beacon" with threshold-share keys
2. ≥85 shares combine into deterministic aggregated signature
3. beacon_N = Hash(aggregated_signature) → 32 bytes
4. Published in last wave of epoch N
```

Properties:
- **Deterministic** given the shares
- **Unpredictable** until ≥85 shares combine (no single party knows it)
- **Bias-resistant** (shares determined by DKG, can't be cherry-picked)

## 10. DKG (Distributed Key Generation)

Each epoch transition, the new committee runs DKG to produce a fresh threshold encryption key:

```
Pedersen DKG, multi-round protocol (~30-60s in background):

Round 1: Each member i picks random secret polynomial f_i(x), degree 84
Round 2: Each member broadcasts public commitments to f_i's coefficients
Round 3: Member i sends f_i(j) to each other member j (encrypted point-to-point)
Round 4: Member j verifies received shares against public commitments,
         sums valid shares: s_j = Σ f_i(j) = f(j)
         where f(x) = Σ f_i(x) is the combined polynomial

Result:
  - Each member j holds s_j = f(j) (private share)
  - Public key PK derived from public commitments
  - SK = f(0) is NEVER computed
  - Threshold = 85 of 128
```

Mathematical foundation: any 85 points on a degree-84 polynomial uniquely determine it (Lagrange interpolation). 84 points don't.

DKG runs in **background** during the prior epoch's last minutes. New committee has threshold key ready at epoch start. Plaintext consensus continues during DKG (encryption is optional anyway).

## 11. Threshold Decryption Ceremony

After commit fires, for each encrypted batch in the canonical order:

```
Each committee member i:
  - partial_i = ApplyShare(s_i, batch_ciphertext)
    (single elliptic-curve operation or polynomial multiplication, ~100μs-1ms)
  - + FALCON sig over (partial_i, batch_hash)
  - Piggyback on next-round vertex (no separate message)

Receivers:
  - Verify FALCON sig (~80μs per share)
  - Once ≥85 valid partials collected:
    - Lagrange interpolation combines partials → reveals plaintext batch
  - wasmtime executes decrypted txs in canonical order
```

### Pipelining

Partials can be computed **as soon as the batch enters the DAG**, before the commit fires. By commit time, partials are typically 80%+ propagated. Effective post-commit decryption latency: tens of milliseconds.

### Scale

At 100K encrypted TPS:
- ~100 ceremonies/sec (batch granularity, ~1000 txs per batch)
- Per-ceremony: 85 partials × ~80μs verify + ~1ms Lagrange = ~8ms CPU work
- ~800ms CPU per second total → parallelizable across cores
- GPU acceleration enables higher throughput

See [WHITEPAPER §11](../companion/WHITEPAPER.md#11-performance) for honest scaling limits.

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

Equivocation, bad state-root signatures, invalid vertices, bad decryption shares, DKG failure, share withholding, extended downtime — all slashable. See [SLASHING.md](../companion/SLASHING.md) for the full catalog.

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
| MEV resistance | Proposer + threshold-enc | Structural (no proposer) |
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
  - Mysticeti (Babel et al., 2024) — `https://arxiv.org/abs/2310.14821`
  - Bullshark (Spiegelman et al., 2022)
  - Narwhal (Danezis et al., 2021)
