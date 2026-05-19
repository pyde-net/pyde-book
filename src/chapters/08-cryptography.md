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

3. **Hybrid hashing — Blake3 for speed, Poseidon2 for ZK.** Bitwise hashes
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
                    JMT internals, batch hashes, vertex hashes, gossip
                  Poseidon2 (Goldilocks field, ZK-native)
                    state root, addresses, MAC, VRF output, RNG mix
  Threshold:    Shamir over Goldilocks + Kyber + Poseidon2 KDF/MAC
  PSS resharing: Lagrange interpolation over Goldilocks
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
makes the lattice VRF (§8.7) work — the output is a deterministic function of
the inputs.

The domain-separation tag `b"pyde-falcon-v1"` is mixed into the signing
context to prevent cross-protocol signature reuse.

### Where FALCON-512 is used

1. **Transaction signing** — every transaction carries a FALCON-512 sig from
   the sender's account.
2. **Vertex production** — every DAG vertex is FALCON-signed by its producer.
3. **State-root attestations** — committee members sign `(wave_id,
   blake3_state_root, poseidon2_state_root)` after each wave commit;
   ≥ 85 sigs constitute the `HardFinalityCert`.
4. **Decryption share authentication** — threshold partial decryptions
   are FALCON-signed by their producer.
5. **PSS resharing contributions** — contributors sign their shares.
6. **P2P peer authentication** — the FALCON handshake (`crates/net/src/auth.rs`).
7. **VRF proofs** — every VRF output is paired with a FALCON proof.
8. **Slashing evidence** — submitters sign their evidence transactions.

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
2. **Threshold encryption for the encrypted mempool.** The committee's
   threshold public key is a Kyber-768 key whose secret has been
   Shamir-split across 128 validators. See §8.5.

---

## 8.4 Hashing: Blake3 + Poseidon2

Pyde uses **two** hash functions, each chosen for a class of paths:

| Function    | Speed (native) | ZK cost (constraints) | Used for |
|-------------|----------------|------------------------|----------|
| **Blake3**  | ~3 GB/s        | ~150k per hash (huge) | JMT internal nodes, batch hashes, vertex hashes, gossip de-dup, RocksDB keys |
| **Poseidon2** | ~60 MB/s     | ~400 (small)          | State root commitment, address derivation, threshold MAC, VRF output, FALCON sig hashing inside ZK circuits, PVM `Poseidon` opcode |

### Blake3

Blake3 is the BLAKE family successor — based on the BLAKE2 compression
function arranged as a parallelizable Merkle tree, with hardware
acceleration on every modern CPU. Pyde uses Blake3 in its default
configuration (256-bit output) for every hash that lives entirely off-chain
or inside a trusted committee-signed structure.

Key Pyde-specific uses:

- **JMT internal nodes** — `blake3_pair(left, right)` per Merkle level.
  At commodity CPU speed, an entire JMT update batch hashes in microseconds.
- **Batch hashes referenced from vertices** — the worker batches transactions
  and identifies each batch by its Blake3 hash.
- **Vertex hashes in the DAG** — every consensus vertex is identified by
  its Blake3 hash.
- **Gossip message de-duplication** — Gossipsub uses Blake3 to detect
  duplicate broadcasts.
- **RocksDB cache keys** — Blake3 fingerprint of (key, version) for the
  LRU value cache.

### Poseidon2: ZK-Friendly Hashing

Poseidon2 is the algebraic hash function used on paths that may be exposed
to a ZK circuit, plus a handful of legacy paths kept for compatibility.

### Why not Keccak or SHA-256?

Inside an algebraic system (a STARK, an MPC protocol, a future ZK validity
proof), bitwise hash functions like Keccak-256 are catastrophically expensive
— roughly 150,000 algebraic constraints per Keccak hash compared to a few
hundred for Poseidon2. Even though Pyde doesn't ship a STARK at mainnet, the
threshold-encryption MAC and the lattice VRF both benefit from a hash that's
cheap inside an algebraic field, and the JMT itself amortizes the per-Merkle
work better when the hash is field-native.

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

1. **State root commitment** — the dual-rooted state has a Poseidon2 root
   alongside the Blake3 root, signed by the committee.
2. **Account address derivation** — `Poseidon2(falcon_pubkey)`.
3. **CREATE / CREATE2 address derivation** — `Poseidon2(deployer || nonce)`
   or `Poseidon2(0xFF || deployer || salt || code_hash)`.
4. **Storage key derivation in Otigen** — `Poseidon2(contract, slot)` for
   single fields, doubled for maps.
5. **Transaction hashing** — the canonical tx hash used for replay
   prevention and the wallet's signing target.
