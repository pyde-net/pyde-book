# Pyde Failure Scenarios

**Version 0.1**

Operational walk-throughs of failure modes. Complements [THREAT_MODEL.md](./THREAT_MODEL.md) (what attacks exist) with step-by-step recovery procedures.

## General Incident Response Timeline

```
T+0:00  Detection (auto or manual)
T+0:05  On-call notified
T+0:15  Triage call initiated
T+0:30  Initial incident page published
T+1:00  Root cause investigation begins
T+6:00  Recovery plan proposed
T+24:00 Recovery executed (straightforward cases)
T+72:00 Resolution + initial post-mortem
T+7d    Full public post-mortem published
T+30d   Drill that scenario in testnet
```

## Communication Protocol

- **Authoritative source:** foundation incident page + Discord #incidents
- **Status page:** pyde.network/status (always updated)
- **Validator coordination:** private email list + dedicated Discord channel
- **Public:** Twitter/X status updates every 30 min during active incident

## The 12 Scenarios

### Scenario 1: Single Validator Offline (Hardware Failure)

- **Trigger:** Validator's server crashes (disk, power, etc.)
- **Detection:** Auto-detected within 2 rounds (no vertex from validator)
- **Initial Response:** None needed; other 127 continue normally
- **Investigation:** Operator diagnoses (off-chain)
- **Recovery:** Operator replaces hardware, runs state sync, resumes
- **Time to Recovery:** 4-24 hours
- **Slashing:** Downtime accumulates (~0.05%/round)
- **Drill Frequency:** Quarterly

### Scenario 2: Validator Key Compromise

- **Trigger:** Operator's key stolen (phishing, server intrusion)
- **Detection:** Unusual signing patterns OR operator reports
- **Initial Response:**
  - Operator: rotate to new key immediately
  - Foundation: investigate scope
  - Other validators: monitor for collusion
- **Investigation:** Forensic analysis, attribution if possible
- **Recovery:** Key rotation, possibly fresh validator slot if old one slashed
- **Time to Recovery:** 1-7 days
- **Slashing:** Whatever the attacker did with the key
- **Lessons:** HSM strongly recommended; key rotation procedures documented
- **Drill Frequency:** Annual paper drill

### Scenario 3: Network Partition (30% Split for 1 Hour)

- **Trigger:** BGP routing issue, undersea cable cut, ISP outage
- **Detection:**
  - Active committee count drops below 85 (quorum threshold = 2f+1, f=42)
  - Soft stall triggered automatically
  - Downtime slashing PAUSES (partition-aware)
- **Initial Response:**
  - Validators in majority partition: keep producing vertices
  - Validators in minority: cannot reach quorum, stall
  - No coordination needed (automatic handling)
- **Investigation:** Root cause analysis (network team)
- **Recovery:**
  - Network heals
  - Minority validators rejoin gossip
  - DAG resynchronizes
  - Slashing resumes
- **Time to Recovery:** Hours (depends on network)
- **Slashing:** None during partition (partition-aware pause)
- **Drill Frequency:** Quarterly (simulate in testnet)

### Scenario 4: State Root Divergence Detected

- **Trigger:** Bug in WASM execution layer or non-determinism
- **Detection:** Auto: 2+ validators sign contradictory state roots for same commit → hard halt
- **Initial Response:**
  - All validators halt
  - Forensic state preserved
  - Incident page published
- **Investigation:**
  - Identify which validators signed which root
  - Determine which root is "correct"
  - Identify bug causing divergence
  - 6-24 hours
- **Recovery:**
  - Patch the bug
  - Validators update software
  - Roll back to last consistent commit (within 1-epoch window)
  - Resume from rolled-back state
  - Slash validators who signed wrong roots
- **Time to Recovery:** 24-72 hours
- **Slashing:** Bad-state-root-sig (~10%) to validators on wrong fork
- **Lessons:** WASM execution determinism testing must improve; add new test cases
- **Drill Frequency:** Quarterly (inject in testnet)

### Scenario 5: DKG Ceremony Fails Repeatedly

- **Trigger:**
  - Several committee members go offline mid-DKG
  - DKG round 3 messages don't reach validators
  - Bug in DKG implementation
