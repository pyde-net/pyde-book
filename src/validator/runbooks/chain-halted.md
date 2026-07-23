# Runbook: chain halted (no waves committing)

The chain has stopped advancing. Every validator's `waves_committed` counter is flat. This is the highest-severity incident: the network produces nothing until it's resolved.

## Symptom

- Pager alert: `PydeChainHalted` (Prometheus rule on `increase(pyde_node_waves_committed_total[2m]) == 0`).
- Grafana "Validator health" dashboard: wave-commit cadence panel flatlined.
- Logs (`journalctl -u pyde-validator -f`): no `wave committed` lines for >2 min; vertex production may still be running.
- `pyde_waveId` RPC returns the same wave_id on repeated calls 30s apart.

## First check

```bash
# From any validator host or a monitoring box that can hit the RPC:
curl -s -X POST http://127.0.0.1:9933 \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"pyde_waveId","params":[]}' | jq .result
# Re-run after 15 s. If the number is identical → confirmed halt.
```

If both calls return the same value, the chain is halted on at least this node. Cross-check from a second validator's RPC to rule out "only this node is stuck."

## Triage decision tree

1. **Is this node the only one halted?**
   - `for v in val-1 val-2 val-3 val-4; do curl -s -X POST http://$v:9933 -d '{"jsonrpc":"2.0","id":1,"method":"pyde_waveId","params":[]}' | jq .result; done`
   - Yes (others advancing) → this node is desynced, not a chain halt → go to [state-sync-mismatch](state-sync-mismatch.md).
   - No (all flat) → real chain halt, continue.

2. **Are vertices still being produced?**
   - `curl -s http://127.0.0.1:9933/metrics | grep -E '^pyde_node_(vertices_produced|vertices_received)_total'`
   - Yes (counters climbing) → DAG growing but no anchor, likely VRF / committee mismatch or quorum lost → go to step 3.
   - No (counters flat) → producer loop wedged → check journald for panics, then [validator-OOM](validator-OOM.md) if memory pressure, otherwise restart this validator (`sudo systemctl restart pyde-validator`).

3. **Is the committee quorum reachable?**
   - Quorum = ⌈2·committee_size / 3⌉. For testnet committee_size = 4, quorum = 3. For mainnet committee_size = 128, quorum = 85.
   - Count online committee members: `curl -s -X POST http://127.0.0.1:9933 -d '{"jsonrpc":"2.0","id":1,"method":"pyde_getCommittee","params":[]}' | jq '.result.members | length'`
   - Then ping each member's libp2p listen address.
   - Quorum lost (offline members > committee_size − quorum) → coordinate restarts of the offline validators (private Discord channel). Do NOT remove from committee; v1 has no on-chain rotation.
   - Quorum reachable → continue.

4. **Are validators producing divergent state_roots?**
   - `curl -s -X POST http://val-1:9933 -d '{"jsonrpc":"2.0","id":1,"method":"pyde_getWave","params":[]}' | jq -r .result.state_root`
   - Repeat against every committee member at the same `wave_id` (use `pyde_getWave [N]` with the highest common N).
   - Roots disagree → STOP, this is [state-root-divergence-detected](state-root-divergence-detected.md). Do not restart.
   - Roots agree → consensus is producing waves but commits are stuck. Check for an epoch handover boundary: `pyde_getEpoch.waves_remaining == 0` → [epoch-handover-wedge](epoch-handover-wedge.md).

5. **Is disk full on the wave-committer?**
   - `df -h /var/lib/pyde` on each validator. RocksDB stalls writes at >95% disk.
   - Full → [validator-disk-full](validator-disk-full.md).

## Recovery

Pick the matching branch above. If you reach this point with no branch matching, the chain halt is novel: open an incident channel, preserve state, then coordinate a software restart from the validator quorum.

```bash
# Forensic snapshot on each validator BEFORE restart:
sudo systemctl stop pyde-validator
sudo rsync -a /var/lib/pyde /var/lib/pyde-halt-$(date +%Y%m%d-%H%M)/

# Coordinated restart (each operator on private Discord, on countdown):
sudo systemctl start pyde-validator
```

## Verify recovery

```bash
watch -n 5 'curl -s -X POST http://127.0.0.1:9933 -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"pyde_waveId\",\"params\":[]}" | jq .result'
```

`pyde_node_waves_committed_total` should be increasing across every validator within 30 s of the last restart.

## Post-mortem template

- **Time of halt detected:**
- **Time chain resumed:**
- **Total downtime:**
- **Root cause:**
- **Trigger (PR / config change / external event):**
- **What we tried before the fix:**
- **Why the alert fired in time (or didn't):**
- **Code or doc changes to prevent recurrence:**
- **Drill scheduled for testnet:**
