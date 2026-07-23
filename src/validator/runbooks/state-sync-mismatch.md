# Runbook: state sync mismatch

A node finishes state-sync but its local `state_root` disagrees with the next live wave's expected root. The node refuses to advance.

## Symptom

- Logs on the affected node: `state_sync: applied snapshot at wave=N root=0x… does not match committee root 0x…` or `tail_replay: state_root mismatch after wave=N`.
- The validator/full-node is up but `pyde_waveId` is stuck at the snapshot's wave_id and isn't advancing.
- Grafana on this node: `waves_committed` flat while peer validators advance.

## First check

```bash
# This node's highest wave + state_root:
HIGHEST=$(curl -s -X POST http://127.0.0.1:9933 -d '{"jsonrpc":"2.0","id":1,"method":"pyde_waveId","params":[]}' | jq .result)
MY_ROOT=$(curl -s -X POST http://127.0.0.1:9933 -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"pyde_getWave\",\"params\":[$HIGHEST]}" | jq -r .result.state_root)

# Same wave on a healthy peer:
PEER_ROOT=$(curl -s -X POST http://val-1.testnet.pyde.network:9933 \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"pyde_getWave\",\"params\":[$HIGHEST]}" | jq -r .result.state_root)

echo "Local: $MY_ROOT"
echo "Peer:  $PEER_ROOT"
test "$MY_ROOT" = "$PEER_ROOT" && echo MATCH || echo MISMATCH
```

If MISMATCH at the same wave_id, this runbook applies. If MATCH but stalled, see [chain-halted](chain-halted.md).

## Triage decision tree

1. **Which source did state-sync use?**
   - `grep -E 'state.sync|snapshot' /var/log/pyde/validator.log | head -20` (or `journalctl -u pyde-validator | grep -E 'state.sync|snapshot' | head -20`)
   - File source → the file is wrong or pre-engine-#332 (snapshot non-determinism). Re-fetch from a peer's RPC.
   - RPC source → the serving peer was on a bad fork at snapshot time, or transport corruption. Switch source and resync.

2. **Is this node running the same engine version as the network?**
   - `pyde --version` vs the network's pinned version.
   - Drift → upgrade first, then resync. A pre-#332 binary applies snapshots non-deterministically.

3. **Did weak-subjectivity checkpoints verify?**
   - `grep weak_subjectivity /var/log/pyde/validator.log` should show `checkpoint verified at wave=N`.
   - Missing or failed → the snapshot came from a non-checkpointed source. Re-sync from a node that exposes checkpoints (engine PR #279 wired this).

## Recovery

```bash
# Stop, blow away state, resync from a known-good peer.
sudo systemctl stop pyde-validator
sudo rm -rf /var/lib/pyde/data /var/lib/pyde/state
sudo -u pyde mkdir -p /var/lib/pyde/data /var/lib/pyde/state

# Pick the freshest peer (typically the bootnode array's first entry).
sudo systemctl edit pyde-validator
# Add line: Environment=PYDE_STATE_SYNC=rpc://bootnode-1.testnet.pyde.network:9933

# Confirm engine version is current:
sudo cp /var/lib/pyde/binaries/pyde-latest /usr/local/bin/pyde

sudo systemctl start pyde-validator
sudo journalctl -u pyde-validator -f
# Look for "snapshot applied", "checkpoint verified", "tail replay complete".
```

## Verify recovery

```bash
# Wait for tail-replay to catch up (~40 min for a full testnet snapshot + tail).
watch -n 30 'curl -s -X POST http://127.0.0.1:9933 \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"pyde_waveId\",\"params\":[]}" | jq .result'

# Once it stabilises within 10 of the peer:
HIGHEST=$(curl -s -X POST http://127.0.0.1:9933 -d '{"jsonrpc":"2.0","id":1,"method":"pyde_waveId","params":[]}' | jq .result)
MY=$(curl -s -X POST http://127.0.0.1:9933 -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"pyde_getWave\",\"params\":[$HIGHEST]}" | jq -r .result.state_root)
PEER=$(curl -s -X POST http://val-1.testnet.pyde.network:9933 -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"pyde_getWave\",\"params\":[$HIGHEST]}" | jq -r .result.state_root)
test "$MY" = "$PEER" && echo "GREEN" || echo "STILL MISMATCH — escalate"
```

## Post-mortem template

- **Time mismatch detected:**
- **Source of bad snapshot (file path or peer):**
- **Engine version of the bad node:**
- **Engine version of the source:**
- **Was weak-subjectivity checkpoint enforced?:**
- **Resync source:**
- **Time-to-resync:**
- **Tests that would have caught it:**
