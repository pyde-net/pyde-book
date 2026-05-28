# Pyde Performance Harness

**Version 0.1**

The gate before any external TPS claim. This is testing infrastructure that protects against the HotStuff trap: claimed numbers production cannot reproduce.

## Why

Pyde's pre-pivot HotStuff implementation hit ~4K TPS in practice despite claims of higher. The lesson: **lab benchmarks ≠ production**. Performance harness is what prevents repeat.

**All Pyde TPS claims must come from harness output, never from microbenchmarks or local devnet measurements.**

## Goals

1. **Reproducibly measure** end-to-end performance under realistic conditions
2. **Detect regressions** automatically on code changes
3. **Validate claims** before they're published externally
4. **Find limits** before they bite in production
5. **Generate audit trail** of "this is how we know X is true"

## Architecture

```
pyde-bench/
├── topology/            # Network topology configurations
│   ├── single_region.toml   (8-16 validators, same DC)
│   ├── multi_region.toml    (3 regions, geographic distribution)
│   └── production_sim.toml  (full 128 validators, 3+ regions)
├── workloads/           # Workload generators
│   ├── transfers.rs         (simple PYDE transfers)
│   ├── contract_calls.rs    (WASM contract interactions)
│   ├── encrypted_swaps.rs   (Kyber-encrypted, MEV-sensitive)
│   ├── nft_mint_burst.rs    (burst pattern simulation)
│   └── mixed.rs             (realistic distribution)
├── metrics/             # Metrics collection + reporting
│   ├── collector.rs         (per-validator scraping)
│   ├── prometheus.rs        (export to Prometheus/Grafana)
│   └── reporter.rs          (markdown/HTML reports)
├── chaos/               # Chaos engineering
│   ├── validator_kill.rs    (random validator restarts)
│   ├── network_partition.rs (split-brain testing)
│   ├── slow_peer.rs         (latency injection)
│   └── adversarial.rs       (bad-actor behaviors)
├── soak/                # Long-duration test runners
└── reports/             # Output formats
```

## Test Topologies

| Topology | Validators | Regions | Use |
|---|---|---|---|
| Local devnet | 4 | 1 (localhost) | Smoke tests, dev iteration |
| Single-region testnet | 16 | 1 (single datacenter) | Component testing |
| **Multi-region testnet** | 16-32 | 3 (US, EU, APAC) | **Realistic perf testing** |
| Production-sim | 128 | 4+ (global) | Pre-mainnet validation |

**Multi-region requirement is critical.** Pre-pivot HotStuff testing was likely localhost or single-DC. Real conditions include:
- 50-200ms RTT between regions
- 1-3% packet loss occasionally
- Bandwidth variation
- Time clock skew

Cloud provider matrix for production-sim:
- AWS (us-east-1, eu-west-1, ap-southeast-1)
- GCP (us-central, europe-west, asia-east)
- Hetzner / Vultr / OVH (cost-optimized)
- Mix providers for cross-provider scenarios

## Workload Generators

```rust
trait Workload {
    fn generate_tx(&mut self, ctx: &Context) -> Tx;
    fn target_tps(&self) -> u64;
    fn distribution(&self) -> &Distribution;
}
```

Concrete workloads:
- **TransferWorkload:** simple A→B transfers; baseline
- **ContractWorkload:** realistic WASM contract interactions
- **EncryptedSwapWorkload:** ~80% encrypted (worst-case for decryption)
- **NFTMintBurstWorkload:** ramps from idle to a high burst and back over 60s
- **MixedWorkload:** 70% transfers / 15% contracts / 10% encrypted / 5% complex

**Workload realism:**
- Real FALCON sig generation (not pre-computed)
- Real Kyber encryption (not pre-computed)
- Variable tx sizes (not all minimum)
- Account hot-spotting (some accounts get more traffic — tests parallel execution)

## Metrics Collected (Continuous)

### TPS Metrics
- `tps_sustained` — average over last 60s
- `tps_burst` — peak sustained over 10s
- `tps_pending` — txs in mempool / queued

### Latency Metrics (Percentiles p50, p90, p99, p99.9)
- `tx_submission_to_finality` — end-to-end
- `tx_in_batch_latency` — submit → in batch
- `batch_to_vertex_latency` — batch → referenced by vertex
- `vertex_to_commit_latency` — vertex → commit
- `commit_to_execution_latency` — commit → wasmtime executed
- `decryption_ceremony_latency` — start partial → ≥85 received

### Consensus Metrics
- `round_advance_rate` — rounds/sec per validator
- `vertex_certification_rate` — % of vertices that get 85+ certs
- `commit_success_rate` — % of rounds where commit fires
- `anchor_selection_success_rate` — % of anchors that have valid vertex

### Resource Utilization (Per Validator)
- `cpu_usage_pct` — total CPU
- `cpu_per_subsystem` — consensus / wasmtime / network / IO
- `memory_resident_mb` / `memory_heap_mb`
- `disk_read_iops` / `disk_write_iops` / `disk_used_gb`
- `network_in_mbps` / `network_out_mbps`
- `open_file_descriptors` / `tcp_connections`

