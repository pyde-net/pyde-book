# Pyde State Sync Protocol

**Version 0.1**

How new nodes join the network at any point in time. At the chain's sustained throughput, replaying from genesis is infeasible — snapshot sync is the default.

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

## Chunk Format and Merkle Range Proofs

Each snapshot chunk is a self-contained, independently-verifiable bundle of JMT nodes. A chunk's authenticity is proven by walking its nodes' hashes up to the committee-signed state root, using **fringe siblings** carried in the chunk.

```rust
struct Chunk {
    chunk_id: u32,
    
    // Contiguous range of jmt_cf entries (internal nodes + leaves) covered by this chunk.
    nodes: Vec<(NodeKey, NodeContents)>,
    
    // The slot_hash → value pairs for leaves in this chunk's range.
    // (Used to populate state_cf at the new validator.)
    leaves: Vec<(SlotHash, ValueBytes)>,
    
    // Merkle range proof — the sibling hashes along the path from the chunk's
    // bottom layer up to the global state_root. Needed to verify the chunk
    // independently of other chunks.
    fringe_siblings: Vec<(NibblePath, Hash)>,
}
```

### Why fringe siblings

The chunk doesn't contain the entire JMT — that would be every other chunk too. It contains some contiguous portion (e.g., "all nodes whose NibblePath starts with `3a`"). To prove that portion is part of the canonical state at the snapshot's version, the chunk must include the sibling hashes along the boundary.

```text
Conceptual example:

  Suppose the JMT looks like:
                 ROOT
                /    \
              h_3    h_5
             /  \      \
           ...  ...    leaf at 0x5b22...
           
  A chunk covers leaves under "3a..." prefix. It contains:
    - All internal nodes under "3a"
    - All leaves under "3a"
    - Fringe sibling: h_5 (sibling of h_3 at root level)
    - Any other siblings along the path from the "3a" subtree to root

  The chunk does NOT include leaves under "5..." prefix; only their hash on the way up.
```

### Verification per chunk

```text
For each chunk received:

  1. For each leaf in chunk.leaves:
       compute leaf_hash = Hash(slot_hash || value || metadata)
       
  2. Reconstruct internal-node hashes within the chunk's subtree using its
     internal-node entries (NodeContents include children's fingerprints).
     
  3. Walk up from the chunk's local root using fringe_siblings at each level:
       current_hash = chunk_local_root_hash
       for (sibling_path, sibling_hash) in fringe_siblings:
           combine_hashes(current_hash, sibling_hash, sibling_path)
           
  4. Final hash MUST equal trusted state_root (from the committee-signed manifest).
  
  5. If yes: chunk is authentic. Write its (NodeKey, NodeContents) pairs into 
     local jmt_cf, and its (slot_hash, value) pairs into local state_cf.
  6. If no: discard. Request the chunk from a different peer (the source was malicious
     or corrupted). The bad peer is penalized via peer scoring.
```

### Properties

- Each chunk is independently verifiable. Lose one chunk, request from another peer; no cascading failure.
- The fringe siblings are small (~few hundred bytes per chunk) — they don't materially inflate chunk size.
- The proof is **non-interactive** — chunk + fringe siblings is enough; no back-and-forth needed.
- Standard cryptographic primitive — Aptos's JMT uses this; Ethereum's MPT has similar range-proof support. Not novel.

### Snapshot manifest RPC handler

```text
RPC method: pyde_getSnapshotManifest(wave_id)
  → Returns SnapshotManifest for that wave's snapshot, or NotAvailable.

Behind the scenes:
  1. waves_cf.get(wave_id) → WaveCommitRecord → look up jmt version
  2. snapshots_cf.get(version) → SnapshotManifest if pre-generated, else None
  3. If None: optionally generate on-demand (expensive; archive only)
  4. Return manifest

Snapshot generation (background, archive nodes):
  - Triggered every N waves (e.g., every epoch)
  - Walk jmt_cf at target version, group nodes into ~50MB chunks with key-range partitions
  - Compute range proofs (fringe siblings) for each chunk
  - Store chunks + manifest in snapshots_cf
  - Manifest published with committee threshold sig
```

---

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

**License:** See repository root
