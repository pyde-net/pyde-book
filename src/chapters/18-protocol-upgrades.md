# Chapter 18: Protocol Upgrades

Pyde's upgrade model is the same one Bitcoin and Ethereum use: a public
specification (PIPs), a reference implementation, and **voluntary
validator upgrade**. Validators choose whether to run a new release.
There is no on-chain governance switch that flips protocol rules without
that choice.

This chapter covers the upgrade process end to end: the PIP linkage, the
validator upgrade flow, hard-fork vs soft-fork distinctions, the
emergency pause as a separate mechanism, and the patterns for in-flight
state migrations.

---

## 18.1 Upgrade Categories

Different changes require different process weight.

| Category                                  | Example                                  | Process required                         |
| ----------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| Operational config update                 | Bootstrap node list, log level           | Operator-side; no PIP                    |
| Bug fix (no protocol change)              | Memory leak, RPC parse bug               | Code release; PIP not required           |
| Backward-compatible feature               | New opcode unused by existing contracts  | PIP + voluntary upgrade; no fork         |
| Backward-incompatible (hard fork)         | Gas cost change, new tx type semantics    | PIP + activation block + coordinated upgrade |
| Cryptographic primitive change            | Hash migration                            | PIP + multi-version overlap window        |
| Treasury action                           | Grant payout, audit funding              | PIP + on-chain `MultisigTx`              |
| Emergency response                        | Active exploit                           | `EmergencyPause` (multisig); fix; resume |

Each path has its own velocity. A bug fix can ship in days; a hash
migration takes months and dedicated audit time.

---

## 18.2 The Voluntary Upgrade Flow

For a typical hard-fork-grade change (e.g., adjusting a gas constant):

```
Step 1 — PIP draft
    Author writes the PIP, opens PR against zarah-s/pips, defines:
      - the change
      - the rationale
      - the activation block height (or activation epoch)
      - the test plan
      - backward compatibility implications

Step 2 — Discussion + acceptance
    Open review by core devs, validators, security team.
    PIP merges into pips repo with a final number.

Step 3 — Implementation
    Code change merged into the Pyde repo, referencing the PIP #.
    Ships in the next node release (e.g. v0.5.0).

Step 4 — Release announcement
    The release notes name the activation block.
    Typical activation window: weeks to months out, to give validators
    time to upgrade.

Step 5 — Validator upgrade
    Each validator operator updates their binary. They can do this as
    early as they want; the new code is dormant until activation block.

Step 6 — Activation
    At the named slot, every node running the new release starts using
    the new rule. Nodes still on the old release either:
      - Fork off (if the change is consensus-incompatible).
      - Stay in sync (if the change is backward-compatible).

Step 7 — Stable state
    After enough time, the upgrade is "settled" — old releases are
    deprecated, the network runs the new rule.
```

There is no on-chain "yes/no" vote. The closest signal is **what fraction
of the active committee runs the new code at activation**. If less than
2f+1 (86 of 128) validators upgrade, the new rule cannot reach finality
and the change is effectively rejected by the network.

This is governance through validator opt-in. It is slow and conservative
by design.

---

## 18.3 Hard Fork vs Soft Fork

### Hard fork (consensus-incompatible)

A hard fork is a change that nodes running the old rules cannot accept
under any circumstances — e.g., a new gas cost, a new transaction type
the old code doesn't recognize, a change to the encryption scheme.

For a hard fork:

- Activation block must be set well in advance.
- Validator coordination is required: at least 2f+1 must be on the new
  release at activation.
- Validators that don't upgrade fork off; their chain is the legacy
  version.
- Hard forks should be rare and well-justified.

### Soft fork (backward-compatible)

