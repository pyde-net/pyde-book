# Soft Testnet Quickstart

From a clean machine to a validator that's signing, committing waves, and earning rewards on a multi-validator Pyde test network.

This is the operator path. Contract authors want the [Otigen Toolchain Guide](../otigen/README.md) instead.

---

## 0. Prerequisites

You need a Rust toolchain, ~4 GB free disk, and inbound network reachability (a public IP or a forwarded port — Pyde is libp2p-based, peers need to dial you back).

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustc --version  # expect 1.85+ stable
```

Pyde is currently distributed as source. Clone + build:

```bash
git clone https://github.com/pyde-net/engine.git pyde-engine
cd pyde-engine
cargo build --release --bin pyde
```

The binary lands at `target/release/pyde`. Add it to your PATH or invoke it via the full path. Every subsequent command in this guide assumes `pyde` resolves.

```bash
pyde --version
```

```text
pyde 0.1.0
```

---

## 1. Generate your validator keypair

Pyde uses post-quantum FALCON-512 signatures. Generate yours off-validator on a machine you trust:

```bash
pyde keys generate \
  --falcon-keypair ./falcon.keypair \
  --password-stdin <<< 'change-me-to-a-real-passphrase'
```

This writes an Argon2id + ChaCha20-Poly1305 encrypted FALCON keypair. Treat it the way you'd treat a hardware-wallet seed phrase — it's the single secret that controls your validator's stake.

To inspect the public material (no password required):

```bash
pyde keys inspect --falcon-keypair ./falcon.keypair
```

```text
falcon_pubkey:    0x1f3a9b…  (897 bytes)
validator_addr:   0xa4c2…    (Poseidon2 of pubkey, 32 bytes)
```

The `validator_addr` is what the chain identifies you by. Save it.

You'll also need a libp2p Ed25519 keypair for the peer-to-peer layer. `pyde validator` generates one on first boot if you point `--keypair` at a non-existent path, so most operators skip an explicit step here.

---

## 2. Pick a network onboarding path

Two ways to join a soft testnet:

- **Path A — bootstrap a fresh network.** You and N other operators agree on a genesis manifest, every operator points `pyde validator --genesis` at the same file. Use this when you're starting a new test network.
- **Path B — join an existing network.** You state-sync from a peer that's already running. Use this for everything after the initial bootstrap.

If you're not sure, you want **Path B**. Skip to it.

### Path A — Bootstrap a fresh network

Write a template genesis manifest:

```bash
pyde genesis template \
  --output ./genesis.toml \
  --chain-id 31337 \
  --chain-name "soft-testnet"
```

Edit it. The interesting fields:

- **`committee`** — one entry per founding validator. Each entry carries that validator's `falcon_pubkey`, `operator_address`, and `stake_quanta` (must be `>= MIN_VALIDATOR_STAKE = 10_000_000_000_000 quanta = 10,000 PYDE`).
- **`prefund`** — initial balances. At minimum prefund every committee member's `operator_address` so they can pay gas.
- **`economic.epoch_length_waves`** — keep at `100` for production-shape, drop to `5` or `10` if you want fast epoch boundaries during testing.

Validate the file:

```bash
pyde genesis validate --genesis ./genesis.toml
```

Distribute the file to every founding operator. Everyone must boot `pyde validator` with the same `--genesis` path; the chain ID inside the manifest is what binds them to the same network.

Then jump to step **4 — Run the validator**.

### Path B — Join an existing network via state-sync

Get a trusted peer's RPC endpoint (their `pyde validator --rpc-listen` address) and an out-of-band copy of their current `(wave_id, state_root)` pair. The state root is published by the chain on the wave commit record; in practice you'll grab it from the running peer:

```bash
curl -s http://peer.example.com:9933 \
  -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"pyde_getSnapshotManifest","id":1}' | jq .result
