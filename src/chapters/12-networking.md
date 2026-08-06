# Chapter 12: Networking

Pyde's P2P network sits on libp2p over QUIC, with purpose-specific
gossipsub channels and an application-layer FALCON-512 handshake that binds
each peer's libp2p PeerId to a post-quantum identity. **Peer discovery
uses a layered approach (no Kademlia DHT): hardcoded seeds, then DNS,
then the on-chain validator registry, then PEX**. This was a deliberate
post-pivot choice: a DHT for a 128-member committee is more attack surface
than it is value.

**Worker / Primary split (Narwhal pattern).** Within each validator,
transactions and consensus traffic are decoupled. Workers gossip
transaction batches peer-to-peer (high-volume data dissemination);
primaries gossip vertices (low-volume consensus structure). A vertex
carries batch hashes by reference, never full payloads.

The encryption story is layered: libp2p's standard Ed25519/X25519 handles
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

Per-stream independence matters most when wave propagation (large) and
consensus votes (latency-critical) share the same QUIC connection. A single
lost packet on the wave stream does not stall the vote stream.

The libp2p config is set up in `crates/net/src/transport.rs` via
`SwarmBuilder::with_existing_identity(..).with_quic()`.

### Identity at the libp2p layer

libp2p PeerIds in Pyde are derived from **Ed25519 / X25519** keys, the
libp2p default. The choice is intentional: libp2p's PeerId routing,
Kademlia DHT lookups, and QUIC handshake all assume one of the supported
key types. Replacing the libp2p layer's identity with FALCON would require
a custom libp2p fork.

The **post-quantum identity** layer sits one step higher: every consensus
and validator-channel message is signed with FALCON-512, and the
application-level peer handshake (§12.4) binds the libp2p PeerId to a
FALCON public key. Pyde's threat model treats the libp2p layer as fungible
peer routing; the cryptographic claims that matter (vote authenticity,
finality cert verification, evidence verification) all sit on FALCON.

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
|  | Consensus   | | Transactions| | Waves       | | Sync     |  |
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

