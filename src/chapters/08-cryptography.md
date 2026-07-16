# Chapter 8: Cryptography

Pyde's cryptographic stack is post-quantum from genesis. There are no elliptic
curves anywhere in the protocol — no secp256k1, no ed25519, no BLS12-381. Every
primitive used to authenticate transactions, exchange keys, hash state, or
prove randomness is built on lattices or hash functions.

This chapter specifies every primitive with the parameters Pyde actually
ships, where they live in the codebase, and how they fit together.

---

## 8.1 Design Principles

Three constraints shape every choice:

1. **Post-quantum security.** Every primitive must resist both classical and
   known quantum attacks (Shor for factoring/DLP, Grover for brute force).
   This rules out RSA, ECDSA, EdDSA, BLS, ECDH, and anything else built on
   elliptic curves or integer factorization.

2. **No trusted setup.** No ceremony, no toxic waste. Every public parameter
   is either a NIST standard or a transparent algebraic constant.

3. **Hybrid hashing: Blake3 for speed, Poseidon2 for ZK.** Bitwise hashes
   (Blake3) saturate modern CPUs at multi-GB/s and dominate the
   high-volume native paths (JMT internals, gossip de-dup, batch hashes).
   Algebraic hashes (Poseidon2) are 30-50× slower in native execution but
   roughly 1000× cheaper inside an algebraic constraint system (STARK,
   future ZK validity proof). Pyde uses both: Blake3 where the work is
   off-chain or committee-signed, Poseidon2 where the hash may be exposed
   to a ZK circuit (state root, address derivation, signature payloads).

```
Traditional blockchain crypto stack:
  Signatures:   ECDSA (secp256k1)        broken by quantum
  Key exchange: ECDH                      broken by quantum
  Hashing:      Keccak-256                quantum-safe; not ZK-native
  Randomness:   BLS-based VRF             broken by quantum

Pyde crypto stack:
  Signatures:   FALCON-512                lattice (NIST FIPS 206)
  Key exchange: Kyber-768 / ML-KEM        lattice (NIST FIPS 203)
  Hashing:      Blake3 + Poseidon2        hybrid: speed + ZK-friendly
                  Blake3 (Goldilocks-free, ~3 GB/s)
                    JMT internals, batch hashes, vertex hashes, gossip,
                    commit-reveal commitments
                  Poseidon2 (Goldilocks field, ZK-native)
                    state root, addresses, VRF output, RNG mix
  Randomness:   Lattice VRF (FALCON-proof + Poseidon2 output)
  Symmetric:    AES-256-GCM (hardware-accelerated)
```

The whole stack lives under `crates/crypto`.

---

## 8.2 FALCON-512: Digital Signatures

FALCON (Fast Fourier Lattice-based Compact Signatures over NTRU) is Pyde's
signature scheme. NIST standardized it as part of FIPS 206. Pyde uses the
**FALCON-512** parameter set (`LOGN = 9`, dimension 512).

### Why FALCON-512 over Dilithium / SPHINCS+

| Scheme       | Pubkey | Signature | Verify time | Notes                       |
| ------------ | ------ | --------- | ----------- | --------------------------- |
| FALCON-512   | 897 B  | 600–900 B | very fast   | smallest sigs, lattice (NTRU) |
| Dilithium-2  | 1312 B | 2420 B    | fast        | larger sigs, module-LWE     |
| SPHINCS+-128 | 32 B   | 7856 B    | slow        | hash-based, huge sigs       |

A blockchain hashes signatures into every transaction, every consensus vote,
and every finality certificate. A 666 B FALCON sig × 128 committee × per-slot
finality cert × 10K blocks/hour adds up — Dilithium's 2420 B would inflate
that by 3.6×, SPHINCS+ by ~12×. FALCON's compactness is what keeps the
bandwidth budget reasonable.

### Parameter set

| Parameter           | Value                              |
| ------------------- | ---------------------------------- |
| Polynomial degree n | 512                                |
| Modulus q           | 12,289                             |
| Public key          | 897 bytes                          |
| Secret key          | 1,281 bytes                        |
| Signature           | 600–900 bytes (variable, accepted) |
| Security level      | NIST Level 1 (128-bit post-quantum)|

