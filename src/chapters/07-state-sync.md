# State Sync & Chain Halt

This chapter covers how new nodes join the network (state sync) and what happens when consensus encounters problems (chain halt + recovery). Both are operational concerns that the design must address explicitly — the HotStuff pre-pivot architecture lacked clear procedures for both, contributing to the wedges that motivated the pivot.

## Part 1: State Sync

### The Problem

At 30K+ TPS, replaying every block from genesis is infeasible (~10^13 transactions/year). A new node joining the network needs a way to reach current state without full replay.

### Three Sync Modes

| Mode | Use Case | Time |
|---|---|---|
| Full sync (genesis replay) | Archive nodes only | Infeasible at high TPS |
| **Snapshot sync (default)** | Most full nodes, new committee joiners | ~30-60 min on commodity |
| Light client sync | Mobile wallets, browser, dApp backends | Seconds-minutes |

### Snapshot Architecture

**Decoupled signing and chunk generation:**
- Committee signs **state root** (cheap, every epoch boundary)
- Volunteers generate **chunks** (heavier, daily cadence)

```rust
struct SnapshotManifest {
    epoch: u64,
    snapshot_state_root_blake3: Hash,
    snapshot_state_root_poseidon2: Hash,
    chunk_manifest: Vec<ChunkRef>,
    current_committee_pubkeys: Vec<FalconPubkey>,  // chain-of-trust
    signatures: Vec<FalconSig>,                     // ≥85 from prior committee
}
```

**Why dual roots:** Blake3 for fast native verification by syncing nodes; Poseidon2 for future ZK light-client compatibility.

### Snapshot Cadence

- **Committee root signing:** every epoch boundary (cheap, ~5 KB manifest)
- **Chunk publishing:** every 8 epochs (~daily) by volunteer infrastructure
- **Tail sync window:** up to 24 hours of txs to catch up

### Verification Flow

```
Phase 1: Discover & Verify Manifest
  1. Bootstrap from seed peers
  2. Discover manifest URLs/hashes from peers
  3. Download signed manifest (~5 KB)
  4. Verify ≥85 FALCON sigs against trusted committee pubkeys

Phase 2: Download Chunks
  5. Discover peers serving snapshot
  6. Download chunks in parallel (4 MB each)
  7. Verify each chunk_hash against manifest
  8. Bad chunks → ban peer, retry

Phase 3: Reconstruct State
  9. Apply chunks to JMT
  10. Compute Blake3 state root locally
  11. Compare to manifest
  12. Accept if match

Phase 4: Recent Sync (Tail)
  13. Download blocks from snapshot point to current
  14. Replay txs against snapshot state
  15. Reach current state

Phase 5: Active Operation
  16. Subscribe to gossip; begin participation
```

### Chain-of-Trust Bootstrap

A new node verifies the chain of snapshot manifests from genesis:

```
Genesis block: contains committee_0.pubkeys (hardcoded)
  ↓
Snapshot at epoch 8: signed by committee 0, contains committee_8.pubkeys
  ↓
... etc forward, each signed by prior committee
```

For nodes that prefer speed over trustless verification: **weak subjectivity checkpoints** are published by foundation + reputable infrastructure providers. New nodes can trust a recent checkpoint and sync from there.

### Light Client Mode

For mobile wallets, browser dApps:

- Storage: block headers only + cared-about accounts
- Operations: verify FALCON sigs on headers (~7ms), query accounts via JMT inclusion proofs
- Bandwidth: ~600 KB/year typical wallet usage

### Time Estimates (Commodity, 100 Mbps)

```
Bootstrap from genesis (small):       ~5 seconds
Manifest verification (85 FALCON):    ~7 ms
Snapshot download (3 GB):             ~4 minutes
JMT reconstruction:                   ~5 minutes
Recent tail sync (8 epochs):          ~30 minutes
Total:                                ~40 minutes
```

