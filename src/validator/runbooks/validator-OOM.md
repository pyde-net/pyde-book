# Runbook — validator OOM

The validator process was killed by the OOM-killer or memory pressure has caused it to slow to a crawl.

## Symptom

- `journalctl -u pyde-validator` shows `Killed` or `signal 9` followed by systemd restart.
- `dmesg | tail` shows `Out of memory: Killed process … pyde validator`.
- Grafana "Operational counters" panel: `restart count` ticking up.
- Pager alert: `PydeChainHalted` if this is the only validator down beyond the alert window, otherwise the alert is silent (the chain keeps moving as long as quorum holds).

## First check

```bash
sudo dmesg | grep -i 'out of memory' | tail -3
sudo systemctl status pyde-validator | grep -E 'Active:|Memory:'
```

If `dmesg` shows OOM-kill of the pyde process, this is the right runbook.

## Triage decision tree

1. **Is the process currently up?**
   - `sudo systemctl is-active pyde-validator` → if `inactive`, systemd's restart backoff hit `StartLimitBurst=5`. Reset: `sudo systemctl reset-failed pyde-validator && sudo systemctl start pyde-validator`.
   - If `activating (auto-restart)`, leave it — let the next restart land.

2. **Is RSS growing linearly during normal operation?**
   - `ps -o rss,vsz,comm -p $(pgrep -f 'pyde validator')` repeated every 30 s for 5 min.
   - Yes → memory leak. Capture a heap dump if jemalloc is enabled; otherwise file an engine bug with the metric graph.
   - No (RSS plateaued, single OOM event) → likely a short-lived spike from a large wave-commit batch or RPC blast. Go to step 3.

3. **Is the RPC port being flooded?**
   - `ss -tn state established sport = :9933 | wc -l` → if >>100, you're being scraped — go to [public-rpc-DDoS](public-rpc-DDoS.md).
   - Normal connection count → continue.

4. **Is the consensus_store size pathological?**
   - `du -sh /var/lib/pyde/data /var/lib/pyde/state` — expected ~2 GB/week and ~1 GB/week respectively at testnet cadence.
   - Way larger → likely a rocksdb-compaction backlog → see step 5.

5. **Are batches stuck in mempool?**
   - `curl -s http://127.0.0.1:9933/metrics | grep -E 'mempool_txs_(received|persisted)'`
   - Received >> Persisted by >>1000 → mempool backpressure (also paged via `PydeMempoolBackpressure` warn alert). Consider tightening rate-limit or raising `--mempool-capacity`.

## Recovery

```bash
# Bump cgroup memory if the host has headroom (testnet validators sized for ~8 GB RSS).
sudo systemctl set-property pyde-validator.service MemoryHigh=12G MemoryMax=14G

# Force a clean restart with the new limit applied.
sudo systemctl daemon-reload
sudo systemctl restart pyde-validator

# Confirm the new limits took effect.
systemctl show pyde-validator -p MemoryMax -p MemoryHigh
```

If the OOM was from a leak (RSS growing without bound), pin a known-good engine version and downgrade:

```bash
sudo systemctl stop pyde-validator
sudo cp /usr/local/bin/pyde /usr/local/bin/pyde.bad
sudo cp /var/lib/pyde/binaries/pyde-v0.X.Y /usr/local/bin/pyde
sudo systemctl start pyde-validator
```

## Verify recovery

```bash
sleep 60
ps -o rss,comm -p $(pgrep -f 'pyde validator')
# RSS should be in line with the cgroup MemoryMax and not climbing.

curl -s -X POST http://127.0.0.1:9933 \
  -d '{"jsonrpc":"2.0","id":1,"method":"pyde_waveId","params":[]}' | jq .result
sleep 10
curl -s -X POST http://127.0.0.1:9933 \
  -d '{"jsonrpc":"2.0","id":1,"method":"pyde_waveId","params":[]}' | jq .result
# Second result strictly greater than first.
```

## Post-mortem template

- **Time of OOM:**
- **RSS at kill:**
- **MemoryMax in effect at the time:**
- **Trigger (workload spike / leak / RPC flood / unrelated):**
- **Heap dump captured? Path:**
- **New MemoryMax setting:**
- **Engine version diff if any:**
- **Action items (downstream PR / config push / drill update):**
