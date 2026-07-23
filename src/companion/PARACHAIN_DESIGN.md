# Pyde Parachain Design

**Version 0.2**

This is the canonical design specification for Pyde's parachain layer.
[Chapter 13](../chapters/13-cross-chain.md) is the narrative overview;
this document is the deeper mechanics, the design rationale, and the
surface that future PPIPs (Pyde Parachain Improvement Proposals)
extend.

**Status: v2 design.** The layer ships post-mainnet. What v1 locks in
is the surface: the `type = "parachain"` manifest schema and its
validation in otigen, the gated parachain host-function namespace, the
`cross_call` interface and callback model, and the `HardFinalityCert`
primitive adapters build proofs from. Sections marked **open** are
named as unresolved rather than pretended settled.

> Revision note (0.1 → 0.2): version 0.1 described parachains as
> on-chain WASM modules with state subtrees inside Pyde's own JMT and
> validator committees drawn from the main committee. The design has
> moved: a parachain is now a decentralized off-chain network with its
> own open staked validator set, its own consensus and blocks, and its
> own working state, anchored to and re-validated by Pyde. This
> document supersedes 0.1 everywhere they disagree.

## 1. Scope and framing

A Pyde **parachain** is a small, decentralized, staked network that
performs one declared job the base chain deliberately cannot do
(foreign-chain interaction, data feeds, real-world IO, off-chain
compute), and reports results back to Pyde in a checkable form. It is
the layer between Pyde and everything outside it.

| Term | Meaning |
|---|---|
| Smart contract | A WASM module deployed via `otigen` that shares Pyde's general state space and runs on the main executor. |
| Parachain | A decentralized network defined by four artifacts: a deterministic WASM **parachain contract** (`type = "parachain"` in `otigen.toml`), an author-supplied **relay backend** that performs declared IO, the Pyde-provided **operator binary** that runs networking, stake wiring, and the parachain's consensus, and a **canonical Docker image** whose digest is pinned in the parachain's on-chain state. It has its own validator set (open, staked), its own consensus, its own blocks, and its own working state, all anchored to Pyde. |
| Adapter parachain | A parachain whose declared capability is a foreign chain: it implements that chain's transaction formats and runs its light client. Cross-chain reach in Pyde is *this*, not a separate bridge product. |
| Capability | The parachain's declared job: the request payloads it accepts, the results it produces, and the agreement rule its validators use (§6). |

It is *not* a slot-auction model (Polkadot-style), *not* a subset of
Pyde's main committee moonlighting, and *not* a trusted bridge or
oracle whitelist.

## 2. Why this model

Four design choices define the layer:

1. **One mechanism for the entire outside world.** Foreign chains,
   price feeds, weather, files, arbitrary APIs: all reached the same
   way, under the same staking, consensus, anchoring, and slashing
   rules. The base chain never learns what a parachain does; it learns
   how to check the work. The layer grows by deployment, not protocol
   change.
2. **IO outside consensus, agreement on results.** The parachain
   contract is deterministic and *declares* IO; the relay backend
   *performs* it off the consensus path; the validators reach consensus
   on the *result* under a declared agreement rule (§6). Raw IO inside
   consensus WASM would break the parachain's own finality, so it is
   structurally impossible rather than discouraged.
3. **Open validation, no committee prerequisite.** Anyone can pull a
   parachain by id, stake what its config requires, and join. Slot
   auctions concentrate rights in deep pockets; committee-subset models
   gate the layer on main-chain membership. Pyde parachains are open
   networks whose security is stake, agreement rules, and Pyde's
   re-validation.
4. **Equal-power validator voting.** Each parachain validator gets one
   vote on upgrades, NOT stake-weighted (§8), consistent with Pyde's
   anti-plutocracy committee philosophy.

And, held over from 0.1: **no maintained per-language SDK** (§11). Pyde
provides the ABI spec, the otigen surface, the operator binary, and
canonical examples; authors bring their own languages.

## 3. Architecture overview

One operator node of one parachain:

