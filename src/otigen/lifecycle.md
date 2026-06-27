# Lifecycle

Operating a deployed contract over time: upgrading the logic, pausing it under incident, retiring it permanently.

> **Honest status (v1).** The four CLI subcommands — `otigen upgrade`, `otigen pause`, `otigen unpause`, `otigen kill` — exist and sign correctly, but the chain has **no `TxType::Lifecycle` handler** yet. Submitting one today is refused at the CLI by an `EngineNotReady` gate (see §4 below). Per [`OTIGEN_BINARY_SPEC §8.2`/`§8.3`](../companion/OTIGEN_BINARY_SPEC.md), v1 ships **no chain-side upgrade/pause/unpause/kill tx types**. The patterns in §2 (proxy upgrades, author-declared pause / kill booleans) are how you get the same operational outcomes today.

---

## 1. What the chain provides today

| Need | v1 path | v2 path (planned) |
| --- | --- | --- |
| Replace contract logic | Proxy + `delegate_call`; admin swaps the implementation slot | Native `upgrade` tx → engine swaps the code blob at the same address |
| Halt entrypoints under incident | Author-declared `paused: bool` in `[state]`; every entry asserts `!paused` | Native `pause` flag on `Account` set by a `pause` tx |
| Retire a contract irreversibly | Author-declared `killed: bool`; every entry reverts when set | Native `kill` tx zeroing the contract's `code_hash` |
| Tie any of the above to an owner | Author-managed in storage; the contract is its own authority | `Account.deployer` enforced by the engine |

Two things to internalize:

1. **There is no native "contract owner" concept in v1.** Accounts have `auth_keys`, but a contract account is its own authority surface. Authoring an "owner" means storing an `Address` in `[state]` and checking `pyde::caller() == stored_owner` in your guarded entrypoints. The CLI's lifecycle commands assume engine support that does not exist; they cannot enforce ownership for you today.
2. **The CLI surface is committed in code so the day the engine catches up the wire shape doesn't shift.** Until then, the four subcommands refuse to submit. See [the engine ask in `/tmp/pyde-engine-lifecycle-ask-2026-06-18.md`](https://github.com/pyde-net/engine/issues) for the proposed `TxType::Lifecycle` + `LifecyclePayload` + `paused: bool` + `deployer: Address` shape on `Account`.

---

## 2. The v1 patterns

### 2.1 Upgrade — the proxy pattern

The canonical v1 upgrade story is a proxy contract that holds the admin + implementation address in `[state]` and forwards every call via `pyde::delegate_call`. To upgrade you deploy a new implementation contract and submit a tx that overwrites the implementation slot.