6. **Threshold MAC** — `Poseidon2(0xFF...0xFF || secret || ciphertext)`.
7. **VRF output** — `Poseidon2(domain || fingerprint || input)`.
8. **Epoch randomness combination** — `Poseidon2_many(sorted_shares)`.
9. **PVM `Poseidon` opcode** — exposed to user-space contracts.

---

## 8.5 Threshold Encryption (Mempool MEV Protection)

Threshold encryption is what lets the encrypted mempool work: messages are
encrypted such that no single validator (or coalition of < 85) can decrypt,
but the active committee acting collectively can.

### Construction

The scheme combines three pieces:

1. **Shamir Secret Sharing** over the Goldilocks field — splits a secret
   into 128 shares of which any 85 reconstruct.
2. **Kyber-768 KEM** — the underlying public-key primitive.
3. **Poseidon2** as a counter-mode keystream and as the MAC.

Implementation: `crates/crypto/src/threshold.rs`.

### Setup (per epoch)

```
1. Generate a Kyber-768 keypair: (pk, sk_seed)
2. Split sk_seed into 128 shares using Shamir SSS:
     - Random degree-(t-1) polynomial f over Goldilocks where t = 85
     - f(0) = sk_seed
     - share_i = (i, f(i)) for i in 1..=128
3. Distribute share_i to validator i
4. Publish pk as the committee's threshold public key
```

### Encryption (user wallet)

```
(ciphertext, shared_secret) = Kyber.Encaps(pk)
keystream = Poseidon2_keystream(shared_secret, message_length)
encrypted_payload = message XOR keystream
mac = Poseidon2(0xFF...0xFF || shared_secret || ciphertext)
wire = (ciphertext, encrypted_payload, mac)
```

### Decryption (committee)

```
For each ciphertext in the encrypted block:
    Each validator i computes a blinded share:
        blinded_i = raw_share_i + H(ct_hash || i || elem_idx)
    Validator broadcasts blinded share on the consensus channel.
    Combiner collects >= 85 shares, unblinds them by subtracting the
    same H() values, then Lagrange-interpolates at x=0 to recover the
    Kyber decapsulation seed.
    Kyber.Decaps(seed, ciphertext) -> shared_secret
    Verify MAC; on success, decrypt payload with the keystream.
```

### Share blinding

Each share is blinded with a per-ciphertext, per-element mask
(`H(ct_hash || validator_idx || element_idx)`) before transmission. This
prevents a validator's share from ciphertext A from being reused against a
different ciphertext B — even if a validator's share leaked, an attacker
couldn't apply it to other blocks. The combiner has the ciphertext and can
unblind during recovery.

### Parameters

| Parameter          | Value                       |
| ------------------ | --------------------------- |
| Underlying KEM     | Kyber-768                   |
| Committee size n   | 128                         |
| Threshold t        | 85 (~2/3, matches BFT quorum)|
| Per-share size     | ~256 bytes (blinded)        |
| Decryption latency | ~10–15 ms once t shares present |

---

## 8.6 PSS — Proactive Secret Sharing and Resharing

The committee rotates each epoch; the threshold public key does not change.
PSS is what makes that work — at every epoch boundary the shares are
refreshed without anyone learning the underlying secret.

### Why PSS

Without PSS, every committee rotation would require a fresh distributed key
generation (DKG), which is `O(n^2)` interactive and slow. PSS achieves the
same goal with a single round of asynchronous contributions per validator.

### Same-committee refresh

Used for routine forward-security refresh:

```
Each member generates a degree-(t-1) polynomial f_i with f_i(0) = 0.
Each member sends f_i(j) to every other member j.
Each member j updates: new_share_j = old_share_j + Σ f_i(j)
Because every f_i(0) = 0, the underlying secret is unchanged.
But every share is now drawn from a fresh combined polynomial.
```

The verification check `verify_refresh_contribution` confirms the first
`t` evaluations interpolate back to zero — catching contributors who tried
to inject a non-zero free term.

### Cross-committee resharing

Used at epoch boundaries when membership changes:

```
Each old member i with share s_i picks a fresh degree-(new_t - 1)
polynomial g_i with g_i(0) = s_i. They evaluate at the indices of
the new committee and ship the resulting sub-shares.

Each new member j collects threshold contributions, applies a
canonical-subset rule (lowest-from_old_index first), and aggregates:
    new_share_j = Σ (lambda_i × g_i(j))
where lambda_i are Lagrange coefficients at x=0 over the OLD indices.

Result: H(0) = original secret; H is the new polynomial; the new
committee sits on H.
```

The canonical-subset rule is critical. Different new members must
deterministically agree on which `t` contributions to use, or they end up on
different polynomials. The rule: sort contributions by `from_old_index`, take
the first `t`. This is implemented as `canonical_resharing_subset()` in
`crates/crypto/src/threshold.rs`.

