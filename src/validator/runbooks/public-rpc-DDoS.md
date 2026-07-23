# Runbook: public RPC under DDoS

`rpc.testnet.pyde.network` is being flooded. The validator behind it is paying CPU + memory cost to reject requests; legitimate users see 429 or timeout.

## Symptom

- Grafana "Operational counters" panel: `rpc_request_rate` spiking 100x normal.
- Validator logs: `429 Too Many Requests` flood + the validator itself may be paging on `PydeChainHalted` if the RPC overhead is starving the consensus loops.
- Cloudfront / nginx access logs: same IP or same /24 hammering `/`.
- Users on Discord complain RPC returns 502 / 429.

## First check

```bash
# Which IPs are dominant?
sudo journalctl -u pyde-validator --since '5 minutes ago' \
  | grep -oE 'remote=[0-9.]+' \
  | sort | uniq -c | sort -rn | head -10

# OR if behind nginx:
sudo tail -n 10000 /var/log/nginx/access.log \
  | awk '{print $1}' | sort | uniq -c | sort -rn | head -10
```

If one IP or /24 accounts for >>50% of traffic, you're being targeted.

## Triage decision tree

1. **Is the validator actually running, or is the load knocking it over?**
   - `curl -s http://127.0.0.1:9933/metrics | grep waves_committed_total`
   - Counter advancing → consensus is healthy; RPC is the only thing struggling. Continue.
   - Counter flat → DDoS is impacting consensus → go to step 2 fast.

2. **Is the attack distributed (botnet) or single-source?**
   - Top 10 IPs cover >80% → single-source. Block at firewall (step 4).
   - Top 100 IPs cover <20% (long tail) → botnet. Cloudfront / Cloudflare gate (step 5).

3. **Is the validator's per-IP rate-limit (PR #294) enabled?**
   - Check service unit: `grep -i rate /etc/systemd/system/pyde-validator.service`
   - Default 100 rps / 200 burst is what we ship. If disabled, enable it.

4. **Is RPC exposed directly, or behind a CDN/proxy?**
   - Direct → expose only the proxy. Move RPC behind nginx + Cloudfront.

5. **Are the abused methods cap-respecting?**
   - `pyde_getEvents` and `pyde_sendRawEncryptedTransaction` were unbounded pre-engine-#337 / #338. Confirm those PRs are pinned.

## Recovery

```bash
# IMMEDIATE: block the worst offender at the firewall.
BAD_IP=1.2.3.4
sudo ufw deny from $BAD_IP

# OR if behind nginx:
sudo tee -a /etc/nginx/conf.d/blocklist.conf >/dev/null <<EOF
deny $BAD_IP;
EOF
sudo nginx -s reload

# TIGHTEN per-IP rate-limit at the validator (was 100rps, push to 10):
sudo systemctl edit pyde-validator
# Add to ExecStart: --rpc-rate-limit-rps 10 --rpc-rate-limit-burst 20
sudo systemctl daemon-reload
sudo systemctl restart pyde-validator

# IF behind Cloudflare, enable "Under Attack" mode:
# Dashboard → Security → Settings → Security Level → Under Attack.

# Allow the explorer indexer's CIDR through (don't break legitimate internal traffic):
sudo systemctl edit pyde-validator
# Add: --rpc-rate-limit-allowlist 10.0.0.0/16
sudo systemctl restart pyde-validator
```

## Verify recovery

```bash
# Request rate drops back to baseline within 5 min:
for i in 1 2 3 4 5; do
  sleep 60
  curl -s http://127.0.0.1:9933/metrics \
    | grep rpc_requests_total | tail -1
done
# Counter should decelerate sharply after the block lands.

# Legitimate users can still call:
curl -s -w '%{http_code}\n' -X POST https://rpc.testnet.pyde.network \
  -d '{"jsonrpc":"2.0","id":1,"method":"pyde_waveId","params":[]}'
# Expected: 200 OK.

# Consensus loop is healthy:
curl -s -X POST http://127.0.0.1:9933 -d '{"jsonrpc":"2.0","id":1,"method":"pyde_waveId","params":[]}' | jq .result
sleep 10
curl -s -X POST http://127.0.0.1:9933 -d '{"jsonrpc":"2.0","id":1,"method":"pyde_waveId","params":[]}' | jq .result
# Increasing.
```

## Post-mortem template

- **Peak request rate:**
- **Top source IPs / ASNs:**
- **Block applied at (firewall / nginx / CDN):**
- **Did consensus stall during the attack?:**
- **Engine PR #337 + #338 pinned?:**
- **CDN / Cloudflare in front yet? When did it land?:**
- **Per-IP rate-limit value before / after:**
- **What's the next escalation (autoscale / WAF rules / Bot Protection):**