```text
┌───────────────────────── operator node (canonical image) ─────────────────────────┐
│                                                                                    │
│  ┌────────────────────────┐   declared IO    ┌────────────────────────┐            │
│  │ Parachain contract      │─────────────────►│ Relay backend           │──► world  │
│  │ (WASM, wasmtime,        │◄─────────────────│ (author's service,      │◄── (Chain │
│  │  deterministic)         │   raw result     │  any language)          │    X, an  │
│  └───────────┬────────────┘                  └────────────────────────┘    API...) │
│              │ state transition                                                    │
│  ┌───────────▼────────────────────────────────────────────────────────┐            │
│  │ Operator binary (Pyde-provided, same for every parachain)           │            │
│  │                                                                     │            │
│  │  · peer discovery + parachain p2p        · stake + eligibility      │            │
│  │  · parachain consensus (preset)          · result agreement (§6)    │            │
│  │  · block production + working state      · anchor broadcast to Pyde │            │
│  └─────────────────────────────────────────────────────────────────────┘            │
└────────────────────────────────────────────────────────────────────────────────────┘
```

And the parachain's relationship to Pyde:

```text
   Pyde (base chain)                                   parachain network
┌──────────────────────────┐                     ┌──────────────────────────┐
│ Parachain anchor account  │   forwarded         │ validators (open, staked) │
│  · parachain_id, name     │   cross_calls       │ own consensus (preset)    │
│  · config + capability    │────────────────────►│ own blocks                │
│  · canonical image digest │                     │ own working state         │
│  · stake bookkeeping      │◄────────────────────│                          │
│  · anchored state roots   │   anchor blocks     └──────────────────────────┘
│  · version history        │   (re-validated;
└──────────────────────────┘    fraud → challenge,
                                 cutoff, slash)
```

**The anchor account** lives on Pyde and is the parachain's on-chain
identity: registry entry, config, capability declaration, canonical
image digest, stake bookkeeping, version history, and the latest
re-validated state roots. It is small, and it is what Pyde consults
before forwarding a `cross_call`.

**The working state** lives with the parachain network itself, in its
own tree, committed per block under its own consensus. The
`parachain_storage_*` host functions operate on this working state. Its
roots flow back to Pyde inside anchor blocks.

**Anchoring.** Every parachain block is broadcast to the Pyde network.
Pyde re-validates what is deterministically checkable: the parachain
committee's signatures against the registered validator set, included
light-client proofs, state-root continuity, and agreement-rule
conformance for attested results (§6). A block that fails is
challenged; an unresolved challenge cuts off forwarding (§10) and
slashes (§13).

## 4. Parachain ID derivation

```text
parachain_id = Poseidon2("pyde-parachain:" || name_bytes)
```

Names are globally unique, ENS-style. 1-32 chars, single-letter
allowed. First-come-first-served at registration with yearly renewal +
grace period (see [Chapter 11](../chapters/11-account-model.md) for the
full naming model).

**Why prefix the hash with `"pyde-parachain:"`**: to keep the parachain
namespace disjoint from the contract namespace and the account
namespace. A contract named `chainlink` and a parachain named
`chainlink` would otherwise collide on Poseidon2(name). The prefix
forces them into different `parachain_id` and `contract_address` values
even when their human-readable names are identical.

**Why 32 bytes for the full ID**: Pyde uses full 32-byte addresses
everywhere (no truncation). The first 16 bytes cluster the anchor
account's on-chain records under PIP-2 (§5); the full 32 bytes are the
canonical identifier in receipts, events, cross-parachain messages, and
the operator binary's `--parachain-id` argument.

**Collision risk**: with `2^128` possible 16-byte clustering prefixes,
the birthday bound is ~`2^64` names before a clustering collision
becomes likely. Pyde additionally enforces uniqueness at registration
time. PIP-2 collision risk is effectively zero.

## 5. State: anchor on Pyde, working state on the parachain

Two state domains, deliberately separate:

**On Pyde (the anchor).** The parachain's anchor account and its
records are ordinary Pyde state, PIP-2-clustered under
`parachain_id[..16]` so registry reads, stake lookups, and anchored
root queries are contiguous. This is the state Pyde's own consensus
covers directly.

**On the parachain (working state).** Request queues, capability data
(order books, observation histories, light-client checkpoints),
operator bookkeeping: all of it lives in the parachain network's own
tree, written through `parachain_storage_read / write / delete`,
committed per parachain block, its root carried in the anchor
broadcast.

Consequences:

- **Pyde stays light.** A busy parachain does not bloat base-chain
  state; Pyde stores anchors, not order books.
- **Per-parachain roots are first-class.** Light clients (including
  other parachains) verify against a parachain's anchored root without
  touching Pyde's global root.
