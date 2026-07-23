# Joining a Public Testnet

How to point your validator at a specific Pyde public testnet: fetch the genesis manifest, verify it's the one the network was bootstrapped against, configure your bootnodes, register your stake on-chain.

This chapter assumes you've already followed the [Quickstart](quickstart.md) through step 1 (you have the `pyde` binary installed and a FALCON keypair generated). It picks up where the quickstart's *Path B: Join an existing network* branch starts.

---

## The trust chain

A public testnet has one canonical genesis manifest. Every validator on the network booted against the same `genesis.toml` (or a byte-identical copy); the manifest's content hash binds them all to the same chain identity. Joining the network means downloading that exact file and verifying it byte-for-byte matches what every other validator is running.

Two artifacts make this honest:

1. **The genesis manifest itself** (`genesis.toml`): the human-readable network spec.
2. **A SHA-256 checksum + sigstore-keyless signature**: published alongside the manifest so you can prove the file you downloaded is the one the bootstrappers actually published.

Both are hosted on the public release mirror (`pyde-net/test-releases`) under the same release tag as the validator binary you installed. Same trust root, same URL pattern.

---

## 1. Download the genesis manifest + verification artifacts

Pick the release tag that matches your installed binary (e.g. `v0.1.0-testnet.1`). Every release ships three files relevant to genesis:

- `genesis.toml`: the manifest
- `genesis.toml.sha256`: the SHA-256 checksum
- `genesis.toml.sig` + `genesis.toml.pem`: the sigstore-keyless signature + ephemeral cert

Fetch them:

```bash
RELEASE_TAG=engine-v0.1.0-testnet.1
mkdir -p ~/pyde-testnet && cd ~/pyde-testnet

BASE="https://github.com/pyde-net/test-releases/releases/download/${RELEASE_TAG}"
curl -fsSL -O "${BASE}/genesis.toml"
curl -fsSL -O "${BASE}/genesis.toml.sha256"
curl -fsSL -O "${BASE}/genesis.toml.sig"
curl -fsSL -O "${BASE}/genesis.toml.pem"
```

All four files now live in `~/pyde-testnet/`.

---

## 2. Verify the SHA-256 checksum

Confirms the manifest hasn't been corrupted in transit or replaced by something else with the same filename.

```bash
shasum -a 256 -c genesis.toml.sha256
```

```text
genesis.toml: OK
```

If it says `FAILED`, **stop immediately**. Re-download from the canonical mirror; if it still fails, post on the operator channel before proceeding.

The checksum alone proves the file matches the published one; it doesn't prove who published it. That's what the sigstore signature is for.

---

## 3. Verify the sigstore signature (optional but recommended)

Sigstore-keyless signing binds the genesis file to the GitHub Actions workflow that published it. The signature includes an ephemeral cert proving the signer was the `pyde-net/engine` release workflow at the tagged commit. Anyone can verify without us managing long-lived signing keys.

