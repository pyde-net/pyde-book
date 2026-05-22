# Chapter 15: Governance

Pyde's governance is deliberately minimal at the protocol level. There is
no two-chamber voting machine, no plutocratic stake-weighted ballot, no
on-chain referendum logic. The model is **off-chain Pyde Improvement
Proposals (PIPs) + an on-chain treasury multisig**, with everything else
either hard-coded or operationally driven.

This chapter describes the actual governance design: how proposals form,
how rough consensus is reached, what authority the on-chain multisig has,
and what falls outside governance entirely.

---

## 15.1 Why "Off-Chain PIPs + On-Chain Multisig"

A small number of governance models are well-explored in production
blockchains, each with distinct failure modes:

| Model                         | Common failure mode                             |
| ----------------------------- | ----------------------------------------------- |
| Stake-weighted token voting   | Plutocracy (whales decide, low turnout, capture) |
| Liquid democracy (delegation) | Concentrated delegates, unstable delegation     |
| Two-chamber (validators + holders) | Procedural deadlock, complex thresholds     |
| Off-chain BIP-style + voluntary upgrade | Real but slow                          |
| Council multisig              | Centralized; depends on signer integrity         |

Pyde's choice is closer to the Bitcoin BIP / Ethereum EIP model than to
Cosmos-style on-chain governance:

1. **Proposals are documents**, not on-chain ballots. They live in a public
   `pips` repo (`zarah-s/pips`), open to any author, indexed and discussed
   in the open.
2. **Adoption is via voluntary validator upgrade.** When validators
   running a new client version reach a sufficient share of the active
   committee, the new behavior takes effect. Validators that don't upgrade
   continue running the old rules and either follow along (no consensus
   change) or fork off (consensus-breaking change).
3. **The on-chain treasury multisig executes spends linked to PIPs.** The
   `MultisigTx` payload carries `data_digest = hash(pip_file_contents)`,
   so every treasury action is on-chain-linked to a published PIP.

The model's core property: **no party can drain the treasury, halt the
chain, or change the rules without a coordinated, public, auditable
process**. Drainage requires multisig signers; chain halt requires the
emergency multisig; rule changes require validators choosing to run the
new code.

---

## 15.2 The PIP Process

PIPs are governed by **PIP-0001**, the founding document that ratifies
the PIP system itself. The process at a high level:

```
PIP lifecycle:

  1. Draft        Author writes a markdown document (problem, design,
                  rationale, security considerations).
                  Creates a PR against zarah-s/pips.

  2. Discussion   Open discussion on the PR, in forums, etc.
                  Author iterates.

  3. Review       PIP receives review from core devs, validators, the
                  security team. Concerns are addressed in discussion.

  4. Acceptance   PIP is merged into the pips repo with a final number.
                  An acceptance signal does not change protocol behavior
                  by itself — it is documentation of rough consensus.

  5. Implementation The PIP is implemented in a code change (PR against
                  the relevant Pyde repo). The PIP # is referenced.

  6. Deployment   The new node version ships. Validators choose to run
                  the new version. Once a sufficient validator share
                  upgrades, the change takes effect on-chain.
```

There is no on-chain "yes/no" vote on the PIP itself. The closest thing
to a vote is **validators choosing to run the new code** — a softer but
genuine signal.

### What gets a PIP

| Change type                                     | PIP needed?    |
| ----------------------------------------------- | -------------- |
| Consensus rule change (block format, finality)  | Yes            |
| Gas cost changes                                | Yes            |
| Fee distribution changes (e.g., 70/20/10 split)  | Yes            |
| Cryptographic primitive change                  | Yes            |
| New transaction type                            | Yes            |
| New WASM host function                          | Yes            |
| Treasury spend (any size)                       | Yes (`data_digest` carries hash) |
| Bootstrap node list update                      | No (config-driven)|
| Bug-fix release (no protocol change)            | No (changelog) |
| Doc updates                                     | No             |

### What a PIP looks like

A PIP includes (at minimum):

- **Problem statement** — what is being addressed and why.
- **Specification** — the exact design / wire format / behavior change.
- **Rationale** — why this design over alternatives.
- **Security considerations** — what could go wrong.
- **Backwards compatibility** — does this require a coordinated upgrade?
- **Reference implementation link** — code PR(s) that implement it.

