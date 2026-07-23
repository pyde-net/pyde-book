# Chapter 12: Networking

Pyde's P2P network sits on libp2p over QUIC, with purpose-specific
gossipsub channels and an application-layer FALCON-512 handshake that binds
each peer's libp2p PeerId to a post-quantum identity. **Peer discovery
uses a layered approach (no Kademlia DHT) — hardcoded seeds, then DNS,
then the on-chain validator registry, then PEX**. This was a deliberate
post-pivot choice: a DHT for a 128-member committee is more attack surface
than it is value.

**Worker / Primary split (Narwhal pattern).** Within each validator,
transactions and consensus traffic are decoupled. Workers gossip
transaction batches peer-to-peer (high-volume data dissemination);
primaries gossip vertices (low-volume consensus structure). A vertex
carries batch hashes by reference, never full payloads.

The encryption story is layered — libp2p's standard Ed25519/X25519 handles
peer routing, FALCON does the heavy lifting at the application layer where
quantum-safety matters. Committee defense uses the **sentry node pattern**
(Cosmos-style): committee validators are reachable only through sentry
proxies, never expose their committee identity to public peers.

---

## 12.1 Transport: libp2p over QUIC

### Why libp2p

libp2p is the modular networking stack used by Ethereum 2.0, Filecoin, and
Polkadot. It gives Pyde:

- Pluggable transport (Pyde uses **QUIC**).
- Multistream protocol negotiation per stream.
- Built-in Kademlia DHT and gossipsub implementations.
- Peer identity via PeerId.

### Why QUIC

| Property               | TCP + Yamux/mplex       | QUIC                          |
| ---------------------- | ----------------------- | ----------------------------- |
| Connection setup       | 1-3 RTT (TCP + TLS)     | 0-1 RTT (integrated TLS)      |
| Head-of-line blocking  | yes (all streams share) | no (per-stream flow control)  |
| Multiplexing           | userspace (Yamux)       | native (kernel-assisted)      |
| Connection migration   | not supported            | supported (connection IDs)    |
| Mandatory encryption   | optional (TLS)          | always (TLS 1.3 in handshake) |

Per-stream independence matters most when block propagation (large) and
consensus votes (latency-critical) share the same QUIC connection. A single
lost packet on the block stream does not stall the vote stream.

The libp2p config is set up in `crates/net/src/node.rs` via
`SwarmBuilder::with_quic()`.

### Identity at the libp2p layer

libp2p PeerIds in Pyde are derived from **Ed25519 / X25519** keys — the
libp2p default. The choice is intentional: libp2p's PeerId routing,
Kademlia DHT lookups, and QUIC handshake all assume one of the supported
key types. Replacing the libp2p layer's identity with FALCON would require
a custom libp2p fork.

The **post-quantum identity** layer sits one step higher: every consensus
and validator-channel message is signed with FALCON-512, and the
application-level peer handshake (§12.4) binds the libp2p PeerId to a
FALCON public key. Pyde's threat model treats the libp2p layer as fungible
peer routing; the cryptographic claims that matter — vote authenticity,
finality cert verification, evidence verification — all sit on FALCON.

---

## 12.2 The Four Channels

Different traffic has different latency and throughput profiles. Mixing
them on one gossip topic forces the worst-case scheduling on every message
type. Pyde splits traffic into four channels, each tuned for its workload.

```
+---------------------------------------------------------------+
|                          Pyde Node                            |
|                                                               |
|  +-------------+ +-------------+ +-------------+ +----------+  |
|  | Consensus   | | Transactions| | Blocks      | | Sync     |  |
|  | gossip      | | gossip      | | gossip      | | req/resp |  |
|  +------+------+ +------+------+ +------+------+ +----+-----+  |
|         |               |               |             |        |
|  +------+---------------+---------------+-------------+------+  |
|  |                  libp2p / gossipsub                       |  |
|  +------+----------------------------------------------------+  |
|         |                                                       |
|  +------+----------------------------------------------------+  |
|  |                       QUIC transport                      |  |
|  +-----------------------------------------------------------+  |
+---------------------------------------------------------------+
```

| Topic                    | Participants            | Size limit | What it carries                          |
| ------------------------ | ----------------------- | ---------- | ---------------------------------------- |
| `pyde/vertices/1`        | Committee primaries     | 256 KB     | DAG vertices (batch refs + parent refs + state-root sigs + beacon commits + FALCON sig) |
| `pyde/transactions/1`    | All nodes               | 128 KB     | User transactions (plaintext, or private-mempool commit / reveal) |
| `pyde/batches/1`         | Workers + primaries     | 4 MB       | Worker batches (hard cap; preserves modest-hardware claim) |
| `pyde/sync/1`            | All nodes (req/resp)    | 16 MB      | Snapshot chunks (4 MB typical), historical vertices |
| `pyde/evidence/1`        | Validators              | 64 KB      | Slashing evidence (double-sign, equivocation, etc.) |

