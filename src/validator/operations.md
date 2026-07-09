# Day-2 Operations

Running a Pyde validator as a real service on a real machine — not a `pyde validator` you SIGINT when you close the laptop. This chapter covers systemd, monitoring, log rotation, encrypted-keypair workflow, and the operational hygiene that keeps you from getting slashed for downtime.

Prereqs: you've installed `pyde` per the [Quickstart](quickstart.md), generated keys, and joined the network per [Joining a Public Testnet](joining-testnet.md). Your validator boots cleanly via `pyde validator …` and the metrics endpoint responds. Now we make that survive the host rebooting.

---

## 1. Run `pyde validator` as a systemd service

The pattern: a dedicated `pyde` user, a service unit that supervises the process, a tmpfile for the FALCON-keypair password.

### Create the service user + data dirs

```bash
sudo useradd --system --shell /usr/sbin/nologin --home-dir /var/lib/pyde pyde
sudo mkdir -p /var/lib/pyde /etc/pyde /var/log/pyde
sudo chown -R pyde:pyde /var/lib/pyde /var/log/pyde
sudo chmod 750 /var/lib/pyde /var/log/pyde
sudo chmod 755 /etc/pyde
```

### Move keypairs + config into place

Assuming you generated keys + downloaded genesis per the earlier chapters:

```bash
sudo cp ~/falcon.keypair /etc/pyde/falcon.keypair
sudo cp ~/pyde-testnet/genesis.toml /etc/pyde/genesis.toml
sudo cp ~/pyde-testnet/bootnodes.txt /etc/pyde/bootnodes.txt
sudo chown root:pyde /etc/pyde/falcon.keypair /etc/pyde/genesis.toml /etc/pyde/bootnodes.txt
sudo chmod 640 /etc/pyde/falcon.keypair
sudo chmod 644 /etc/pyde/genesis.toml /etc/pyde/bootnodes.txt
```

The FALCON keypair is `640` so only the `pyde` group reads it. Genesis + bootnodes are world-readable — they're public network config.

### Provide the FALCON keypair password

Two options:

**(a) systemd credential** (recommended on systemd ≥ 250 — Ubuntu 22.04+, RHEL 9+):

```bash
sudo systemd-creds encrypt --name=falcon-password - /etc/pyde/falcon-password.cred <<< 'your-falcon-passphrase'
sudo chmod 600 /etc/pyde/falcon-password.cred
```

This produces a TPM-bound encrypted credential; systemd decrypts it at service-start time. The plaintext never lives on disk.

**(b) Plain file with strict permissions** (older systemd):

```bash
echo 'your-falcon-passphrase' | sudo tee /etc/pyde/falcon-password >/dev/null
sudo chown root:pyde /etc/pyde/falcon-password
sudo chmod 640 /etc/pyde/falcon-password
```

Less ideal — the password lives in plaintext on disk and is only protected by file perms. Acceptable for testnet operations; production should prefer (a) or an external secret manager.

### Write the service unit

```bash
sudo tee /etc/systemd/system/pyde-validator.service >/dev/null <<'EOF'
[Unit]
Description=Pyde Validator
Documentation=https://book.pyde.network/validator/operations.html
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pyde
Group=pyde

# Hardening — defense in depth.
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/pyde /var/log/pyde
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
MemoryDenyWriteExecute=false
SystemCallArchitectures=native

# Resource limits.
LimitNOFILE=65536

# systemd credential — pipes to pyde's stdin so --falcon-password-stdin works.
LoadCredentialEncrypted=falcon-password:/etc/pyde/falcon-password.cred

ExecStart=/bin/bash -c 'cat "${CREDENTIALS_DIRECTORY}/falcon-password" | /usr/local/bin/pyde validator \
    --keypair /var/lib/pyde/libp2p.kp \
    --falcon-keypair /etc/pyde/falcon.keypair \
    --falcon-password-stdin \
    --consensus-store-path /var/lib/pyde/data \
    --genesis /etc/pyde/genesis.toml \
    --bootnodes /etc/pyde/bootnodes.txt \
    --listen /ip4/0.0.0.0/tcp/30303 \
    --rpc-listen 127.0.0.1:9933 \
    --falcon-beacon'

# Logging — to journald, structured.
StandardOutput=journal
StandardError=journal
SyslogIdentifier=pyde-validator

# Restart policy — chain bugs that crash hard should self-recover.
# But back off enough that a tight crash loop doesn't churn the log + the chain.
Restart=on-failure
RestartSec=10
StartLimitIntervalSec=300
StartLimitBurst=5

[Install]
WantedBy=multi-user.target
EOF
```

