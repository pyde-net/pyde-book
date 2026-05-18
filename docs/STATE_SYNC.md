# Pyde State Sync Protocol

**Version 0.1 — May 2026**

How new nodes join the network at any point in time. At 30K+ TPS, replaying from genesis is infeasible — snapshot sync is the default.

## Sync Modes

| Mode | Use Case | Time |
|---|---|---|
| Full sync (genesis replay) | Archive nodes only | Infeasible at high TPS |
| **Snapshot sync (default)** | Most full nodes, new committee joiners | ~30-60 min on commodity |
| Light client sync | Mobile wallets, browser, dApp backends | Seconds-minutes |

## Snapshot Architecture

**Key separation:**
- Committee signs **state root** (cheap, every epoch boundary)
- Volunteers generate **chunks** (heavier, daily-ish cadence)

This drops committee disk I/O burden. Manifest is small and committee-signed; chunks are large and content-verifiable.

### Snapshot Manifest

```rust
struct SnapshotManifest {
    epoch: u64,
    snapshot_state_root_blake3: Hash,
    snapshot_state_root_poseidon2: Hash,
    chunk_manifest: Vec<ChunkRef>,
    current_committee_pubkeys: Vec<FalconPubkey>,  // chain-of-trust
    signatures: Vec<FalconSig>,                     // ≥85 from prior epoch's committee
}

struct ChunkRef {
    chunk_index: u32,
    chunk_size: u32,
    chunk_hash: Hash,    // Blake3
    chunk_path: String,  // P2P routing hint
}
```

### Why Dual Roots

- **Blake3:** fast native verification
- **Poseidon2:** future ZK light-client compatibility

Both computed at snapshot time, both signed by committee.

### Snapshot Cadence

- **Committee root signing:** every epoch boundary (cheap)
- **Chunk publishing:** every 8 epochs (~daily) by volunteer infrastructure providers
- **Tail sync window:** up to 24 hours of txs to catch up

### Snapshot Size Projections

| Component | v1 mainnet | 5-year projection |
|---|---|---|
| Account state (~10M accounts × ~150B) | 150 MB – 1.5 GB | 5-10 GB |
| Contract storage (~5× accounts × 64B) | 500 MB – 3 GB | 20 GB |
| Contract code (~50K contracts × 50KB) | ~2.5 GB | 20 GB |
| **Total** | **~1-3 GB** | **~50 GB** |

## Verification Flow

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
  8. Bad chunks → ban peer, retry from another

Phase 3: Reconstruct State
  9. Apply chunks to JMT
  10. Compute Blake3 state root locally
  11. Compare to manifest.snapshot_state_root_blake3
  12. If match: snapshot valid, accept

Phase 4: Recent Sync (Tail)
  13. Download blocks from snapshot point to current
  14. Replay txs against snapshot state
  15. Reach current state, exit sync mode

Phase 5: Active Operation
  16. Subscribe to gossip
  17. Begin normal participation
```

## Bootstrap from Genesis: Chain-of-Trust

A new node doesn't yet know which committee pubkeys to trust. Solved via genesis chain:

```
Genesis block: contains committee_0.pubkeys (hardcoded by founders)
  ↓
Snapshot at epoch 8: signed by committee 0, contains committee_8.pubkeys
  ↓
Snapshot at epoch 16: signed by committee 8, contains committee_16.pubkeys
  ↓
... etc forward
```

New node verifies the chain by:
1. Downloading genesis (~5 MB, includes committee_0 pubkeys)
2. Downloading intermediate manifests (~5 KB each, hundreds at scale)
3. Verifying chain forward: each manifest signed by prior committee
4. Accepting current snapshot if chain-of-trust holds

## Weak Subjectivity Checkpoints (Optional)

For nodes that don't want full chain-of-trust verification:

- Foundation and reputable infra providers publish "trusted recent checkpoints"
- Signed by their own keys (not committee)
- Assert: "we've verified the chain up to epoch X, root = Y"
- Distributed via known infrastructure (HTTPS, signed websites)
- Updated weekly

New node options:
- **Purist:** full chain-of-trust from genesis (long but trustless)
- **Pragmatist:** trust a recent checkpoint, sync from there (fast)

Both produce same security guarantees from the trusted point forward.

## Light Client Mode

Doesn't download full state. For mobile wallets, browser dApps, embedded clients.

### Storage
- Block headers only (no full blocks)
- Recent committee pubkeys
- Own account state + recent transactions
- JMT proofs for accounts user cares about

### Operations
- Verify new block headers via FALCON sigs (~85 verifies, ~6.8ms)
- Query specific accounts: ask full node for `{balance, JMT inclusion proof}`
- Verify proof against latest signed state root
- Submit transactions: same as regular RPC

### Bandwidth
~600 KB/year for typical wallet usage (8 epochs/day × 365 days × ~200 bytes per epoch boundary header).

## Incremental Sync (Delta Snapshots)

For nodes with a recent snapshot:

```
Have: Snapshot at epoch E
Want: Snapshot at epoch E + 8

Delta snapshot:
  - Changed accounts since epoch E
  - Changed storage slots since E
  - New contracts deployed since E
  - Signed by committee at E + 8
  
Apply delta to existing local state → updated snapshot
```

Saves bandwidth: typical delta is 10-50 MB vs full 3 GB.

## Storage / Pruning Policy

| Node type | State retention | Block retention |
|---|---|---|
| Archive node | All historical state | All blocks since genesis |
| Full node (default) | State for last 90 days | Blocks for last 30 days |
| Committee validator | State for last 30 days | Blocks for last 8 epochs |
| Light client | Headers + cared-about accounts | Headers only |

Tunable per-node. Archive nodes earn slightly higher RPC fees for serving historical queries.

## Failure Modes & Recovery

| Failure | Detection | Recovery |
|---|---|---|
| All peers serve bad data | Manifest sig fails | Try more peers, ban liars |
| Snapshot corruption mid-download | Chunk hash mismatch | Ban peer, retry chunk from another |
| Manifest signed by wrong committee | Sig verify fails | Reject manifest, find another |
| Network outage during sync | Connection dropped | Resume from last verified chunk |
| Snapshot too old (> evidence window) | Sig set might be slashed | Use newer snapshot |

## Time Estimates (commodity hardware, 100 Mbps)

```
Bootstrap from genesis (small):       ~5 seconds
Manifest verification (85 FALCON):    ~7 ms
Snapshot download (3 GB at 100 Mbps): ~4 minutes
JMT reconstruction:                   ~5 minutes
Recent tail sync (8 epochs of txs):   ~30 minutes
Total:                                ~40 minutes
```

For comparison: Ethereum snap sync 4-24 hours, Cosmos statesync 1-3 hours.

## State Growth (v2 Concern)

5-year projection of ~50 GB is optimistic. Solana shows ~80 GB after 4 years despite aggressive engineering.

Future mitigations (defer to v2):
- **Account expiration** (Aptos pattern): accounts not touched in N years get archived
- **Storage rent** (Solana pattern): accounts pay rent to stay active
- **Stateless validators** (Ethereum research): validators use state proofs

## References

- Hash strategy: see [WHITEPAPER.md](./WHITEPAPER.md) §4.3
- Light client (more detail): see [WHITEPAPER.md](./WHITEPAPER.md) §7
- Network bandwidth: see [NETWORK_PROTOCOL.md](./NETWORK_PROTOCOL.md)

---

**Document version:** 0.1
**Date:** 2026-05-18
**License:** See repository root