### State Metrics
- `jmt_depth_max` / `jmt_depth_avg`
- `state_root_compute_ms` (per commit)
- `state_growth_per_hour_mb`

### Network Metrics
- `peer_count`
- `peer_score_distribution`
- `messages_per_second` (by type)
- `bandwidth_per_message_type`
- `failed_message_rate`

### Validator-Specific
- `slashing_events_per_epoch`
- `dkg_ceremony_time_ms`
- `epoch_transition_time_ms`

## Soak Test Schedule

| Test | Duration | Frequency |
|---|---|---|
| **Smoke** | 5 min | Every commit (CI) |
| Short soak | 1 hour | Daily |
| **Standard soak** | 4 hours | Weekly |
| Extended soak | 24 hours | Pre-release |
| **Pre-launch soak** | 7 days | Before mainnet only |

Pass criteria for soak:
- TPS within 5% of starting value over 4 hours
- p99 latency within 20% of starting value
- Memory growth < 100 MB/hour (excluding state)
- No consensus stalls > 5 seconds
- No new "halt" events (other than scripted chaos)

## Chaos Scenarios

```rust
trait ChaosScenario {
    fn name(&self) -> &str;
    fn execute(&self, network: &mut TestNetwork) -> ChaosResult;
}
```

- **ValidatorRestart:** random validator restarts every 5 min
- **NetworkPartition:** split 30% of validators for 5 min
- **SlowPeer:** inject 500ms latency on some peers
- **BadActor:** validator equivocates, sends bad sigs, attacks
- **BandwidthConstraint:** cap one validator at 100 Mbps
- **ClockSkew:** skew validator clocks by up to 5s

## Mandatory Pre-Mainnet Tests

All must pass with publishable evidence before any TPS claim:

| Test | Pass Criteria |
|---|---|
| Steady-state at v1 target | 4 hours at the v1 throughput target, p99 <1s, no stalls |
| Burst above target | 60s burst absorbed, queue drains in 5 min |
| Validator restart loop | 24h with restarts every 5 min, no stall |
| Network partition | 30% partition for 5 min, both recover, no fork |
| DKG under load | Epoch transition at the v1 throughput target, no commit stall |
| State sync under load | New node joins under sustained load, syncs in <1 hour |
| Slashing under load | Equivocation slashed within 1 epoch |
| 7-day soak | Sustained load for 7 days, no memory leak, no drift |
| Encrypted tx mix | 30% encrypted at the v1 throughput target, decrypt latency <500ms |
| Modest hardware | Single committee validator on 1 Gbps, 8c/16GB |

## Honest Reporting Discipline

**The publishing discipline:**

- Publish only what the harness measures under sustained, production-realistic conditions.
- Never lab extrapolations, microbenchmark peaks, or single-machine numbers where multi-region is the relevant scope.
- Aspirational figures are labelled "production validation pending" and carry no concrete number.

**Publication format:**

> *"Pyde sustained [harness-measured] TPS over a 4-hour test on a 16-validator multi-region testnet (US-East, EU-West, AP-Southeast), with median finality of 480ms and p99 of 950ms. Workload: 70% transfers, 15% contract calls, 10% encrypted, 5% complex. Test methodology and raw data available at `pyde.network/perf/{run-id}`."*

Specific numbers, methodology referenced, reproducible. **NOT** "Pyde supports [huge number] TPS" with no caveats.

## Public Dashboard Structure

```
pyde.network/perf
├── Current Metrics
│   ├── Sustained TPS (last 7 days)
│   ├── p50, p99 latency
│   ├── Validator count + uptime
│   └── Test network conditions
├── Soak History
│   ├── 4h, 24h, 7d soak results
│   ├── Pass/fail per scenario
│   └── Regression trend lines
└── Methodology
    ├── Test topology
    ├── Workload composition
    ├── Hardware specs
    └── How to reproduce
```

## Build Effort

| Component | Effort |
|---|---|
| Basic harness skeleton + workload generators | ~2 weeks |
| Multi-region deployment automation | ~1 week |
| Metrics collection + Prometheus integration | ~1 week |
| Chaos testing scenarios | ~2 weeks |
| Long-duration soak runners | ~1 week |
| Reporting + dashboard | ~1 week |
| **Total minimum viable harness** | **~8 weeks of focused engineering** |

In practice, with competing priorities across the rest of the protocol, this sequences across a multi-month window rather than running back-to-back.

## Cloud Cost

- 16-validator multi-region testnet: ~$300/month sustained
- Pre-mainnet 128-validator production-sim: ~$2500/month
- Run as needed; don't keep production-sim running continuously

## The Key Principle

**Build harness BEFORE making any TPS claims externally.** The harness IS the evidence. Without it, claims are aspirational. With it, claims are defensible.

This is the HotStuff lesson. Don't skip.

## References

- Honest throughput targets: see [WHITEPAPER.md](./WHITEPAPER.md) §11
- Chaos integration with failure scenarios: see [FAILURE_SCENARIOS.md](./FAILURE_SCENARIOS.md)

---

**Document version:** 0.1

**License:** See repository root
