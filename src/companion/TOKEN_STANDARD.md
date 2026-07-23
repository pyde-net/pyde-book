# PTS: The Pyde Token Standard

> **Status: Accepted (`pts-f/1` active).** The normative specification
> is [PIP-0005](https://github.com/pyde-net/pips/blob/main/pip-0005-pyde-token-standard.md);
> this document is the deep explainer: the flow, the design
> reasoning, and the integration guide. The guide-level introduction
> lives at [Token Standard (PTS)](../otigen/token-standard.md).
> `pts-f/1` has shipped end to end: reference implementation,
> config-only `type = "token"` generation, `otigen verify`
> conformance, and the frozen vector suite. `pts-n/1` is specified
> with a merged reference; its generation + verifier are v1.1.

PTS is Pyde's native standard for on-chain assets: **PTS-F**
(`pts-f/1`) for fungible tokens and **PTS-N** (`pts-n/1`) for
non-fungible tokens. It differs from every inherited-from-Ethereum
token standard in one structural way:

> **A PTS token is not code an author writes. It is a manifest the
> toolchain compiles.**

`type = "token"` in `otigen.toml` makes otigen generate the entire
contract (interface, storage schema, events, validation) from one
audited canonical implementation. A token manifest is config-only:
declaring functions, state, events, or shipping any source at all is
a build error. Misimplementation is not discouraged; it is
unrepresentable.

---

## 1. Why Pyde does not inherit ERC-20

The short version (the PIP's Motivation section carries the full
evidence): the ERC-20 model's failures are structural, not
incidental. Standing approvals fed a ~$450M drain economy; off-chain
`permit` signatures became the top phishing vector the year after
they were introduced; transfers carry no recipient handshake, so
$100M+ of tokens sit permanently stuck inside contracts that never
knew they arrived; mandatory transfer hooks (ERC-777) handed control
flow to attackers mid-update and were deleted from the ecosystem's
own reference library; and a spec loose enough that major tokens
return nothing from `transfer` taxed every integrator with wrapper
libraries for a decade.

Every ledger designed after Ethereum converged on the same
counter-move: **one audited implementation instead of a million
hand-rolled token contracts**, namely Solana's shared token program,
Cosmos's bank module, Aptos's Fungible Asset, Polkadot's assets
pallet. Pyde reaches the same property at the toolchain layer, with
zero engine changes, because the platform already has what it needs:
the ABI travels inside the artifact (`pyde.abi` custom section),
storage slots derive from a declared schema, and one manifest drives
four language toolchains.

## 2. The kind system

`type` on `[contract]` selects the build pipeline; `standard` selects
the generated surface:

| `type =`     | `standard =`             | Result                          |
|--------------|--------------------------|---------------------------------|
| `"contract"` | *absent* (presence = build error) | ordinary hand-written contract |
| `"token"`    | `"pts-f/1"`              | generated fungible surface      |
| `"token"`    | `"pts-n/1"`              | generated non-fungible surface  |
| `"token"`    | missing / unknown        | build error listing known standards |

`type` is a tiny, permanently-stable vocabulary. `standard` is where
the family grows: a future multi-token standard is a new *value*
(`pts-m/1`), never a new keyword. Because `standard` is one scalar
field, a fused fungible/NFT hybrid is unrepresentable.

On-chain, a PTS token deploys as plain `ContractType::Contract`. The
chain stays token-ignorant; token-ness is an ABI *shape* plus the
`standard()` view, both mechanically checkable.

## 3. The authoring flow

```
otigen new acme-token --type token        (prompts for the standard)
        │
        ▼
acme-token/otigen.toml                    ← the entire token; no src/
        │  otigen build
        ▼
validate manifest ──► generate canonical implementation
        │                     │
        ▼                     ▼
   build errors        compile to WASM + inject pyde.abi
  (see §4)                    │
                              ▼
              artifacts/acme-token.bundle/
                              │  otigen deploy
                              ▼
        ordinary contract on-chain; name registered
        (pyde_resolveName), callable like anything else
                              │
                              ▼
        otigen verify --standard pts-f <address>
        → mechanical conformance against frozen vectors
```

A complete fungible manifest:

```toml
[contract]
name     = "acme-token"        # registered chain-side at deploy
version  = "1.0.0"
type     = "token"
standard = "pts-f/1"

[token]
name           = "Acme Credits"   # 1–64 UTF-8, control chars rejected
symbol         = "ACME"           # 1–12 chars
decimals       = 9                # display hint; omit → 9 (native parity)
initial_supply = "1_000_000_000_000_000"
initial_holder = "deployer"       # optional; defaults to deployer

[token.supply]
minter     = "deployer"    # address | "deployer" | "none" → mint code stripped
manager    = "deployer"    # role rotation + metadata_uri custody
max_supply = "10_000_000_000_000_000"   # optional; omit = uncapped
burnable   = true

[token.extensions]         # consent-visible in pyde.abi forever; off = code absent
freeze       = false
pause        = false
registration = "open"      # "open" | "required" (opt-in receiving + quanta bond)
metadata_uri = ""

[token.hooks]
transfer_call = true       # opt-in settle-then-notify deposit path
```

Because a token carries no author code, generation runs from **one
canonical implementation**, so the language question does not arise,
and every deployed PTS token is verifiable by rebuilding its manifest
and comparing bytes. *Same manifest, same bytes* is the standard's
trust anchor.

## 4. The validation wall

All of it at build time, each error naming the offending key:

- `standard` required for `type = "token"`; forbidden (absent, not
  `"none"`) for `type = "contract"`; unknown values list the known
  set.
- Cross-standard key contamination: `decimals` in a `pts-n/1`
  manifest is an error; per-id metadata knobs in `pts-f/1` likewise.
  The toolchain's message, verbatim:

  ```text
  `decimals` is a pts-f field — non-fungible tokens have no fractional units
  ```
- Config-only: any `[functions.*]`, `[state]`, `[events]`, or a
  source directory on `type = "token"` is an error. Custom behaviour
  is a companion contract (§11).
- Value checks: symbol charset/length, name length + control-char
  rejection, `decimals ≤ 18`, supplies fit u128,
  `initial_supply ≤ max_supply`, role addresses well-formed, unknown
  extension keys rejected.

## 5. Conventions the whole surface obeys

- **Amounts are `u128` smallest units, everywhere.** `decimals` is a
  display-only hint, default **9**, so token units and native quanta
  (1 PYDE = 10⁹ quanta) share one mental model.
- **Mutations return nothing.** Success = no revert. Failure = a
  canonical machine-readable code (`token:insufficient_balance`,
  `token:insufficient_allowance`, `token:allowance_expired`,
  `token:invalid_recipient`, `token:overflow`, `token:not_minter`,
  `token:cap_exceeded`, `token:frozen`, `token:paused`,
  `token:not_registered`, `token:bad_receiver`) that propagates
  verbatim through `cross_call` unwinds. The
  inconsistent-boolean-return disease has no substrate.
- **No core token function is `PAYABLE`.** The engine's own gate
  rejects attached native value on every standard entry, structurally
  keeping native value out of code paths that never need to touch it. The single
  exception is the registration extension's `register()`, which is
  specified revert-free (§10).
- **Names are exact `snake_case`.** Pyde dispatches by function name;
  the names are the ABI. No overloading exists.
- **Storage economics: write zero, never `sdelete`** on balances and
  allowances; the chain has no gas refunds, so deletion is strictly
  costlier than zeroing.
- **Commit-reveal neutrality (normative):** no conformant function
  may depend on mempool visibility, same-wave ordering, or
  first-come state races. Every PTS operation must behave identically
  when wrapped in a private send. Wallets should surface private
  sends for conformant tokens.

## 6. The fungible surface (pts-f/1)

### Views: free off-chain, 50-gas dispatch on-chain

| Function | Returns | Notes |
|---|---|---|
| `standard()` | `String` | `"pts-f/1"` (runtime discovery handshake) |
| `name()` / `symbol()` / `decimals()` | `String` / `String` / `u8` | mandatory typed metadata |
| `total_supply()` / `max_supply()` | `u128` | `max_supply = 0` means uncapped |
| `balance_of(owner: Address)` | `u128` | missing slot reads as 0 |
| `balance_of_batch(owners: Vec<Address>)` | `Vec<u128>` | capped at 256; reverts above |
| `allowance(owner, spender)` | `u128` | reports 0 once expired (lazy, no keeper) |
| `allowance_expiry(owner, spender)` | `u64` | the raw expiry wave |
| `token_info()` | struct | `{name, symbol, decimals, total_supply, max_supply, minter, extension_flags}` in one call |
| `minter()` / `manager()` | `Address` | zero address = renounced |
| `is_frozen(owner)` / `is_paused()` / `is_registered(owner)` | `bool` | exist only when the extension is on |

### Mutations

| Function | Semantics |
|---|---|
| `transfer(to, amount)` | Debit caller, credit `to`; exactly two balance slots; **never invokes recipient code**. Reverts on `to == ZERO` (burn must be explicit) and `to == self` (the largest measured stuck-token class). |
| `transfer_call(to, amount, data) → u32` | Settle-then-notify: balances fully written and `Transfer` emitted **first**, then `cross_call on_token_received(operator, from, amount, data)` on `to`; reverts `token:bad_receiver` unless the 4-byte acknowledgement returns. `data` is size-capped. Replaces approve-then-pull for deposits; no standing authority is ever created. |
| `transfer_from(from, to, amount)` | Spends a live (unexpired) allowance, decrements, moves balance; three pair-unique slots. Operator attribution is derivable from the enclosing transaction, not the event. |
| `approve(spender, amount)` | Compatibility sugar: sets the allowance with the maximum TTL auto-applied. Routers pattern-match the name; "unlimited forever" stays unrepresentable. |
| `increase_allowance(spender, amount, expiry_wave)` / `decrease_allowance(spender, amount)` / `revoke_allowance(spender)` | Delta-based: the approve race is dead by construction. Every allowance carries a mandatory expiry wave, TTL-capped (≈ one year of waves). Amount + expiry live in one Borsh slot. Revoke writes zero. |
| `set_allowance_exact(spender, expected_remaining, new_remaining, expiry_wave)` | Compare-and-set: reverts unless current remaining equals `expected_remaining`, which closes the delta-accumulation footgun. Documented interaction: under commit-reveal, the CAS can fail at reveal time if state moved. |
| `mint(to, amount)` | Minter role only; reverts above `max_supply`; emits `Transfer(ZERO, to, amount)`. |
| `burn(amount)` / `burn_from(from, amount)` | Decrement supply; emit `Transfer(x, ZERO, amount)`; `burn_from` spends an allowance. |
| `set_minter(new)` / `set_manager(new)` / `set_freezer(new)` / `set_paused(bool)` / `freeze(account, bool)` | Role management + extension operations. Manifest-absent roles have no code. Renounce = set to zero, provably. |
| `register()` / `deregister()` | Registration extension only; see §10. |

## 7. Delegated spending, redesigned

Three layers, ordered by preference:

1. **Transient-first.** `transfer_call` covers the dominant DeFi
   flows (vault deposits, escrow funding, marketplace payment) in one
   atomic message. No standing authority exists: nothing to phish,
   nothing to revoke, nothing to forget.
2. **Bounded, expiring allowances** where standing delegation is
   genuinely needed. Deltas kill the overwrite race; mandatory expiry
   (wave-denominated, a deterministic clock wallets render as dates)
   makes even the laziest grant self-destruct; the amount and expiry
   share one storage slot; `allowance()` lazily reports zero after
   expiry so nobody pays to clean up.
3. **No off-chain approval signatures.** `permit`-class primitives
   moved granting into invisible signatures and became the #1 drainer
   vector. Pyde does not need them: gasless flows use the platform's
   `SPONSORED` attribute, private flows use commit-reveal, and
   session keys (v2) will deliver scoped account-layer authority. A
   FALCON-signed **one-shot payment authorization** (exact
   recipient, exact amount, wave-window validity, single-use id) is
   reserved as the `pts-f/2` extension: a signed *check*, never a
   signed blank.

## 8. `transfer_call` and the receiver protocol

The recipient side implements one standardized entry:

```rust
fn on_token_received(operator: Address, from: Address,
                     amount: u128, data: Vec<u8>) -> u32
```

Arguments are filled by the **token**, never spoofable by the sender.
The acknowledgement (a `u32` whose little-endian bytes are the
Blake3-derived protocol tag) exists because of Pyde's dispatch rule
that a function-name miss routes to the recipient's `fallback`: a
fallback cannot return the acknowledgement, so a `transfer_call` to a
contract that does not genuinely handle tokens **reverts and
refunds** instead of silently vanishing.

Safety under Pyde's exact reentrancy model (same-function re-entry
blocked per `(contract, function)`; cross-function re-entry not
blocked):

