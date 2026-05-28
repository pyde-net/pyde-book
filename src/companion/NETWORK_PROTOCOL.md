# Pyde Network Protocol

**Version 0.1**

Transport, peer discovery, gossip, message types, DoS protections, and committee defense patterns.

## Transport & P2P Library

| Choice | Rationale |
|---|---|
| Transport: **QUIC** (over UDP) | No HOL blocking, built-in TLS 1.3, mature in Rust (quinn) |
| Fallback: TCP | Compatibility for restrictive networks |
| Library: **libp2p (Rust)** | Mature, audited, used by Ethereum/Filecoin/Polkadot |
| Node ID: Ed25519 keypair (separate from validator FALCON) | Stable network identity, rotatable without affecting validator status |

## Peer Discovery: Layered Bootstrap

```
Layer 1: Hardcoded seeds (5-10 stable, foundation-operated)
   ↓
Layer 2: DNS seeds (~10 more peer addresses)
   ↓
Layer 3: Validator registry (on-chain — committee members publish addresses)
   ↓
Layer 4: Peer Exchange (PEX) — peers tell each other about peers
   ↓
Layer 5: Persistent peer set (preserved across restarts)
```

### No DHT

Kademlia DHT (used by IPFS, Filecoin) is for content discovery. Pyde is a chain — peers are limited and known. DHT adds complexity without benefit.

**Why layered > DHT for Pyde:**
- ✅ Peer identity is on-chain (validator FALCON-bound)
- ✅ Sybil cost is real (`MIN_VALIDATOR_STAKE` = 10K PYDE + operator-identity cap of 3 per operator)
- ✅ Far simpler (~1K LOC vs ~10K LOC for DHT)
- ✅ Faster discovery (single-hop vs multi-hop)
- ✅ Smaller audit surface

Comparable approaches: Bitcoin, Cosmos, Solana all use layered (no DHT). Ethereum uses both but primarily layered.

### Bootstrap Sequence (First Launch)

```
1. Try hardcoded seeds first (5-10 stable, foundation-operated)
2. Resolve DNS seeds (~10 more peer addresses)
3. Query validator registry on-chain (all staked validators — active committee + awaiting selection)
4. Establish connections to N peers (default N=20)
5. Run PEX to discover more peers
6. Persist successful peers to disk for next startup
```

## Connection Management

| Parameter | Default | Notes |
|---|---|---|
| `MAX_CONNECTIONS` | 200 | Tunable |
| `MIN_OUTBOUND_CONNECTIONS` | 8 | Tunable |
| `MAX_CONNECTIONS_PER_IP` | 5 | Tunable |
| `MAX_CONNECTIONS_PER_ASN` | 50 | Anti-clustering |
| `INBOUND_CONNECTION_LIMIT` | 100 | Tunable |
| `CONNECTION_TIMEOUT` | 10s | Tunable |
| `HANDSHAKE_TIMEOUT` | 5s | Not tunable (security) |

### Per-Role Recommendations
- Committee validators: 30-50 active peers (reliability + low-latency)
- Full nodes: 10-20 active peers (default)
- Light clients: 3-5 active peers

### Churn Handling
- Lost connection → reconnect with backoff (1s, 5s, 30s, 5min, 30min)
- Persistent failure → demote from "preferred" list
- Misbehaving → ban with TTL (1h, 6h, 24h, permanent)

## Message Types & Hard Size Limits

| Type | Priority | Typical | Hard Limit |
|---|---|---|---|
| Ping / Pong | Low | 16B | 64B |
| PeerExchange | Low | 1KB | 8KB |
| VertexAnnouncement | High | 40B | 64B |
| VertexRequest | High | 32B | 64B |
| VertexData | High | 4KB | **64KB** |
| BatchAnnouncement | Med | 40B | 64B |
| BatchRequest | Med | 32B | 64B |
| BatchData | Med | 50-200KB | **4MB** |
| DecryptionShare | High | 1KB | 2KB |
| StateRootSig | High | 738B | 1KB |
| TxSubmission (plain) | Med | 500B | 8KB |
| TxSubmission (encrypted) | Med | 1.5KB | 8KB |
| ManifestRequest | Low | 32B | 64B |
| ManifestData | Low | 5KB | 64KB |
| ChunkData (state sync) | Low | 4MB | 4MB |