### The aggregation delay

Because the network delivers contributions asynchronously, every new member
waits `RESHARE_AGGREGATION_DELAY_SLOTS = 5` slots after entering the new
epoch before aggregating. This guarantees that the same canonical set is
visible to every new member when aggregation begins.

### Known limitation: no VSS / KZG commitments

The current `verify_refresh_contribution` and `verify_resharing_contribution`
detect polynomial **inconsistency** — if the sub-shares aren't all on the
claimed polynomial, the check fails. They do **not** detect a malicious
member who consistently presents a polynomial whose constant term is not
their actual share `s_i`. This would silently cause the new committee to
derive shares of a *different* secret, and threshold decryption would stop
working at the start of the next epoch.

The mitigation requires Pedersen or KZG commitments on the shares — a
substantial crypto upgrade. For mainnet, the assumption is "committee-member
compromise is rare," and any such corruption surfaces as a hard decryption
failure within the first block of the affected epoch (highly visible). The
upgrade is tracked as post-mainnet research.

---

## 8.7 Lattice VRF

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

1. **Proposer selection.** Each slot, every committee member computes their
   own VRF output for `epoch_randomness || slot`. Lowest score is the
   primary proposer; second-lowest is the fallback.
2. **Epoch randomness contributions.** Each member of the previous epoch's
   committee contributes a VRF share that, combined with 84 others, seeds
   the next epoch's committee selection.
3. **Committee selection scoring.** At each epoch boundary, every registered
   validator gets a VRF score from `epoch_randomness || "committee"`; top
   128 form the next committee.

---

## 8.8 Symmetric Encryption: AES-256-GCM

All symmetric encryption uses **AES-256-GCM**:

1. **Threshold-encrypted transaction payloads.** Once the Kyber KEM gives
   the wallet a 32-byte shared secret, the payload is encrypted with
   AES-256-GCM under that secret.
2. **P2P channel encryption** (after the libp2p QUIC handshake — see
   Chapter 12).
3. **Wallet keystore encryption** (`crates/pyde-rust-sdk/src/wallet.rs`).

### Properties

- 256-bit key (128-bit post-quantum security against Grover).
- AEAD — authenticated encryption with additional data; tampering is detected.
- AES-NI hardware acceleration on every modern CPU.

---

## 8.9 Key Derivation and Address Format

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

## 8.10 The Stack at a Glance

```
   +----------------+     +----------------+
   | FALCON-512     |     | Kyber-768      |
   | sigs           |     | KEM            |
   +----------------+     +----------------+
        |                       |
        v                       v
   tx sigs               P2P session keys
   vertex sigs           threshold pubkey (mempool)
   state root attest         |
   PSS contributions          |
        |                       |
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
   vertex hashes          MAC, VRF output, RNG mix
   gossip dedup           PVM Poseidon opcode

   +----------------+
   | AES-256-GCM    |
   +----------------+
   payload AEAD,
   wallet keystore
```

No elliptic curves anywhere. No trusted setup. Every primitive is either a
NIST FIPS-standardized scheme (FALCON, ML-KEM, AES) or a widely-studied
algebraic construction (Poseidon2, Shamir SSS, PSS).

---

## 8.11 Cryptographic Agility

Each primitive is accessed through a small, well-defined module
(`crates/crypto/src/falcon.rs`, `kyber.rs`, `poseidon2.rs`, `threshold.rs`,
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
| FALCON-512         | All signatures (txs, vertices, state roots, attestations)| `crates/crypto/src/falcon.rs` |
| Kyber-768 / ML-KEM | P2P session keys + threshold mempool encryption  | `crates/crypto/src/kyber.rs`     |
| Blake3             | High-volume native hashes (JMT, batches, vertices, gossip) | `crates/crypto/src/blake3.rs` |
| Poseidon2          | ZK-bearing hashes (state root, addresses, MAC, VRF, opcode)| `crates/crypto/src/poseidon2.rs` |
| Threshold scheme   | 85-of-128 mempool decryption (Kyber + Shamir)    | `crates/crypto/src/threshold.rs` |
| PSS (refresh + reshare)| Forward security + cross-committee handoff   | `crates/crypto/src/threshold.rs` |
| Lattice VRF        | Anchor seeding, randomness, committee score      | `crates/crypto/src/vrf.rs`       |
| AES-256-GCM        | Symmetric AEAD (mempool payload, wallet keystore)| (via the `aes-gcm` crate)        |

The next chapter walks through MEV protection end-to-end — how these
primitives combine in the slot pipeline to make front-running and sandwich
attacks not "discouraged," but unexpressible.
