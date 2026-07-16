# Token Standard (PTS) — Planned

> **Status: accepted, pre-implementation.** This page introduces
> Pyde's native token standard — **PTS** (Pyde Token Standard) — and
> the otigen features that will enforce it. The specification is
> ratified; none of the tooling is shipped yet.
> The normative specification is
> [PIP-0005](https://github.com/pyde-net/pips/blob/main/pip-0005-pyde-token-standard.md);
> the deep explainer — full surface, storage layout, receiver
> protocol, conformance — is the
> [Token Standard companion](../companion/TOKEN_STANDARD.md). The interface itself ships first as ordinary reference
> examples (`fungible-token`, `nft-token`); the manifest type described
> below is the second phase.

Pyde does not inherit ERC-20. The research behind that decision is a
long catalog of structural losses — standing-approval drains, tokens
stranded in contracts that never knew they arrived, transfer hooks
that fired mid-update — and one convergent lesson from every ledger
that came after Ethereum: **the winning token standards moved balances
out of hand-written per-token code and into one audited
implementation.** Solana's shared token program, Cosmos's bank module,
Aptos's Fungible Asset, and Polkadot's assets pallet all did it at the
platform layer.

Pyde gets the same property at the **toolchain** layer, with zero
engine changes, because it has ingredients no other chain has at
genesis: the ABI travels inside the artifact (`pyde.abi` custom
section), storage slots are host-derived from a declared schema, and
one manifest already drives contract generation in four languages.

---

## The standard is a manifest type

A token author will not write token code. They will write a manifest:

```toml
[contract]
name     = "acme-token"       # registered chain-side → pyde_resolveName
version  = "1.0.0"
type     = "token"            # contract | token — selects the build pipeline
standard = "pts-f/1"          # which generated surface; required for tokens

[token]
name           = "Acme Credits"
symbol         = "ACME"
decimals       = 9            # display hint; omit → 9 (1 PYDE = 10⁹ quanta)
initial_supply = "1_000_000_000_000_000"

[token.supply]
minter     = "deployer"       # address | "deployer" | "none" → mint code stripped
max_supply = "10_000_000_000_000_000"
burnable   = true

[token.extensions]            # consent-visible in pyde.abi forever; off = code absent
freeze       = false
pause        = false
registration = "open"         # "open" | "required" (opt-in receiving + quanta bond)

[token.hooks]
transfer_call = true          # opt-in settle-then-notify deposit path
```

`otigen build` sees `type = "token"` and generates the canonical
interface, storage schema, events, and invariant-preserving internal
APIs — the same audited implementation regardless of language — then
compiles it to a normal contract WASM. The chain never learns what a
"token" is; the artifact deploys, dispatches, and meters exactly like
any hand-written contract.

An NFT is a token too — non-fungible is in the name — so both
standards live under one `type = "token"`, differentiated by the
`standard` field:

| `type =`     | `standard =` | Result                                     |
|--------------|--------------|--------------------------------------------|
| `"contract"` | *(absent — presence is a build error)* | ordinary hand-written contract |
| `"token"`    | `"pts-f/1"`  | generated fungible surface: balances, expiring allowances, `transfer` / `transfer_call` / pull path |
| `"token"`    | `"pts-n/1"`  | generated non-fungible surface: per-id owners, approvals, on-chain `token_uri` |
| `"token"`    | *(missing or unknown)* | build error listing the known standards — fungible vs non-fungible is not a guessable default |

`type` stays a tiny, stable vocabulary (which build pipeline);
`standard` is where the family grows (a future multi-token `pts-m/1`
adds a value, not a keyword). And because `standard` is a single
scalar field, a fused fungible/NFT hybrid is not merely forbidden —
it is unrepresentable.

The `[token]` section is shared by both standards, but its **allowed
keys are a function of the declared standard**, enforced at build
time: `decimals` in a `pts-n/1` manifest is a build error ("a pts-f
field — non-fungible tokens have no fractional units"), per-id
metadata knobs in a `pts-f/1` manifest likewise, and every such error
names the offending key and the standard that owns it. And a token
manifest is **config-only**: any `[functions.*]`, `[state]`, or
`[events]` section — or a source directory at all — on
`type = "token"` is a build error. Custom behaviour lives in a
companion contract beside the token (below), never inside it, so
overriding or extending standard logic is not something the schema
can express.

## What the generated surface fixes

Every deviation from the ERC-20 shape points at a documented loss
class:

- **Revert-only mutations.** No boolean returns to mis-handle;
  failures are canonical machine-readable codes
  (`token:insufficient_balance`, …) that propagate verbatim through
  `cross_call` unwinds.
- **Expiring, delta-only allowances.** Every grant carries a mandatory
  expiry wave (TTL-capped); increase/decrease deltas replace raw
  overwrites, killing the approve race by construction. "Unlimited
  forever" is unrepresentable. A plain `approve(spender, amount)`
  survives as compatibility sugar that auto-applies the maximum TTL.
- **Settle-then-notify deposits.** `transfer_call` writes balances and
  emits the event *first*, then cross-calls the recipient's
  `on_token_received`, which must return a 4-byte acknowledgement —
  a name-miss falling through to a fallback cannot silently swallow
  tokens. Plain `transfer` never invokes recipient code.
- **Consent-visible control.** Mint/freeze/pause capabilities are
  declared in the manifest, therefore baked into the deployed
  artifact's ABI forever — never retroactively enableable, renounced
  by provable zeroing. A wallet answers "can this issuer freeze me?"
  by reading the artifact, not by trusting documentation.
- **Parallel-execution-ready layout.** Per-holder balance slots;
  `total_supply` is written only by mint/burn, never on transfer;
  extensions that are off compile *out* (no inert shared reads). Two
  transfers between disjoint parties touch disjoint slots and commute
  under Block-STM. Generation also emits correct per-function access
  lists — the prefetch hint humans get wrong.

## Custom logic lives beside the token, not inside it

A PTS token contains exactly the generated surface — nothing else.
This is a hard line, not a missing feature. The moment author code
shares a module with the token, the reproducibility guarantee — *same
manifest, same bytes: verify any deployed token by rebuilding its
manifest and comparing hashes* — degrades into "the standard subset is
conformant, plus unreviewed extras", and every wallet and scanner
inherits the job of flagging the extras. A config-only token cannot
contain a drain function, because it cannot contain any function the
generator didn't write. The patterns that genuinely require code
inside a token — fee-on-transfer, rebasing, reflection — are precisely
the pathologies the standard exists to kill.

Custom behaviour is a **companion contract**: a vesting schedule, a
staking pool, a governance vault — an ordinary `type = "contract"`
member that holds and moves tokens through the same standard surface
every other integrator uses (`transfer_call` deposits in, `transfer`
out, allowances where standing delegation is genuinely needed).
[Multi-contract workspaces](workspaces.md) make the pairing one
project: the companion takes the token's deployed address as a
constructor reference, and build, test, and deploy run across both
members with one command.

If a future need genuinely belongs inside the token — the way
vote-checkpointing hooks balance changes on other chains — it enters
as a **declared standard extension** in a `pts-f/2`: generated,
audited, and consent-visible in the artifact like freeze and pause.
Never as author code.

Contracts that want to *react* to incoming deposits (vaults, escrows,
marketplaces) opt in from the receiving side. The author declares the
intent and writes only business logic:

```toml
[receiver]
accept_tokens = "any"         # or an explicit allowlist
```

The generated `on_token_received` wire function authenticates the
calling token against the allowlist *before* user code runs, decodes
arguments, invokes the author's handler, and returns the
acknowledgement. Marking a receiver `REENTRANT` is a build error. The
checks that history shows authors forget are exactly the ones that are
no longer written by hand.

## Conformance is mechanical

Because the ABI, state schema, and events ship inside the artifact,
standard-compliance is a static property of deployed bytes — no
interface-probing handshake:

```bash
otigen verify --standard pts-f <address|bundle>
```

will check a deployed artifact's functions, attribute bits, parameter
types, events, and state schema against the frozen `pts-f/1` shape and
its byte-level conformance vectors.

## Deliverables, in order

1. **Reference examples first** (no new tooling): the PTS-F/1 and
   PTS-N/1 interfaces implemented as ordinary contracts —
   `fungible-token`, `nft-token` — plus updated integrations (AMM,
   marketplace) as the reference receivers.
2. **The PIP:** frozen surface, byte-level conformance vectors, and a
   malicious-receiver test battery.
3. **`type = "token"` generation** (both standards) in otigen from
   one canonical implementation — tokens carry no author code, so the
   build is language-independent and every deployed token verifies by
   rebuilding its manifest and comparing bytes. Per-language work
   shrinks to the receiver wrapper macros. Includes an independent
   audit of the generator itself — one audited implementation is only
   as good as its generator.
4. **`otigen verify --standard`** and playground templates that start
   from a manifest, not from copied token code.

A reserved second version (`pts-f/2`) is already shaped: a
FALCON-signed one-shot payment authorization (exact recipient, exact
amount, wave-window validity, single-use id) and the fourth `Transfer`
event topic, both reserved now because the ABI compatibility ratchet
makes them unpurchasable later.
