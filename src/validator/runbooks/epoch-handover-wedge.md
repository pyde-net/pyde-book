# Runbook: epoch handover wedge

The chain advances inside an epoch but stalls at the boundary. The DKG attestation buffer didn't reach the threshold the new epoch's MEV decryption needs, OR the next-epoch beacon didn't combine.

## Symptom

- Logs at the last wave of an epoch: `epoch handover blocked — beacon shares insufficient` OR `dkg attestation buffer below committee size`.
- `pyde_getEpoch.waves_remaining` reaches `0` and stays there. New wave commits stop.
- Pager: `PydeChainHalted` fires after 2 min.
- This is the failure mode engine bug #333 fixed (DKG buffer required N = committee_size, not the (k,n) threshold). Mid-soak validator drop triggered it.

## First check

```bash
# Confirm the chain is sitting at the epoch boundary:
curl -s -X POST http://127.0.0.1:9933 \
  -d '{"jsonrpc":"2.0","id":1,"method":"pyde_getEpoch","params":[]}' | jq .result
# Expected if wedged:
# {"epoch": "0xN", "current_wave_id": "0xM", "wave_within_epoch": "0x...", "waves_remaining": "0x0", ...}

# Did the next-epoch beacon assemble?
NEXT=$(curl -s -X POST http://127.0.0.1:9933 \
  -d '{"jsonrpc":"2.0","id":1,"method":"pyde_getEpoch","params":[]}' | jq -r '.result.epoch')
curl -s -X POST http://127.0.0.1:9933 \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"pyde_getBeacon\",\"params\":[$((NEXT + 1))]}" | jq .result.source
# "pending" means the threshold-combine hasn't completed for the next epoch.
```

## Triage decision tree

1. **Is `pyde_getBeacon` for the next epoch `"pending"`?**
   - Yes → beacon shares incomplete. Go to step 2.
   - No (`"derived"`) → beacon is fine; the wedge is on the DKG attestation side. Go to step 3.

2. **How many validators submitted beacon shares?**
   - `curl -s http://127.0.0.1:9933/metrics | grep -E 'beacon_(shares_received|combine_failures|combined)'`
   - Below threshold (k of n, where k = ⌈2n/3⌉) → some validators are offline at the handover. Check liveness of every committee member (TCP 30303 + RPC 9933 reachability). Get them back online.

3. **How many DKG attestations are in the buffer?**
   - `curl -s http://127.0.0.1:9933/metrics | grep dkg_attestations`
   - Below committee size → engine bug #333 should have fixed this; if it's still happening, you're on a stale binary. Confirm `pyde --version` matches what's pinned in `pyde-net/engine` for the network.

4. **Was a validator removed mid-epoch?**
   - Cross-check operator addresses in last 3 epochs via `pyde_getCommittee` from RPC archive nodes.
   - v1 has no on-chain rotation, but a slash that jails a validator mid-epoch can shrink the live set.
   - If yes → coordinate to bring the slashed/jailed validator back via `pyde stake unjail` after `jail_until_wave`, or accept the wedge until next epoch when a backup-pool member is selected.

## Recovery

Most common path: the missing validators come back online and the handover completes automatically.

```bash
# On each offline validator's host:
sudo systemctl start pyde-validator
sudo journalctl -u pyde-validator -f
# Look for "submitted dkg attestation" and "submitted beacon share" lines.
```

If you can't bring quorum back (lost keys, dead hardware), the **only** non-rollback fix is to wait for the network to advance via the wait-window policy (engine #163 wait-window). The wedge will release once all online members catch up.

If the wedge persists >30 min with quorum available, escalate to coordinated restart:

```bash
# Coordinated restart on every committee member (Discord countdown).
sudo systemctl stop pyde-validator
# Wait 60s for all peers to disconnect cleanly.
sudo systemctl start pyde-validator
```

## Verify recovery

```bash
# wave_id climbs past the epoch boundary:
START=$(curl -s -X POST http://127.0.0.1:9933 -d '{"jsonrpc":"2.0","id":1,"method":"pyde_waveId","params":[]}' | jq .result)
sleep 60
END=$(curl -s -X POST http://127.0.0.1:9933 -d '{"jsonrpc":"2.0","id":1,"method":"pyde_waveId","params":[]}' | jq .result)
test "$END" -gt "$START" && echo "GREEN: wave advanced from $START to $END"

# New epoch's beacon is derived:
NEXT=$(curl -s -X POST http://127.0.0.1:9933 -d '{"jsonrpc":"2.0","id":1,"method":"pyde_getEpoch","params":[]}' | jq -r '.result.epoch')
curl -s -X POST http://127.0.0.1:9933 -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"pyde_getBeacon\",\"params\":[$NEXT]}" | jq .result.source
# Expected: "derived" (or "genesis" if epoch 0).
```

## Post-mortem template

- **Epoch boundary that wedged:**
- **Online committee members at the time:**
- **Quorum threshold:**
- **What blocked: beacon, DKG, or both:**
- **Engine version at the time:**
- **Did engine bug #333 fix this? (Confirm pinned version on all validators.)**
- **Validators slashed mid-epoch:**
- **Drill scheduled (mid-epoch validator drop):**
