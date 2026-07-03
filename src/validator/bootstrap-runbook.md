# Public Testnet Bootstrap Runbook

How the testnet's initial committee actually launches the network — from "we agreed to run a testnet" to "external operators can curl-install + join". This is the bootstrapper's side of the [Joining a Public Testnet](joining-testnet.md) flow.

**Audience:** the operator (or small operator group) coordinating a fresh Pyde public testnet launch. If you're a downstream operator joining an already-running testnet, [Joining a Public Testnet](joining-testnet.md) is the chapter you want.

**Scope:** one full bootstrap cycle. Pick a chain id, agree on a committee, mint genesis + checkpoint + bootnodes, publish to the release mirror, run the initial committee, accept external validators. The whole arc.

---

## 1. Prerequisites the bootstrap operator owns

Decisions that need to be made BEFORE any binary runs. These are bound into the genesis manifest and can't change without a full re-bootstrap.

| Decision | Recommendation | Notes |
|---|---|---|
| **Chain id** | Use the [chain-id registry](https://chainlist.network) to pick an unused id. v1 Pyde testnet uses `11_155_111` (Sepolia-style sentinel) | Once tagged, every tx signed against the chain id is replay-locked to it. Reusing an existing chain id risks tx replay from another network. |
| **Chain name** | A short kebab-case slug like `pyde-testnet-1` | Surfaced in `pyde_getNodeInfo`, in operator banners, and in the release notes |
| **Committee size** | 4–7 for the first testnet | Too small = small-cluster mesh fragility (use #313 `small_cluster_mesh: true`); too large = coordination overhead during bootstrap. Production target is 128. |
| **Epoch length** | 100 waves at first | Drop to `10` or `5` during smoke tests; production-shape is `100`. |
| **Dispute window** | 6 epochs | Default. Tightens to 3-4 for high-tempo testnets if you want faster slashing finality. |
| **Genesis timestamp** | Now (`date +%s`) | The chain doesn't care about wall-clock past genesis; operators do for "when did this testnet start." |
| **Initial prefund accounts** | Every committee operator address + ~20 dev accounts | The dev accounts let the faucet, the bootstrap-side soak-test runs, and downstream contract authors have funded EOAs without each begging for transfers. |

Once these are locked, every committee member needs to know them — they all bind into the genesis manifest's chain-identity hash and must match byte-for-byte.

---

## 2. Generate the committee keypairs

Each committee operator generates their own FALCON-512 keypair offline. **Never centralise this step** — the bootstrap operator does NOT generate keys on behalf of others; only the operator who controls a key knows the password.

On each committee member's machine:

```bash
# Generate FALCON keypair (validator identity)
pyde keys generate \
  --out ./falcon-${OPERATOR_NAME}.keypair \
  --password-stdin <<< 'your-strong-passphrase'

# Export just the public half — this is what the bootstrap operator needs
pyde keys export-pubkey ./falcon-${OPERATOR_NAME}.keypair \
  --format hex > ./falcon-${OPERATOR_NAME}.pub

# Read the corresponding validator address
pyde keys inspect ./falcon-${OPERATOR_NAME}.keypair
```

The operator sends only the `.pub` file (the 897-byte hex pubkey) + the derived validator address to the bootstrap coordinator. **Never the keypair file itself + never the passphrase.**

Each operator also generates a libp2p Ed25519 keypair — `pyde validator` does this automatically on first boot if `--keypair` points at a non-existent path. The bootstrap operator needs the libp2p PeerId from each committee member too, since those go into the published bootnodes list. The PeerId is derived from the libp2p keypair on first boot; the operator extracts + sends it:

```bash
# After first validator boot (which generates the keypair):
pyde keys inspect-libp2p ./libp2p.kp  # prints PeerId in 12D3KooW... form
```

---

## 3. Mint the genesis manifest

Once the bootstrap coordinator has every operator's `.pub` + validator address + PeerId, they assemble `genesis.toml`:

```bash
pyde genesis template \
  --output ./genesis.toml \
  --chain-id 11155111 \
  --chain-name "pyde-testnet-1"
```

Then edit `genesis.toml` to fill in:

- **`committee`** — one entry per founding operator. Each entry:
  ```toml
  [[committee]]
  member_id = 0
  falcon_pubkey = "0x<paste the .pub hex here>"
  operator_address = "0x<paste the validator address here>"
  stake_quanta = 10000000000000   # MIN_VALIDATOR_STAKE = 10,000 PYDE
  ```
- **`prefund`** — at minimum every `operator_address` from the committee table above (each needs gas headroom). Plus dev accounts.
- **`economic.epoch_length_waves`** — pick per § 1.
- **`economic.dispute_window_epochs`** — pick per § 1.
- **`genesis_timestamp_unix`** — `date +%s` at the moment of mint.

Validate the manifest:

```bash
pyde genesis validate --genesis ./genesis.toml
```

```text
chain_name:     pyde-testnet-1
chain_id:       11155111
chain_identity: 0x...  ← THIS is the binding fingerprint
committee:      7 founding validators
prefund:        27 accounts
```

**Distribute the genesis.toml + chain_identity hash to every committee member out-of-band.** Email, Signal, encrypted Slack — whatever the bootstrap group already uses. Every member must boot against the same file. The chain_identity hash is what they verify against once they've downloaded.

---

## 4. Assemble the bootnodes list

A bootnode is just a `pyde validator` with a **stable, publicly reachable libp2p address**. New operators dial bootnodes on first boot; once the gossipsub mesh forms, gossip finds the rest of the network.

Convention: every committee member runs as a bootnode for the first ~30 days of testnet life. After that the bootstrap operator can prune to 3–5 stable ones.

`bootnodes.txt`:

```text
# Pyde Testnet bootnodes — operator-run, stable across the testnet lifetime.
# One multiaddr per line. Lines starting with `#` are comments.

# Operator: alice (committee member_id=0)
/dns4/bootnode-alice.testnet.pyde.network/tcp/30303/p2p/12D3KooW<peer-id>

# Operator: bob (committee member_id=1)
/dns4/bootnode-bob.testnet.pyde.network/tcp/30303/p2p/12D3KooW<peer-id>

# Operator: carol (committee member_id=2)
/dns4/bootnode-carol.testnet.pyde.network/tcp/30303/p2p/12D3KooW<peer-id>
```

Two requirements per bootnode address:

- **Stable DNS or IP.** Don't use AWS spot instances, residential IPs, or anything that re-rolls on reboot. Use a stable hostname; rotate the underlying VM behind it without breaking the multiaddr.
- **Reachable inbound TCP 30303** (or whichever port matches your bootnodes.txt). The bootnode operator's firewall must allow inbound on the listed port; new operators dialing in fail silently otherwise.

---

## 5. Mint the initial weak-subjectivity checkpoint

The first checkpoint is a `wave_id:state_root` pair that pins the snapshot a new validator's state-sync source must produce before it'll trust the data. The bootstrap operator mints this **after** the chain has run for a few epochs (so there's actual committed state to anchor against), then publishes it to the release mirror.

```bash
# On any healthy committee validator:
curl -s http://localhost:9933 \
  -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"pyde_getSnapshotManifest","id":1}' \
  | jq -r '.result | "\(.wave_id):\(.state_root.blake3)"' \
  > ./checkpoint.txt

cat ./checkpoint.txt
# 4200:0x9a3f...
```

Refresh weekly (or whenever the bootstrap operator wants to narrow the trust window further). Each new checkpoint commits to a more-recent state; older checkpoints stay valid but a new operator following them ends up with a longer tail-replay.

---

## 6. Publish to the release mirror

Once all four artifacts are ready (`genesis.toml`, `bootnodes.txt`, `checkpoint.txt`, and the validator binary release), the bootstrap operator pushes a release tag on `pyde-net/engine`:

```bash
git tag v0.1.0-testnet.1
git push origin v0.1.0-testnet.1
```

The release pipeline:

1. Runs the gates (fmt + clippy + workspace tests + doc).
2. Builds the binary per platform.
3. Sigstore-signs every artifact.
4. Publishes to `pyde-net/test-releases` under tag `engine-v0.1.0-testnet.1`.

**Then the bootstrap operator manually attaches the bootstrap artifacts** to that release via the GitHub UI (or `gh release upload`):

```bash
gh release upload engine-v0.1.0-testnet.1 \
  --repo pyde-net/test-releases \
  ./genesis.toml \
  ./genesis.toml.sha256 \
  ./genesis.toml.sig \
  ./genesis.toml.pem \
  ./bootnodes.txt \
  ./checkpoint.txt
```

The sigstore artifacts come from a manual `cosign sign-blob` against `genesis.toml` (and optionally `bootnodes.txt` + `checkpoint.txt`) using the bootstrap operator's GitHub identity:

```bash
COSIGN_EXPERIMENTAL=1 cosign sign-blob --yes \
  --output-signature genesis.toml.sig \
  --output-certificate genesis.toml.pem \
  genesis.toml
```

After publish, anyone can verify per [Joining a Public Testnet](joining-testnet.md) § 3.

---

## 7. Run the initial committee

Every committee member boots their validator with the now-published genesis + bootnodes:

```bash
# Download the published artifacts
RELEASE_TAG=engine-v0.1.0-testnet.1
BASE="https://github.com/pyde-net/test-releases/releases/download/${RELEASE_TAG}"

mkdir -p /etc/pyde
sudo cp ./falcon-${OPERATOR_NAME}.keypair /etc/pyde/falcon.keypair
sudo curl -fsSLo /etc/pyde/genesis.toml "${BASE}/genesis.toml"
sudo curl -fsSLo /etc/pyde/bootnodes.txt "${BASE}/bootnodes.txt"

# Boot — first committee members boot against bare genesis (no state-sync;
# the chain is fresh, there's nothing to sync against). Later joiners use
# --state-sync per Joining a Public Testnet § 5.
sudo systemctl start pyde-validator
sudo journalctl -u pyde-validator -f
```

You should see, in order:

1. `validator: chain seeded from genesis` — the validator's seed pass succeeds against the published manifest.
2. `validator: bound + dialing` — listening on its public address, dialing the bootnodes list.
3. `wave committer: ...` lines — committing waves once enough committee members are online (BFT-quorum from § 1).

When the chain commits its first wave, the testnet is alive.

---

## 8. Open the network to external operators

At this point downstream operators can follow [Joining a Public Testnet](joining-testnet.md). The bootstrap operator's remaining responsibilities:

- **Run a public state-sync RPC endpoint** — at least one committee validator exposes `--rpc-listen 0.0.0.0:9933` behind TLS termination + rate limiting so downstream operators can `--state-sync https://state-sync.testnet.pyde.network`. Don't expose the raw RPC port — there's no auth on `pyde_sendRawTransaction`.
- **Publish checkpoint refreshes weekly** — re-mint `checkpoint.txt` from a current validator + upload to the latest release.
- **Watch the alerts** — set up Prometheus + the [shipped alert rules](operations.md#2-set-up-monitoring) so the bootstrap operator notices when the chain halts before downstream operators do.
- **Coordinate hard upgrades** — when the engine releases a chain-breaking change, the bootstrap operator decides whether to re-tag, re-mint genesis, and coordinate a re-bootstrap or whether the change is backwards-compatible.

---

## 9. What "testnet works perfectly" means in practice

The honest bar for a public unaudited testnet:

| Property | Bar | Verified by |
|---|---|---|
| Chain commits waves continuously | ≥ 99% wave-commit rate over 7+ days | [Operations dashboard](operations.md#2-set-up-monitoring) |
| External operators can join | Someone non-bootstrap follows the docs cold and lands a healthy validator | The [external-validator drill](#) (planned task) |
| Slashing detectors don't false-positive | Zero unjustified slashes over the soak-test window | DKG participation + equivocation counters |
| Receipts resolve | 100% of submitted txs return a receipt within 30s | The `pyde soak` workload generator |
| State sync works for fresh joiners | New validator can join from snapshot in < 1 hour | Manual drill |
| Network survives validator churn | Restart any one validator; chain doesn't halt | `kill -9` drill |

Test each one explicitly before announcing the testnet to the public. The dashboards + alerts are the day-to-day watcher; the explicit drills are the launch gate.

---

## 10. Re-bootstrap (when chain-breaking changes ship)

If the engine ships a chain-breaking change (consensus rule change, on-disk format change, new mandatory tx field, etc.), the existing testnet's state cannot be carried forward. The bootstrap operator:

1. **Announces the re-bootstrap window** — usually 1–2 weeks of notice to downstream operators.
2. **Bumps the chain id** in the new genesis (don't reuse the old one — that risks tx replay).
3. **Re-runs §§ 3 → 7** with the new release tag (`v0.1.0-testnet.2`, etc.).
4. **Marks the old release** as superseded on the mirror; doesn't delete it (downstream operators may need to compare).
5. **Updates the testnet docs** with the new chain id + release tag.

The first 3–6 months of any new chain typically see 1–3 re-bootstraps. Plan for it.

---

## Where to go next

- [Joining a Public Testnet](joining-testnet.md) — what downstream operators do once you've published.
- [Day-2 Operations](operations.md) — the production-side of running a validator (systemd, monitoring, log rotation, key rotation).
- The [Chain Halt & Recovery companion spec](../companion/CHAIN_HALT.md) — playbook for when the chain stops committing.