- **Cross-parachain proofs.** Parachain A can verify an inclusion proof
  against parachain B's latest *anchored* root, which Pyde has already
  re-validated. Trust flows through the anchor, not through B's
  self-report.
- **Replayability.** Anchored roots plus the pinned canonical image
  (§7) make a parachain's history re-executable and auditable.

## 6. Capabilities and agreement rules

Every parachain declares its **capability** (what requests it serves)
and its **agreement rule** (how its validators agree a result is THE
result) in config. Data divides into two honesty classes, and the rule
must match the class:

| Class | Examples | Agreement rule | Trust basis |
|---|---|---|---|
| **Provable** | foreign-chain receipt, light-client-verified event, content hash of a delivered file | `exact`: byte-identical across the quorum, carrying the proof | the foreign chain's own consensus, re-checkable by any validator and by Pyde |
| **Attested** | price, weather, API response, delivery confirmation without a receipt | `quorum(N, tolerance)`: median or trimmed aggregate of independent observations, within a declared tolerance | validator quorum + stake + slashing; an oracle, and declared as one |

Rules are part of the capability declaration, visible on-chain in the
anchor account, so a consuming contract (and its users) can read
exactly what kind of truth a parachain sells before calling it.
Divergence outside the rule is slashable (§13). Mechanism choices
inside the rule (commit-then-aggregate of observations, DAG-anchored
observation batches) are the parachain author's, constrained by the
conformance spec (§10).

## 7. The canonical image and the operator binary

**Canonical image.** Each parachain version pins the Docker image
digest of the full operator bundle (contract WASM + relay backend +
operator binary wiring) in its anchor account. Effects:

- Every operator runs the same verified bytes; a node running off-image
  is detectable by its peers and by Pyde.
- Upgrades are explicit on-chain state changes (§9), never silent
  pushes.
- Anyone can pull the image, inspect it, and join, which is what keeps
  "decentralized" honest.

What the pin buys is **reproducibility and auditability**, not trust
elimination: the author still authored the backend. Result-level
agreement (§6), stake, and slashing carry the trust; the pin makes
divergence visible.

**Operator binary.** Pyde provides one binary, the same for every
parachain. It owns everything an author should never rebuild:

- p2p networking and peer discovery for the parachain's own network,
- the limited, authenticated connection to the Pyde network (anchor
  broadcast, forwarded-call intake),
- stake submission and eligibility verification,
- the parachain consensus engine (preset menu, §8),
- block production, working-state management, agreement-rule
  execution.

An operator runs, in effect:

```text
pyde-parachain --id <parachain_id> --config <path>   # stake per the
                                                     # parachain's config;
                                                     # binary validates
                                                     # eligibility, pulls the
                                                     # canonical image, joins
```

Authors are left with exactly two deliverables: the parachain contract
and the relay backend.

## 8. Consensus, membership, and governance

**Membership.** Open. A prospective validator stakes the parachain's
configured `min_stake` (PYDE), passes the eligibility validation
(stake, spec conformance, canonical image), and joins. No main-
committee membership prerequisite, no whitelist. Departure returns
stake after an unbonding period; slashed stake does not return.

**Consensus.** Each parachain runs its own consensus instance from a
preset menu (`simple_bft` / `threshold` / `optimistic`), chosen in
config. Quorum thresholds are configurable with sane defaults (2/3).
The consensus covers block production over the working state AND
agreement-rule execution over results (§6): a result enters a block
only once the rule is satisfied.

**Governance (equal-power).**

```text
Parachain validators:  one validator, one vote
Quorum:                configurable (default 2/3 of validators must vote)
Threshold:             2/3 of voters say YES to pass
```

NOT stake-weighted, mirroring Pyde's main-committee philosophy: stake
weighting concentrates governance in deep pockets; equal-power voting
keeps coalitions on merit and operational reliability. Vote flow
(proposal → discussion window → voting window → tally → threshold-
signed activation) is unchanged from 0.1 and lives in the PPIP surface.

## 9. Lifecycle

