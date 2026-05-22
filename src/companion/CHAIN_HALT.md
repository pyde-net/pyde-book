# Pyde Chain Halt + Recovery Procedures

**Version 0.1**

The HotStuff lesson made operational: explicit halt detection → investigation → recovery procedures. No live-patching under pressure.

## Three Halt Types

| Type | Trigger | Severity | Authority | Recovery |
|---|---|---|---|---|
| **Soft stall** | Network/quorum issues | Liveness only | Emergent (any node detects) | Wait (auto-resume) |
| **Hard halt** | Detected inconsistency (state root divergence, equivocation cluster) | Safety risk | Protocol-detected automatic | Manual investigation |
| **Emergency halt** | Critical bug, active exploit, hard-fork prep | High intentional | Governance multisig (7-of-12) | Per-incident, max 30 days |

## Detection Mechanisms

### Soft Stall (Automatic)

- No commit for > 5 rounds (~1s expected, so 5s threshold)
- <85 vertices certified for last K rounds
- Active committee count drops below safety threshold (86)

**Response:** Validators enter "stall mode" — produce vertices, wait for quorum. Mempool keeps accepting txs (queued). Auto-recover when conditions improve.

### Hard Halt (Automatic)

- State root divergence detected (2+ signed contradictory roots for same commit)
- Equivocation cluster (10+ validators in single epoch)
- DKG output mismatch
- Execution layer critical invariant violation
- DAG fork detected (impossible per protocol, indicates bug)

**Response:** All validators stop producing vertices. All commits halted. Halt event broadcast. Forensic state preserved. Manual intervention required.

### Emergency Halt (Manual)

- Critical bug discovered (off-chain, e.g., security researcher)
- Active exploit being mitigated
- Hard-fork coordination needed
- State recovery from previous incident

**Response:** Governance multisig signs HaltMessage with timestamp + reason. Halt activated for max 30 days (constitutional limit).

## What Happens During Halt

| Activity | Soft Stall | Hard Halt | Emergency Halt |
|---|---|---|---|
| Vertex production | Continues (no quorum) | Stops | Stops |
| Commits | Paused | Paused | Paused |
| Tx submission | Accepted, queued | Accepted, queued | Accepted, queued |
| Decryption ceremonies | Paused | Stopped | Stopped |
| DKG ceremonies | Continues unless triggered | Stopped | Stopped |
| State queries | Continue | Continue (forensic) | Continue |
| **Slashing evidence acceptance** | **Continues** | **Continues** | **Continues** |
| Gossip | Continues | Continues | Continues |

**Key invariant:** slashing evidence accepted during halt. **Attackers cannot escape consequences by triggering a halt.**

## Investigation Procedure (Hard / Emergency)

```
Phase 1: Triage (within 1 hour)
  - Confirm halt type + trigger
  - Identify affected commits / validators
  - Snapshot forensic state (preserve)
  - Public incident report (initial)

Phase 2: Root Cause Analysis (within 6-24 hours)
  - Bug / attack / infrastructure failure?
  - Determine scope of impact
  - Coordinate with validator operators
  - Develop fix or recovery plan

Phase 3: Recovery Plan (within 24-72 hours)
  - Propose recovery strategy
  - Validate plan with multisig + community
  - Coordinate validator updates if needed
  - Schedule resume timing
```

## Recovery Procedures (5 Paths)

### 1. Wait It Out (Soft Stalls)

- Network/validator issues resolve naturally
- 85+ validators come back online
- Quorum forms, commits resume
- No intervention needed
- Typical: <30 minutes; >1 hour escalates

### 2. Software Update + Replay (Hard Halts from Bugs)

- Identify the deterministic bug causing state divergence
- Patch validator software
- Validators verify they're at consistent state
- Coordinate restart from last verified commit
- Replay txs from mempool

### 3. Rollback (Controversial, Severe Bugs)

- Roll back to last "clean" commit (max **1 epoch back** — 3 hours)
- Discard commits after rollback point
- Re-execute affected txs
- Apply slashing to bad actors
- **Limited window prevents catastrophic finality violations**

### 4. Hard Fork (Irreconcilable Issues)

- Manual coordination via governance multisig
- Agreement on canonical state
- All validators update software
- Resume from agreed genesis-of-new-fork state
- Old chain abandoned

### 5. Emergency Unhalt (False-Positive Halts)

- Investigation reveals no actual issue
- Multisig releases halt
- Resume normally

## Rollback Policy