### Validator-only vertex channel

Non-validator peers are dropped from the `pyde/vertices/1` and
`pyde/evidence/1` topics. The check
(`ChannelAccess::validator_only()` in `crates/net/src/channels.rs`) refuses
to forward messages from peers whose FALCON-attested pubkey is not in the
current committee set. A non-validator that subscribes to the topic gets
`ValidationResult::Reject` on every publish.

This matters: the vertex channel carries committee FALCON sigs,
piggybacked beacon commits, and state-root attestations. A malicious
non-validator that could flood the channel could DoS the commit
pipeline. The validator-only filter prevents this by construction.

### Per-channel size limits

The validator (`crates/net/src/channels.rs`) checks the message size
against the per-channel cap before forwarding. Oversized messages are
rejected and the originating peer takes a reputation penalty.

---

## 12.3 Gossipsub Configuration

`crates/net/src/node.rs` configures gossipsub:

| Parameter                | Value                | Why                                |
| ------------------------ | -------------------- | ---------------------------------- |
| `validation_mode`        | `Permissive`         | Auto-forward; see throughput note  |
| `heartbeat_interval`     | 150 ms               | Matches DAG round cadence; amortizes mesh maintenance without blocking round progress |
| `mesh_n`                 | 8                    | Mesh size per node                 |
| `mesh_n_low`             | 4                    | Trigger mesh expansion             |
| `mesh_n_high`            | 12                   | Trigger mesh pruning               |
| `gossip_lazy`            | 8                    | Number of IHAVE peers              |
| `history_length`         | 6                    | Recent message-id buffer (heartbeats)|
| `history_gossip`         | 3                    | Size of the IHAVE batch            |
| `duplicate_cache_time`   | 60 s                 | Dedup window — handles small-net jitter|
| `flood_publish`          | true                 | Initial publish reaches all mesh peers|
| `max_transmit_size`      | 1 MB                 | Per-message cap (channels override)|

### The Permissive + flood_publish change

Strict gossipsub validation requires the application layer to call
`report_message_validation_result` for every message before it gets
forwarded. Earlier Pyde code didn't do this on every path — the result was
that, on a small (4-validator) testnet, transactions only reached the
direct peer of the submitting node. They never propagated through the
mesh.

The fix (commit 2018b17) was twofold:

1. Switch to `ValidationMode::Permissive`, which auto-forwards a message
   once the basic structural check passes.
2. Set `flood_publish = true` so the initial publish from a node reaches
   all of its mesh peers immediately, not just a random subset.

The combination raised sustained TPS from ~1K to ~4K on the same testnet
hardware. There is also a paired change in the wave executor that skips
redundant per-tx FALCON verification when the wave-level batched verify
already passed (`block_sigs_pre_verified` flag in `WaveContext`) —
roughly 70% reduction in wave-execution CPU.

---

## 12.4 FALCON P2P Handshake

After a libp2p connection is established, the two peers run a FALCON
attestation exchange to bind the libp2p PeerId to a post-quantum identity.

```rust
// crates/net/src/auth.rs
struct PydeAuthReq  { nonce: [u8; 32] }
struct PydeAuthResp {
    falcon_pubkey: Vec<u8>,    // ~897 bytes
    signature:     Vec<u8>,    // FALCON over (nonce || responder_peer_id_bytes)
}
```

### Flow

```
A (initiator)                    B (responder)
  |                                |
  | --- PydeAuthReq(nonce) ------->|
  |                                |
  |                                | sign  msg = nonce || responder_peer_id_bytes
  |                                | with B's FALCON sk
  |                                |
  | <-- PydeAuthResp(pk, sig) -----|
  |                                |
  | verify(pk, msg, sig)           |
  | record (peer_id -> pk)         |
  |                                |
```

`verify_auth_resp(req, resp, peer_id)` parses the pubkey, reconstructs the
attestation message, and runs `falcon_verify`. On success, the binding
`(peer_id -> falcon_pubkey)` is recorded in the local `PeerManager`.

### Outcome

```rust
enum AuthOutcome {
    NoPendingNonce,           // attempt to respond with no outstanding req
    VerifyFailed,             // FALCON sig invalid
    RebindRejected,           // peer tried to bind a different pubkey
    StoredAsValidator,        // pubkey is in current committee_keys
    StoredAsNonValidator,     // pubkey is not in committee
}
```