```

```json
{
  "wave_id": 12345,
  "state_root": "0xabcd0123…",
  "chunk_size": 4096,
  "chunk_count": 17,
  "chunk_hashes": ["0x…", "0x…", "..."],
  "total_keys": 65536
}
```

The lightweight manifest RPC is cheap on both sides — no chunks are transmitted. **Reconcile the `wave_id` and `state_root` against a reference you trust independently** (a public mirror, an audited validator, a committee-signed checkpoint from your own infrastructure). The whole point of the weak-subjectivity flow is that the peer serving the snapshot is untrusted; your reconciliation is what makes it safe.

Once you've verified the manifest matches your reference, you'll pass the pair to `pyde validator` as `--state-sync-checkpoint <wave_id>:<state_root_hex>` in step **4**. Save the values:

```bash
export PYDE_PEER_RPC=http://peer.example.com:9933
export PYDE_CHECKPOINT=12345:0xabcd0123…
```

---

## 3. Pre-fund your operator address (Path B only)

To register as a validator on an existing network you need ≥ `MIN_VALIDATOR_STAKE + gas` worth of PYDE at your `operator_address`. Path A operators already prefunded themselves in the genesis manifest; Path B operators need to receive a transfer from someone who holds testnet PYDE.

Ask the operator running the network's faucet (or any holder) to send to your `operator_address`:

```bash
# (on the funder's machine)
# Build + sign + submit a Standard transfer. Use whatever tooling
# you have; the value must be ≥ 10_000_010_000_000 quanta
# (10,000 PYDE stake + headroom for gas).
```

Verify the balance landed:

```bash
curl -s "$PYDE_PEER_RPC" \
  -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"pyde_getBalance","params":["0xYOUR_ADDR"],"id":1}'
```

```json
{"jsonrpc":"2.0","id":1,"result":"0x9184e72a000"}
```

---

## 4. Run the validator

For Path A:

```bash
pyde validator \
  --keypair ./libp2p.keypair \
  --falcon-keypair ./falcon.keypair \
  --falcon-password-stdin \
  --consensus-store-path ./consensus_store \
  --listen /ip4/0.0.0.0/tcp/0 \
  --bootnodes ./bootnodes.txt \
  --rpc-listen 0.0.0.0:9933 \
  --genesis ./genesis.toml \
  --validator-id 0 \
  --producer-tick-ms 50 \
  --committer-tick-ms 50 \
  --falcon-beacon <<< 'your-keypair-password'
```

For Path B:

```bash
pyde validator \
  --keypair ./libp2p.keypair \
  --falcon-keypair ./falcon.keypair \
  --falcon-password-stdin \
  --consensus-store-path ./consensus_store \
  --listen /ip4/0.0.0.0/tcp/0 \
  --bootnodes ./bootnodes.txt \
  --rpc-listen 0.0.0.0:9933 \
  --state-sync "$PYDE_PEER_RPC" \
  --state-sync-checkpoint "$PYDE_CHECKPOINT" \
  --validator-id 0 \
  --producer-tick-ms 50 \
  --committer-tick-ms 50 \
  --falcon-beacon <<< 'your-keypair-password'
```

Flags worth knowing:

| Flag | Why |
|---|---|
| `--bootnodes <FILE>` | File of multiaddrs to dial at startup. Path B operators receive this from the network's bootstrap docs. |
| `--listen <MULTIADDR>` | What address `pyde` binds for incoming peer connections. `tcp/0` lets the OS pick a port; pin a specific one if you're behind a NAT and need to forward it. |
| `--rpc-listen <ADDR>` | JSON-RPC bind. Required if you want to use `pyde stake` against your own node. Skip if you'd rather talk to a separate RPC node. |
| `--state-sync <FILE_OR_URL>` | Path B only. Local borsh file OR an HTTP(S) URL pointing at a peer's RPC. The validator fetches the snapshot, applies it, then tail-replays missing waves before joining consensus. |
| `--state-sync-checkpoint <WAVE_ID>:<HEX>` | Pin the snapshot's expected `(wave_id, state_root)`. Refuses to boot on mismatch. Always supply this with `--state-sync` — without it you're trusting the peer URL. |
| `--validator-id <N>` | Your committee slot. For Path A you and the other founders pick distinct ids; for Path B the chain assigns it when you register (set to 0 here, then re-launch with the assigned id after registration). |
| `--falcon-beacon` | Use the production FALCON-512 beacon scheme (vs. the mock for dev). Always on for testnet+. |

You should see something like:

```text
validator: snapshot manifest matches operator checkpoint
validator: snapshot applied; entering tail-replay
validator: tail-replay persistence complete waves_persisted=3247 txs_persisted=8112
validator: tail-replay walk_chain_log re-executed tail waves
validator: vertex producer started tick_ms=50 quorum=5
validator: wave committer started
…
wave committer: snapshotted DKG attestations target_epoch=124 buffered=7 written=21
```

Leave it running. Move to a new terminal for step **5**.

---

## 5. Register your validator on-chain

You're now running a `pyde validator` process and (Path B) talking to a state-synced chain. The chain has your account but no `ValidatorRecord` yet. Register it:

```bash
pyde stake register \
  --rpc http://localhost:9933 \
  --falcon-keypair ./falcon.keypair \
  --falcon-password-stdin \
  --amount 10000000000000 \
  --chain-id 31337 <<< 'your-keypair-password'