**Bounded operational pragmatism:**

```
Maximum rollback window: 1 epoch (~3 hours)
Within window: governance multisig can authorize rollback
Beyond window: only hard fork (community coordination required)
```

Philosophy: weak finality with a sunset.
- Within 1 epoch: finality is "almost certain but reversible via emergency"
- After 1 epoch: finality is "irreversible without coordinated hard fork"

This is industry standard pattern (Solana de facto, Ethereum has emergency rollback procedures).

## State Reconciliation After Rollback

```
1. All validators agree on rollback target (commit C)
2. Validators roll back state to C
3. Commits after C are discarded
4. Txs in those commits returned to mempool (if still valid)
5. Slashing applied to validators who produced bad-state-root sigs
6. Software updates applied if needed
7. Resume normal operation from C
8. New canonical fork is the post-rollback chain
```

## Specific Scenario Playbooks

### Scenario A: State Root Divergence in Commit N

- Detection: 2+ validators signed contradictory roots for commit N
- Action: hard halt automatic
- Investigation: which validators? what tx caused? bug or attack?
- Recovery: identify cause, patch validators, rollback to N-1, resume
- Slashing: validators with wrong root get bad-state-root-sig slash (10%+)

### Scenario B: 43+ Committee Offline Simultaneously

- Detection: <85 quorum cannot form
- Action: soft stall
- Investigation: coordinated (attack) or correlated (datacenter outage)?
- Recovery: correlated → wait; coordinated → governance emergency halt to remove
- Slashing: extended downtime + possibly coordination evidence

### Scenario C: Critical Bug Discovered (Off-Chain)

- Detection: human report to foundation
- Action: emergency halt via multisig
- Investigation: assess exploit, develop patch
- Recovery: coordinate validator update, resume after patch
- Slashing: none (no on-chain evidence)

### Scenario D: DKG Ceremony Failed (Multiple Times)

- Detection: round 4 fails >3 consecutive
- Action: partial halt (encryption disabled for epoch)
- Investigation: which members not contributing? bug or attack?
- Recovery: rotate problematic members + retry DKG, OR continue without encryption
- Slashing: DKG-failure for non-participants

### Scenario E: Detected DAG Fork

- Detection: contradictory subdags after commit
- Action: hard halt (this should be impossible per protocol)
- Investigation: deep protocol bug
- Recovery: hard fork to canonical chain, coordinate community
- Slashing: equivocation slashing for forking actors

## Communication & Coordination

```
Halt detected → On-chain "ChainHalted" event emitted
              ↓
Validator dashboards display halt status
              ↓
Foundation publishes incident page (initial within 1 hour)
              ↓
Coordination channels active:
  - Discord/Telegram: real-time
  - Validator email list: critical comms
  - Twitter/X: public status
              ↓
Resolution proposed
              ↓
Multisig signs ResumeMessage when ready
              ↓
On-chain "ChainResumed" event
              ↓
Public post-mortem within 7 days
```

## Re-Entry After Halt

```
1. Multisig signals resume (or auto-resume for soft stalls)
2. Validators verify they're at consistent state
3. Mempool processes queued txs (validity re-checked against current state)
4. Commits resume normal cadence
5. Slashing evidence from halt period processed
6. System returns to normal operation
```

## Test Plan / Drills

**Mandatory before mainnet:**

1. **Soft stall drills:** deliberately offline 43 validators, verify recovery
2. **Hard halt drills:** inject state divergence, verify detection + flow
3. **Emergency halt drills:** practice multisig coordination
4. **Rollback drills:** practice 1-epoch rollback procedure
5. **Hard fork drills:** practice coordinated upgrade

**Frequency:** quarterly in testnet, annually in mainnet.

**Documentation:** runbooks for each scenario; updated after every drill.

## The HotStuff Lesson Applied

HotStuff broke under wedges/stalls because there was no clear halt → investigate → recover procedure. The team patched live, accumulating safety subtleties.

Pyde's design EXPLICITLY:
- Separates the three halt types
- Defines authority + procedure for each
- Builds drills into the operational plan

This is the lesson learned from the pivot.

## References

- Threat model: see [THREAT_MODEL.md](./THREAT_MODEL.md)
- Failure scenarios (operational walk-through): see [FAILURE_SCENARIOS.md](./FAILURE_SCENARIOS.md)
- Slashing: see [SLASHING.md](./SLASHING.md)

---

**Document version:** 0.1

**License:** See repository root
