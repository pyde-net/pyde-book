# Multi-Contract Workspaces

Most real projects are more than one contract: a token plus a vault, a
registry plus the things it registers, a router plus its pools. A
**workspace** groups several contracts that build, test, and deploy
together, and lets one contract's constructor take another's deployed
address without you copy-pasting hex.

`otigen init` scaffolds a workspace. `otigen new` adds a contract to it.
Every command you already know (`build`, `test`, `deploy`, `inspect`,
`verify`, `call`) works across the whole workspace or, with
`--contract <name>`, against a single member.

**One contract per crate.** Each member is a self-contained project with
its own `otigen.toml`, source, and tests. A Rust member is its own
crate. The workspace is the coordination layer; it doesn't merge the
members into one binary.

For the single-contract flow this chapter builds on (writing a
contract, the bundle internals, receipts), see [Your First
Contract](first-contract.md) and [Shipping Contracts](shipping.md).

---

## 1. Scaffold a workspace

```bash
otigen init shop --lang rust
cd shop
```

```text
  ✓ Scaffolded shop — Rust workspace (starter member: contracts/counter/)

  Next steps:
    cd shop
    otigen new <name>   # add another contract
    otigen test         # build + test every member
    otigen deploy       # against `otigen devnet`
```

What landed:

```text
shop/
├── otigen.toml            # the workspace manifest (members, order, args)
├── .gitignore             # ignores artifacts/, per-member build output
├── README.md              # workspace cheatsheet
├── Makefile               # build / test / deploy / clean
└── contracts/
    └── counter/           # the starter member — a full single-contract project
        ├── Cargo.toml
        ├── otigen.toml
        ├── src/lib.rs
        └── tests/contract.test.toml
```

The root `otigen.toml` carries a `[workspace]` table; the member under
`contracts/counter/` is an ordinary single-contract project. The starter
is named `counter` (its `[contract].name`): **rename it before a real
deploy**, because on-chain names are globally unique.

`--lang` picks the language for the starter member; `TinyGo`,
`AssemblyScript`, and `C` scaffold the same counter starter in that
language.

## 2. Add a contract

Run `otigen new <name>` from the workspace root:

```bash
otigen new vault --from counter --lang rust
```

```text
  ✓ Added vault to the workspace — Rust contract from `counter`

    contracts/vault/
    ├─ src/lib.rs                 the contract (start here)
    ├─ otigen.toml                state schema · functions · networks
    └─ tests/contract.test.toml   behaviour tests

  Next steps:
    otigen test --contract vault    # test just this member
    otigen deploy                   # deploy every member in order
```

This scaffolds `contracts/vault/` and registers it in the root manifest,
appending `contracts/vault` to `[workspace].members` and `vault` to
`[workspace].order`, preserving your formatting and comments. (`otigen
new` run *outside* a workspace still scaffolds a standalone
single-contract project, exactly as before.)

## 3. The workspace manifest

```toml
# shop — Pyde workspace manifest.

[workspace]
# Member contract directories (relative to this file). `otigen new`
# appends here automatically.
members = ["contracts/counter", "contracts/vault"]

# Deploy sequence, by member CONTRACT name (the [contract].name inside
# each member's manifest — not the directory). A contract must appear
# after every contract it references via @name.
order = ["counter", "vault"]

# Per-member constructor arguments. A "@name" string resolves to that
# member's deployed address at deploy time; wallet names and hex
# addresses are plain strings.
[workspace.args]
vault = ["@counter", "devnet-0"]

[network.default]
name = "devnet"

[network.devnet]
rpc_url  = "http://127.0.0.1:9933"
chain_id = 31337

[deploy]
gas_limit = 10_000_000
gas_price = "auto"
```

Three things to know:

- **`members`** are directory paths; **`order`** and **`[workspace.args]`**
  key off the member's `[contract].name`. They differ if you rename a
  contract without moving its directory.
- **`order`** is the deploy sequence. When it's set, it must list every
  member. Otherwise a member would be silently skipped. A contract must
  come *after* everything it references via `@name`.
- **`[workspace.args]`** are constructor arguments, one array per member.
  A `@name` entry resolves to that member's deployed address; everything
  else (wallet names, `0x…` addresses, numbers, booleans) is passed
  through to the member's declared constructor inputs (the `[functions.*]` entry tagged `constructor`).

The workspace `[network.*]` tables are **authoritative**: every member
deploys, and every workspace-level `call` / `inspect` / `verify`
resolves, against these, not against a member's own network table.

## 4. Build & test the whole workspace

```bash
otigen build            # build every member → artifacts/<name>.bundle/
otigen test             # build + test every member
```

`otigen build` compiles and bundles each member into the shared
`artifacts/` directory at the workspace root, and prunes bundles for
members you've removed. `otigen test` mirrors it: it builds, then runs
each member's `tests/*.test.toml`, with a workspace summary.

```text
── counter ─────────────────────────────────────────────
  test result: ok. 3 passed; 0 failed; 0 skipped (3 ran)
── vault ─────────────────────────────────────────────
  test result: ok. 3 passed; 0 failed; 0 skipped (3 ran)

  ✓ workspace test: 2 contract(s) passed
```

A member with no test file is skipped (`⊘ <name> (no tests)`), not
failed. Scope either command to one member with `--contract <name>`;
`--watch` isn't supported at the workspace level (cd into a member to
watch it).

