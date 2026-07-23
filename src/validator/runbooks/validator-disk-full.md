# Runbook: validator disk full

`/var/lib/pyde` (or its mount) is at or above 95% full. RocksDB write-stalls trigger first, then the wave-committer wedges, then systemd's restart loop fails because the validator can't allocate WAL space.

## Symptom

- `df` shows `/var/lib/pyde` at >95%.
- Logs (`journalctl -u pyde-validator`): `rocksdb: write stalled` or `IO error: No space left on device`.
- `pyde_node_waves_committed_total` flat on this node; other validators continue if quorum holds.
- Pager alert: `PydeChainHalted` if this brings the network below quorum; otherwise the host-side disk alert (any standard node-exporter disk-usage rule) should have fired first.

## First check

```bash
df -h /var/lib/pyde
du -sh /var/lib/pyde/* | sort -h | tail -10
```

If the mount is >95% full and the largest consumers are under `/var/lib/pyde/data` or `/var/lib/pyde/state`, this is the right runbook.

## Triage decision tree

1. **Is it the consensus_store, state_store, or logs eating disk?**
   - `du -sh /var/lib/pyde/data /var/lib/pyde/state /var/log/pyde`
   - Logs dominant → log rotation broke; go to step 2.
   - State or consensus dominant → expected growth; go to step 3.

2. **Are journald + logrotate working?**
   - `journalctl --disk-usage` and `du -sh /var/log/pyde/*`
   - Journald above its `SystemMaxUse=` cap → restart journald: `sudo systemctl restart systemd-journald`.
   - logrotate not rotating → `sudo logrotate -f /etc/logrotate.d/pyde-validator` and check `cat /var/lib/logrotate/status`.

3. **Is this a single-validator capacity miss, or are all validators near full?**
   - Cross-check: `for v in val-1 val-2 val-3 val-4; do ssh $v df -h /var/lib/pyde | tail -1; done`
   - One node only → host-side fix (this runbook).
   - All nodes near full → coordinate, then schedule a v2 pruning sprint. Quick fix: pause the soak workload.

4. **Is RocksDB compaction backlogged?**
   - `ls -1 /var/lib/pyde/data/*.sst | wc -l` (a healthy store has dozens, not thousands).
   - Backlogged → compactions can take hours; tail logs for `Compaction started` lines and let it run if you can spare the disk to land.

## Recovery

Short-term: free disk by removing the OLD on-disk replicas (the consensus_store is replicated across all committee members; this validator's copy can be regenerated via state sync).

```bash
# Confirm this validator is NOT the only one holding history:
for v in val-1 val-2 val-3 val-4; do
  ssh $v 'curl -s -X POST http://127.0.0.1:9933 -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"pyde_waveId\",\"params\":[]}" | jq .result'
done

# Stop the validator, archive state, blow away the heavy stores, restart with state-sync.
sudo systemctl stop pyde-validator
sudo tar czf /mnt/backup/pyde-data-$(date +%Y%m%d).tgz /var/lib/pyde
sudo rm -rf /var/lib/pyde/data /var/lib/pyde/state
sudo -u pyde mkdir -p /var/lib/pyde/data /var/lib/pyde/state

# Patch the service unit to fetch from a peer's snapshot endpoint:
sudo systemctl edit pyde-validator
# Add: Environment=PYDE_STATE_SYNC=rpc://val-2.testnet.pyde.network:9933
sudo systemctl start pyde-validator
```

Long-term: provision more disk. Plan ~50 GB per validator per 3 months at testnet cadence.

```bash
# If on AWS gp3 EBS:
aws ec2 modify-volume --volume-id vol-XXX --size 200
sudo growpart /dev/nvme1n1 1
sudo resize2fs /dev/nvme1n1p1
```

## Verify recovery

```bash
df -h /var/lib/pyde
# Should now show 50%+ free.

# State sync completes, wave_id catches up:
watch -n 10 'curl -s -X POST http://127.0.0.1:9933 -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"pyde_waveId\",\"params\":[]}" | jq .result'
# Should converge to the chain's current wave_id within ~40 min.
```

## Post-mortem template

- **Time disk filled:**
- **Mount and capacity at the time:**
- **Largest on-disk consumer:**
- **Was pruning v2 work prioritised in roadmap?**
- **New disk capacity provisioned:**
- **Alert threshold updated (current default fires at 90%):**
- **Are all validators sized consistently?**