PIP-0001 specifies the template in detail.

---

## 15.3 Voluntary Validator Upgrade

How a consensus rule change actually takes effect:

```
1. PIP is accepted; reference implementation merged into Pyde repo.
2. A new node release is cut, including the new behavior.
3. Validators choose whether to upgrade to the new release.
4. If enough validators upgrade simultaneously, the new behavior takes
   effect at the activation block (specified in the PIP).
5. Validators on the old release either continue producing the old rules
   (forking off if the change is incompatible) or stay in sync (if the
   change is opt-in or backward-compatible).
```

The key word is **voluntary**. There is no on-chain mechanism to force a
validator to upgrade. Validators that reject a change keep running the
old rules; if they constitute >1/3 of the active committee, the new
behavior cannot reach finality and the change is effectively rejected by
the network.

This means the upgrade decision is itself a kind of vote — not measured by
token weight, but by validator participation. A controversial change that
fails to attract supermajority validator participation simply doesn't
land, regardless of how many off-chain signers nominally approved.

### Activation parameters

Most consensus changes ship with an **activation height** — a specific
`wave_id` at which old nodes will produce waves the new nodes reject
(or vice versa). Validators run the upgrade window with both code paths
available, switching to the new path at the activation wave.

Backward-compatible changes (e.g., new opcodes that no existing contract
uses) can ship without coordinated activation — they take effect when an
upgraded validator processes the wave, are simply not used by old
contracts, and become standard once enough nodes have upgraded.

---

## 15.4 The On-Chain Treasury Multisig

The one piece of "governance" that lives on-chain at mainnet is the
treasury multisig. This is the mechanism by which approved PIPs that
require funding turn into actual PYDE movement.

### Configuration

State (recap from Chapter 14):

| Discriminator | Name                  | Holds                              |
| ------------- | --------------------- | ---------------------------------- |
| `0x1C`        | `MULTISIG_SIGNERS`    | Length-prefixed array of FALCON pks |
| `0x1D`        | `MULTISIG_THRESHOLD`  | Required signature count            |
| `0x1E`        | `MULTISIG_NONCE`      | Replay protection counter           |

Maximum signers: 16. The threshold is `t-of-n` — requires `t` valid FALCON
signatures from distinct signers in `MULTISIG_SIGNERS`.

Suggested initial configuration (set at mainnet genesis): 12 signers,
threshold 7, drawn from the Foundation board, core dev leads, validator
operator representatives, and independent ecosystem representatives. The
emergency-halt multisig is **separate** (typically a tighter 5-of-7 of
core devs + security team for fast crisis response). The exact composition
is a launch decision and will be ratified by PIP-0001 + a follow-up PIP.

### Spend transaction (`MultisigTx` = type 9)

```rust
struct MultisigSpend {
    target:      Address,         // recipient
    value:       u128,            // PYDE quanta to send
    data_digest: [u8; 32],        // hash(pip_file_contents)
}
```

The `data_digest` is the audit trail. Anyone reading the chain sees a
treasury spend `(target, value, data_digest)`; anyone who has the PIP can
hash it and confirm the spend matches. If the digest does not match a
published PIP, that's a public, on-chain anomaly.

Validation enforces:

- `value > 0`
- `target != Address::ZERO`
- `target != treasury_address` (cannot spend to self)
- `target != tx.from` (writeback-clobber protection)
- `tx.to == Address::ZERO`
- `MULTISIG_NONCE` matches the signed payload (replay protection)
- Number of valid signatures from `MULTISIG_SIGNERS` ≥ `MULTISIG_THRESHOLD`
- Each signer index referenced exactly once (no duplicates)

Gas: 50,000 base + 50,000 per signature.

### Rotation (`RotateMultisig` = type 10)

```rust
struct MultisigRotate {
    new_signer_pks: Vec<Vec<u8>>,    // each is 897-byte FALCON pk
    new_threshold:  u8,
}
```

The current signer set authorizes the rotation. Validation requires:

- `new_threshold >= 1`
- `new_threshold <= new_signer_pks.len()`
- `new_signer_pks.len() <= MAX_MULTISIG_SIGNERS` (16)
- Same writeback-clobber defenses as `MultisigTx`