### API

`crates/crypto/src/falcon.rs` exposes:

```rust
pub fn falcon_keygen() -> (FalconPublicKey, FalconSecretKey);
pub fn falcon_sign(sk: &FalconSecretKey, msg: &[u8]) -> FalconSignature;
pub fn falcon_verify(pk: &FalconPublicKey, msg: &[u8], sig: &FalconSignature) -> bool;
pub fn falcon_batch_verify(items: &[(&FalconPublicKey, &[u8], &FalconSignature)]) -> bool;
```

### Determinism

Signing is deterministic. The implementation ties the FALCON Gaussian sampler
to a deterministic context derived from the input message, so the same
`(secret_key, message)` always produces the same signature. This is what
makes the lattice VRF (§8.6) work — the output is a deterministic function of
the inputs.

The domain-separation tag `b"pyde-falcon-v1"` is mixed into the signing
context to prevent cross-protocol signature reuse.

### Where FALCON-512 is used

1. **Transaction signing:** every transaction carries a FALCON-512 sig from
   the sender's account.
2. **Vertex production:** every DAG vertex is FALCON-signed by its producer.
3. **State-root attestations:** committee members sign `(wave_id,
   blake3_state_root, poseidon2_state_root)` after each commit;
   ≥ 85 sigs constitute the `HardFinalityCert`.
4. **Beacon contributions:** each committee member signs its per-member
   beacon share with a `BeaconKeypair`; ≥ quorum aggregated FALCON sigs
   form the epoch beacon (see Chapter 6).
5. **P2P peer authentication:** the FALCON handshake (`crates/net/src/auth.rs`).
6. **VRF proofs:** every VRF output is paired with a FALCON proof.
7. **Slashing evidence:** submitters sign their evidence transactions.

### Batch verification

`falcon_batch_verify` checks an array of `(pk, msg, sig)` triples
sequentially. The current implementation is **not** algebraically batched —
it returns true only if every individual verification succeeds. Algebraic
batch verification (sharing FFT operations across signatures) is on the
post-mainnet hardening list; the sequential version is correct and meets the
current per-block budget.

---

## 8.3 Kyber-768 / ML-KEM: Key Encapsulation

Kyber is Pyde's key encapsulation mechanism. NIST standardized it as ML-KEM
under FIPS 203. Pyde uses the **Kyber-768** parameter set, NIST Security
Level 3.

### What is a KEM?

A KEM lets two parties agree on a shared secret without the symmetric key
ever crossing the wire. Alice runs `encaps(pk) -> (ciphertext, shared_secret)`
and sends the ciphertext to Bob. Bob runs `decaps(sk, ciphertext) ->
shared_secret`. They now share a 32-byte symmetric key, which Pyde uses as
the AES-256-GCM key for the actual payload encryption.

### Parameters

| Parameter              | Value                                  |
| ---------------------- | -------------------------------------- |
| Module dimension k     | 3                                      |
| Polynomial degree n    | 256                                    |
| Modulus q              | 3,329                                  |
| Public key (encaps key)| 1,184 bytes                            |
| Secret key (decaps seed)| 64 bytes (full key derived on demand) |
| Ciphertext             | 1,088 bytes                            |
| Shared secret          | 32 bytes                               |
| Security level         | NIST Level 3 (192-bit post-quantum)    |

### API

`crates/crypto/src/kyber.rs`:

```rust
pub fn kyber_keygen() -> (KyberPublicKey, KyberSecretKey);
pub fn kyber_encapsulate(pk: &KyberPublicKey) -> (KyberCiphertext, SharedSecret);
pub fn kyber_decapsulate(sk: &KyberSecretKey, ct: &KyberCiphertext) -> SharedSecret;
```

The dependency is `ml_kem = "0.3.0-rc.0"` — a release-candidate of the NIST
final standard. Upgrading to the stable release once published is tracked as
post-mainnet hardening (`task 057` in the mainnet plan).

### Where Kyber is used

1. **P2P transport key exchange.** When two nodes establish a libp2p
   connection, the QUIC handshake uses a hybrid Ed25519 + Kyber key exchange
   (Ed25519 for the libp2p PeerId, Kyber for forward-secure session keys).
   See Chapter 12.