```text
                  REGISTERING
                       │
       author submits  │  RegisterParachainTx
       deploy fee +    │  name + contract WASM + config
       owner deposit   │  + capability + image digest
                       ▼
                    ACTIVE  ◄────────────────────────┐
                    /  \                              │
        owner      /    \  governance vote            │ challenge resolved
        pause     ▼      ▼ to upgrade                 │
              PAUSED    UPGRADING                CHALLENGED
                 │          │                    (forwarding cut off;
                 │          │ new version + new   §10, §13)
                 │          │ image digest at
                 ▼          ▼ wave N + grace
              ACTIVE     ACTIVE (new version)

      kill (owner-only, irreversible) ──► KILLED
```

**Registration** carries the initial contract WASM, the config
(capability, agreement rule, `min_stake`, gas charge, consensus preset,
slashing preset, bootnodes, metadata), and the canonical image digest.
Validation checks name uniqueness and shape, WASM instantiability under
the deterministic config, imports against the parachain allowlist
(§12), config internal consistency, and fees. The otigen manifest
schema for `[parachain]` (min_stake, `[parachain.metadata]`,
`[parachain.genesis]`, `[parachain.upgrade_authority]`) is already
validated toolchain-side at v1.

**Upgrades** append a `ParachainVersionRecord` (WASM hash, config
snapshot, image digest, vote certs, threshold sig, activation wave)
after an §8 vote. Version history is retained forever: receipts record
`(parachain_id, parachain_version, wasm_hash)` so replay can always
fetch the exact bytes that executed. The last versions keep WASM bytes
on-chain; older versions keep hashes plus content-addressed refs.

**Pause / kill** are owner-side operational lifecycle (pause preserves
state and rejects new requests; kill is irreversible, returns the
deposit minus cleanup, retains state for the retention window, and
locks the name against reuse for a grace period).

**Challenge** is entered from Pyde's side (§10), not the owner's.

## 10. Conformance, forwarding, and challenge

Pyde publishes a **parachain conformance spec**: what a parachain must
implement to be one. The spec covers the anchor-block format, the
agreement-rule declaration and execution, the canonical-image
discipline, stake handling, the forwarded-call intake protocol, and the
callback contract.

**Forwarding.** Pyde validators forward a contract's `cross_call` to a
parachain only while the parachain is conformant and unchallenged. The
routing is principle-based: the contract names the parachain and the
capability it expects; Pyde checks the anchor account (active, staked,
capability matches, image pinned) and forwards.

**Challenge.** When a parachain broadcasts a fraudulent or invalid
anchor block (bad signatures, root discontinuity, agreement-rule
violation, off-image execution evidence), Pyde challenges it:

1. The anchor is rejected and the parachain enters `CHALLENGED`.
2. Forwarding stops immediately: no new `cross_call` reaches it until
   the challenge is resolved (the liveness lever).
3. Offending validators are slashed per the parachain's preset plus the
   layer's fraud schedule (the economic lever, §13).
4. Resolution requires a corrected anchor accepted by Pyde
   re-validation.

**Open (dispute mechanics).** The challenge window length, the
fraud-proof format for each violation class, in-flight callback
handling during a challenge, and adjudication of non-mechanical edge
cases (automatic proof vs governance) are open design. They are the
second of the two hard problems named in §16.

## 11. No-SDK approach

Pyde does **not** ship a maintained per-language SDK for parachain
development. The rationale is unchanged from 0.1: solo-founder
bandwidth, mature wasm32 toolchains already existing, and SDK/ABI
version-skew being worse than a single authoritative ABI doc.

What Pyde provides:

1. **The Host Function ABI Specification** (names, signatures, memory
   conventions, gas table, versioning rules), including the parachain
   namespace.
2. **The `otigen` CLI**: `otigen init <name> --type parachain`
   scaffolds; `build` packages (bundle carries
   `contract_type = Parachain`); `deploy` registers. Same surface as
   contracts, parachain behavior gated on the bundle type.
3. **The operator binary** (§7): networking, peers, stake, consensus,
   anchoring, handled once for every parachain.
4. **The on-chain anchor registry**: single source of truth for config,
   capability, image digest, version history.
5. **The conformance spec + verification** (§10).
6. **Slashing preset menu**: minimal / standard / strict (§13).
7. **Canonical example parachains** (starter projects, not SDKs).

What authors provide:

- The **parachain contract**: compiled WASM in any wasm32-target
  language, deterministic, declaring its host imports.
- The **relay backend**: their own service, any language, spoken to
  only through the declared-IO boundary (§12).
- The config: capability, agreement rule, stakes, charges, presets,
  bootnodes, metadata.