If you chose plain-file password (option b), replace the `LoadCredentialEncrypted` + the `cat "${CREDENTIALS_DIRECTORY}/…"` invocation with:

```text
ExecStart=/bin/bash -c 'cat /etc/pyde/falcon-password | /usr/local/bin/pyde validator …'
```

Also install the binary to a system path so the unit's absolute path resolves:

```bash
sudo cp ~/.pyde/bin/pyde /usr/local/bin/pyde
sudo chown root:root /usr/local/bin/pyde
sudo chmod 755 /usr/local/bin/pyde
```

### Start the service

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pyde-validator
sudo systemctl status pyde-validator
```

Check logs:

```bash
sudo journalctl -u pyde-validator -f
```

You should see the validator-boot banner, then wave-commit lines flowing.

---

## 2. Set up monitoring

The validator exposes a Prometheus `/metrics` endpoint on the same RPC port (`127.0.0.1:9933/metrics`). Scrape it from a Prometheus instance — run one on the same host or on an adjacent monitoring server.

### Minimal Prometheus scrape config

```yaml
# /etc/prometheus/prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'pyde-validator'
    metrics_path: '/metrics'
    static_configs:
      - targets: ['127.0.0.1:9933']
        labels:
          validator: 'mainnet-1'   # adjust per your operator identity
```

The validator exposes ~40 counters covering vertex flow, batch flow, mempool flow, wave-commit progress, beacon assembly, finality, slashing-consumer outcomes, DKG attestations, and the receipt-gossip + wave-commit-gossip pipelines. See the [Companion Spec on metrics](../companion/METRICS_REFERENCE.md) for the full enumeration.

### Grafana dashboards

JSON dashboard templates ship at `pyde-net/test-releases:engine/grafana/`. Import via Grafana's UI (Dashboards → Import → upload JSON). The templates cover:

- **Validator health**: vertex production rate, wave-commit cadence, mempool depth, gossipsub mesh size.
- **Consensus participation**: DKG attestations sent/received, beacon shares emitted/combined, state-root sigs.
- **Operational counters**: RPC request rate, restart count, disk usage.

### Alerting: the chain-halt signal

The single most important alert: **`waves_committed` stops climbing**. If your validator's wave counter hasn't ticked in 2 minutes, the chain has halted (or your node is silently behind) and someone needs eyes on it.

Prometheus alert rule:

```yaml
# /etc/prometheus/rules/pyde-validator.yml
groups:
  - name: pyde-validator
    rules:
      - alert: PydeChainHalted
        expr: increase(pyde_node_waves_committed_total[2m]) == 0
        for: 2m
        labels:
          severity: page
        annotations:
          summary: "Pyde chain halt — wave_id frozen on {{ $labels.validator }}"
          description: |
            The validator's waves_committed counter has not advanced in 2 minutes.
            Investigate: is the local validator alive? Is the network reaching consensus?
            Runbook: https://book.pyde.network/companion/CHAIN_HALT.html

      - alert: PydeSlashFailureDetected
        expr: increase(pyde_node_dkg_participation_failures_detected_total[1h]) > 0
        for: 5m
        labels:
          severity: warn
        annotations:
          summary: "DKG participation failure — slash candidate on {{ $labels.validator }}"
          description: |
            The DKG participation detector has registered a participation failure.
            You may be missing DKG attestation submissions; this leads to slashing.

      - alert: PydeMempoolBackpressure
        expr: pyde_node_mempool_txs_received_total - pyde_node_mempool_txs_persisted_total > 1000
        for: 5m
        labels:
          severity: warn
        annotations:
          summary: "Mempool backpressure on {{ $labels.validator }}"
          description: |
            The mempool is admitting more txs than it persists. Check disk i/o,
            consensus-store growth, or mempool capacity tuning.