Kyber's role is confined to transport-layer key agreement. It is **not** part
of the MEV-protection path: Pyde's private mempool is a keyless commit-reveal
scheme (§8.5) that uses no key encapsulation at all.

---

## 8.4 Hashing: Blake3 + Poseidon2

Pyde uses **two** hash functions, each chosen for a class of paths:

| Function    | Speed (native) | ZK cost (constraints) | Used for |
|-------------|----------------|------------------------|----------|
| **Blake3**  | ~3 GB/s        | ~150k per hash (huge) | JMT internal nodes, batch hashes, vertex hashes, gossip de-dup, RocksDB keys |
| **Poseidon2** | ~60 MB/s     | ~400 (small)          | State root commitment, address derivation, VRF output, FALCON sig hashing inside ZK circuits, `poseidon2` WASM host function |

### Blake3

Blake3 is the BLAKE family successor — based on the BLAKE2 compression
function arranged as a parallelizable Merkle tree, with hardware
acceleration on every modern CPU. Pyde uses Blake3 in its default
configuration (256-bit output) for every hash that lives entirely off-chain
or inside a trusted committee-signed structure.

Key Pyde-specific uses:

- **JMT internal nodes:** `blake3_pair(left, right)` per Merkle level.
  At commodity CPU speed, an entire JMT update batch hashes in microseconds.
- **Batch hashes referenced from vertices:** the worker batches transactions
  and identifies each batch by its Blake3 hash.
- **Vertex hashes in the DAG:** every consensus vertex is identified by
  its Blake3 hash.
- **Gossip message de-duplication:** Gossipsub uses Blake3 to detect
  duplicate broadcasts.
- **RocksDB cache keys:** Blake3 fingerprint of (key, version) for the
  LRU value cache.

### Poseidon2: ZK-Friendly Hashing

Poseidon2 is the algebraic hash function used on paths that may be exposed
to a ZK circuit, plus a handful of legacy paths kept for compatibility.

### Why not Keccak or SHA-256?

Inside an algebraic system (a STARK, an MPC protocol, a future ZK validity
proof), bitwise hash functions like Keccak-256 are catastrophically expensive
— roughly 150,000 algebraic constraints per Keccak hash compared to a few
hundred for Poseidon2. Even though Pyde doesn't ship a STARK at mainnet, the
lattice VRF benefits from a hash that's cheap inside an algebraic field, and
the JMT itself amortizes the per-Merkle work better when the hash is
field-native.

### Construction

Poseidon2 is a sponge construction over a prime field. Pyde uses the
**Goldilocks field** (`p = 2^64 − 2^32 + 1`) because:

- Single field elements fit in a 64-bit register.
- Modular reduction is a shift-and-subtract.
- Hardware AES is independent of this field, so we can use both efficiently.

### Parameters

| Parameter            | Value                              |
| -------------------- | ---------------------------------- |
| Field                | Goldilocks (`p = 2^64 − 2^32 + 1`) |
| State width          | 8 field elements (≈ 512 bits)      |
| Rate                 | 4 field elements (256-bit absorb)  |
| Capacity             | 4 field elements                   |
| External rounds      | 8 (4 initial + 4 terminal)         |
| Internal rounds      | 22                                 |
| S-box                | `x^7` (coprime to `p − 1`)         |
| Output size          | 4 field elements (256 bits)        |
| Security level       | 128-bit collision resistance       |

(Verified in `crates/crypto/src/poseidon2.rs` test suite.)

### API

```rust
pub fn poseidon2_hash(data: &[u8]) -> Hash256;
pub fn poseidon2_pair(left: Hash256, right: Hash256) -> Hash256;
pub fn poseidon2_many(hashes: &[Hash256]) -> Hash256;
```

Domain separation is built into the encoding: variable-length inputs are
length-prefixed before sponge absorption, and field elements are packed 7
bytes at a time (avoiding values that exceed the Goldilocks modulus).

### Where Poseidon2 is used

1. **State root commitment:** the dual-rooted state has a Poseidon2 root
   alongside the Blake3 root, signed by the committee.