Gas: 60,000 base + 50,000 per signature + 10,000 per new signer.

### Why this isn't "centralized governance"

Critics of multisig-based governance often raise the centralization
concern: "a few signers can do anything." The mitigating factors:

1. **Bounded scope.** The multisig can spend the treasury and rotate
   itself. It cannot change the inflation schedule, the consensus rules,
   the gas distribution, or any other protocol parameter — those are
   hard-coded in the validator binary.
2. **Public, on-chain audit trail.** Every spend has a `data_digest`
   linkable to a PIP. Off-chain spending the treasury is not possible.
3. **Validator override.** If the multisig were captured and started
   spending against published PIPs, validators could refuse to include
   the spend transactions (or hard-fork them out). Validators retain veto
   power even over the multisig.
4. **Rotatable.** The signer set can be replaced, also via PIP + multisig
   action.

A captured multisig is a problem, but a bounded one — it cannot rewrite
consensus or change supply.

---

## 15.5 Emergency Governance

Pyde has a separate `EmergencyPause` / `EmergencyResume` mechanism (also
multisig-authorized) for crisis response. Covered in Chapter 14 §14.9; the
governance-relevant points:

- The emergency multisig signer set is **separate** from the treasury
  multisig (the same configuration mechanism, different state slot in a
  proper deployment).
- Pausing requires the emergency signers; resuming requires the same.
- Pause is auto-expiring at `MAX_PAUSE_DURATION_WAVES` (~30 days). A
  paused chain cannot stay paused indefinitely without a fresh
  authorization.

The recommended emergency signer set: core developers + security team,
with a much lower threshold than the treasury multisig (so a quick
response is possible during a live exploit). The exact configuration is a
mainnet-launch decision.

---

## 15.6 What Is NOT Governable

Hard-coded protocol constants that **cannot** be changed by any on-chain
action — only by a PIP + new validator binary release + voluntary
validator upgrade:

| Constant                       | Where                                |
| ------------------------------ | ------------------------------------ |
| DAG round period (~150 ms)     | `crates/consensus/src/round.rs`       |
| Commit cadence (~500 ms median) | `crates/consensus/src/wave.rs`  |
| Committee size (128)           | `crates/consensus/src/committee.rs`   |
| Quorum / threshold (85)        | `crates/consensus/src/quorum.rs`      |
| Equivocation threshold (44)    | `crates/consensus/src/quorum.rs`      |
| Validator min stake (10,000 PYDE) | `crates/tx/src/pipeline.rs` (will move to shared crate post-consensus-rebuild) |
| Operator-identity cap (3 / operator) | `crates/tx/src/pipeline.rs`     |
| Unbonding period (30 days)     | `crates/consensus/src/validator.rs`   |
| Inflation schedule             | `crates/tx/src/fee.rs`                |
| Fee split (70/20/10)           | `crates/tx/src/execution.rs`          |
| Gas target / ceiling           | `crates/tx/src/fee.rs`                |
| `MAX_TX_SIZE` (128 KB)         | `crates/tx/src/validation.rs`         |
| `MAX_CALLDATA` (64 KB)         | `crates/tx/src/validation.rs`         |
| `MAX_BATCH_SIZE` (4 MB)        | `crates/mempool/src/batch.rs`         |
| Cryptographic primitives       | `pyde-crypto` polyrepo (FALCON, Kyber, Blake3, Poseidon2) |
| WASM host function ABI         | `crates/wasm-exec/src/host_fns.rs` + Host Function ABI spec doc |

Changing any of these requires a code release. Validators choose whether
to run it.

---

## 15.7 What Falls Through the Gaps

Some operational concerns sit outside both the PIP process and the
multisig:

| Concern                        | Handled by                         |
| ------------------------------ | ---------------------------------- |
| Bootstrap node list            | Config — operators ship their own   |
| Block explorer                 | Foundation operates a public one    |
| RPC endpoints                  | Multiple operators run them         |
| Indexing / data products       | Ecosystem builds them               |
| Wallet integrations            | Ecosystem partnerships              |
| Marketing / branding           | Foundation                          |
| Conference sponsorships        | Treasury via PIP-driven multisig    |
| Bug bounty payments            | Treasury via PIP-driven multisig    |

