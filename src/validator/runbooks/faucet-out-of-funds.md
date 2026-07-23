# Runbook: faucet out of funds

`faucet.testnet.pyde.network` is rejecting drip requests with insufficient-balance errors. The faucet's funding account is drained.

## Symptom

- Users report on Discord: faucet returns `400 Bad Request` with body `{"error":"faucet out of funds"}`.
- Faucet service logs: `tx submission failed: insufficient balance, account=0x... want=10_000_000_000 have=N`.
- Faucet drip-count metric flatlines while the request-count metric keeps climbing.
- Indirect symptom: testnet new-user onboarding stops cold; everyone clamours on Discord.

## First check

```bash
# The faucet's funding account address is published in the README / genesis.
FAUCET_ADDR=0xfa00cefa00cefa00cefa00cefa00cefa00cefa00
curl -s -X POST https://rpc.testnet.pyde.network \
  -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"pyde_getBalance\",\"params\":[\"$FAUCET_ADDR\"]}" | jq .result
# Should be much larger than DRIP_AMOUNT (testnet default 100 PYDE).
```

If the balance is below the drip amount times 100 (fewer than 100 drips remaining), you're out of runway. Refill now.

## Triage decision tree

1. **Is the drain organic (high demand) or a leak (loop bug or abuse)?**
   - `journalctl -u pyde-faucet | tail -200 | grep -c 'drip ok'` → if drips are happening at a sane rate, organic.
   - Faucet metric `drips_per_minute` >> normal rate (testnet day-1: ~5/min) → abuse. Tighten the rate-limit.

2. **Is the faucet's per-IP rate-limit enabled?**
   - Faucet config (typically `/etc/pyde-faucet/config.toml`): `rate_limit_per_ip_per_24h`.
   - Default should be 1. If `0` or unset, attackers can drain it via VPN-hopping.

3. **Does the cooldown window match the spec?**
   - Cooldown should be 24h per address AND per IP. Cross-check the config.

4. **Is the GitHub-whitelist gate live?**
   - Testnet Sybil gating: only addresses on the `pyde-net/testnet-validators` whitelist OR addresses tied to a verified GitHub account get drips.
   - If the gate isn't live, anonymous abuse is the most likely drain.

## Recovery

```bash
# 1. Top up the faucet from the foundation treasury wallet.
TREASURY_KEYPAIR=/etc/pyde/treasury.keypair
FAUCET_ADDR=0xfa00cefa00cefa00cefa00cefa00cefa00cefa00
REFILL_AMOUNT=10000000000000000000000  # 10,000 PYDE in wei

pyde send \
  --rpc https://rpc.testnet.pyde.network \
  --falcon-keypair $TREASURY_KEYPAIR --falcon-password-stdin \
  --to $FAUCET_ADDR \
  --amount $REFILL_AMOUNT

# 2. If abuse caused the drain, tighten the limit + add whitelist gate:
sudo systemctl stop pyde-faucet
sudo sed -i 's/^rate_limit_per_ip_per_24h.*/rate_limit_per_ip_per_24h = 1/' /etc/pyde-faucet/config.toml
sudo sed -i 's/^require_github_auth.*/require_github_auth = true/' /etc/pyde-faucet/config.toml
sudo systemctl start pyde-faucet
```

## Verify recovery

```bash
# Faucet balance is healthy:
curl -s -X POST https://rpc.testnet.pyde.network \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"pyde_getBalance\",\"params\":[\"$FAUCET_ADDR\"]}" | jq .result

# A drip succeeds end-to-end:
curl -s -X POST https://faucet.testnet.pyde.network/drip \
  -H 'content-type: application/json' \
  -d '{"address":"0xtestrecipient0000000000000000000000000000"}' | jq .
# Expected: {"tx_hash":"0x...","status":"submitted"}

# Funds land at the recipient within ~2 wave commits:
sleep 30
curl -s -X POST https://rpc.testnet.pyde.network \
  -d '{"jsonrpc":"2.0","id":1,"method":"pyde_getBalance","params":["0xtestrecipient0000000000000000000000000000"]}' | jq .result
```

## Post-mortem template

- **Time faucet drained:**
- **Balance at drain:**
- **Refill amount + treasury balance after:**
- **Drain cause (organic / loop bug / abuse):**
- **Rate limit + cooldown values at drain:**
- **Rate limit + cooldown values after:**
- **Was GitHub-whitelist gate live?:**
- **Abuser addresses (if traceable):**
- **Treasury runway at current drip rate:**