2. **Account address derivation:** `Poseidon2(falcon_pubkey)`.
3. **CREATE / CREATE2 address derivation:** `Poseidon2(deployer || nonce)`
   or `Poseidon2(0xFF || deployer || salt || code_hash)`.
4. **Storage key derivation:** `Poseidon2(contract, slot)` for single
   fields, doubled for maps. Encoded as build-time constants by the
   `otigen` developer toolchain's state binding generator.
5. **Transaction hashing:** the canonical tx hash used for replay
   prevention and the wallet's signing target.
6. **VRF output:** `Poseidon2(domain || fingerprint || input)`.
7. **Epoch randomness combination:** `Poseidon2_many(sorted_shares)`.
8. **`poseidon2` WASM host function:** exposed to user-space contracts via the host-function ABI.

---

## 8.5 Commit-Reveal Commitment Scheme (Mempool MEV Protection)

Pyde's front-running protection is a **keyless commit-reveal** private mempool.
It uses no encryption key, no committee decryption, and no threshold ceremony:
the only primitives involved are Blake3 hashing and FALCON signatures — both
post-quantum. Safety never depends on any set of validators declining to
collude, because there is no shared secret to collude over. This makes the
scheme **unconditionally trustless**.

The mechanism works in two phases and is specified end-to-end in Chapter 9
(MEV Protection). This section covers only the cryptographic commitment: how a
transaction is bound to a hiding commitment and later opened.

### The commitment

A user who wants front-running protection first publishes a **Commit** (TxType
`0x11`) that carries only a hash, never the transaction body:

```
commitment = Blake3("pyde-commit-reveal-v1" || borsh(inner_tx) || nonce)
```

- `inner_tx` is the real transaction the user wants to run, serialized with
  borsh.
- `nonce` is a fresh random `[u8; 32]` that hides the commitment (so equal
  inner transactions do not produce equal commitments) and makes the
  commitment non-malleable.
- `"pyde-commit-reveal-v1"` is the domain-separation tag, preventing a
  commitment from being replayed as any other Blake3 digest in the protocol.

Blake3 is preimage- and collision-resistant, so the commitment reveals nothing
about `inner_tx` and cannot later be opened to a different transaction.

### The reveal

Once the commit's DAG position is fixed, the sender (or **any** account —
the reveal need not come from the committer) publishes a **Reveal** (TxType
`0x12`) carrying `RevealPayload { commitment, nonce, inner_tx }`. The protocol
recomputes `Blake3("pyde-commit-reveal-v1" || borsh(inner_tx) || nonce)` and
accepts the reveal only if it equals the committed hash. This binding is what
guarantees the revealed transaction is exactly the one committed to.

### Why this defeats MEV

Order is fixed **before** content is known. The DAG deterministically sequences
commits at commit time; in the reveal wave's resolution pass, revealed inner
transactions execute **in commit order**, not reveal order. An adversary who
sees a commit sees only an opaque Blake3 digest — the payload is hidden — and
by the time the payload is revealed, its execution position is already locked.
There is no window in which an attacker can observe a pending transaction's
content and reorder around it. Front-running is not "discouraged"; it is
unexpressible.

### Bond

A commit escrows a bond, sized to disincentivize spam and abandonment:

```
required_bond(value_ceiling) = max(MIN_COMMIT_BOND, value_ceiling × 1%)
MIN_COMMIT_BOND = 1e9 quanta = 1 PYDE
```

`value_ceiling` is declared in the `CommitPayload` and caps the value the
inner transaction may move. The bond is **refunded** when the reveal is
accepted and **burned** if the commit is abandoned or expires.

### Window

```
COMMIT_REVEAL_WINDOW_WAVES = 120
```

The reveal must land within 120 waves of the commit's inclusion wave. Past
that, the commit expires, its slot is dropped, and the bond is forfeit.
Expiry is evaluated as a view predicate over wave height, not a background
timer.

### Parameters

| Parameter                    | Value                                     |
| ---------------------------- | ----------------------------------------- |
| Commitment hash              | Blake3, domain `"pyde-commit-reveal-v1"`  |
| Commit tx type               | `0x11` (to = ZERO, value = required_bond) |
| Reveal tx type               | `0x12` (to = ZERO, value = 0)             |
| `MIN_COMMIT_BOND`            | 1e9 quanta = 1 PYDE                       |
| Bond ceiling                 | `value_ceiling × 1%` (whichever is larger)|
| `COMMIT_REVEAL_WINDOW_WAVES` | 120                                       |