A `RebindRejected` is suspicious — once a PeerId is bound to a FALCON
pubkey, attempts to re-bind it are denied (a PeerId switching pubkeys mid
session is either a bug or an attack).

### Validator-channel filtering uses this binding

Every gossipsub message on `pyde/consensus/1` is checked against the
attested pubkey of the publishing peer. Non-validators (no committee
membership) get their messages dropped before any heavyweight verification
runs. This is the cheap front-line filter that keeps consensus traffic
clean.

---

## 12.5 Peer Discovery (Layered, No DHT)

**Pyde does not use a Kademlia DHT.** The pre-pivot design did, until we
audited the security profile: a DHT for a 128-member committee gives an
attacker a controllable lookup surface (Sybil flooding of routing tables,
eclipse via DHT poisoning) without offering value the committee couldn't
get from simpler mechanisms.

Discovery proceeds in five layers, each falling back to the next:

```
1. Hardcoded bootstrap seeds       (chain spec ships ~10 well-known IPs)
2. DNS seed lookup                  (TXT records at seed.pyde.network)
3. On-chain validator registry      (each validator's PeerId+addr on-chain)
4. Peer exchange (PEX)              (peers gossip their connected-peer list)
5. Local cache                      (recently-seen-good peers persisted)
```

### Bootstrap

The chain spec ships hardcoded bootstrap seeds + the DNS seed name. At
startup the node dials seeds in parallel, performs FALCON handshakes,
and queries each seed's connected-peer list (PEX) to expand the candidate
set.

```toml
# in pyde.toml
[network]
bootstrap_seeds = [
    "/dns4/seed1.pyde.network/udp/30303/quic-v1/p2p/12D3Koo...",
    "/dns4/seed2.pyde.network/udp/30303/quic-v1/p2p/12D3Koo...",
]
dns_seed = "seed.pyde.network"
```

### On-chain validator registry

Each committee validator's `(falcon_pubkey, peer_id, multiaddr)` is on
chain in the validator-registry account, updated when a validator joins
the committee. A new node fetching the genesis block (or any later state
snapshot) has the complete committee directory — no DHT lookup required.

### Peer exchange (PEX)

Once connected, peers periodically gossip a short list of other peers
they're currently connected to. PEX uses a small dedicated request/response
protocol (`/pyde/pex/1`) — not the gossipsub channels — to avoid mixing
discovery traffic with consensus.

### Why this is enough

- **128 committee members** is small enough that the on-chain registry is
  the entire ground truth. No DHT-style scalability is needed.
- **Sentry node pattern** (next section) hides committee identities from
  public peers anyway — the committee discovery layer is private.
- **Layered fallback** means no single point of failure: seeds, DNS,
  on-chain, PEX, cache.

### What's stored in the layered cache

| Layer              | Persistence  | Trust model                    |
| ------------------ | ------------ | ------------------------------ |
| Hardcoded seeds    | binary       | Chain-spec trusted              |
| DNS records        | DNS TTL      | DNS operator trusted             |
| On-chain registry  | JMT          | Consensus-finalized              |
| PEX cache          | LRU 1024     | Peer-attested only               |
| Local good-peer cache| disk LRU 100| Empirically known good          |

---

## 12.6 Connection Limits and Rate Limiting

`crates/net/src/config.rs` defaults:

| Constant                       | Default     | Meaning                                  |
| ------------------------------ | ----------- | ---------------------------------------- |
| `DEFAULT_PORT`                 | 30303       | Default UDP listen port                  |
| `DEFAULT_MAX_PEERS`            | 50          | Total connected peers                    |
| `DEFAULT_MAX_INBOUND`          | 30          | Max inbound connections                  |
| `DEFAULT_MAX_OUTBOUND`         | 20          | Max outbound connections                 |
| `DEFAULT_RATE_LIMIT_PER_IP`    | 5 / sec     | Inbound connect rate per IP              |
| `DEFAULT_IDLE_TIMEOUT`         | 60 s        | Drop idle connections after              |

The peer manager (`crates/net/src/peer.rs`) tracks these per-IP
counters; `can_accept()` enforces them.

### Token-bucket rate limits

The DDoS subsystem (`crates/net/src/ddos.rs`) implements per-peer
token-bucket rate limiting:

```rust
RateLimiter {
    max_tokens:   f64,
    refill_rate:  f64,    // tokens / sec
    current:      f64,
    last_refill:  Instant,
}
```

Evidence ingest, in particular, is rate-limited (per the post-Phase-1
audit hardening: `task 014d`). Without the limit, a non-validator peer
could spam garbage-sig evidence at ~60 µs of FALCON verify each — enough
to consume validator CPU at scale. With the limit, repeat offenders are
dropped after the first failure.

