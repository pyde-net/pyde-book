# Pyde Parachain Design

**Version 0.3**

This is the canonical design specification for Pyde's parachain layer.
[Chapter 13](../chapters/13-cross-chain.md) is the narrative overview;
this document is the deeper mechanics, the design rationale, and the
surface that future PPIPs (Pyde Parachain Improvement Proposals)
extend.

**Status: v2 design.** The layer ships post-mainnet. What v1 locks in
is the surface: the `type = "parachain"` manifest schema and its
validation in otigen, the gated parachain host-function namespace, the
callback model that `parachain_call` extends, and the
`HardFinalityCert` primitive adapters build proofs from. Sections
marked **open** are named as unresolved rather than pretended solved.

> Revision note (0.2 to 0.3): parachains no longer stand up their own
> consensus or produce their own blocks. A parachain's validators
> stake PYDE and attest into Pyde's security: results carry the
> parachain's per-member aggregated FALCON attestation and post to
> Pyde as ordinary transactions of a dedicated result type, ordered in
> the DAG and dispatched deterministically. Callbacks are pull-first.
> Outbound signing splits into three keys. This supersedes 0.2
> everywhere they disagree. (0.1 described on-chain WASM modules with
> committee-subset validators; 0.2 introduced the off-chain operator
> network; 0.3 collapses its consensus onto Pyde's.)

## 1. Scope and framing

A Pyde **parachain** is a small, decentralized, staked network that
performs one declared job the base chain deliberately cannot do
(foreign-chain interaction, data feeds, real-world IO, off-chain
compute) and posts attested results back to Pyde in a checkable form.
It is the layer between Pyde and everything outside it.

| Term | Meaning |
|---|---|
| Smart contract | A WASM module deployed via `otigen` that shares Pyde's general state space and runs on the main executor. |
| Parachain | A decentralized network defined by four artifacts: a deterministic WASM **parachain contract** (`type = "parachain"` in `otigen.toml`), an author-supplied **relay backend** that performs declared IO, the Pyde-provided **operator binary** that runs networking, stake wiring, and result agreement, and a **canonical Docker image** whose digest is pinned in the parachain's on-chain state. Its validators stake PYDE and attest results into Pyde's security; it does not run its own consensus. |
| Verifier capability | Proves data against a foreign chain's own consensus through a light client. Agreement is exact. |
| Oracle capability | Reports quorum-agreed data within a declared tolerance, honestly named as an oracle. |
| Bridge capability | A verifier that additionally holds an outbound key to write on the foreign chain. |

It is *not* a slot-auction model (Polkadot-style), *not* a sovereign
sub-chain with its own consensus (that remains a later option, not the
default), and *not* a trusted bridge or oracle whitelist.

## 2. Why this model

Five design choices define the layer:

1. **One mechanism for the entire outside world.** Foreign chains,
   price feeds, weather, files, arbitrary APIs: all reached the same
   way, under the same staking, attestation, and slashing rules. The
   base chain never learns what a parachain does; it learns how to
   check the work. The layer grows by deployment, not protocol change.
2. **Attest into Pyde rather than bootstrap new security.** A
   parachain that had to grow its own economic security from a cold
   start would be exactly the cheap-to-attack surface oracles and
   bridges have always been. Instead its validators stake PYDE, attest
   results into Pyde, and answer to Pyde's slashing. This also
   collapses the build: there is no separate consensus per parachain
   to stand up.
3. **Results are ordinary transactions.** A result becomes canonical
   because it is an ordered transaction of a dedicated result type,
   gossiped, sequenced in the DAG, and dispatched deterministically,
   the same path every settlement transaction already takes. No
   bespoke consensus primitive exists anywhere in the layer.
4. **IO outside the agreement path, agreement on results.** The
   parachain contract is deterministic and *declares* IO; the relay
   backend *performs* it; the members agree on the *result* under a
   declared rule (§5) before attesting it. Raw IO inside the
   deterministic core is structurally impossible rather than
   discouraged.
5. **Open validation, no committee prerequisite.** Anyone can pull a
   parachain by id, stake what its config requires, and join. Slot
   auctions concentrate rights in deep pockets; committee-subset
   models gate the layer on main-chain membership. Neither applies.

And, held over: **equal-power governance** (§8) and **no maintained
per-language SDK** (§11).

## 3. Architecture overview

One operator node of one parachain:

```text
┌───────────────────────── operator node (canonical image) ─────────────────────────┐
│                                                                                    │
│  ┌────────────────────────┐   declared IO    ┌────────────────────────┐            │
│  │ Parachain contract      │─────────────────►│ Relay backend           │──► world  │
│  │ (WASM, wasmtime,        │◄─────────────────│ (author's service,      │◄── (Chain │
│  │  deterministic)         │   raw result     │  any language,          │    X, an  │
│  └───────────┬────────────┘                  │  sandboxed)             │    API...) │
│              │ state transition               └────────────────────────┘            │
│  ┌───────────▼────────────────────────────────────────────────────────┐            │
│  │ Operator binary (Pyde-provided, same for every parachain)           │            │
│  │                                                                     │            │
│  │  · peer discovery + parachain p2p        · stake + eligibility      │            │
│  │  · result agreement (§5)                 · member attestation       │            │
│  │  · working-state maintenance             · result posting to Pyde   │            │
│  └─────────────────────────────────────────────────────────────────────┘            │
└────────────────────────────────────────────────────────────────────────────────────┘
```

And the parachain's relationship to Pyde:

```text
   Pyde (base chain)                                   parachain network
┌──────────────────────────┐                     ┌──────────────────────────┐
│ Parachain anchor account  │   forwarded         │ validators (open, staked) │
│  · parachain_id, name     │   parachain_calls   │ agreement rule over       │
│  · config + capability    │────────────────────►│ results (§5)              │
│  · canonical image digest │                     │ per-member aggregated     │
│  · stake bookkeeping      │◄────────────────────│ FALCON attestation        │
│  · version history        │   attested result   └──────────────────────────┘
└──────────────────────────┘   transactions
                                (ordered in the DAG;
                                 fraud → challenge,
                                 cutoff, slash)
```

**The anchor account** lives on Pyde and is the parachain's on-chain
identity: registry entry, config, capability declaration, canonical
image digest, stake bookkeeping, and version history. It is what Pyde
consults before forwarding a `parachain_call`.

**The result path.** Members run the declared agreement rule over a
request's outcome, attest the agreed result with per-member aggregated
FALCON (the same signing shape the base chain's beacon already uses,
so no threshold scheme is reintroduced), and post it to Pyde as a
transaction of a dedicated result type. Pyde orders it in the DAG and
dispatches it deterministically. Canonical, because ordered.

**Working state.** Capability data a parachain needs between requests
(light-client checkpoints, observation histories, queues) is
maintained member-side through the `parachain_storage_*` host
functions and is derived from, and replayable against, the ordered
result history on Pyde. Pyde itself stays light: it stores the anchor
and the results, never the order books.

## 4. Parachain ID derivation

```text
parachain_id = Poseidon2("pyde-parachain:" || name_bytes)
```

Names are globally unique, ENS-style. 1 to 32 chars, single-letter
allowed. First-come-first-served at registration with yearly renewal
and a grace period (see [Chapter 11](../chapters/11-account-model.md)
for the full naming model).

**Why the prefix**: it keeps the parachain namespace disjoint from the
contract and account namespaces. A contract named `chainlink` and a
parachain named `chainlink` would otherwise collide on
Poseidon2(name).

**Why 32 bytes**: Pyde uses full 32-byte addresses everywhere. The
first 16 bytes cluster the anchor account's records under PIP-2; the
full 32 bytes are the canonical identifier in receipts, events, and
the operator binary's `--parachain-id` argument.

**Collision risk**: with `2^128` possible 16-byte clustering prefixes
the birthday bound is ~`2^64` names, and registration enforces
uniqueness on top. Effectively zero.

## 5. Capabilities and agreement rules

Every parachain declares its **capability** (verifier, oracle, or
bridge, plus the request payloads it serves) and its **agreement
rule** (how members agree a result is THE result) in config. Data
divides into two honesty classes:

| Class | Examples | Agreement rule | Trust basis |
|---|---|---|---|
| **Provable** | foreign-chain receipt, light-client-verified event, content hash of a delivered file | `exact`: byte-identical across the quorum, carrying the proof | the foreign chain's own consensus, re-checkable by any member and by Pyde |
| **Attested** | price, weather, API response | each member fetches independently and **commits to its value before revealing it** (the base chain's own commit-reveal, reused), then the **median of the revealed quorum** within a declared tolerance | member quorum + stake + slashing; an oracle, and declared as one |

The commit-before-reveal step stops a lazy member from mirroring a
neighbour's number; the median stops a minority from swinging the
value; members persistently outside the declared tolerance are
slashed. Rules are part of the capability declaration, visible in the
anchor account, so a consuming contract can read exactly what kind of
truth a parachain sells before calling it.

**Timeouts (open).** A request that times out for one member but not
another must resolve to a single agreed outcome, so the timeout is
folded into what the quorum attests rather than left to each member's
wall clock. The exact attestation encoding for timed-out requests is
open design.

## 6. The call model

The outward verb is **`parachain_call`**, distinct from the in-chain
`cross_call`, because the two have different properties: `cross_call`
is synchronous, in-VM, contract-to-contract; a `parachain_call` is
asynchronous, cross-network, and non-deterministic in what it returns.
Different properties deserve different names.

**Pull-first.** A `parachain_call` returns a request id; the contract
reads the settled result later through a view. A push form, where the
result transaction invokes a named handler as an ordinary entrypoint
with the result as its input, can follow once the result-transaction
path is proven. Either way there is no new execution primitive: a
callback is just a later transaction calling an exported function,
under the VM's existing non-reentrant rules.

**ABI.** `parachain_call` and the result-type transaction enter the
Host Function ABI through its additive path when the layer ships; the
v1 ABI is frozen without them.

## 7. The canonical image and the operator binary

**Canonical image.** Each parachain version pins the Docker image
digest of the operator bundle in its anchor account. Every operator
runs the same verified bytes; drift is detectable; upgrades are
explicit state changes.

What the pin buys is **reproducibility and a supply-chain anchor, not
truth**. Only the WASM contract is deterministic; the image contains
the relay backend that does real, non-deterministic IO. It is
third-party code on validator hardware, so it runs **sandboxed**. The
guarantee is that members agree on the result, never that the image is
trustworthy.

**Operator binary.** Pyde provides one binary, the same for every
parachain: p2p networking and peer discovery, the authenticated
connection to Pyde (forwarded-call intake, result posting), stake
submission and eligibility verification, agreement-rule execution, and
member attestation. An operator points it at a parachain id and a
config; it pulls everything else:

```text
pyde-parachain --id <parachain_id> --config <path>   # stake per the
                                                     # parachain's config;
                                                     # binary validates
                                                     # eligibility, pulls the
                                                     # canonical image, joins
```

Authors are left with exactly two deliverables: the parachain contract
and the relay backend.

## 8. Membership and governance

**Membership.** Open. A prospective member stakes the parachain's
configured `min_stake` (PYDE), passes eligibility validation (stake,
spec conformance, canonical image), and joins. No main-committee
prerequisite, no whitelist. Departure returns stake after an unbonding
period; slashed stake does not return.

**Attestation quorum.** The parachain's config sets the quorum its
attestations require (default two thirds of registered members). An
attested result Pyde accepts must carry that quorum of member
signatures in the aggregated attestation.

**Governance (equal-power).**

```text
Parachain members:  one member, one vote
Quorum:             configurable (default 2/3 of members must vote)
Threshold:          2/3 of voters say YES to pass
```

NOT stake-weighted, mirroring Pyde's main-committee philosophy. Vote
flow (proposal, discussion window, voting window, tally, activation)
lives in the PPIP surface.

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
                 │          │ new version + new   §10, §12)
                 │          │ image digest
                 ▼          ▼
              ACTIVE     ACTIVE (new version)

      kill (owner-only, irreversible) ──► KILLED
```

**Registration** carries the initial contract WASM, the config
(capability, agreement rule, `min_stake`, gas charge, slashing preset,
bootnodes, metadata), and the canonical image digest. Validation
checks name uniqueness and shape, WASM instantiability under the
deterministic config, imports against the parachain allowlist (§11),
config internal consistency, and fees. The otigen manifest schema for
`[parachain]` (min_stake, `[parachain.metadata]`,
`[parachain.genesis]`, `[parachain.upgrade_authority]`) is already
validated toolchain-side at v1.

**Upgrades** append a version record (WASM hash, config snapshot,
image digest, vote certs, activation wave) after an §8 vote. Version
history is retained forever: receipts record
`(parachain_id, parachain_version, wasm_hash)` so replay can always
fetch the exact bytes that executed.

**Pause / kill** are owner-side operational lifecycle. **Challenge**
is entered from Pyde's side (§10).

## 10. Conformance, forwarding, and challenge

Pyde publishes a **parachain conformance spec**: the result-transaction
format, the agreement-rule declaration and execution, the
canonical-image discipline, stake handling, the forwarded-call intake
protocol, and the pull-first read surface.

**Forwarding.** Pyde validators forward a contract's `parachain_call`
to a parachain only while it is conformant and unchallenged. The
contract names the parachain and the capability it expects; Pyde
checks the anchor account (active, staked, capability matches, image
pinned) and forwards.

**Challenge.** When a parachain attests a fraudulent or invalid result
(bad attestation, agreement-rule violation, a provable-data claim that
fails its proof, off-image execution evidence), Pyde challenges it:

1. The result is rejected and the parachain enters `CHALLENGED`.
2. Forwarding stops immediately (the liveness lever).
3. Offending members are slashed per §12 (the economic lever).
4. Resolution requires a corrected, accepted result history.

**Open (fraud proofs and dispute).** The light-client verification
path for provable data, the challenge-window length, the fraud-proof
format per violation class, in-flight request handling during a
challenge, and adjudication of non-mechanical edge cases are open
design. This is one of the three named open problems (§13).

## 11. No-SDK approach and the capability model

Pyde does **not** ship a maintained per-language SDK for parachain
development. What Pyde provides: the Host Function ABI specification
(including the parachain namespace below), the otigen surface
(`otigen init <name> --type parachain`, `build`, `deploy`, with the
bundle carrying `contract_type = Parachain`), the operator binary
(§7), the on-chain anchor registry, the conformance spec (§10), the
slashing preset menu (§12), and canonical example parachains. Authors
bring the contract (any wasm32-target language) and the relay backend.

The v1-reserved parachain host-function namespace:

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

**Still explicitly forbidden inside the WASM:** network calls, file
and disk access, the system clock, non-deterministic entropy, direct
database access, WASM threads, non-deterministic SIMD and float ops,
and WASI wholesale. This is the foundation of the IO model, not a
limitation it works around: the contract **declares** IO,

```text
io_request {
  url:            String        // the author's relay backend endpoint
  method:         String
  headers:        Map<String, String>
  payload:        bytes         // schema declared by the capability
  timeout_ms:     u64
}
```

the sandboxed relay backend performs it, and the result enters the
agreement rule (§5). Determinism inside, reality outside, agreement at
the boundary. The exact `io_request` ABI (signature, gas schedule,
response bounds) is v2 ABI work on the additive path.

Deploy-time validation rejects any `.wasm` importing outside the
allowlist. Hard-enforced; no opt-out.

## 12. Stake, slashing, and the fraud schedule

Parachains pick a slashing preset at deploy time, applied to that
parachain's member stake:

| Preset | Equivocation | Fraudulent attestation | Liveness (offline) |
|---|---|---|---|
| `minimal` | 5% | 5% | 0.5%/epoch |
| `standard` | 25% | 10% | 1%/epoch |
| `strict` | 50% | 25% | 2%/epoch |

Uniform across presets (the layer's own fraud schedule, not
author-tunable):

| Offense | Consequence |
|---|---|
| Signing a fraudulent attested result | Slash (preset's fraudulent-attestation rate, floored at `standard`) + parachain enters CHALLENGED |
| Oracle attestation persistently outside the declared tolerance | Slash per occurrence; repeated divergence escalates |
| Provable off-image execution | Slash + ejection from the member set |
| Unresolved challenge | Forwarding remains cut off; signing members' stake stays locked until resolution |

Main-committee slashing (see [SLASHING.md](./SLASHING.md)) is separate
and additive for any validator who also serves there; parachain stake
and main stake are distinct bonds.

## 13. Trust model: three keys, and the three open problems

**Three keys, not one threshold.** There is no production-ready
threshold signature for FALCON, and the design does not need one:

1. **Pyde consensus** stays FALCON, exactly as shipped.
2. **Parachain result attestation** uses per-member aggregated FALCON,
   the same signing shape the base chain's beacon already uses. No
   threshold scheme is reintroduced.
3. **The outbound key** (bridge capability only) is dictated by the
   target chain: a chain that verifies secp256k1 cannot verify FALCON.
   That one foreign-facing key is held under a standard MPC scheme
   across the parachain's members, never a single signer, backed by
   slashing.

The honest one-liner: Pyde-side is post-quantum; the foreign-facing
key uses whatever the foreign chain mandates. The entire read-only
side (verifier and oracle capabilities) needs no outbound key at all
and stays fully FALCON-native.

**The three open problems**, named rather than waved away:

1. **Fraud proofs and the dispute game** for provable data (§10): the
   light-client verification path and the challenge process that lets
   Pyde reject a lie.
2. **Operational security of the outbound key**: the key-generation
   ceremony, resharing as members come and go, and making a stolen-key
   attack unprofitable through slashing. This is where most bridges
   have failed and it gates the first bridge-capability parachain.
   Verifier and oracle parachains do not wait on it.
3. **Deterministic timeouts** (§5): folding request timeouts into the
   quorum's attestation rather than each member's wall clock.

## 14. Cross-parachain messaging

Parachains call each other via `parachain_send_xparachain_message`.
The sending parachain's members attest the outgoing message with their
aggregated signature; Pyde's main consensus routes it as regular
transactions; the receiving parachain verifies the source attestation
against the on-chain registry; the response rides back the same way.
Rate-limited per wave (default 64 outgoing). Claims about a sender's
state verify against the sender's Pyde-ordered result history, not its
self-report.

## 15. Parachain economics

PYDE is the gas token across the layer. A contract's `parachain_call`
pays that parachain's **declared gas charge** (in config, visible in
the anchor account) on top of standard execution gas; result
transactions are paid from that charge, so a busy feed pays its own
way on the base chain. Members earn the charge for honest service;
registration fees and owner deposits are paid in PYDE at deploy time;
slashing burns per Pyde's economics. Parachain authors can layer their
own token economies on top; application concern, not protocol
mechanics.

## 16. Failure modes

| Failure | Detection | Recovery |
|---|---|---|
| Parachain WASM enters infinite loop | Fuel exhausted, trap | Request fails; gas charged; state rolled back |
| Relay backend down / IO timeout | Timeout folded into the quorum attestation (§5) | Result transaction records the timeout; the caller's view reads it; retry is the caller's choice |
| Single member's IO result diverges | Median outvotes it (§5) | Result unaffected; persistent divergence slashed (§12) |
| Fraudulent attested result | Pyde challenge (§10) | CHALLENGED: forwarding cut off, signers slashed, corrected history required |
| Off-image operator | Peer or attestation evidence vs pinned digest | Slash + ejection (§12) |
| Cross-parachain message attestation fails | Receiving parachain rejects | Message dropped + logged; no response |
| Member set falls below quorum | Attestations cannot reach quorum | Parachain stalls (no results, no forwarding); recovers when quorum restores; liveness slashing applies |
| Bad upgrade | Post-activation results fail re-validation | CHALLENGED; rollback to prior version record via governance |
| Name registry race | Atomic registry check | First confirmed at wave-commit wins; later one refunded |

## 17. ZK-readiness path baked in

The parachain contract stays in the deterministic WASM subset (no
floats outside canonical NaN, no threads, no non-deterministic SIMD,
no mutable globals), which keeps it amenable to future zk-WASM
proving. Bridge-capability parachains additionally benefit from
ZK-aggregated FALCON verification (one proof instead of 85 verifies
per finality cert on the counterparty side). Both are tracked
post-layer work.

## 18. References

- Narrative overview: [Chapter 13](../chapters/13-cross-chain.md)
- Plain-language one-pager: `PARACHAINS.md` at the workspace root
  (its Design resolutions section is the source of the 0.3 revision)
- Account model + naming: [Chapter 11](../chapters/11-account-model.md)
- State model + PIP-2 clustering: [Chapter 4](../chapters/04-state-model.md)
- Execution layer + WASM: [Chapter 3](../chapters/03-virtual-machine.md)
- Host function surface: [HOST_FN_ABI_SPEC](./HOST_FN_ABI_SPEC.md)
- Slashing: [SLASHING.md](./SLASHING.md)
- Threat model: [THREAT_MODEL.md](./THREAT_MODEL.md)
- Network protocol: [NETWORK_PROTOCOL.md](./NETWORK_PROTOCOL.md)

---

**Document version:** 0.3

**License:** See repository root