```

```text
StakeDeposit submitted
  tx_hash:           0x8a3f…
  validator_address: 0xa4c2…
```

Poll for confirmation:

```bash
pyde stake status \
  --rpc http://localhost:9933 \
  --falcon-keypair ./falcon.keypair \
  --falcon-password-stdin <<< 'your-keypair-password'
```

```text
ValidatorRecord
  status:            Active
  stake:             10_000_000_000_000 quanta (10,000 PYDE)
  pubkey:            0x1f3a9b…
  unbond_at_wave:    null
  jail_until_wave:   null
  last_claimed_rps:  0
```

Path A note: founding-committee operators are already registered at genesis — skip this step.

---

## 6. Verify the validator is healthy

Two quick checks. First, your wave-commit metric should be advancing:

```bash
curl -s http://localhost:9933 \
  -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"pyde_getMetrics","id":1}' | jq .result.waves_committed
```

```text
"42"
```

Second, the DKG participation detector should NOT be slashing you:

```bash
curl -s http://localhost:9933 \
  -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"pyde_getMetrics","id":1}' \
  | jq '.result.dkg_participation_failures_detected, .result.dkg_attestations_received'
```

```text
"0"
"127"
```

Zero failures detected, attestations flowing — you're a good citizen.

---

## 7. Day-2 ops

Every lifecycle transition is one `pyde stake` subcommand. The full surface:

| Subcommand | Effect |
|---|---|
| `pyde stake status` | Read-only — query your on-chain `ValidatorRecord`. No signing. |
| `pyde stake register` | Submit `StakeDeposit`. Must hold `≥ MIN_VALIDATOR_STAKE + gas` at the operator address. |
| `pyde stake rotate --new-pubkey …` | Swap your FALCON keypair. Authorised by the OLD key; after success the new key controls the address. Run while `Active`. |
| `pyde stake unbond` | Begin the unbonding period. Validator transitions to `Unbonding`; stake stays locked through `UNBONDING_PERIOD_WAVES = 5,184,000` waves. |
| `pyde stake claim` | Claim accrued rewards. After `UNBONDING_PERIOD_WAVES` waves past unbond, this also transitions the record to `Exited` and refunds the stake. |
| `pyde stake unjail` | Release a `Jailed` validator back to `Active`. Allowed only after `jail_until_wave` has elapsed; costs an `UNJAIL_FEE`. |

Each subcommand takes `--rpc`, `--falcon-keypair`, optional `--falcon-password-stdin`, `--gas-limit`, and `--chain-id`. Run `pyde stake <subcommand> --help` for the exact flag set.

---

## Where to go next

- The [Validator Lifecycle companion spec](../companion/VALIDATOR_LIFECYCLE.md) covers state transitions, slashing rules, and unbonding/jail constants in formal detail.
- The [State Sync companion spec](../companion/STATE_SYNC.md) explains the snapshot format, weak-subjectivity checkpoints, and the tail-replay design.
- The [Slashing companion spec](../companion/SLASHING.md) enumerates every offense, its evidence shape, its slash amount, and its jail period.
- The [Chain Halt & Recovery companion spec](../companion/CHAIN_HALT.md) covers what to do when the network stalls.

Public testnet bootstrap docs (bootnodes, genesis hash, initial committee) will live in `pyde-net/testnet` once the soft testnet launches.