The wire strings are frozen: adding a topic is fine (older nodes just
don't subscribe), renaming one is a forking event. The full set is
`crates/net/src/topics.rs`:

| Topic                     | Participants            | What it carries                          |
| ------------------------- | ----------------------- | ---------------------------------------- |
| `pyde/vertices/1`         | Committee primaries     | DAG vertices (batch refs + parent refs + state-root sigs + beacon commits + FALCON sig) |
| `pyde/batches/1`          | Workers + primaries     | Transaction batches; vertices reference them by hash |
| `pyde/mempool/1`          | All nodes               | Pending-transaction propagation between RPC ingress and mempool workers |
| `pyde/beacon-shares/1`    | Committee members       | Per-epoch beacon shares, combined at the epoch boundary |
| `pyde/state-root-sigs/1`  | Committee members       | Rolling state-root attestations; feeds finality |
| `pyde/wave-commits/1`     | Validators → all nodes  | Committed `WaveCommitRecord` announcements; full nodes use them as the tx list to execute locally |
| `pyde/state-sync/1`       | All nodes               | Snapshot manifest + chunk announcements  |
| `pyde/checkpoints/1`      | Committee members       | Signed weak-subjectivity checkpoints     |
| `pyde/evidence/1`         | Validators              | Slashing evidence (double-sign, equivocation) |
| `pyde/governance/1`       | All nodes               | Governance proposals + votes             |

### Per-message size limit

There is **one** cap, not a per-topic table: `max_transmit_size` = 4 MiB,
set once on the gossipsub config in `crates/net/src/behaviour.rs` and
applied uniformly to every topic. Oversized messages never reach the
application layer.

### Validator-only traffic

The vertex and evidence topics carry committee FALCON sigs, piggybacked
beacon commits, and state-root attestations, so a non-validator flooding
them would be attacking the commit pipeline directly. The filter that
enforces this is **not** a transport-layer ACL: gossipsub's own signature
is only the cheap first pass, and the authority check is the inner FALCON
signature against the committee set, applied by the node-side consumer
before the message is acted on (`crates/net/src/gossip_verdict.rs` carries
the verdict back to the mesh, so an unauthorised publisher's message is
reported `Reject` and counted against the sender).

---

## 12.3 Gossipsub Configuration

`build_gossipsub()` in `crates/net/src/behaviour.rs` configures gossipsub.
Only the parameters Pyde sets are listed; everything else is the libp2p
default:

| Parameter                | Value                | Why                                |
| ------------------------ | -------------------- | ---------------------------------- |
| `protocol_id_prefix`     | fork-scoped          | Two chains with different `fork_id` advertise different meshsub protocol strings, so a foreign-fork peer's gossip never enters the process |
| `validation_mode`        | `Strict`             | Envelope must carry a valid libp2p signature before anything else looks at it |
| `heartbeat_interval`     | 1 s (`GOSSIPSUB_HEARTBEAT`) | libp2p's default, kept for v1; retuned once the perf harness lands |
| `max_transmit_size`      | 4 MiB (`GOSSIPSUB_MAX_TRANSMIT_SIZE`) | Large enough for a full vertex with batch refs; still modest-hardware friendly |
| `message_authenticity`   | `Signed(keypair)`    | Every published message is signed with the host's libp2p key |

Mesh sizing (`mesh_n`, `mesh_n_low`, `mesh_n_high`, `mesh_outbound_min`) is
left at libp2p's production defaults **except** in small-cluster mode,
where the node overrides them to `1 / 2 / 4 / 0` and drops the heartbeat to
200 ms (`SMALL_CLUSTER_HEARTBEAT`). That override exists for in-process
devnet clusters of fewer than six validators: the production defaults
cannot fill `mesh_n_low` against a three-peer cluster, so the mesh sits in
heartbeat-driven recovery and cross-vertex gossip never converges.

### Why Strict, and how the verdict gets reported

Strict validation means gossipsub stops forwarding a message on receipt and
waits for the application to report a verdict. That is the right shape — a
node should not amplify junk to its whole mesh before looking at the bytes
— but it converts a bandwidth bug into a liveness one: a message the
application never reports on is *never forwarded*, silently, with no error.
A topic whose verdict is missed stops propagating fleet-wide.

`crates/net/src/gossip_verdict.rs` closes that hole with two deliberate
choices. The verdict is produced by a guard that reports on `Drop`, so
early returns, `?` and panics all still produce one. And the drop default
is `Accept`, never `Ignore`. That looks backwards until you compare failure
modes: defaulting to `Ignore` degrades to *the mesh stops carrying that
topic*; defaulting to `Accept` degrades to *we relayed a size-bounded
message without judging it*. One has a no-regression failure mode, the
other halts the chain. The missed verdict is still logged at `error` and
counted — loud, but not fatal.

---

## 12.4 FALCON P2P Handshake

**Status: designed, not built.** There is no `auth` module in the net
crate and no connection-level FALCON exchange today. What ships instead:
libp2p's own Ed25519 identity binds the PeerId at the transport layer, and
every consensus message carries its FALCON signature *inside the payload*,
verified by the node-side consumer against the committee set before the
message is acted on. `crates/net/src/behaviour.rs` states the split
directly — the gossipsub signature is the cheap first filter, FALCON is the
chain-level identity binding.

That ordering is deliberate about where authority lives: nothing grants a
peer standing because of how it connected. An unauthenticated connection
can waste bandwidth, which the connection and request-rate limits below
bound, but it cannot get a message counted as a committee member's.

The design below binds the PeerId to a post-quantum identity at connection
time, which would let a node reject junk earlier — before the payload
parse rather than after. It is described here so the intended shape is on
the record, not because you can read it out of `crates/net`.

```rust
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

A `RebindRejected` is suspicious: once a PeerId is bound to a FALCON
pubkey, attempts to re-bind it are denied (a PeerId switching pubkeys mid
session is either a bug or an attack).

### What the binding would buy

With the binding in place, a message on `pyde/vertices/1` could be checked
against the attested pubkey of the *publishing peer* and dropped before any
heavyweight verification runs. Today the equivalent check happens one layer
later, against the FALCON signature inside the message, so the saving is
CPU on junk rather than any change to what the chain accepts.

---

## 12.5 Peer Discovery (Layered, No DHT)

**Pyde does not use a Kademlia DHT.** The pre-pivot design did, until we
audited the security profile: a DHT for a 128-member committee gives an
attacker a controllable lookup surface (Sybil flooding of routing tables,
eclipse via DHT poisoning) without offering value the committee couldn't
get from simpler mechanisms.

Discovery is layered, with every source either operator-configured or
derived from the chain's own state — never from a public routing table.
`crates/net/src/discovery.rs` is explicit about which layers ship today:

```
1. Operator bootnodes file          SHIPPED  (plain-text multiaddr list)
2. DNS resolution of /dns/ addrs    SHIPPED  (libp2p's dns transport)
3. On-chain validator registry      FUTURE   (needs the registry gossiped + queryable)
4. Peer exchange (PEX) cache        FUTURE   (persisted across restarts)
```

### Bootstrap

The operator supplies a `bootnodes` file: plain text, one multiaddr per
line, `#` comments, blank lines ignored. The validator dials every entry at
startup alongside any `--dial` CLI arguments. There is no compiled-in seed
list and no DNS TXT-record seed lookup — a `/dns/` multiaddr in the file is
resolved by libp2p's own DNS transport, which `crates/net/src/transport.rs`
opts the swarm builder into.

```text
# Pyde testnet bootnodes — auto-generated; do not hand-edit.
/dns/seed1.pyde.network/udp/4001/quic-v1/p2p/12D3Koo…
/dns/seed2.pyde.network/udp/4001/quic-v1/p2p/12D3Koo…
/ip4/198.51.100.7/udp/4001/quic-v1/p2p/12D3Koo…
```

TOML and JSON were deliberately avoided: plain text is grep-friendly, easy
to template from operator tooling, and pulls in no parser dependency.

### On-chain validator registry (future)

Each committee validator's `(falcon_pubkey, peer_id, multiaddr)` is meant
to live on chain in the validator-registry account, updated when a
validator joins the committee, so a new node fetching the genesis manifest
or any later state snapshot has the complete committee directory with no
DHT lookup. The registry exists on chain; the discovery layer that reads it
for dialling does not yet.

### Peer exchange (future)

Once connected, peers would periodically exchange a short list of the peers
they are connected to, over a dedicated request/response protocol rather
than the gossipsub topics, to avoid mixing discovery traffic with
consensus. Not implemented; there is no PEX protocol in the net crate
today.

### Why this is enough

- **128 committee members** is small enough that the on-chain registry is
  the entire ground truth. No DHT-style scalability is needed.
- **Sentry node pattern** (next section) hides committee identities from
  public peers anyway; the committee discovery layer is private.
- **No public routing table** means no Sybil-floodable lookup surface: the
  worst an attacker can do to discovery is decline to answer, which the
  operator's own bootnode list routes around.

### Trust model per layer

| Layer                     | Status  | Trust model                    |
| ------------------------- | ------- | ------------------------------ |
| Operator bootnodes file   | shipped | Operator-trusted                |
| DNS resolution of `/dns/` | shipped | DNS operator trusted            |
| On-chain registry         | future  | Consensus-finalized             |
| PEX cache                 | future  | Peer-attested only              |

---

## 12.6 Connection Limits and Rate Limiting

Connection caps are compile-time constants in
`crates/net/src/behaviour.rs`, applied through libp2p's
`connection_limits::Behaviour` — not an operator-tunable config file:

| Constant                       | Value       | Meaning                                  |
| ------------------------------ | ----------- | ---------------------------------------- |
| `MAX_ESTABLISHED_INCOMING`     | 128         | Established inbound connections           |
| `MAX_ESTABLISHED_OUTGOING`     | 64          | Established outbound (peers we dialed)    |
| `MAX_ESTABLISHED_TOTAL`        | 192         | Aggregate ceiling — the hard FD cap       |
| `MAX_ESTABLISHED_PER_PEER`     | 4           | Connections to any one peer               |
| `MAX_PENDING_INCOMING`         | 32          | In-flight inbound handshakes              |
| `MAX_PENDING_OUTGOING`         | 16          | In-flight outbound dials                  |

The split is an **eclipse-safety invariant**, not arbitrary sizing: the
total is exactly incoming + outgoing, so an inbound flood that maxes the
incoming cap still leaves the full outbound budget free for the node's own
committee dials. The directional caps always bind before the total. A
compile-time assertion enforces the relationship, so editing the numbers so
it breaks is a build error rather than a silent eclipse regression.

### Global request-rate limits

Inbound *serve* requests — vertex fetch, batch fetch, state-sync chunk
fetch — are rate-limited by token bucket in
`crates/net/src/inbound_limit.rs`. Connection limits bound how many peers
can connect; they do not bound the request rate from the peers that are
already connected, and cheap Ed25519 PeerId rotation defeats any purely
per-peer limit. So the bucket is **global** — aggregate across all peers —
which a rotating attacker cannot escape:

| Bucket                | Capacity | Refill / sec |
| --------------------- | -------- | ------------ |
| Consensus fetch       | 2,048    | 1,024        |
| State-sync chunk serve| 512      | 256          |
| Durable vertex serve  | 64       | 32           |

The pressure this relieves is real: every inbound fetch is served
synchronously on the single swarm event-loop task, so without a cap any set
of connected peers can pin that loop's CPU and upload bandwidth.

### Per-subnet limits

**Not implemented.** There is no subnet limiter in the net crate. A single
network operator holding many addresses in one `/24` is bounded only by the
aggregate connection caps above, not by anything subnet-aware. Closing that
is on the hardening list.

---

## 12.7 Peer Reputation

**Status: designed, not built.** `crates/net/src/peer.rs` is a thin
newtype wrapping libp2p's `PeerId` at the crate boundary — it carries no
per-peer counters and no score. What the node has today is libp2p's own
per-peer bookkeeping plus the global rate limits above; a message reported
`Reject` through `crates/net/src/gossip_verdict.rs` is counted against its
sender by gossipsub itself.

The intended record:

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

Peers with strongly negative reputation would be dropped and rate-limited.
The scoring is deliberately simple, and Pyde ships no gossip score at all
today (no `peer_score_thresholds`), trusting the combination of
payload-level FALCON verification and the global request-rate limits to
handle the major attack vectors.

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
| Validator    | 100+ Mbps symmetric| 50 to 100   |
| Full node    | 100 Mbps symmetric | 30 to 60    |
| Light client | 1 Mbps             | 3 to 5      |

These are well within commodity hosting tiers: no datacenter requirement.

### Bandwidth reductions

- **Transaction batching** within gossipsub (configurable batch + 50 ms
  flush window).
- **Compact waves** for large wave bodies: short tx IDs (6 bytes of
  Poseidon2 hash) instead of full tx hashes (32 bytes).
- **LZ4 / Snappy compression** on gossip payloads (~60% reduction on
  transaction batches).
- **Mesh dedup cache**: `duplicate_cache_time = 60 s` prevents the same
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
| `pyde_wave_propagation_time_ms`     | histo   | Time from propose to receipt         |
| `pyde_consensus_msg_latency_ms`     | histo   | Round-trip on consensus channel      |
| `pyde_dht_routing_table_size`       | gauge   | Kademlia routing table entries       |
| `pyde_falcon_handshakes_completed`  | counter | Successful peer handshakes            |
| `pyde_falcon_handshakes_failed`     | counter | Verification failures                 |

These feed into the `docker/grafana` dashboards that ship with the repo.

---

## 12.12 Sentry Node Pattern (Committee Defense)

Committee validators have stake at risk and produce vertices on a tight
~500ms cadence; losing connectivity for a few rounds risks liveness
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
- **PEX-suppressed**: the committee validator does not gossip its address
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
| Channels                   | 5: vertices / transactions / batches / sync / evidence |
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

The next chapter covers the parachain layer (Pyde's one mechanism for
everything off-chain, from foreign chains to data feeds): what's locked
at mainnet, what ships after, and how the layer stays honest.