```

Wire the alerts to whatever paging system you have (PagerDuty, OpsGenie, ntfy, an SMS bridge, a Discord webhook — the SR side is the same).

---

## 3. Log rotation

systemd's journald handles rotation by default — the journal file caps at ~10% of disk space and the oldest entries get evicted. Tune the cap if you want shorter retention:

```bash
sudo sed -i 's/^#SystemMaxUse=.*/SystemMaxUse=2G/' /etc/systemd/journald.conf
sudo systemctl restart systemd-journald
```

If you want plain log files (for shipping to an external log aggregator), redirect `StandardOutput=` in the service unit to a file:

```text
StandardOutput=append:/var/log/pyde/validator.log
StandardError=append:/var/log/pyde/validator.log
```

Then ship via `logrotate`:

```bash
sudo tee /etc/logrotate.d/pyde-validator >/dev/null <<'EOF'
/var/log/pyde/validator.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0640 pyde pyde
    sharedscripts
    postrotate
        systemctl kill --signal=USR1 pyde-validator.service 2>/dev/null || true
    endscript
}
EOF
```

The `kill -USR1` is a no-op for `pyde validator` today (it reads `stderr` directly), but the rotation works regardless because `logrotate` truncates atomically with `copytruncate` if needed.

---

## 4. FALCON keypair lifecycle

Your FALCON keypair is the single secret controlling your validator's stake. Treat it the way you'd treat a hardware-wallet seed.

### At-rest encryption

The keypair file is encrypted with Argon2id + ChaCha20-Poly1305 — the password you supplied to `pyde keys generate --password-stdin`. Without the password the file is opaque.

### Backups

The 32-byte FALCON seed is recoverable from any byte-identical copy of the keypair file. Back it up:

```bash
# Encrypted backup on offline storage (USB drive, paper key, etc.)
sudo cp /etc/pyde/falcon.keypair /mnt/usb/pyde-validator-backup.keypair
```

Test the backup by loading it in a sandbox:

```bash
pyde keys inspect /mnt/usb/pyde-validator-backup.keypair
# Should print the same pubkey + address as your live keypair
```

### Rotation

When you rotate the FALCON key (compromise scare, scheduled rotation, etc.), generate the new keypair off-validator + submit a `RotateValidatorKeys` tx signed by the OLD key:

```bash
pyde keys generate --out ./falcon-new.keypair --password-stdin <<< 'new-passphrase'
pyde stake rotate \
  --rpc http://127.0.0.1:9933 \
  --falcon-keypair /etc/pyde/falcon.keypair --falcon-password-stdin \
  --new-pubkey-from ./falcon-new.keypair \
  <<< 'old-passphrase'
```

After the tx confirms (a few wave commits), swap the new keypair into place:

```bash
sudo systemctl stop pyde-validator
sudo mv /etc/pyde/falcon.keypair /etc/pyde/falcon.keypair.old
sudo cp ./falcon-new.keypair /etc/pyde/falcon.keypair
sudo chown root:pyde /etc/pyde/falcon.keypair
sudo chmod 640 /etc/pyde/falcon.keypair
# Re-encrypt the password credential with the new passphrase
sudo systemd-creds encrypt --name=falcon-password - /etc/pyde/falcon-password.cred <<< 'new-passphrase'
sudo systemctl start pyde-validator
```

The `.old` file can be archived for incident-response purposes, then securely destroyed.

### Compromise recovery

If you believe the FALCON keypair is compromised, **rotate immediately** as above; the rotation tx is signed by the old key so an attacker with the same key COULD also rotate. The race is yours to win.

If you've already lost custody (the attacker submitted a `RotateValidatorKeys` first), your stake is gone — there's no recovery once the chain accepts a new pubkey. This is the same trust model as any FALCON-secured chain.

---

## 5. Disk planning

Pyde stores three growing artifacts on disk:

- **`consensus_store`**: receipts, txs, wave-commit records. Grows monotonically. ~2 GB/week at testnet cadence; pruning is a v2 feature.
- **`state_store`**: JMT slots, account blobs, events. Also monotonic until pruning lands. ~1 GB/week.
- **`/var/log/pyde`** + journald: bounded by the rotation / journald cap above.

Plan for **~50 GB free disk** at minimum for a 3-month testnet operation. SSD strongly recommended — RocksDB's write amplification hits spinning rust hard.

---

## 6. Firewall config

The validator needs:

- **Inbound TCP 30303** (or your `--listen` port): peers dial you here.
- **Outbound TCP 30303 to bootnodes + peers**: `pyde validator` initiates the gossipsub mesh.
- **Outbound HTTPS to your state-sync source** (first boot only — for the snapshot fetch).

RPC (`127.0.0.1:9933`) stays loopback. **Never expose RPC publicly** without a TLS-terminating reverse proxy + per-method auth — v1 RPC has no auth and accepts `pyde_sendRawTransaction` from any caller.

Sample `ufw`:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp                  # SSH
sudo ufw allow 30303/tcp               # libp2p
sudo ufw enable
```

If you front the RPC behind nginx for monitoring access from an adjacent host, terminate TLS + add a `proxy_pass` for `/metrics` only.

---

## Where to go next

- [Quickstart Step 7: Day-2 ops surface](quickstart.md#7-day-2-ops) for the `pyde stake` subcommand reference.
- The [Chain Halt & Recovery companion spec](../companion/CHAIN_HALT.md) for what to do when alerts fire.
- The [Slashing companion spec](../companion/SLASHING.md) for the full enumeration of slashable offenses + how to avoid them.