## 12. Capability model: host functions and declared IO

The parachain contract is sandboxed; host functions are the only
escape. The v1-reserved parachain namespace:

```text
storage:
  parachain_storage_read(key_ptr, key_len, out_ptr, out_len_ptr) -> i32
  parachain_storage_write(key_ptr, key_len, val_ptr, val_len) -> i32
  parachain_storage_delete(key_ptr, key_len) -> i32

events:
  parachain_emit_event(topic_ptr, topic_len, data_ptr, data_len) -> i32

context:
  parachain_get_caller(out_ptr) -> i32
  parachain_get_wave_id() -> u64
  parachain_get_parachain_id(out_ptr) -> i32

cross-parachain messaging (rate-limited):
  parachain_send_xparachain_message(target_id_ptr, msg_ptr, msg_len, callback_spec_ptr) -> i32

hashing primitives:
  hash_keccak256(in_ptr, in_len, out_ptr) -> i32
  hash_blake3(in_ptr, in_len, out_ptr) -> i32
  hash_poseidon2(in_ptr, in_len, out_ptr) -> i32

explicit gas metering:
  consume_gas(units: u64) -> i32
```

**Still explicitly forbidden inside the WASM:**

```text
network calls (any kind) — non-deterministic
file/disk access — non-deterministic + capability escape
system clock — non-deterministic; use wave_timestamp / wave_id instead
non-deterministic entropy — use the beacon via host fn
direct RocksDB access — must route through parachain_storage_*
WASM threads — non-deterministic by definition
non-deterministic SIMD / float ops — determinism risk
WASI — not allowed (whole interface forbidden)
```

This is not a limitation the IO model works around; it IS the IO
model's foundation. The contract never performs IO. It **declares** it:

```text
io_request {
  url:            String        // the author's relay backend endpoint
  method:         String
  headers:        Map<String, String>
  payload:        bytes         // schema declared by the capability
  timeout_ms:     u64
}
```

The operator binary hands the declaration to the relay backend, which
performs the call off the consensus path and returns the raw result.
The result then enters the parachain's consensus under the declared
agreement rule (§6), and only the agreed result is sealed into the
block. Determinism inside, reality outside, agreement at the boundary.

**Open (ABI).** The exact `io_request` host-function signature, its gas
schedule, response-size bounds, and its place in the ABI's no-removal
ratchet are v2 ABI work. The v1 Host Function ABI is frozen without it;
it enters through the ABI's additive path when the layer ships.

Deploy-time validation rejects any `.wasm` whose imports reference
functions outside the allowlist. Hard-enforced; no opt-out.

## 13. Stake, slashing, and the fraud schedule

Parachains pick a slashing preset at deploy time, applied to that
parachain's validator stake:

| Preset | Equivocation | Bad state root | Liveness (offline) |
|---|---|---|---|
| `minimal` | 5% | 5% | 0.5%/epoch |
| `standard` | 25% | 10% | 1%/epoch |
| `strict` | 50% | 25% | 2%/epoch |

Added in 0.2, uniform across presets (the layer's own fraud schedule,
not author-tunable):

| Offense | Consequence |
|---|---|
| Signing a fraudulent anchor block | Slash (preset's bad-state-root rate, floored at `standard`) + parachain enters CHALLENGED |
| Attestation divergence outside the declared agreement rule | Slash per occurrence; repeated divergence escalates |
| Provable off-image execution | Slash + ejection from the validator set |
| Unresolved challenge | Forwarding remains cut off; stake of signing validators remains locked until resolution |

Why a preset menu rather than free parameters: small parachain teams
should not be making slashing-economics decisions. If a parachain wants
custom slashing, that is a PPIP for a new preset.

Main-committee slashing (see [SLASHING.md](./SLASHING.md)) is separate
and additive for any validator who also serves there; parachain stake
and main stake are distinct bonds.

## 14. Cross-parachain messaging

Parachains call each other via `parachain_send_xparachain_message`.
Mechanics are unchanged from 0.1: the calling parachain's committee
threshold-signs the outgoing message; Pyde's main consensus routes it;
the receiving committee verifies the source committee's signature
against the on-chain registry; the callback (same context model as
`cross_call`) rides back the same way. Rate-limited per wave
(default 64 outgoing).

What changes in the 0.2 frame is only the proof anchor: the receiving
parachain verifies claims about the sender's state against the
sender's latest *Pyde-anchored* root, not against the sender's
self-report.

## 15. Parachain economics

PYDE is the gas token across the layer. A contract's `cross_call` into
a parachain pays that parachain's **declared gas charge** (in config,
visible in the anchor account) on top of standard execution gas.
Parachain validators earn the charge for honest service; registration
fees and owner deposits are paid in PYDE at deploy time; slashing burns
per Pyde's economics.

