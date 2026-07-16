# Runbook — state root divergence detected

Two or more validators have signed contradictory state_roots for the same `wave_id`. This is a hard halt — the chain is fork-suspended until the divergence is reconciled.

## Symptom

- Logs: `state_root mismatch at wave_id=N expected=0x… got=0x…` (engine `wave_committer` emits this).
- Grafana "Consensus participation" panel: `state_root_sigs_received` is split — half the committee on one root, half on another.
- Pager: `PydeChainHalted` fires after the 2-minute window because no wave can advance past the divergence point.
- Full nodes downstream go silent on `wave_committed` — they refuse to advance past a wave they can't verify.

## First check

```bash
# Get the wave_id of the last successful commit on this node:
HIGHEST=$(curl -s -X POST http://127.0.0.1:9933 \
  -d '{"jsonrpc":"2.0","id":1,"method":"pyde_waveId","params":[]}' | jq .result)
echo "Local highest wave: $HIGHEST"

# Compare state_root across the committee at $HIGHEST:
for v in val-1 val-2 val-3 val-4; do
  echo -n "$v: "
  curl -s -X POST http://$v:9933 \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"pyde_getWave\",\"params\":[$HIGHEST]}" \
    | jq -r '.result.state_root // "null"'
done
```

If the roots disagree across nodes, this is confirmed divergence.

## Triage decision tree

1. **Which validators are on which root?**
   - Group by root from the curl loop above. Note the operator addresses of each group.
   - If one validator is the outlier, it's likely a local bug → that operator goes to step 2.
   - If the split is even (50/50), it's a global determinism bug → escalate immediately (Discord #incidents, halt all validators).

2. **Is the outlier's engine version drifted from the rest?**
   - `for v in val-1 val-2 val-3 val-4; do ssh $v '/usr/local/bin/pyde --version'; done`
   - Yes → the outlier is running an old/new engine that produces different state. Bring it back to the committee's version (see Recovery below).
   - No → real determinism bug in the engine. Preserve forensic state and escalate.

3. **Has the WASM execution layer been touched in the last release?**
   - `git log --oneline pyde-net/engine --since '7 days ago' -- crates/wasm-exec`
   - Yes → there's a candidate root-cause PR. Tag the author in incident channel.

4. **Are encrypted transactions involved at the divergence wave?**
   - `curl -s -X POST http://val-1:9933 -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"pyde_getWave\",\"params\":[$HIGHEST]}" | jq '.result.encrypted_txs_count // 0'`
   - Non-zero → may be a threshold-decryption non-determinism (pyde-crypto research-risk surface). Inspect MEV decryption shares.

## Recovery

This is one of the **hardest** scenarios. The general shape:

```bash
# 1. Stop ALL validators (coordinated via Discord, on countdown).
sudo systemctl stop pyde-validator

# 2. Preserve forensic state on every validator BEFORE any modification:
sudo tar czf /mnt/forensics/pyde-divergence-$(hostname)-$(date +%Y%m%d-%H%M).tgz /var/lib/pyde

# 3. Identify the patch (engine PR + binary).
# 4. Roll back to last consistent wave. v1 allows 1-epoch rollback (~3 hours).
#    A rollback is irreversible — DO NOT proceed without operator quorum sign-off in the incident channel.
sudo /usr/local/bin/pyde admin rollback \
  --consensus-store-path /var/lib/pyde/data \
  --to-wave $((HIGHEST))   # last verified-consistent wave

# 5. Update binary on every validator to the patched build.
sudo cp /tmp/pyde-patched /usr/local/bin/pyde

# 6. Restart on countdown.
sudo systemctl start pyde-validator
```

For the validators that signed the WRONG root: they'll be slashed for `bad-state-root-sig` (~10% of bond per the slashing rules) once the network resumes. Do NOT try to dodge this on-chain.

## Verify recovery

```bash
# Every committee member agrees on the state_root at HIGHEST:
HIGHEST=$(curl -s -X POST http://127.0.0.1:9933 -d '{"jsonrpc":"2.0","id":1,"method":"pyde_waveId","params":[]}' | jq .result)
for v in val-1 val-2 val-3 val-4; do
  curl -s -X POST http://$v:9933 -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"pyde_getWave\",\"params\":[$HIGHEST]}" \
    | jq -r '.result.state_root'
done | sort -u | wc -l
# Expected output: 1 (all roots match).

# wave_id climbing again:
sleep 30
curl -s -X POST http://127.0.0.1:9933 -d '{"jsonrpc":"2.0","id":1,"method":"pyde_waveId","params":[]}' | jq .result
```

## Post-mortem template

- **Divergence detected at wave_id:**
- **Roots on each side of the split:**
- **Operators on each side:**
- **Engine version diff between sides:**
- **Root cause (WASM bug / pyde-crypto / config drift / other):**
- **Rollback executed? To wave:**
- **Slash candidates:**
- **Test that would have caught this in CI:**
- **WASM determinism test additions:**
- **Drill scheduled to inject divergence in testnet:**