### Enforcement Pattern

```rust
trait Message {
    const MAX_SIZE: usize;
    fn validate_size(len: usize) -> Result<()>;
}

// At parse time:
// 1. Read message type tag (1 byte)
// 2. Read payload length (4 bytes)
// 3. CHECK against max_size BEFORE allocating buffer
// 4. If too large: reject + peer score penalty (+5 points)
// 5. If OK: read payload, deserialize, process
```

Memory safety, DoS resistance, predictability, audit-friendliness all depend on explicit limits.

### BatchData Sizing

| Hard Limit | Modest hardware fit | Theoretical batch-implied ceiling |
|---|---|---|
| 2 MB | Strongest | Lowest |
| **4 MB (chosen)** | **Strong** | **Moderate** |
| 8 MB | Mixed | Higher |
| 16 MB | Aspirational | Highest |

**4 MB hard limit** balances modest-hardware committee promise (≥500 Mbps NIC sufficient for v1's honest throughput target, which is to be established by the multi-region performance harness, with headroom in the batch size for post-mainnet scaling) with realistic burst scenarios (NFT mints up to ~2000 encrypted txs in one batch). The theoretical-ceiling column above is implied by the batch limit; the v1 *honest target* is much lower (see [honest throughput reset](../chapters/01-introduction.md)).

For batches >4 MB: chunked transfer (BatchAnnouncement → multiple BatchChunk messages of 4 MB each).

## Gossip Protocol: Gossipsub

Pyde uses libp2p's **Gossipsub** for message propagation. Industry standard.

### How It Works
1. Each node maintains "meshes" per topic (subscribed peers, default 6-8)
2. Messages flood through the mesh first
3. Lazy push: message IDs (8 bytes) sent more broadly; full message pulled on demand
4. Heartbeat every second prunes / repairs mesh

### Pyde Topics

| Topic | Subscribers |
|---|---|
| `pyde/vertices/<epoch>` | All committee + full nodes |
| `pyde/batches/<shard>` | All committee workers + RPC nodes |
| `pyde/decryption_shares/<commit>` | All committee |
| `pyde/state_root_sigs/<commit>` | All committee + full + light |
| `pyde/mempool/plain` | All validators + RPC nodes |
| `pyde/mempool/encrypted` | All validators + RPC nodes |
| `pyde/state_sync/manifests` | Sync-mode nodes |

### Parameters (Battle-Tested Defaults)
- Mesh size D = 8 (target peers in mesh)
- Fanout = 6 (peers for non-mesh delivery)
- Heartbeat interval = 1s
- Message TTL = 60s

## DoS Protections (Multi-Layer)

### Layer 1: Connection-Level
- Max connections per IP/ASN (already specified)
- Token bucket per connection
- Slow-loris protection (handshake timeout)
- Reject obviously malformed traffic at OS level (iptables hints to ops)

### Layer 2: Message-Level Rate Limits

| Limit | Default | Per |
|---|---|---|
| Vertex announcements | 10/s | Per peer |
| Vertex data requests | 20/s | Per peer |
| Batch announcements | 100/s | Per peer |
| Batch data requests | 50/s | Per peer |
| Tx submissions | 100/s | Per peer (lower for unknown) |
| State sync requests | 10/min | Per peer |
| PEX requests | 1/min | Per peer |

Exceeding rate → drop messages silently. Repeated exceedance → ban.

### Layer 3: Peer Scoring

```rust
struct PeerScore {
    successful_messages: u64,
    failed_messages: u64,
    invalid_messages: u64,
    avg_latency_ms: u32,
    bandwidth_used: u64,
    misbehavior_points: i32,
    last_misbehavior: Timestamp,
}
```

Misbehavior point assignments:
- Invalid sig: +10 points
- Malformed message: +5 points
- Duplicate spam: +2 points
- Slow / timeout: +1 point

Thresholds:
- 50 points → throttle (reduce priority, drop low-prio messages)
- 100 points → temp ban (1 hour)
- 200 points → longer ban (24 hours)
- 500 points → permanent ban

Points decay over time (1 point per hour) — rewards good behavior over time.

### Layer 4: Application-Level
- Tx submission rate limit per sender address
- Gas tank prepayment (legacy `gas_tank` field) — pay-as-you-go for ingress
- Resource caps on processing (CPU, memory per operation)

## Bandwidth Prioritization (When Constrained)

```
Priority queue (top = highest):
  1. State root sigs (consensus finality)
  2. Vertex broadcasts (consensus structure)
  3. Decryption shares (encrypted tx finality)
  4. Batch announcements + small data
  5. Tx submissions (mempool)
  6. State sync chunks (background)
  7. PEX, ping/pong (low frequency)
```

Per-peer bandwidth caps prevent any single peer from monopolizing.

Committee members can configure higher priority for vertex/share traffic.

## Sentry Node Pattern (for Committee Validators)

DoS-vulnerable validators (committee members) should NOT expose to the public internet. Standard pattern:

```
Public Internet
    ↓
Sentry Node 1, 2, 3 (public-facing)
    ↓ (private network)
Committee Validator (NOT internet-exposed)
```

Sentries:
- Run by same operator (or trusted relays)
- Filter incoming traffic
- Forward only valid messages to validator
- Absorb DDoS attacks

Cost: 2-3× infrastructure per validator. Standard practice. Cosmos chains all use this.

## Network Identity & Validator Binding

Three layers of identity:

1. **Network ID** (Ed25519): used by libp2p for connection-level identity. Rotatable.
2. **Validator FALCON pubkey:** consensus identity, registered on-chain. Rotatable per epoch.
3. **Operator stake account:** ownership, slashing target. Stable.

Binding: validator's FALCON pubkey is signed by their stake account.

Publishing committee network IDs (in account state) for active epoch enables direct peer connections; mapping cleared after epoch ends to limit DoS targeting outside committee duty.

## Anti-Eclipse Protections

Eclipse attack: adversary surrounds a node with malicious peers, controls their view of the network.

Defenses:
- Maintain peers from diverse IPs / ASNs
- Persistent peers (preserve across restarts)
- Random peer rotation (drop oldest every N hours)
- Mandatory connections to "well-known" peers (foundation, reputable infra) — optional

## State Sync Network Behavior

State sync chunks are large (4 MB). Special handling:
- Lower priority than consensus traffic
- Dedicated bandwidth budget (e.g., max 20% of available)
- Peers can opt-out of being state sync sources
- Sync nodes maintain separate connection pool for chunk fetching

## Connection Diagram

```
                   [Light Client]
                    (3-5 peers)
                          |
                          ↓ State queries via libp2p
                          |
                 [Full Node / RPC]
                  (10-20 peers)
                          |
                          ↓ Gossip vertices, batches
                          |
              [Public Sentry Nodes]
                  (filtering)
                          |
                          ↓ Filtered traffic only
                          |
            [Committee Validator]
            (30-50 peers, private mesh)
```

## References

- Transport details: see [WHITEPAPER.md](./WHITEPAPER.md) §9
- Performance impact: see [PERFORMANCE_HARNESS.md](./PERFORMANCE_HARNESS.md)
- Threat model (network threats): see [THREAT_MODEL.md](./THREAT_MODEL.md) §4 Network Layer

---

**Document version:** 0.1

**License:** See repository root