These are not "governance" in any rigorous sense. They are operational
choices that the Foundation, validators, and ecosystem participants make
independently.

---

## 15.8 Comparison with Other Networks

| Property                         | Pyde                            | Ethereum               | Cosmos / Tendermint        | Polkadot                |
| -------------------------------- | ------------------------------- | ---------------------- | -------------------------- | ----------------------- |
| Protocol-rule change             | PIP + voluntary upgrade         | EIP + voluntary upgrade| On-chain governance vote   | Council + referenda     |
| Treasury spend                   | On-chain multisig + PIP         | Foundation grants       | On-chain governance         | On-chain treasury / Council|
| Emergency halt                   | Multisig pause                  | None at protocol layer  | None at protocol layer      | Sudo (pre-removal)       |
| Token voting                     | None                            | None at protocol layer  | Stake-weighted              | Stake-weighted          |
| Validator-only signal            | Voluntary upgrade               | Voluntary upgrade       | On-chain                     | Council inclusion        |
| Off-chain coordination doc       | PIP                              | EIP                     | Forum + on-chain proposal    | OpenGov / Forum          |
| Constitutional parameters        | All of them, hard-coded         | Hard-coded              | Some on-chain                | Some on-chain            |

The Pyde model is closest to Ethereum's: heavy reliance on off-chain
proposals and voluntary validator upgrades, with a small on-chain mechanism
(in our case, the treasury multisig) for the parts that genuinely need
on-chain authorization.

---

## 15.9 Why No Stake-Weighted Voting?

Stake-weighted voting is the most common form of on-chain governance, and
the design Pyde explicitly rejected. Three reasons:

1. **Plutocracy.** A stake-weighted vote concentrates power in whoever
   holds the most tokens. PYDE distribution at any point in time is a
   snapshot — there's no reason to think it tracks anything beyond who
   bought early.
2. **Low turnout.** Most token holders don't vote. The few who do gain
   outsized influence.
3. **Vote-buying.** Active markets exist for vote delegation in
   stake-weighted systems. Treasury-spend votes can be auctioned off.

The PIP-and-voluntary-upgrade model removes the "vote weight" question
entirely. There is no quantum of governance influence that can be
purchased. There is only:

- Anyone can write a PIP.
- Validators can choose to run the resulting code (or not).
- Multisig signers can authorize PIP-linked treasury spends (or not).

Each piece is a clear, narrow authority. None of them aggregate into
"control of the protocol."

---

## 15.10 Future Direction

Possible post-mainnet additions to governance, none on the critical path:

- **Validator signal mechanism.** A way for validators to publicly signal
  support or opposition for a PIP before activation, increasing process
  transparency. Pure off-chain or a thin on-chain log.
- **Quadratic / conviction voting for treasury allocation.** A sub-process
  for ecosystem grant allocation that gives some weighted input to
  ecosystem participants without becoming token-weighted control.
- **Optional on-chain PIP registry.** A storage-discriminator (`PIP_REGISTRY`?)
  that mirrors the off-chain PIP repo so on-chain readers can resolve a
  `data_digest` without needing the off-chain repo.

None of these change the fundamental shape: the multisig is bounded, the
PIP process is open, and validators decide what code they run.

---

## Summary

| Component                       | Status at mainnet                     |
| ------------------------------- | ------------------------------------- |
| PIP process                     | Off-chain, in `zarah-s/pips`           |
| PIP authority                   | Documents intent; not protocol law    |
| Validator upgrade               | Voluntary; per-release                 |
| Treasury multisig               | On-chain, `MultisigTx` (type 9)        |
| Multisig rotation               | On-chain, `RotateMultisig` (type 10)   |
| Multisig signer cap             | 16                                     |
| `MultisigTx` PIP linkage        | `data_digest = hash(pip_file)` on-chain |
| Emergency pause                 | On-chain, `EmergencyPause` (type 11)   |
| Pause max window                | ~30 days (auto-expiring)               |
| On-chain stake-weighted voting  | None                                    |
| Hard-coded protocol constants   | All of them — change via code release  |

The next chapter covers security — the threat model, slashing detail, and
the weak-subjectivity defenses that protect against long-range attacks.
