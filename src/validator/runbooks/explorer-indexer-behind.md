# Runbook: explorer indexer behind

The explorer's indexer process is more than 100 waves behind the chain head. The public site shows stale wave numbers, missing transactions, and "indexer X seconds behind" warnings.

## Symptom

- Explorer footer: `Indexer lag: N waves` where N > 100.
- Grafana (explorer dashboards): `indexer_wave_lag` panel climbing.
- Indexer logs (`docker logs pyde-indexer` or `journalctl -u pyde-indexer`): `falling behind: head=W indexer=W-100`, or RecvError::Lagged spam.
- Users complain on Discord that their tx shows as `pending` on the explorer long after it confirmed on-chain.

## First check

```bash
# Chain head:
HEAD=$(curl -s -X POST https://rpc.testnet.pyde.network \
  -d '{"jsonrpc":"2.0","id":1,"method":"pyde_waveId","params":[]}' | jq .result)
echo "Chain head: $HEAD"

# Explorer's reported indexer position:
INDEXED=$(curl -s https://testnet.pyde.network/api/health | jq .indexer_head)
echo "Explorer head: $INDEXED"

# Lag:
echo "Lag: $((HEAD - INDEXED)) waves"
```

If lag > 100, this runbook applies.

## Triage decision tree

1. **Is the indexer process alive?**
   - `sudo systemctl status pyde-indexer` OR `docker ps | grep indexer`
   - Dead → restart, look at exit reason in logs.
   - Alive → continue.

2. **Is the RPC client hitting the per-IP rate limit?**
   - `journalctl -u pyde-indexer | grep -c '429\|rate'` over the last hour.
   - >100 → engine bug #334 (per-IP rate limiter too tight for co-located indexer). Raise the indexer's per-IP allowance via `--rpc-rate-limit-per-ip 1000` on the validator OR move the indexer behind an internal allowlisted CIDR.

3. **Is the WebSocket subscription dropping events?**
   - Look for `RecvError::Lagged(N)` in indexer logs.
   - Yes → the WS broadcast buffer is overflowing. Engine PR #341 fixed silent drop on Lagged; confirm the indexer is on the patched version.

4. **Is the indexer's Postgres slow?**
   - `docker exec -it pyde-postgres psql -U pyde -c "select datname, query_start, state, query from pg_stat_activity where state <> 'idle' order by query_start asc limit 5;"`
   - Long-running queries → likely a missing index. The `metrics_transactions` table needs indexes on `(wave_id, tx_status)`. See [postgres-corruption](postgres-corruption.md) for a deeper Postgres triage.

5. **Is the indexer single-threaded and CPU-bound?**
   - `top -p $(pgrep -f pyde-indexer)`: if one core pegged, the indexer is CPU-bound on event decode. Scale horizontally is the long-term fix.

## Recovery

```bash
# Fast recovery: restart the indexer pointed at the right wave (don't re-index from 0).
sudo systemctl stop pyde-indexer

# Reset its watermark to chain head minus a small overlap (re-process last 50 waves to catch what was in-flight).
HEAD=$(curl -s -X POST https://rpc.testnet.pyde.network \
  -d '{"jsonrpc":"2.0","id":1,"method":"pyde_waveId","params":[]}' | jq .result)
docker exec -it pyde-postgres psql -U pyde -c \
  "update indexer_state set last_processed_wave = $((HEAD - 50)) where id = 1;"

sudo systemctl start pyde-indexer
```

If the indexer is hitting the rate limit (step 2), patch the validator's allowlist:

```bash
# On the validator host:
sudo systemctl edit pyde-validator
# Add to ExecStart: --rpc-rate-limit-allowlist 10.0.0.0/16
sudo systemctl restart pyde-validator
```

## Verify recovery

```bash
# Lag drops to under 10 waves within 5 min:
for i in 1 2 3 4 5; do
  sleep 60
  HEAD=$(curl -s -X POST https://rpc.testnet.pyde.network \
    -d '{"jsonrpc":"2.0","id":1,"method":"pyde_waveId","params":[]}' | jq .result)
  INDEXED=$(curl -s https://testnet.pyde.network/api/health | jq .indexer_head)
  echo "min $i: lag = $((HEAD - INDEXED))"
done
# Lag should monotonically shrink.

# Recent tx shows up on the explorer:
TXHASH=$(curl -s -X POST https://rpc.testnet.pyde.network \
  -d '{"jsonrpc":"2.0","id":1,"method":"pyde_getRecentTransactions","params":[1]}' | jq -r .result[0].hash)
curl -s "https://testnet.pyde.network/api/tx/$TXHASH" | jq .status
# Expected: "confirmed", not "not_found".
```

## Post-mortem template

- **Lag at detection:**
- **Time to drain back to <10:**
- **Root cause (rate limit / Lagged / Postgres / CPU):**
- **Engine PR #341 + #334 pinned on all validators? Versions:**
- **Indexer connection-pool size:**
- **Postgres slow-query list:**
- **Capacity headroom for next 4x demand growth:**
