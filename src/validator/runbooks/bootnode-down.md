# Runbook: bootnode down

One of `bootnode-1..N.testnet.pyde.network` isn't accepting libp2p dials. New validators / full nodes can't bootstrap into the network.

## Symptom

- Operator joining the network reports `failed to dial bootnode-2 — timeout` in their validator boot log.
- Grafana "Peer discovery" panel: peer count from the down bootnode panel is zero.
- Monitoring uptime probe (any standard HTTP / TCP healthcheck): `bootnode-2:30303` red.
- Pager: a bespoke `BootnodeDown` alert (not part of the v1 alert set; deferred to bootnode-monitoring follow-up).

## First check

```bash
# Identify which bootnodes are reachable:
for n in bootnode-1 bootnode-2 bootnode-3 bootnode-4; do
  echo -n "$n: "
  nc -zv $n.testnet.pyde.network 30303 2>&1 | tail -1
done

# Cross-check via RPC if the bootnode exposes one (some are pure libp2p):
for n in bootnode-1 bootnode-2 bootnode-3 bootnode-4; do
  echo -n "$n: "
  curl -s -m 5 -X POST http://$n.testnet.pyde.network:9933 \
    -d '{"jsonrpc":"2.0","id":1,"method":"pyde_getNodeInfo","params":[]}' \
    | jq -r '.result.agent_version // "DOWN"'
done
```

## Triage decision tree

1. **Is the host responsive at all?**
   - SSH check: `ssh bootnode-2.testnet.pyde.network 'uptime'`
   - No SSH → the host itself is down. AWS console restart (step 4).
   - SSH works → continue.

2. **Is the `pyde` process running?**
   - `ssh bootnode-2.testnet.pyde.network 'sudo systemctl status pyde-validator'`
   - Down → restart it (`sudo systemctl restart pyde-validator`).
   - Up → continue.

3. **Is libp2p binding to the right address?**
   - `ssh bootnode-2 'sudo ss -tlnp | grep 30303'`
   - Listening on `127.0.0.1` only → misconfigured. Add `--listen /ip4/0.0.0.0/tcp/30303`.
   - Listening on `0.0.0.0` → continue.

4. **Is the AWS security group / DNS / TLS allowing inbound 30303?**
   - `aws ec2 describe-security-groups --group-ids sg-XXX | jq '.SecurityGroups[0].IpPermissions'`
   - 30303 missing → add: `aws ec2 authorize-security-group-ingress --group-id sg-XXX --protocol tcp --port 30303 --cidr 0.0.0.0/0`.

5. **Are validators / full nodes able to talk to the OTHER bootnodes?**
   - Yes → low urgency; one bootnode down is acceptable as long as 1+ alternate is reachable.
   - No → critical; new nodes cannot bootstrap. Escalate.

## Recovery

```bash
# Most common case: process is dead.
ssh bootnode-2.testnet.pyde.network 'sudo systemctl restart pyde-validator'
ssh bootnode-2.testnet.pyde.network 'sudo journalctl -u pyde-validator -n 50 --no-pager'

# Host is dead: AWS console / CLI restart.
aws ec2 reboot-instances --instance-ids i-XXX
# Wait ~90 s, then re-check:
sleep 90
nc -zv bootnode-2.testnet.pyde.network 30303

# Bootnode is gone for good: remove from DNS, update bootnodes.txt distribution.
# 1. Remove the Route53 A record for the dead bootnode.
# 2. Push an updated bootnodes.txt to the testnet pin (S3 / GitHub release).
# 3. Notify validators in Discord to update /etc/pyde/bootnodes.txt.
```

Always run >=3 bootnodes so one dying isn't a network event.

## Verify recovery

```bash
# Port is open:
nc -zv bootnode-2.testnet.pyde.network 30303

# A fresh node can dial it. Test from a throwaway VM:
ssh test-vm '/usr/local/bin/pyde devnet --bootnodes /ip4/$(dig +short bootnode-2.testnet.pyde.network)/tcp/30303/p2p/12D3KooWXYZ... --listen /ip4/0.0.0.0/tcp/30304' &
sleep 30
ssh test-vm 'curl -s http://127.0.0.1:9933/metrics | grep peers_connected'
# Expected: non-zero peers_connected counter.
```

## Post-mortem template

- **Bootnode that went down:**
- **Time down:**
- **Time to detection:**
- **Root cause (process crash / host failure / DNS / SG / TLS):**
- **Were the OTHER bootnodes also down? (single-point-of-failure check):**
- **How many bootnodes does the testnet currently run?:**
- **Monitoring gap that delayed detection:**
- **AWS Auto Scaling / spot-instance reconsidered?:**