### Why not threshold encryption

Earlier Pyde drafts protected the mempool with a threshold-encrypted lane —
transactions encrypted to a committee Kyber-768 key whose secret was
Shamir-split across the validator set and reconstructed after ordering. That
lane has been **removed** from the protocol. The blocker is fundamental:
there is no *trustless* post-quantum distributed key generation. Lattice
public keys (Kyber/ML-KEM) do not combine homomorphically the way BLS keys
do, so a committee cannot generate a threshold ML-KEM key without a trusted
dealer. Commit-reveal sidesteps the problem entirely by holding **no key at
all**.

A one-shot ciphertext mempool ("Threshold-LWE") remains a **v2+ research
direction** — it would run as an *optional* lane alongside the keyless
commit-reveal default, gated on a trustless PQ threshold-keygen breakthrough.
See Chapter 20, "Threshold-LWE One-Shot Private Mempool," for that future
work.

---

## 8.6 Lattice VRF

Pyde's VRF is built on FALCON-512. The construction:

```
Output (deterministic):
    fingerprint = Poseidon2("pyde-vrf-output-v1" || sk_bytes)
    output      = Poseidon2("pyde-vrf-output-v1" || fingerprint || input)

Proof:
    msg   = "pyde-vrf-proof-v1" || pk || input || output
    proof = falcon_sign(sk, msg)

Verify(pk, input, output, proof):
    msg  = "pyde-vrf-proof-v1" || pk || input || output
    return falcon_verify(pk, msg, proof)
```

### Properties

| Property         | Why it holds                                                |
| ---------------- | ----------------------------------------------------------- |
| Deterministic    | Output is a Poseidon2 hash of (sk-derived) constants + input |
| Unpredictable    | An attacker without `sk` cannot compute `fingerprint`        |
| Verifiable       | Anyone with `pk` can verify the FALCON sig over the input/output |
| Post-quantum     | Inherits FALCON's NTRU-lattice security                      |

### Where the VRF is used

1. **Anchor selection (indirect).** Each round, the canonical anchor is
   computed as `Hash(beacon, round, prev_state_root) mod 128` (see
   Chapter 6 §3). The beacon itself is the quorum-aggregated VRF
   output of the prior epoch's committee (an aggregate of ≥ quorum
   per-member contributions, not a threshold-shared secret) — so VRF
   underpins anchor selection one step removed, not per-round.
2. **Epoch randomness contributions.** Each member of the previous epoch's
   committee contributes a VRF share that, combined with 84 others, seeds
   the next epoch's beacon.
3. **Committee selection scoring.** At each epoch boundary, every registered
   validator gets a VRF score from `epoch_randomness || "committee"`; the
   uniform-random subset of eligible validators chosen by this score
   forms the next committee.

---

## 8.7 Symmetric Encryption: AES-256-GCM

All symmetric encryption uses **AES-256-GCM**:

1. **P2P channel encryption** (after the libp2p QUIC handshake — see
   Chapter 12).
2. **Wallet keystore encryption** (`crates/pyde-rust-sdk/src/wallet.rs`) —
   protecting a FALCON secret key at rest on disk.

### Properties

- 256-bit key (128-bit post-quantum security against Grover).
- AEAD: authenticated encryption with additional data; tampering is detected.
- AES-NI hardware acceleration on every modern CPU.

---

## 8.8 Key Derivation and Address Format

### From keypair to address

```
Master seed (user-provided or random)
    -> SHAKE-256 (with domain separator) -> FALCON keygen seed
    -> FALCON-512 keygen
        |
        +-> Public key (897 bytes)
        |
        +-> Secret key (1281 bytes)

Address derivation:
    EOA address = Poseidon2(falcon_public_key)              // 32 bytes
    CREATE      = Poseidon2(deployer_address || nonce)
    CREATE2     = Poseidon2(0xFF || deployer || salt || code_hash)
```