- **Detection:** DKG round 4 verification fails for >3 consecutive attempts → partial halt (encryption disabled for this epoch)
- **Initial Response:**
  - Identify which members not contributing valid shares
  - Decide: retry vs. continue without encryption
- **Investigation:**
  - Per-member: offline, buggy, or malicious?
  - Network issues vs. software bug
- **Recovery (options):**
  - A: Retry DKG with backup committee members
  - B: Continue without encryption for this epoch
  - C: Replace problematic members from the validators-awaiting-selection pool
- **Time to Recovery:** Same epoch (~3 hours) or next epoch
- **Slashing:** DKG-failure for non-contributors (~5%)
- **Drill Frequency:** Annual

### Scenario 6: Critical Execution Layer Bug (Off-Chain Disclosure)

- **Trigger:** Security researcher reports vulnerability via responsible disclosure
- **Detection:** Email to `security@pyde.network`
- **Initial Response:**
  - Within 1 hour: foundation reviews + confirms severity
  - If critical + active exploit risk: emergency halt via multisig
  - If critical + no immediate risk: 24-72 hour disclosure window
- **Investigation:**
  - Reproduce the bug
  - Develop patch
  - Test patch
  - Coordinate validator updates
- **Recovery:**
  - All validators update software simultaneously
  - Coordinated restart if needed
  - Public disclosure + acknowledgment + bounty payment
- **Time to Recovery:** 24-72 hours
- **Slashing:** None (no on-chain offense)
- **Lessons:** Strong bug bounty program; clear disclosure policy
- **Drill Frequency:** Annual paper drill

### Scenario 7: Active Exploit Being Used

- **Trigger:** Foundation observes attacker draining funds
- **Detection:** On-chain monitoring tools, validator reports
- **Initial Response:** Emergency halt within 15 minutes via multisig
- **Investigation:**
  - Identify exploit mechanism (fast)
  - Calculate scope of damage
  - Identify attacker addresses if possible
- **Recovery:**
  - Patch the exploit
  - Validator update
  - Rollback if within 1-epoch window (controversial)
  - OR resume without rollback (user funds lost)
  - Compensation plan from treasury if available
- **Time to Recovery:** 24-72 hours
- **Slashing:** None (off-chain attack)
- **Lessons:** Better monitoring; multisig response speed critical
- **Drill Frequency:** Annual simulated

### Scenario 8: Foundation Multisig Key Lost / Compromised

- **Trigger:** Holder loses key (HW failure) OR key stolen
- **Detection:** Holder reports loss OR unusual multisig activity observed
- **Initial Response:**
  - Lost: holder coordinates with other multisig members for replacement
  - Stolen: investigate scope, secure remaining keys
- **Investigation:** Verify identity of remaining holders; forensic if stolen
- **Recovery:**
  - Replace lost/compromised key via multisig vote
  - May need genesis-update if all keys at risk
  - Update on-chain multisig configuration
- **Time to Recovery:** Days to weeks
- **Slashing:** None (operational)
- **Lessons:** Diverse holders, geographic distribution, HSM
- **Drill Frequency:** Annual paper drill

### Scenario 9: Major Cloud Provider Outage (AWS us-east-1)

- **Trigger:** Cloud provider region outage
- **Detection:** 30-60% of validators in that region go offline
- **Initial Response:** Validators outside affected region continue if quorum maintained
- **Investigation:** Identify cause (provider's issue, not Pyde's)
- **Recovery:**
  - Cloud provider recovers
  - Validators come back online
  - Network catches up
  - Slashing PAUSED during partition
- **Time to Recovery:** Hours (depends on provider)
- **Slashing:** None (partition-aware)
- **Lessons:** Validator diversity matters; encourage multi-provider, multi-region
- **Drill Frequency:** Quarterly multi-region resilience test

### Scenario 10: Coordinated 43-Validator Attack

- **Trigger:** 43 validators coordinate to attack (offline or equivocate)
- **Detection:** Real-time monitoring shows coordinated behavior
- **Initial Response:**
  - 43 offline: stall (auto), need governance to remove if persistent
  - 43 equivocating: massive slashing events
- **Investigation:** Identify coordinator; collect cryptographic evidence
- **Recovery:**
  - 43 offline: emergency halt + governance removal
  - 43 equivocating: slash all 43 (correlation multiplier = 2× → full bond)
  - Network resumes with remaining 85+ honest