See [STATE_SYNC.md](../../docs/STATE_SYNC.md) for complete protocol details.

## Part 2: Chain Halt + Recovery

The HotStuff pre-pivot architecture suffered persistent wedges with no clear halt → investigate → recover procedure. The team patched live, accumulating safety subtleties. Pyde's post-pivot design EXPLICITLY:
- Separates three halt types
- Defines authority + procedure for each
- Builds drills into the operational plan

### Three Halt Types

| Type | Trigger | Severity | Authority |
|---|---|---|---|
| **Soft stall** | Network / quorum issues | Liveness only | Emergent |
| **Hard halt** | Contradictory state roots, equivocation cluster | Safety risk | Protocol-detected automatic |
| **Emergency halt** | Critical bug, active exploit, hard-fork prep | High intentional | Governance multisig (7-of-12) |

### Detection

**Soft stall (automatic):**
- No commit > 5 rounds (~5 sec)
- <85 vertices certified
- Active committee count < 86

**Hard halt (automatic):**
- State root divergence (2+ signed contradictory roots)
- Equivocation cluster (10+ in single epoch)
- DKG output mismatch
- PVM critical invariant violation
- DAG fork detected (should be impossible)

**Emergency halt (manual):**
- Critical bug discovery (off-chain)
- Active exploit
- Hard-fork coordination

### What Happens During Halt

| Activity | Soft | Hard | Emergency |
|---|---|---|---|
| Vertex production | Continues (no quorum) | Stops | Stops |
| Commits | Paused | Paused | Paused |
| Tx submission | Queued | Queued | Queued |
| Decryption ceremonies | Paused | Stopped | Stopped |
| **Slashing evidence acceptance** | **Continues** | **Continues** | **Continues** |
| Gossip | Continues | Continues | Continues |

**Key invariant:** slashing evidence accepted during halt — attackers cannot escape consequences by triggering a halt.

### Recovery Procedures

1. **Wait it out** (soft stalls) — auto-recover
2. **Software update + replay** (hard halts from bugs) — patch, verify, resume
3. **Rollback** (max 1 epoch back, governance authorized) — controversial but bounded
4. **Hard fork** (irreconcilable splits) — coordinated upgrade
5. **Emergency unhalt** (false positives) — multisig releases

### Rollback Policy

**Bounded operational pragmatism:**
- Maximum rollback window: 1 epoch (~3 hours)
- Within window: governance multisig can authorize
- Beyond window: only hard fork (community coordination required)

This is "weak finality with sunset" — operational flexibility for early detection without arbitrary commit reversibility. Industry standard pattern.

### Test Plan

Mandatory drills before mainnet:
1. Soft stall: deliberately offline 43 validators
2. Hard halt: inject state divergence
3. Emergency halt: practice multisig coordination
4. Rollback: 1-epoch procedure
5. Hard fork: coordinated upgrade

**Frequency:** quarterly in testnet, annually in mainnet. Runbooks per scenario, updated after every drill.

### The HotStuff Lesson Applied

HotStuff broke because there was no clear halt procedure — patches accumulated under pressure. Pyde now has:
- Automatic detection of safety violations
- Explicit halt classification
- Pre-rehearsed recovery procedures
- Drill schedule

See [CHAIN_HALT.md](../../docs/CHAIN_HALT.md) and [FAILURE_SCENARIOS.md](../../docs/FAILURE_SCENARIOS.md) for complete operational specs.

## References

- Full state sync spec: [STATE_SYNC.md](../../docs/STATE_SYNC.md)
- Full halt spec: [CHAIN_HALT.md](../../docs/CHAIN_HALT.md)
- Failure scenarios + drills: [FAILURE_SCENARIOS.md](../../docs/FAILURE_SCENARIOS.md)
- Validator lifecycle (jail mechanics): [VALIDATOR_LIFECYCLE.md](../../docs/VALIDATOR_LIFECYCLE.md)
