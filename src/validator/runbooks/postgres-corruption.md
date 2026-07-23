# Runbook: explorer Postgres corruption

The explorer's Postgres database (`pyde-postgres` container or RDS instance) has corrupted pages, refuses connections, or returns stale / wrong data on indexer queries.

## Symptom

- Indexer logs: `ERROR: invalid page in block N of relation base/X/Y` or `database system was interrupted`.
- Explorer site: HTTP 500 from `/api/*` routes, or completely stale data (wave_id frozen on the explorer days behind chain head).
- Postgres logs: `PANIC: could not locate a valid checkpoint record` (worst case).
- Connection failures: `psql: FATAL: could not start WAL streaming`.

## First check

```bash
# Is Postgres alive at all?
docker ps | grep pyde-postgres
docker logs pyde-postgres --tail 100 2>&1 | grep -E 'PANIC|FATAL|invalid page'

# Or for RDS:
aws rds describe-db-instances --db-instance-identifier pyde-explorer-prod \
  | jq '.DBInstances[0].DBInstanceStatus'
```

If Postgres logs reference `invalid page`, `PANIC`, or won't start, this is real corruption.

## Triage decision tree

1. **Is the issue corruption, or a soft transient (disk full / OOM)?**
   - Disk full: `docker exec pyde-postgres df -h` (or RDS storage metric).
   - OOM: `docker logs pyde-postgres | grep -i 'out of memory'`
   - Either → fix that first (free disk / scale up); corruption may resolve on restart.

2. **Is the chain data itself the source of truth?**
   - YES (always for Pyde). The Postgres database is a derived index, not authoritative. You can wipe it and re-index from the chain.
   - This is the killer fact: rebuilding the explorer DB from scratch is operationally cheap.

3. **How recent is the last good backup?**
   - Daily snapshots: `aws rds describe-db-snapshots --db-instance-identifier pyde-explorer-prod | jq '.DBSnapshots[-1].SnapshotCreateTime'`
   - <24h old → restore is fast. Continue.
   - Stale → wipe + re-index.

4. **Is replication / WAL streaming the corruption source?**
   - `docker exec pyde-postgres ls /var/lib/postgresql/data/pg_wal | wc -l`:
     pathological growth = stuck replication.

## Recovery

The fast path (rebuild from chain):

```bash
# 1. Stop the indexer + explorer.
sudo systemctl stop pyde-indexer pyde-explorer

# 2. Wipe the DB volume.
docker stop pyde-postgres
docker rm pyde-postgres
sudo rm -rf /var/lib/pyde-postgres/data

# 3. Recreate from the docker-compose definition.
docker compose up -d postgres
sleep 30  # let it initialise

# 4. Run migrations (Diesel / sqlx on the indexer).
sudo systemctl start pyde-indexer
sudo journalctl -u pyde-indexer -f
# Look for "migration applied" + "indexing from wave=0".

# 5. Watch the catch-up. At ~125 ms / wave + ~1000 tx / wave, expect ~2 h to catch up to a 1-week chain.
watch -n 30 'docker exec pyde-postgres psql -U pyde -c "select max(wave_id) from waves;"'

# 6. Re-enable the explorer once the indexer reaches chain head.
sudo systemctl start pyde-explorer
```

The slower path (restore from snapshot):

```bash
# Restore RDS from latest snapshot to a new instance.
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier pyde-explorer-restored \
  --db-snapshot-identifier $(aws rds describe-db-snapshots --db-instance-identifier pyde-explorer-prod | jq -r '.DBSnapshots[-1].DBSnapshotIdentifier')

# Once the new instance is healthy, repoint the indexer's DATABASE_URL and restart.
```

Always prefer wipe + re-index for a corrupted explorer DB: the chain has
all the data and the index is meant to be cheap to rebuild.

## Verify recovery

```bash
# Indexer caught up to chain head:
HEAD=$(curl -s -X POST https://rpc.testnet.pyde.network -d '{"jsonrpc":"2.0","id":1,"method":"pyde_waveId","params":[]}' | jq .result)
INDEXED=$(docker exec pyde-postgres psql -U pyde -t -c "select max(wave_id) from waves;" | xargs)
echo "Lag: $((HEAD - INDEXED))"
# Expected: < 10.

# A known tx is queryable:
TXHASH=$(curl -s -X POST https://rpc.testnet.pyde.network -d '{"jsonrpc":"2.0","id":1,"method":"pyde_getRecentTransactions","params":[1]}' | jq -r .result[0].hash)
docker exec pyde-postgres psql -U pyde -c "select status from txs where hash = '$TXHASH';"
# Expected: "confirmed".

# Explorer pages load without 500s:
curl -s -w '%{http_code}\n' https://testnet.pyde.network/
curl -s -w '%{http_code}\n' https://testnet.pyde.network/api/waves
# Both 200.
```

## Post-mortem template

- **Corruption first observed:**
- **Symptoms (PANIC text, error code):**
- **Suspected cause (storage / OOM / unclean shutdown / replication):**
- **Last good backup age:**
- **Recovery path taken (wipe / restore):**
- **Time to recovery:**
- **Was the indexer single-instance? (no replication = single point of failure):**
- **RDS snapshot cadence change:**
- **Storage IOPS provisioned (gp3 baseline 3000):**