What a malicious recipient **can** do: revert (aborting the whole
transfer atomically; that is the consent feature), burn the gas the
caller reserved (bounded and priced), or re-enter `transfer` /
`transfer_from` / the approval family as an *ordinary caller against
fully settled state*, so it can only move funds it owns or is validly
allowed, exactly as in a fresh transaction.

What it **cannot** do: re-enter `transfer_call` itself (engine
per-function guard); observe half-updated token state (none exists at
callback time; settlement completes before notification); forge
`operator`/`from`; inherit signer privilege (the callback frame sees
`caller()` = the token contract); or spoof deposits, because the
generated receiver wrapper authenticates `caller()` against the
author's declared token allowlist *before* user code runs, and a
receiver marked `REENTRANT` is a build error.

One normative integrator rule remains: a contract that calls
`transfer_call` must itself follow checks-effects-interactions,
because the engine guards its own function, not its siblings.

There are **no sender hooks**, and the plain `transfer` path never
invokes code. Both are deliberate: mandatory hooks are the exact
mechanism behind the costliest token exploits on record.

## 9. Storage, events, and parallel execution

Typed-storage layout (slots host-derived as
`Poseidon2(self ‖ field ‖ keys…)`):

| Field | Shape | Written by |
|---|---|---|
| `token_name`, `token_symbol`, `token_decimals` | scalars | init only |
| `total_supply`, `max_supply` | `u128` scalars | **mint/burn only, never the transfer path** |
| `balances` | `map<address → u128>` | transfer paths (exactly the two parties' slots) |
| `allowance_amounts` / `allowance_expiries` | sibling `map<(address, address)>` → `u128` / `u64` | approval family + `transfer_from` |
| `minter`, `manager`, `freezer` | address scalars | role ops only |
| `frozen` | `map<address → bool>` | freeze extension only; absent otherwise |
| `registered` | `map<address → u128 bond>` | registration extension only |

Consequences:

- **Conflict-free transfers.** Under Block-STM, conflicts are per
  storage slot. Two transfers between disjoint parties touch disjoint
  slots and commute. No supply cell, fee sink, or counter is written
  on transfer, so the hot-shared-cell mistake other chains spent
  years retrofitting away is excluded at genesis. Generation also emits
  correct per-function access lists (the prefetch hint humans get
  wrong).
- **Slot-computable balances.** The schema is canonical, so any
  wallet or light client derives the slot for `(token, holder)` and
  reads (or Merkle-proves) a balance directly from state, no
  contract call, no indexer.
- **Never-held vs zero.** `SLOAD_MISSING` is distinguishable from an
  explicit zero, so holder-set membership is knowable.

Events (Borsh data payloads; `topic0 = Blake3(signature)`):

| Event | Indexed | Data | Notes |
|---|---|---|---|
| `Transfer(address,address,uint128)` | `from`, `to` | `{amount}` | Mint: `from = ZERO`. Burn: `to = ZERO`. One family carries all supply accounting. The signature is byte-identical to the pre-PTS example, so existing subscriptions survive. The 4th topic is **reserved** for a pts-f/2 additive extension. |
| `Approval(address,address,uint128,uint64)` | `owner`, `spender` | `{remaining, expiry_wave}` | absolute post-state on every explicit allowance mutation |
| `RoleTransfer(bytes32,address,address)` | `role`, `new` | `{previous}` | `role` is a precomputed 32-byte identifier (`Blake3("minter")`, …); renounce is publicly provable as `new = ZERO` |
| `Freeze(address,bool)` / `Registration(address,bool,uint128)` | account | n/a | extensions only |

A wallet enumerates holdings with one `pyde_getLogs` scan
(`topic0 = Transfer-sig`, `topic2 = my address`), shape-checks each
candidate's `pyde.abi`, reads metadata with free views, and resolves
the registered chain-side name, with no third-party indexer in the
loop.

## 10. Supply, control, and the consent rule

Roles are separable, rotatable, and individually renounceable by
zeroing. The consent rule is the anti-rug property: **capabilities
are declared in the manifest at creation, baked into the artifact's
ABI forever, and never retroactively enableable.** If the manifest
said `freeze = false`, the freeze code does not exist in the deployed
bytes, so a wallet proves "this token can never freeze me" by
reading the artifact.

- `minter`: mints up to `max_supply`; `"none"` strips the code.
- `manager`: rotates roles and custodies `metadata_uri`; renouncing
  freezes governance permanently.
- `freezer` *(extension)*: per-account freeze/unfreeze, atomic in
  one transaction.
- `pauser` *(extension)*: a global incident brake (`set_paused`),
  separate role, for live-drain response; per-account freeze and
  global pause are distinct statutory needs.
- **Registration** *(extension, `"required"` mode)*: opt-in
  receiving. Transfers to unregistered accounts revert;
  `register()` escrows a small native-quanta bond, returned on
  `deregister()`. This is the anti-dust knob, and it is the issuer's
  declared, machine-readable choice, with default `"open"` because
  opt-in kills airdrop UX. `register()` is the one payable function in the
  standard and is specified **revert-free by construction**
  (idempotent double-registration, validation before any failure
  path) so bonding stays predictable and atomic for wallets and
  integrators.
- **Upgradeability**: token code is immutable. Issuers wanting
  upgrade paths use the delegate-call proxy pattern, and wallets MUST
  surface proxied tokens as loudly as freeze/mint flags: a proxy can
  swap semantics, and it is the one hole static conformance cannot
  close.

## 11. Custom logic lives beside the token

A PTS token contains exactly the generated surface. Vesting,
staking, governance, fee logic: all of it is an ordinary
`type = "contract"` **companion** in the same workspace, holding and
moving tokens through the same standard surface every integrator
uses:

```
acme/
├── otigen.toml              # workspace
├── acme-token/
│   └── otigen.toml          # type = "token" — config only
└── acme-vesting/
    ├── otigen.toml          # type = "contract"; ctor takes @acme-token
    └── src/lib.rs           # ordinary contract: transfer_call deposits in,
                             # transfer out, allowances where truly needed
```

This line is what keeps the reproducibility guarantee universal and
makes "a conformant token cannot contain a drain function" a literal
truth rather than a flagged-extras caveat. Needs that genuinely
belong inside the token enter as declared, generated, audited
`pts-f/2` extensions, never as author code.

## 12. The non-fungible surface (pts-n/1)

Same philosophy, per-id state:

- Storage: `owners: map<u64 → address>` (per-id slot; transfers of
  distinct ids never conflict), `balances: map<address → u64>`,
  `token_approval: map<u64 → address>` (cleared atomically on
  transfer), `operators: map<(address, address) → bool>`,
  `token_uri: map<u64 → string>` (16 KB values make real on-chain
  metadata viable), `next_id: u64`.
- Surface: `owner_of(id)`, `balance_of(owner)`,
  `transfer_from(from, to, id)`, `transfer_call(to, id, data)` →
  `on_nft_received(operator, from, id, data) → u32` under
  identical settle-then-notify + acknowledgement rules,
  `approve(spender, id)`, `set_approval_for_all` /
  `is_approved_for_all`, `mint(to, uri)` (minter role), `burn(id)`.
- Events: `Transfer(from, to, id)` all three indexed; `Approval`;
  `ApprovalForAll`.
- Deliberate exclusions: **no royalties in the spec** (a decade of
  evidence says an interface cannot enforce economics against
  adversarial marketplaces; royalties are marketplace policy), **no
  fused fungible/NFT type** ever.
- Honest v1 cost: sequential `next_id` is a hot slot that serializes
  mass mints; a pre-partitioned id-range extension is sketched for
  parallel drops.

## 13. Conformance and reproducible builds

Two mechanical checks, no interface-probing handshake:

1. **Shape check**: `otigen verify --standard pts-f <address|bundle>`
   validates the deployed artifact's functions, attribute bits,
   parameter types, events, and state schema against the frozen
   `pts-f/1` shape and its byte-level conformance vectors.
2. **Reproducible build**: rebuild the manifest, compare bytes.
   Because tokens are config-only and generated from one canonical
   implementation, equality is expected, not hoped for.

The generator itself is the concentrated trust point, and the PIP
treats that as a first-class deliverable: an independent audit of the
generator, a malicious-receiver conformance battery, and vectors
pinned before `pts-f/1` freezes.

## 14. Deliberately absent

| Absent | Because |
|---|---|
| `permit` / off-chain approval signatures | became the top phishing vector where introduced; platform sponsorship + commit-reveal + session keys cover the legitimate needs |
| sender hooks / mandatory recipient hooks | the costliest exploit mechanism in token history; notification is opt-in and post-settlement |
| fee-on-transfer, rebasing, reflection | the "weird token" pathologies that break integrator invariants; excluded by the config-only rule |
| royalties (PTS-N) | interfaces cannot enforce economics; marketplace policy |
| fused fungible/NFT | violates both parents' invariants; unrepresentable under a scalar `standard` |
| `ContractType::Token` engine variant | the chain stays token-ignorant; token-ness is an ABI shape |

## 15. Rollout

1. **Reference implementations**: `fungible-token` and `nft-token`
   examples implementing the pts-f/1 and pts-n/1 surfaces on today's
   toolchain, plus updated AMM/marketplace integrations as reference
   receivers.
2. **PIP-0005**: the normative spec with conformance vectors and the
   malicious-receiver battery.
3. **Manifest generation**: `type = "token"` in otigen from one
   canonical implementation; `otigen verify --standard`; playground
   templates that start from a manifest, not copied token code.
4. **Reserved pts-f/2**: the FALCON one-shot payment authorization
   and the fourth `Transfer` topic, shaped now because the ABI
   compatibility ratchet makes them unpurchasable later.