A soft fork tightens the rules — old nodes still accept the new rules
(they're a subset of what the old node would accept), but new nodes won't
accept blocks that violate the new rules.

For a soft fork:

- Activation can be more gradual; majority of validators on the new
  release is enough to enforce the new rule.
- Old validators stay in sync; they just don't enforce the new
  constraint themselves.
- Soft forks are the preferred path when possible.

### Simple non-fork

Changes that don't alter consensus semantics — e.g., a new RPC method, a
performance optimization, a logging fix — ship in regular releases without
any activation block. Operators upgrade at their own pace.

---

## 18.4 What Can and Can't Be Changed

### Hard-coded (require code release + PIP)

Per Chapter 15:

| Constant                       | Where                                |
| ------------------------------ | ------------------------------------ |
| DAG round period (~150 ms)     | `crates/consensus/src/round.rs`       |
| Wave commit target (~500 ms)   | `crates/consensus/src/wave.rs`        |
| Committee size (128)           | `crates/consensus/src/committee.rs`   |
| Quorum / threshold (85)        | `crates/consensus/src/quorum.rs`      |
| Equivocation threshold (44)    | `crates/consensus/src/quorum.rs`      |
| Committee min stake (10M PYDE) | `crates/slashing/src/lib.rs`          |
| Non-committee min stake (100K) | `crates/slashing/src/lib.rs`          |
| Unbonding period (14 days)     | `crates/consensus/src/validator.rs`   |
| Inflation schedule             | `crates/tx/src/fee.rs`                |
| Fee split (70/20/10)           | `crates/tx/src/execution.rs`          |
| Gas target / ceiling           | `crates/tx/src/fee.rs`                |
| Tx / calldata size limits      | `crates/tx/src/validation.rs`         |
| Max batch size (4 MB)          | `crates/mempool/src/batch.rs`         |
| Cryptographic primitives       | `crates/crypto/*` (FALCON, Kyber, Blake3, Poseidon2) |
| PVM ISA (62 opcodes)           | `crates/pvm/src/isa.rs`               |

Changing any of these requires a release + voluntary upgrade.

### On-chain (multisig-controlled)

| Item                  | Mechanism                                  |
| --------------------- | ------------------------------------------ |
| Treasury spend        | `MultisigTx` (type 9)                       |
| Multisig signer set   | `RotateMultisig` (type 10)                  |
| Emergency pause       | `EmergencyPause` (type 11)                  |
| Resume from pause     | `EmergencyResume` (type 12)                 |

These are bounded actions — drain treasury (with PIP linkage), rotate
signers, halt for ≤ 30 days, resume. They cannot change protocol rules.

### Operator-side

| Item                  | Lives in                                  |
| --------------------- | ----------------------------------------- |
| Bootstrap peer list   | `pyde.toml` `[network] bootstrap_peers`    |
| RPC endpoint config   | `pyde.toml` `[rpc]`                        |
| Log level / format    | `pyde.toml` `[logging]`                    |
| Metrics port          | `pyde.toml` `[metrics]`                    |
| Datadir location      | `pyde.toml` `[node] datadir`               |

Operators control these per-node; they don't require coordination.

---

## 18.5 Emergency Pause as Crisis Response

`EmergencyPause` (type 11) is **not** a normal upgrade mechanism — it's a
crisis-response tool. The signer set should be specifically chosen for
crisis response (core devs + security team), with a low threshold so a
quick response is possible.

Workflow during a live exploit:

```
t=0       Active exploit detected
t+5min    Security team confirms; emergency multisig assembles signatures
t+10min   EmergencyPause (duration: e.g., 24 hours) submitted on-chain
t+20min   Pause takes effect; chain halts non-Resume txs
t+1-24h   Fix developed, code-reviewed, audited, released
t+24h     EmergencyResume submitted; chain resumes
t+24h     Validator operators upgrade to the patched release
```

The 30-day max pause window (`MAX_PAUSE_DURATION_SLOTS`) is a hard
ceiling — no extension mechanism. If an issue genuinely requires longer
than 30 days to fix, the chain restarts via genesis adjustment plus
voluntary validator upgrade — a much heavier process designed for the
"this can't be fixed in one pause window" case.

---

## 18.6 State Migration Patterns

Changes that affect on-chain state require a migration plan. Three
common patterns:

### Pattern 1: Lazy migration

The old format remains valid; new code accepts both and writes the new
format on first touch.

```
Example: adding a new field to the Account struct.
  - Old encoding: 141 bytes
  - New encoding: 145 bytes (4 extra bytes for new_field)
  - Migration: nodes accept both; on any update to an account, write the
    new format.
  - Eventually all touched accounts are in the new format. Old untouched
    accounts stay in the old format until something writes them.
```

This works for additive changes that don't break existing readers.

### Pattern 2: Activation-block migration

A specific block height where the format flips. Before that block, old
format; after, new format.

```
Example: changing the canonical hash function (hypothetical).
  - Activation block N.
  - Pre-N: all hashes are Poseidon2.
  - Post-N: all hashes are NewHash2.
  - Old data continues to be read with Poseidon2 (matches its block height);
    new data uses NewHash2.
  - State proofs for pre-N data remain valid against pre-N state roots;
    post-N data uses post-N state roots.
```

This is heavyweight. It requires careful protocol-version tracking on
every state read.

### Pattern 3: Migration transaction

The migration is a tx that anyone can submit; it transforms specific
state in place.

```
Example: per-account vesting schedule format change.
  - PIP defines the migration transaction format.
  - During an upgrade window, anyone can submit MigrateVesting(account)
    transactions that re-write the schedule in the new format.
  - After a deadline, the old format is no longer accepted.
```

Useful when the migration is per-account or per-asset and can be done
gradually.

---

## 18.7 Versioning Discipline

The Pyde release cadence is **release-based, not block-based** — releases
ship when ready, not on a fixed schedule. Each release has a semver-style
version (e.g., `0.4.2`).

| Component                | Version source           |
| ------------------------ | ------------------------ |
| Node binary              | `pyde --version`         |
| `otic` compiler          | `otic --version`         |
| `pyde-rust-sdk` crate    | `Cargo.toml` `version`   |
| `pyde-crypto-wasm` pkg   | `package.json`           |
| Otigen language version  | embedded in the artifact |
| ABI version              | embedded in the artifact |

The binary embeds the wire-format version (`EVIDENCE_VERSION = 1` for
slashing evidence, `MULTISIG_VERSION = 0x01` for multisig payloads). If
either is bumped, that's a hard fork — the deserializer rejects unknown
versions.

---

## 18.8 Coordinating an Upgrade

The day-of-upgrade checklist for a hard fork:

```
T-30 days:  PIP merged, release tagged, activation block announced.
T-14 days:  Foundation publishes "validator upgrade tracker" — counts how
            many of the active committee have signaled the new release.
T-7 days:   If <80% of active committee on the new release, postpone the
            activation block via a follow-up PIP.
T-1 day:    Final reminder.
T-0:        Activation block. New rule takes effect.
T+1 hour:   Foundation confirms chain is producing under the new rule.
T+1 week:   Old releases marked deprecated.
```

The "80% signaling threshold" is a social norm, not a protocol enforced
threshold. The protocol-enforced threshold is 2f+1 = 86 of 128 — but
shipping with 87/128 is brittle if a validator goes offline mid-flight.
80%+ as a social coordination target gives margin.

### Validator signaling

There is no explicit on-chain signal of "validator X has upgraded." The
signaling happens out-of-band:

- Validators announce their version via the `identify` libp2p protocol.
- Foundation operates a tracker that polls validators and reports
  aggregate version distribution.
- Validators may also announce intent in PIP discussion threads.

A more formal on-chain signal (e.g., embedding the running release in
the proposer's vote) is on the post-mainnet improvement list.

---

## 18.9 Comparison: Pyde vs Other Upgrade Models

| Property                       | Pyde                       | Ethereum               | Tezos / Cosmos                |
| ------------------------------ | -------------------------- | ---------------------- | ----------------------------- |
| Off-chain proposal             | PIP                         | EIP                     | TIP / CIP                      |
| On-chain governance vote       | None                        | None at protocol level  | Yes (stake-weighted)           |
| Validator upgrade              | Voluntary                   | Voluntary               | On-chain "self-amendment"      |
| Hard-fork coordination         | Activation block + social   | Activation block + social| Voted on-chain                 |
| Treasury action                | On-chain multisig + PIP     | Foundation grants       | On-chain (Tezos), proposal (Cosmos)|
| Emergency halt                 | Multisig pause              | None                    | Sometimes (social fork only)   |

Pyde's model is closer to Ethereum / Bitcoin than to Tezos / Cosmos. The
trade-off: slower to react than on-chain governance, but no
plutocratic-vote attack surface.

---

## 18.10 Honest About Limitations

- **No on-chain validator-upgrade signal.** Coordinated activation depends
  on out-of-band tracking. A future PIP could add an opt-in
  signaling-via-vote-payload mechanism.
- **No automatic rollback.** If a hard fork ships with a critical bug
  discovered post-activation, recovery requires another release + another
  upgrade. The emergency pause buys time but doesn't undo state changes.
- **Manual genesis adjustment** for catastrophic-recovery scenarios is
  documented but never operationally tested at scale. (The mainnet plan's
  Phase 9 incentivized testnet is the place where this kind of recovery
  could be rehearsed.)
- **No validator slashing for "voted for the wrong fork."** Validators can
  signal whatever they want; only protocol-level misbehavior (double
  signing, equivocation, etc.) is slashed.

---

## Summary

| Property                      | Status at mainnet                      |
| ----------------------------- | -------------------------------------- |
| Upgrade model                 | PIP + voluntary validator upgrade       |
| Hard fork mechanism            | Activation block + coordinated upgrade  |
| Soft fork mechanism            | Same; old nodes stay in sync            |
| Treasury action                | On-chain `MultisigTx` + PIP linkage     |
| Emergency response             | `EmergencyPause` (≤30 days, auto-expiring) |
| State migration patterns       | Lazy / activation-block / migration tx  |
| Wire-format versions           | `EVIDENCE_VERSION`, `MULTISIG_VERSION` (bumped on layout change) |
| On-chain validator-upgrade signal | None (out-of-band tracking)         |
| Automatic rollback             | None (re-release path)                  |

The next chapter covers the launch strategy — the ten-phase mainnet plan,
the testnet milestones, and the audit + incentivized testnet
requirements before mainnet genesis.