Install [cosign](https://github.com/sigstore/cosign) if you don't have it:

```bash
# macOS
brew install cosign
# Linux (binary download)
curl -fsSL -o cosign \
  https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64
chmod +x cosign && sudo mv cosign /usr/local/bin/
```

Verify:

```bash
cosign verify-blob \
  --certificate genesis.toml.pem \
  --signature genesis.toml.sig \
  --certificate-identity-regexp 'https://github.com/pyde-net/engine/\.github/workflows/release\.yml@.*' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  genesis.toml
```

```text
Verified OK
```

What this proves:
- The signature was minted by the `pyde-net/engine` release workflow (the `--certificate-identity-regexp`).
- The signer's identity was validated by the GitHub Actions OIDC issuer (the `--certificate-oidc-issuer`).
- The signature covers the exact bytes of `genesis.toml` (cosign re-hashes and matches).

Any one of these failing means the manifest didn't come from a real Pyde release workflow run. Don't proceed.

---

## 4. Inspect the manifest

Before you boot a validator against it, eyeball the fields:

```bash
pyde genesis validate --genesis ./genesis.toml
```

```text
chain_name:        pyde-testnet
chain_id:          11_155_111
chain_identity:    0x91a4...
committee_size:    7
committee:         7 founding validators (10_000 PYDE each)
prefund:           34 accounts
treasury:          0x...
epoch_length:      100 waves
dispute_window:    6 epochs
```

The `chain_identity` (a Blake3 hash over the canonical-encoded manifest) is what every other validator's `consensus_store` is keyed against. If yours disagrees by even one bit, the chain will refuse to peer with you.

For the published testnet, the `chain_identity` is also printed in the release notes on the mirror. Cross-reference them. They must match.

---

## 5. Configure your validator's network access

The release also publishes a `bootnodes.txt` file: a plain-text list of stable libp2p multiaddrs run by the testnet bootstrappers. Your validator dials these on first boot; once you've peered, gossipsub finds the rest of the network.

```bash
curl -fsSL -O "${BASE}/bootnodes.txt"
cat bootnodes.txt
```

```text
# Pyde Testnet bootnodes — operator-run, stable across the testnet lifetime.
/dns4/bootnode-1.testnet.pyde.network/tcp/30303/p2p/12D3KooW...
/dns4/bootnode-2.testnet.pyde.network/tcp/30303/p2p/12D3KooW...
/dns4/bootnode-3.testnet.pyde.network/tcp/30303/p2p/12D3KooW...
```

Pass this via `--bootnodes` on `pyde validator`:

```bash
pyde validator \
  --keypair ./libp2p.kp \
  --falcon-keypair ./falcon.keypair --falcon-password-stdin \
  --consensus-store-path ./data \
  --genesis ./genesis.toml \
  --bootnodes ./bootnodes.txt \
  --listen /ip4/0.0.0.0/tcp/30303 \
  --rpc-listen 127.0.0.1:9933 \
  --falcon-beacon \
  --state-sync https://state-sync.testnet.pyde.network \
  --state-sync-checkpoint $(curl -fsSL "${BASE}/checkpoint.txt")
  <<< 'your-falcon-passphrase'
```

The `--state-sync-checkpoint` is a weak-subjectivity gate: it pins the exact `wave_id:state_root` your state-sync source must produce before you'll trust its snapshot. The release publishes a fresh checkpoint at every cadence; an operator who fetches a stale checkpoint sees their validator refuse to apply the snapshot, which is correct: checkpoints are a trust narrowing, not a convenience.

See [Day-2 Operations](operations.md) for the production setup (systemd, log rotation, monitoring) once your validator is healthy.

---

## Where to go next

- [Day-2 Operations](operations.md): running the validator as a service, monitoring, log rotation, key rotation.
- [Quickstart Step 5: Register on-chain](quickstart.md#5-register-your-validator-on-chain), submit your `StakeDeposit` tx once the validator is committee-eligible.
- The [State Sync companion spec](../companion/STATE_SYNC.md): the full snapshot + tail-replay protocol.

---

## Why this matters: the threat model

What the verification flow protects against:

| Threat | How the flow stops it |
|---|---|
| Corrupted download | SHA-256 fails → operator sees the failure, re-downloads |
| Genesis file swapped on the mirror | SHA-256 still validates against the swapped file, but the sigstore signature was minted against the original; verify-blob fails |
| Mirror compromised, signature swapped too | Sigstore certs are minted against the GitHub Actions OIDC token at workflow-run time, which is logged immutably in Rekor; cosign cross-checks. An attacker would need to compromise GitHub Actions itself + Rekor. |
| Operator skips verification, runs a swapped genesis | Their `chain_identity` diverges from real-network validators; gossipsub refuses the peering handshake. The chain rejects them. |

The honest gap: an attacker with full control of `pyde-net/test-releases` AND the ability to mint sigstore certs against `pyde-net/engine`'s OIDC could swap the entire release. That's the same trust root as the validator binary itself: if you trust the binary you installed, the genesis bound to it has the same trust level.

Pre-mainnet that's an acceptable v1 bar. v2 hardening (multiple genesis-publisher attestations, a deterministic publish from a quorum of bootstrappers) is planned.