## 5. Deploy

```bash
otigen deploy --from devnet-0
```

The deployer account comes from `--from`, or from `[wallet]
default_account` in the workspace manifest if you set one. `otigen
deploy` at a workspace root does the whole thing in one command:

1. **Builds every member first** (compile + bundle), so a deploy always
   uses fresh artifacts. There's no separate "run `otigen build` first"
   step.
2. **Prints the plan**, then deploys each member in `[workspace].order`,
   resolving `@name` cross-references as it goes.

```text
  ✓ Built 2 contract(s) into ./artifacts
  Deploy plan:
    Network:  devnet (chain 31337)
    RPC:      http://127.0.0.1:9933
    Account:  devnet-0
    Order:    counter → vault
  ▸ counter (nonce 0)
    ✓ counter → 0xf92c27a16aa74d5aca7be4d9072836d1fe220c66b7b9cb194b6fac83185370cf
  ▸ vault (nonce 1)  args: [0xf92c27a1…, devnet-0]
    ✓ vault → 0xd2a03f70120d5fe24f71134dfa9d9835c1d56d32ef68077cf8fa8601f4cef1ee
  ✓ Deployed 2 contract(s). Addresses cached at ./artifacts/deployments/devnet.json
```

Notice `vault`'s line shows its **resolved** args: the `@counter` in the
manifest has already become `counter`'s real deployed address, so you
see exactly what goes on-chain before it's submitted. The wallet is
unlocked once and the nonce is sequenced locally across all members.

### Preview without deploying

`--dry-run` prints the full plan (network, RPC, account, order, and
each member's resolved args, with `@refs` shown as a zero-address
placeholder) and submits nothing, builds nothing. It never asks for a
wallet password
and doesn't need a running node: the preview is fully offline.

```bash
otigen deploy --dry-run --from devnet-0
```

```text
  Deploy plan (dry-run — nothing submitted):
    Network:  devnet (chain 31337)
    RPC:      http://127.0.0.1:9933
    Account:  devnet-0
    Order:    counter → vault
  ▸ counter
  ▸ vault  args: [0x0000…0000, devnet-0]
  ✓ dry-run — 2 contract(s) prepared, none submitted
```

### One member, and re-runs

- `otigen deploy --contract vault` deploys just that member.
- With `--contract`, constructor args can come straight from the command
  line instead of `[workspace.args]`, which is handy for one-off deploys
  with values you don't want to commit to the manifest:

  ```bash
  otigen deploy --contract usdc usdc-token USDC 6 100000000000000 --from devnet-0
  ```

  Positional args override that member's `[workspace.args]` entry;
  `@name` values still resolve to member addresses; `--args 0x<hex>` is
  the raw-calldata escape hatch, and `--value <quanta>` funds the
  constructor. (Without `--contract`, CLI args are rejected: one arg
  set can't address several members.)
- Deploy is **idempotent**: on a re-run, a member that's already
  registered on-chain (by name) is skipped, so re-running after a
  partial failure only deploys what's missing. If you passed explicit
  CLI args and the member is skipped, otigen warns you they had no
  effect (a registered name can't be deployed twice).

```text
  ✓ Deployed 0 contract(s), 2 already deployed, skipped.
```

The deployed addresses are cached at
`artifacts/deployments/<network>.json`, keyed by network so different
chains never clobber each other's address book.

## 6. See what's deployed

```bash
otigen addresses
```

```text
  Deployments on devnet (2 member(s)):
  counter  0xf92c27a16aa74d5aca7be4d9072836d1fe220c66b7b9cb194b6fac83185370cf
  vault    0xd2a03f70120d5fe24f71134dfa9d9835c1d56d32ef68077cf8fa8601f4cef1ee
```

Members that haven't been deployed to the selected network show
`(not deployed)`. `--network <name>` lists a different network's
deployments; `--json` emits the raw `name → address` map for scripts.

## 7. Call, inspect, verify: by member name

From the workspace root, address a member by its `[contract].name`.
otigen resolves the member's manifest for the typed-arg schema and the
target address, over the authoritative workspace network:

```bash
otigen call vault increment --from devnet-0    # a state-changing call
otigen call vault get                           # a view read
otigen inspect vault                            # on-chain account + ABI
otigen verify vault                             # bundle == deployed bytecode
```

```text
  Mode:     view (pyde_call — no tx, no gas, no nonce)
  ✓ Call succeeded.
  Return:   1
```

`inspect` and `verify` accept `--rpc-url` to target any endpoint
directly, bypassing the manifest, which is useful for querying a member
on a chain you don't have the project tree for. For the full read
surface (`--field`, `--state-field`, byte-diffing a mismatch), see
[Inspect & Verify](inspecting.md).

## When to use a workspace

Reach for a workspace when your contracts are deployed and versioned
together and reference each other. If you're writing a single standalone
contract, `otigen new <name>` (outside a workspace) still gives you a
plain single-contract project with no workspace overhead. You can
always start single and regroup later.

| | Single contract | Workspace |
| --- | --- | --- |
| Scaffold | `otigen new <name>` (standalone) | `otigen init <name>` |
| Root manifest | `[contract]` | `[workspace]` |
| Deploy | one bundle | all members in `order`, `@ref`-resolved |
| Cross-references | copy addresses by hand | `@name` in `[workspace.args]` |
| Target one | (it's the only one) | `--contract <name>` |