### Why 32-byte addresses

Pyde uses 32 bytes (the full Poseidon2 output) instead of Ethereum's
20-byte truncation. Three reasons:

1. **Birthday-bound margin.** A 20-byte address has 80-bit collision
   resistance. Marginal at chain scale; decisively safer at 128 bits.
2. **Native output size.** Poseidon2 naturally outputs 4 Goldilocks field
   elements (≈ 256 bits = 32 bytes). Using the full output avoids a
   truncation step.
3. **Simpler key derivation.** Every key derivation in the protocol
   produces 32 bytes; addresses match.

### Wallet display

Addresses are stored and serialized as raw 32-byte values. Wallets render
them in hex (`0xabc...123`) or in a Bech32m-style human-readable format with
the `pyde1...` prefix for safety against typos. The choice of display format
is a wallet-side concern; the protocol doesn't care.

---

## 8.9 The Stack at a Glance

```
   +----------------+     +----------------+
   | FALCON-512     |     | Kyber-768      |
   | sigs           |     | KEM            |
   +----------------+     +----------------+
        |                       |
        v                       v
   tx sigs               P2P session keys
   vertex sigs           (transport only)
   state root attest
   beacon shares
        |
        +-> Lattice VRF (FALCON sign + Poseidon2 output)
              anchor seeding, epoch randomness, committee scoring

   +----------------+     +----------------+
   | Blake3         |     | Poseidon2      |
   | (high-volume)  |     | (Goldilocks)   |
   +----------------+     +----------------+
        |                       |
        v                       v
   JMT internals          state root commit,
   batch hashes           addresses, storage keys,
   vertex hashes          VRF output, RNG mix
   gossip dedup           poseidon2 host function
   commit-reveal hash

   +----------------+
   | AES-256-GCM    |
   +----------------+
   transport AEAD,
   wallet keystore
```

No elliptic curves anywhere. No trusted setup. Every primitive is either a
NIST FIPS-standardized scheme (FALCON, ML-KEM, AES) or a widely-studied
algebraic construction (Poseidon2). The MEV-protection path (§8.5) holds no
key at all — it is pure Blake3 + FALCON.

---

## 8.10 Cryptographic Agility

Each primitive is accessed through a small, well-defined module
(`crates/crypto/src/falcon.rs`, `kyber.rs`, `poseidon2.rs`, `blake3.rs`,
`vrf.rs`). If a serious break is discovered in any one of them, the
affected module can be replaced through a protocol upgrade without
restructuring the rest of the system.

Because the address format is bound to a hash of the public key (not the
key itself), a future migration to a different post-quantum signature scheme
would change addresses — but the upgrade path is well-defined: a one-time
key-rotation transaction signed by both old and new keys, with the address
derivation domain-separated by scheme version.

That migration is not planned. NIST's FIPS standardization is the credible
long-term anchor for FALCON and Kyber, and switching from them would only
happen if a substantive cryptanalytic break appeared.

---

## Summary

| Primitive          | Use                                              | Where                            |
| ------------------ | ------------------------------------------------ | -------------------------------- |
| FALCON-512         | All signatures (txs, vertices, state roots, attestations, beacon)| `crates/crypto/src/falcon.rs` |
| Kyber-768 / ML-KEM | P2P transport session keys (transport only)      | `crates/crypto/src/kyber.rs`     |
| Blake3             | High-volume native hashes (JMT, batches, vertices, gossip) + commit-reveal commitments | `crates/crypto/src/blake3.rs` |
| Poseidon2          | ZK-bearing hashes (state root, addresses, VRF, opcode)| `crates/crypto/src/poseidon2.rs` |
| Commit-reveal      | Keyless private mempool (Blake3 commitment + bond)| see Chapter 9 (MEV Protection)   |
| Lattice VRF        | Anchor seeding, randomness, committee score      | `crates/crypto/src/vrf.rs`       |
| AES-256-GCM        | Symmetric AEAD (P2P transport, wallet keystore)  | (via the `aes-gcm` crate)        |

The next chapter walks through MEV protection end-to-end — how these
primitives combine in the DAG commit pipeline to make front-running
and sandwich attacks not "discouraged," but unexpressible.