### Per-subnet limits

`SubnetLimiter` (also in `crates/net/src/ddos.rs`) tracks /24 subnets and
caps connections per subnet, preventing a single network operator from
monopolizing peer slots.

---

## 12.7 Peer Reputation

Each `PeerInfo` (`crates/net/src/peer.rs`) tracks:

```rust
struct PeerInfo {
    peer_id:           PeerId,
    falcon_pubkey:     Option<Vec<u8>>,    // post-handshake binding
    role:              PeerRole,           // Validator / FullNode / Light / Unknown
    messages_received: u64,
    invalid_messages:  u64,
    last_seen:         Instant,
}
```

A simple reputation score:

```
reputation = messages_received - (invalid_messages * 10)
```

Peers with strongly negative reputation are dropped and rate-limited. The
scoring is deliberately simple — Pyde does not currently ship a
sophisticated gossip score (no `peer_score_thresholds`), trusting the
combination of validator-channel filtering, FALCON binding, and
token-bucket rate limits to handle the major attack vectors.

A more sophisticated scoring mechanism (decay weights, per-topic scores,
gray-listing) is on the post-mainnet hardening list.

---

## 12.8 NAT Traversal

Pyde leans on libp2p's standard NAT-traversal tools:

1. **AutoNAT** detects whether the local node is reachable.
2. **DCUtR** (Direct Connection Upgrade through Relay) coordinates QUIC
   hole-punching between nodes behind cone NATs.
3. **Relay nodes** forward traffic for nodes behind symmetric NATs that
   can't be hole-punched.
4. **UPnP / PCP** automatic port mapping on supportive home routers.

A node with `nat_status = SymmetricNat` will rely on relays; a `Public`
node accepts inbound directly. This is standard libp2p mechanics; Pyde
does not modify the underlying behavior.

---

## 12.9 Bandwidth Profile

At the steady-state v1 throughput target (to be established by the
multi-region performance harness; ~80 KB average batches, ~500 ms median
commit cadence):

| Channel               | Inbound       | Outbound      |
| --------------------- | ------------- | ------------- |
| Transactions          | ~3 MB/s        | ~3 MB/s        |
| Batches               | ~1 MB/s        | ~1 MB/s        |
| Consensus (validator) | ~0.3 MB/s      | ~0.3 MB/s      |
| Sync (serving)        | ~2 MB/s        | ~2 MB/s        |
| DHT / discovery       | ~0.1 MB/s      | ~0.1 MB/s      |
| **Validator total**   | **~6 MB/s**   | **~6 MB/s**   |
| **Full node total**   | **~4 MB/s**   | **~4 MB/s**   |

Recommended links:

| Role         | Bandwidth          | Connections |
| ------------ | ------------------ | ----------- |
| Validator    | 100+ Mbps symmetric| 50–100      |
| Full node    | 100 Mbps symmetric | 30–60       |
| Light client | 1 Mbps             | 3–5         |

These are well within commodity hosting tiers — no datacenter requirement.

### Bandwidth reductions

- **Transaction batching** within gossipsub (configurable batch + 50 ms
  flush window).
- **Compact blocks** for large block bodies — short tx IDs (6 bytes of
  Poseidon2 hash) instead of full tx hashes (32 bytes).
- **LZ4 / Snappy compression** on gossip payloads (~60% reduction on
  transaction batches).
- **Mesh dedup cache** — `duplicate_cache_time = 60 s` prevents the same
  message from being forwarded multiple times.

---

## 12.10 Network Initialization Sequence

```
On `pyde run`:

  1. Load config (TOML); apply CLI overrides.
  2. Initialize logging.
  3. Create or load validator identity (FALCON keypair if validator).
  4. Open RocksDB state store; apply genesis if empty.
  5. Attach the consensus_store (restore seen_proposals / votes / evidence).
  6. Generate libp2p keypair (Ed25519); derive PeerId.
  7. Bind QUIC listener on configured port (default 30303).
  8. Connect to bootstrap peers.
  9. Run Kademlia FIND_NODE(self) to populate routing table.
 10. Subscribe to gossipsub topics.
 11. If validator role:
       a. Announce committee membership on DHT (validator:{epoch} key).
       b. Run FALCON handshake with discovered validators.
       c. Start the consensus loop.
 12. Start RPC server (HTTP + WebSocket).
 13. Start metrics endpoint (Prometheus, default port 9090).
```

---

## 12.11 Metrics

Every node exposes a Prometheus endpoint with at minimum:

| Metric                              | Type    | Meaning                              |
| ----------------------------------- | ------- | ------------------------------------ |
| `pyde_peers_connected`              | gauge   | Total connected peers                |
| `pyde_peers_by_role`                | gauge   | Validators / full / unknown          |
| `pyde_gossip_messages_received`     | counter | Messages received per topic          |
| `pyde_gossip_messages_sent`         | counter | Messages sent per topic              |
| `pyde_bandwidth_inbound_bytes`      | counter | Total inbound bytes                  |
| `pyde_bandwidth_outbound_bytes`     | counter | Total outbound bytes                 |
| `pyde_block_propagation_time_ms`    | histo   | Time from propose to receipt         |
| `pyde_consensus_msg_latency_ms`     | histo   | Round-trip on consensus channel      |
| `pyde_dht_routing_table_size`       | gauge   | Kademlia routing table entries       |
| `pyde_falcon_handshakes_completed`  | counter | Successful peer handshakes            |
| `pyde_falcon_handshakes_failed`     | counter | Verification failures                 |

These feed into the `docker/grafana` dashboards that ship with the repo.

---

## 12.12 Sentry Node Pattern (Committee Defense)

Committee validators have stake at risk and produce vertices on a tight
~500ms cadence — losing connectivity for a few rounds risks liveness
penalties. To insulate them from direct attack, Pyde supports the
**sentry node pattern** (Cosmos-style):

```
Internet
   |
   v
+----------+  +----------+  +----------+
| Sentry 1 |  | Sentry 2 |  | Sentry 3 |     (public-facing, no stake)
+----+-----+  +----+-----+  +----+-----+
     |             |              |
     +-------------+--------------+
                   |  (private VPN/cloud network)
                   v
            +-------------+
            | Committee   |               (hidden, never directly addressable)
            | Validator   |
            +-------------+
```

- **Committee validator** only accepts QUIC connections from its known
  sentry IPs. Public peers never know its IP.
- **Sentry nodes** are full nodes that route traffic to the validator.
  They run no stake; if attacked, they're disposable.
- **PEX-suppressed** — the committee validator does not gossip its address
  via PEX, so its IP doesn't leak through the discovery layer.

The pattern is supported in `pyde.toml`:

```toml
[network]
sentry_mode = true                  # for committee validators
allowed_inbound_peers = [
    "/ip4/10.0.1.5/udp/30303/quic-v1/p2p/12D3Koo...",   # sentry 1
    "/ip4/10.0.1.6/udp/30303/quic-v1/p2p/12D3Koo...",   # sentry 2
]
suppress_pex_advertisement = true
```

Non-committee validators and full nodes typically don't bother with sentries.

## 12.13 What's Out of Scope for Mainnet

Honest about what is not in the network layer at launch:

- **Witness delivery to provers.** The chain doesn't have provers, so
  there's no `pyde/witnesses/1` channel.
- **Erasure coding for vertex propagation.** The current implementation
  fans out vertices via gossipsub. Reed-Solomon erasure coding for very
  large vertices is on the post-mainnet improvements list.
- **Algebraic FALCON batch verification.** Implemented as sequential
  loop for v1; algebraic batching (sharing FFT work across signatures)
  is post-mainnet hardening.

---

## Summary

| Component                  | Choice                                                |
| -------------------------- | ----------------------------------------------------- |
| Transport                  | libp2p over QUIC (TCP fallback)                       |
| libp2p identity            | Ed25519 (PeerId routing only)                          |
| Application identity       | FALCON-512 (vertex sigs, attestations, evidence)       |
| Channels                   | 5 — vertices / transactions / batches / sync / evidence |
| Validator channel filter   | FALCON pubkey ∈ current committee                      |
| Gossipsub mode             | `Permissive` + `flood_publish = true`                 |
| Heartbeat                  | 150 ms (matches DAG round cadence)                    |
| Mesh size                  | 8 (low 4, high 12)                                    |
| Peer handshake             | FALCON-512 attestation; binds peer_id → falcon_pk      |
| Discovery                  | Layered: seeds → DNS → on-chain registry → PEX → cache (no DHT) |
| Committee defense          | Sentry node pattern (Cosmos-style)                    |
| Connection limits          | 50 total / 30 inbound / 20 outbound (defaults)        |
| Rate limit (per IP)        | 5 / sec (defaults)                                    |
| Symmetric encryption       | TLS 1.3 inside QUIC                                   |
| Bandwidth (committee)      | 500 Mbps, scales with throughput (Ch 19)              |

The next chapter covers the parachain layer — Pyde's one mechanism for
everything off-chain, from foreign chains to data feeds — what's locked
at mainnet, what ships after, and how the layer stays honest.