The [`upgradeable-proxy`](https://github.com/pyde-net/otigen/tree/main/examples/upgradeable-proxy) template is the worked example. Skeleton:

```rust
#[pyde::declare_storage]
pub mod state {
    pub admin: Address,
    pub implementation: Address,
    pub init_guard: u64,         // set non-zero on first init
}

#[pyde::entry]
fn init(admin: Address, implementation: Address) {
    if state::init_guard().read() != 0 {
        pyde::revert("proxy: already initialized");
    }
    state::admin().write(&admin);
    state::implementation().write(&implementation);
    state::init_guard().write(1);
}

#[pyde::entry]
fn upgrade(new_implementation: Address) {
    let caller = pyde::caller();
    if caller != state::admin().read() {
        pyde::revert("proxy: not admin");
    }
    state::implementation().write(&new_implementation);
}

#[pyde::entry(fallback)]
fn fallback() {
    let impl_addr = state::implementation().read();
    pyde::delegate_call(&impl_addr, pyde::calldata(), pyde::gas_left());
}
```

The proxy address never changes. Storage lives in the proxy. The implementation contract is a pure logic blob — its address rotates each upgrade. Callers point at the proxy's address forever.

Trade-offs vs a native engine upgrade:

- **Cost**: every call pays for a `delegate_call` indirection. Measured at ~3-7% gas overhead in current devnet runs.
- **Storage discipline**: the implementation's `[state]` slot derivation lives in the proxy's address space. Renaming a field is a wire break across upgrades (the slot hash changes); use append-only field order.
- **Admin key risk**: lose the admin key, lose upgradability. Pair with a multisig for production (see [`simple-multisig`](https://github.com/pyde-net/otigen/tree/main/examples/simple-multisig)) once the simple-multisig template's migration to `#[pyde::entry]` lands (tracked separately).

### 2.2 Pause — author-declared boolean

Add a `paused: bool` field and assert it at every state-mutating entrypoint. Reads stay open by convention.

```rust
#[pyde::declare_storage]
pub mod state {
    pub owner: Address,
    pub paused: bool,
    // ... your contract fields
}

fn require_unpaused() {
    if state::paused().read() {
        pyde::revert("contract: paused");
    }
}

fn require_owner() {
    if pyde::caller() != state::owner().read() {
        pyde::revert("contract: not owner");
    }
}

#[pyde::entry]
fn pause() {
    require_owner();
    state::paused().write(true);
}

#[pyde::entry]
fn unpause() {
    require_owner();
    state::paused().write(false);
}

#[pyde::entry]
fn transfer(to: Address, amount: u128) {
    require_unpaused();
    // ... transfer logic
}
```

In-flight transactions that were already accepted into the mempool before the `pause` tx commits will still execute (the pause only affects waves committed AFTER the pause). View calls via `otigen call <addr> <view-fn>` always work regardless; they don't enter consensus.

### 2.3 Kill — author-declared terminal flag

Same shape as `paused`, but the entry assertions never check for an unpause counterpart. Once set, the contract refuses every mutation forever.

```rust
fn require_alive() {
    if state::killed().read() {
        pyde::revert("contract: killed");
    }
}

#[pyde::entry]
fn kill() {
    require_owner();
    state::killed().write(true);
}
```

Storage is retained on-chain — there is no v1 mechanism to free the contract's slot space or release its name. If a future chain release adds a native `kill` tx, the engine ask proposes zeroing `code_hash` (effectively deleting the bytecode while keeping the address registered to prevent name-squatting).

---

## 3. What the CLI subcommands do today

The four subcommands (`upgrade`, `pause`, `unpause`, `kill`) are scaffolded against the future `TxType::Lifecycle` wire shape:

```bash
otigen upgrade <addr> --bundle ./artifacts/<name>.bundle --from deployer
otigen pause <addr> --from deployer
otigen unpause <addr> --from deployer
otigen kill <addr> --from deployer --yes
```

All four sign txs with `tx_type = Standard` and a borsh-encoded `LifecyclePayload` in `tx.data`. The engine sees a Standard tx to a contract address, tries to decode `tx.data` as a `CallPayload { function, calldata }`, fails on the 1-byte discriminant, and reverts with `decode CallPayload: Unexpected length of input` — burning gas on a guaranteed-failed tx.

The CLI refuses to submit by default to avoid that gas burn (see §4). Until the engine ships `TxType::Lifecycle`, prefer the §2 patterns.

---

## 4. The `EngineNotReady` gate

Run any of the four lifecycle commands today and the CLI refuses up-front:

```text
otigen [ERROR] EngineNotReady: `pause` lifecycle ops are not yet wired
 on the chain side (no TxType::Lifecycle handler, no paused/killed
 Account fields). Submitting this tx would revert with
 `decode CallPayload: Unexpected length of input` and consume gas.
 See the engine ask at /tmp/pyde-engine-lifecycle-ask-2026-06-18.md.
  hint:     pass `--i-know-engine-rejects` to bypass this gate
            (e.g., to exercise the CLI signing path against a stub
            engine).
```

Exit code is `1` (`VALIDATION_FAILURE` — same code as `--rpc-url` without `--chain-id`).

### When you'd ever want the bypass

`--i-know-engine-rejects` is for two narrow cases:

1. **CLI development against a stub engine.** Submitting the tx exercises the FALCON signing path, the wave-canonical tx-hash computation, and the wallet keystore flow. The tx itself reverts but everything up to submission is real.
2. **CI / regression tests** that mock the chain side. The wire bytes are still meaningful for test fixtures.

For everyday contract work — **don't pass it.** Burn no gas on a guaranteed-failed tx.

```bash
# Will be refused (correctly):
otigen pause my-counter --from deployer

# Will submit (and the engine will revert, and you'll burn gas):
otigen pause my-counter --from deployer --i-know-engine-rejects
```

---

## 5. Required flag pair for any submitting subcommand

Every signing CLI subcommand (`deploy`, `upgrade`, `pause`, `unpause`, `kill`) carries a `--rpc-url` + `--chain-id` pair. They're optional in isolation but coupled when used:

```bash
# Default: read RPC + chain_id from otigen.toml's [network.<name>]
otigen upgrade my-counter --from deployer --i-know-engine-rejects

# Override RPC URL (e.g. running against an alt port). REQUIRES --chain-id.
otigen upgrade my-counter \
  --from deployer \
  --i-know-engine-rejects \
  --rpc-url http://127.0.0.1:29933 \
  --chain-id 31337
```

Passing `--rpc-url` without `--chain-id` returns `InvalidArgs` with exit `1`. The CLI refuses because the resolver returns `chain_id = 0` on the raw-URL path, and signing a tx against `chain_id = 0` silently bricks the FALCON signature against the chain's tx-hash domain. The pair has to travel together.

---

## 6. Owner key hygiene (forward-looking)

When the engine catches up and lifecycle ops actually submit, the on-chain `Account.deployer` field will gate them. Until then, treat the `auth_keys` of whatever account you used to deploy + write `state::owner` with the same level of paranoia.

- **Don't reuse your dev keystore for production deployments.** Spin a separate wallet via `otigen wallet new prod-owner`.
- **Plan for a multisig.** The path forward is to set the multisig contract's address as the proxy's admin (and as `state::owner` for any direct-pause contracts). Lifecycle ops then go through multisig proposals + signature collection.
- **Test the upgrade flow on devnet before mainnet.** `otigen devnet --rpc-listen 127.0.0.1:9933` + `otigen new my-proxy --from upgradeable-proxy` + `otigen deploy` + a swap of the implementation slot is the canonical drill.

---

## What's next

[Debugging](./debugging.md) catalogs the error surfaces you'll hit and how to recover — including the `EngineNotReady` gate above, the `--rpc-url` + `--chain-id` consistency check, and the common deploy + call failure modes.