Parachain authors can layer their own internal token economies on top
(an adapter might fee in its own unit; a feed might not). Application-
layer concern; the protocol charges PYDE.

## 16. Trust model and the two hard problems

What the layer removes: the bridge multisig, the oracle whitelist, the
silent failure. What remains is named:

- **Attested data is attested** (§6). No mechanism makes a price
  provable; the layer makes the attestation economic, its rule
  explicit, and divergence slashable.
- **Open problem 1: outbound signing custody.** An adapter parachain
  holds signing authority on a foreign chain. That authority must be
  threshold-held across the parachain's validator set (no single
  signer, no fixed side-multisig), with key generation, resharing on
  membership change, and revocation on slashing. Every major bridge
  loss in the industry's history walked through exactly this seam. The
  scheme (threshold construction, ceremony, rotation cadence) is open
  design and gates the first adapter parachain.
- **Open problem 2: dispute mechanics** (§10). Challenge windows,
  fraud-proof formats per violation class, in-flight callback handling,
  adjudication of non-mechanical cases.

Neither open problem blocks the data-feed class of parachains, which
need no foreign signing authority; adapters gate on problem 1.

## 17. Failure modes

| Failure | Detection | Recovery |
|---|---|---|
| Parachain WASM enters infinite loop | Fuel exhausted → trap | Request fails; gas charged; state rolled back |
| Relay backend down / IO timeout | `timeout_ms` exceeded; no result enters agreement | Callback fires with timeout error on `timeout_waves`; caller's error handler runs |
| Single validator's IO result diverges | Agreement rule outvotes it | Result unaffected; divergent attestor slashed on repeat/degree (§13) |
| Fraudulent or invalid anchor block | Pyde re-validation fails | CHALLENGED: forwarding cut off, signers slashed, corrected anchor required (§10) |
| Off-image operator | Peer/anchor evidence vs pinned digest | Slash + ejection (§13) |
| Cross-parachain message verify fails | Target committee rejects signature | Message dropped + logged; no callback fires |
| Cross-parachain message timeout | `timeout_waves` exceeded | Callback fires with timeout error |
| Validator set falls below quorum | Parachain cannot seal blocks | Parachain stalls (no anchors, no forwarding); recovers when quorum restores; liveness slashing applies |
| Bad upgrade (deterministic divergence) | Post-activation anchors fail re-validation | CHALLENGED; rollback to prior version record via governance |
| Name registry race | Atomic registry check | First confirmed at wave-commit wins; later one refunded |

## 18. ZK-readiness path baked in

Unchanged from 0.1, and it applies cleanly to the 0.2 model because the
parachain contract stays in the deterministic WASM subset (no floats
outside canonical NaN, no threads, no non-deterministic SIMD, no
mutable globals). Parachain blocks whose state transitions are
deterministic WASM are exactly the shape zk-WASM proving wants;
adapters additionally benefit from ZK-aggregated FALCON verification
(one proof instead of 85 verifies per finality cert on the counterparty
side). Both are tracked post-layer work.

## 19. References

- Narrative overview: [Chapter 13](../chapters/13-cross-chain.md)
- Plain-language one-pager: `PARACHAINS.md` at the workspace root
- Account model + naming: [Chapter 11](../chapters/11-account-model.md)
- State model + PIP-2 clustering: [Chapter 4](../chapters/04-state-model.md)
- Execution layer + WASM: [Chapter 3](../chapters/03-virtual-machine.md)
- Host function surface: [HOST_FN_ABI_SPEC](./HOST_FN_ABI_SPEC.md)
- Slashing: [SLASHING.md](./SLASHING.md)
- Threat model: [THREAT_MODEL.md](./THREAT_MODEL.md)
- Network protocol: [NETWORK_PROTOCOL.md](./NETWORK_PROTOCOL.md)

---

**Document version:** 0.2

**License:** See repository root