- **Time to Recovery:** 24-72 hours
- **Slashing:** Up to 100% × 43 validators (correlation max)
- **Lessons:** This is the BFT boundary; design defends but at cost
- **Drill Frequency:** Annual paper-only (too disruptive for testnet)

### Scenario 11: Memory Leak Causing Rolling Restarts

- **Trigger:** Bug causes validator memory to grow unbounded
- **Detection:**
  - Operator notices RSS growing
  - Performance dashboards show abnormal memory
  - OOM crashes
- **Initial Response:**
  - Identify affected validators
  - Restart affected (each)
- **Investigation:**
  - Heap profiling
  - Identify leaked structure
  - Patch the bug
- **Recovery:**
  - Software update
  - Rolling restart (not simultaneous)
- **Time to Recovery:** Hours to days
- **Slashing:** Downtime for extended restarts
- **Lessons:** Better memory profiling, soak testing
- **Drill Frequency:** Continuous (every soak test)

### Scenario 12: Genesis State Inconsistency Discovered

- **Trigger:** After mainnet launch, discrepancy found in genesis state
- **Detection:** Foundation review, validator report
- **Initial Response:**
  - Determine if functional or cosmetic
  - If functional: emergency halt
- **Investigation:**
  - Identify cause (founder error, hardcoded discrepancy)
  - Calculate impact
- **Recovery:**
  - Cosmetic: file a note, no action
  - Functional: hard fork required (re-genesis or state correction)
- **Time to Recovery:** Days to weeks (hard fork is coordination-heavy)
- **Slashing:** None (genesis issue)
- **Lessons:** Genesis review must be thorough; multiple parties verify
- **Drill Frequency:** Pre-launch paper review only (irreversible post-launch)

## Generalized Lessons

| Pattern | Recommendation |
|---|---|
| Multiple validators affected together | Encourage geographic + provider + ISP diversity |
| Operational mistakes | HSM, multisig for critical ops, runbooks |
| Software bugs | Bug bounty, formal verification, extensive testing |
| Network issues | Partition-aware slashing, sentry nodes, diverse routes |
| Time to recovery | Pre-rehearsed drills > improvising under pressure |

## Runbook Library Structure

Each scenario should have a written runbook:

```
runbooks/
├── 01-validator-offline-single.md
├── 02-validator-key-compromise.md
├── 03-network-partition.md
├── 04-state-root-divergence.md
├── 05-dkg-failure.md
├── 06-execution-bug-disclosed.md
├── 07-active-exploit.md
├── 08-multisig-key-event.md
├── 09-cloud-provider-outage.md
├── 10-coordinated-attack.md
├── 11-memory-leak.md
├── 12-genesis-discrepancy.md
└── README.md (decision tree → which runbook)
```

Each runbook contains: trigger conditions, detection criteria, step-by-step response (commands to run, calls to make), recovery procedures, escalation paths, communication templates, post-incident checklist.

## Drill Schedule

| Drill | Frequency | Format |
|---|---|---|
| Validator restart | Quarterly | Live (testnet) |
| Network partition | Quarterly | Live (testnet) |
| State root divergence | Quarterly | Live (testnet, injection) |
| DKG failure | Annual | Live (testnet) |
| Active exploit | Annual | Simulated |
| Coordinated attack | Annual | Paper only |
| Key compromise | Annual | Paper only |
| Multisig key event | Annual | Paper only |
| Genesis discrepancy | Pre-launch only | Paper review |
| Cloud outage | Quarterly | Live (testnet, region isolation) |

**Track every drill:** time-to-detect, time-to-respond, time-to-recover. Improve runbooks based on observed gaps.

## Integration with Other Documents

- Threat model: see [THREAT_MODEL.md](./THREAT_MODEL.md) for the "what could attack us"
- Chain halt: see [CHAIN_HALT.md](./CHAIN_HALT.md) for halt mechanics
- Performance harness: see [PERFORMANCE_HARNESS.md](./PERFORMANCE_HARNESS.md) for chaos testing infrastructure
- Slashing: see [SLASHING.md](./SLASHING.md) for slashing details

---

**Document version:** 0.1

**License:** See repository root
