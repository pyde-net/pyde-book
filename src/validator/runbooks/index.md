# Runbook Index

When a Pyde alert fires at 3 a.m., the operator should not be reading 600 lines of design prose. Each runbook here is one symptom, one first check, one decision tree, one recovery, one verification. They're meant to be grep'd by the words in your alert.

The corresponding strategic / paper-drill walk-throughs live in [companion/FAILURE_SCENARIOS.md](../../companion/FAILURE_SCENARIOS.md). This index is the operator's side.

## When to use which runbook

```text
                             ┌────────────────────────────┐
                             │ Alert fires / user reports │
                             └─────────────┬──────────────┘
                                           │
                       ┌───────────────────┼──────────────────────────┐
                       │                   │                          │
              "chain not advancing"   "single host broken"     "downstream broken"
                       │                   │                          │
                       ▼                   ▼                          ▼
              ┌────────────────┐  ┌─────────────────┐       ┌─────────────────┐
              │  chain-halted  │  │ validator-OOM   │       │ explorer-       │
              └────────┬───────┘  │ validator-disk- │       │ indexer-behind  │
                       │          │   full          │       │ postgres-       │
              splits to specific  │ bootnode-down   │       │   corruption    │
              sub-runbooks below: │                 │       │ faucet-out-of-  │
                                  └─────────────────┘       │   funds         │
                                                            │ public-rpc-DDoS │
                                                            └─────────────────┘
              ┌──────────────────────────────────────┐
              │ state-root-divergence-detected       │
              │ epoch-handover-wedge                 │
              │ state-sync-mismatch                  │
              │ private-key-leak                     │
              └──────────────────────────────────────┘
```

## The 12 runbooks

### Consensus-layer (chain stops or forks)

| Runbook | Symptom you'd grep | Severity |
|---|---|---|
| [chain-halted](chain-halted.md) | `PydeChainHalted` alert, `waves_committed` flat across all validators, `pyde_waveId` stuck | P0 |
| [state-root-divergence-detected](state-root-divergence-detected.md) | `state_root mismatch at wave_id`, split state-root sigs | P0 |
| [epoch-handover-wedge](epoch-handover-wedge.md) | `epoch handover blocked`, `waves_remaining == 0`, `pyde_getBeacon.source == pending` | P0 |
| [state-sync-mismatch](state-sync-mismatch.md) | `state_sync: applied snapshot ... does not match committee root` | P1 (per-node) |

### Host-layer (one validator broken)

| Runbook | Symptom you'd grep | Severity |
|---|---|---|
| [validator-OOM](validator-OOM.md) | `Killed`, `out of memory`, `dmesg` OOM-kill of `pyde validator` | P1 |
| [validator-disk-full](validator-disk-full.md) | `df` >95%, `rocksdb: write stalled`, `No space left on device` | P1 |
| [bootnode-down](bootnode-down.md) | new node `failed to dial bootnode`, `bootnode-N:30303` timeout | P2 |

### Network edge (validators OK but users see breakage)

| Runbook | Symptom you'd grep | Severity |
|---|---|---|
| [public-rpc-DDoS](public-rpc-DDoS.md) | `429 Too Many Requests` flood, `rpc_request_rate` spike, single-source traffic | P1 |
| [faucet-out-of-funds](faucet-out-of-funds.md) | faucet returns `faucet out of funds`, `insufficient balance` on tx submission | P1 |

### Off-chain services (explorer / indexer)

| Runbook | Symptom you'd grep | Severity |
|---|---|---|
| [explorer-indexer-behind](explorer-indexer-behind.md) | `Indexer lag: N waves`, `RecvError::Lagged`, `falling behind: head=W indexer=W-100` | P2 |
| [postgres-corruption](postgres-corruption.md) | `invalid page`, `PANIC: could not locate a valid checkpoint`, 500s on `/api/*` | P1 |

### Security incidents

| Runbook | Symptom you'd grep | Severity |
|---|---|---|
| [private-key-leak](private-key-leak.md) | leaked FALCON keypair, unauthorised `RotateValidatorKeys`, treasury balance dropping | P0 |

## Conventions

Every runbook has six sections:

1. **Symptom** — the literal log lines, dashboard panels, and pager alerts an operator sees first.
2. **First check** — one curl / one grep / one `df` that confirms you're in the right runbook. Don't trust the alert; verify.
3. **Triage decision tree** — 3-5 yes/no branches. Each branch routes either to a fix or to another runbook.
4. **Recovery** — exact commands. No prose. Copy-paste-able.
5. **Verify recovery** — one curl + one query. If both green, you're done.
6. **Post-mortem template** — empty fields the operator fills in before closing the incident.

## Drill schedule

Pull from [companion/FAILURE_SCENARIOS.md](../../companion/FAILURE_SCENARIOS.md) — runbook drills run on the cadence defined there. Specifically for testnet launch this week, prioritise drills for:

- **chain-halted** (quarterly live)
- **state-root-divergence-detected** (quarterly live, inject in testnet)
- **epoch-handover-wedge** (live every soak: drop one validator mid-epoch)
- **public-rpc-DDoS** (quarterly live: hammer your own RPC from a separate VM)
- **explorer-indexer-behind** (continuous: every soak)

The other runbooks drill annually or paper-only — they're rarer and lower frequency.
