# Lifecycle

Operating a deployed contract over time: upgrading the logic, pausing it under incident, retiring it permanently.

> **Honest status (v1).** The four CLI subcommands (`otigen upgrade`, `otigen pause`, `otigen unpause`, `otigen kill`) exist and sign correctly, but the chain has **no `TxType::Lifecycle` handler** yet. Submitting one today is refused at the CLI by an `EngineNotReady` gate (see §4 below). Per [`OTIGEN_BINARY_SPEC §8.2`/`§8.3`](../companion/OTIGEN_BINARY_SPEC.md), v1 ships **no chain-side upgrade/pause/unpause/kill tx types**. The patterns in §2 (proxy upgrades, author-declared pause / kill booleans) are how you get the same operational outcomes today.

---

## 1. What the chain provides today

| Need | v1 path | v2 path (planned) |
| --- | --- | --- |
| Replace contract logic | Proxy + `delegate_call`; admin swaps the implementation slot | Native `upgrade` tx → engine swaps the code blob at the same address |
| Halt entrypoints under incident | Author-declared `paused: bool` in `[state]`; every entry asserts `!paused` | Native `pause` flag on `Account` set by a `pause` tx |
| Retire a contract irreversibly | Author-declared `killed: bool`; every entry reverts when set | Native `kill` tx zeroing the contract's `code_hash` |
| Tie any of the above to an owner | Author-managed in storage; the contract is its own authority | `Account.deployer` enforced by the engine |

Two things to internalize:

1. **There is no native "contract owner" concept in v1.** Accounts have `auth_keys`, but a contract account is its own authority surface. Authoring an "owner" means storing an `Address` in `[state]` and checking `pyde::ctx::caller() == stored_owner` in your guarded entrypoints. The CLI's lifecycle commands assume engine support that does not exist; they cannot enforce ownership for you today.
2. **The CLI surface is committed in code so the day the engine catches up the wire shape doesn't shift.** Until then, the four subcommands refuse to submit. See the engine ask tracking `TxType::Lifecycle` + paused/killed `Account` fields for the proposed shape.

---

## 2. The v1 patterns

### 2.1 Upgrade: the proxy pattern

The canonical v1 upgrade story is a proxy contract that holds the admin + logic address in storage and forwards every call via `pyde::call::execute_delegate_raw`. To upgrade you deploy a new logic contract and submit a tx that overwrites the logic slot.

The [`upgradeable-proxy`](https://github.com/pyde-net/otigen/tree/main/examples/upgradeable-proxy) template is the worked example. The skeleton is two files. In `src/lib.rs`:

```rust
pyde::declare_storage!();

const ZERO_ADDRESS: Address = [0u8; 32];

#[pyde::entry]
fn init(initial_logic: Address) {
    // Re-init guard: the manifest tags `init` as `["constructor"]`,
    // and this in-source check makes the invariant explicit.
    if storage::proxy_admin().read() != ZERO_ADDRESS {
        pyde::revert("proxy: already initialized");
    }
    let admin = pyde::ctx::caller();
    if admin == ZERO_ADDRESS || initial_logic == ZERO_ADDRESS {
        pyde::revert("proxy: init with zero address");
    }
    storage::proxy_admin().write(admin);
    storage::proxy_logic().write(initial_logic);
}

#[pyde::entry]
fn upgrade_to(new_logic: Address) {
    let admin = storage::proxy_admin().read();
    if pyde::ctx::caller() != admin {
        pyde::revert("proxy: caller is not admin");
    }
    if new_logic == ZERO_ADDRESS {
        pyde::revert("proxy: upgrade to zero address");
    }
    storage::proxy_logic().write(new_logic);
}

#[pyde::entry]
fn transfer_admin(new_admin: Address) {
    let admin = storage::proxy_admin().read();
    if pyde::ctx::caller() != admin {
        pyde::revert("proxy: caller is not admin");
    }
    if new_admin == ZERO_ADDRESS {
        pyde::revert("proxy: transfer to zero address; use renounce_admin");
    }
    storage::proxy_admin().write(new_admin);
}

#[pyde::entry]
fn renounce_admin() {
    let admin = storage::proxy_admin().read();
    if pyde::ctx::caller() != admin {
        pyde::revert("proxy: caller is not admin");
    }
    storage::proxy_admin().write(ZERO_ADDRESS);
}

#[pyde::entry]
fn forward(function: String, calldata: Vec<u8>) -> Vec<u8> {
    let logic = storage::proxy_logic().read();
    match pyde::call::execute_delegate_raw(&logic, &function, &calldata) {
        Ok(bytes) => bytes,
        Err(CallError::Reverted(payload)) => {
            let msg = core::str::from_utf8(&payload)
                .unwrap_or("proxy: delegate-call failed");
            pyde::revert(msg);
        }
        Err(CallError::InvalidFunction) => {
            pyde::revert("proxy: logic has no such function");
        }
        Err(_) => pyde::revert("proxy: delegate-call failed"),
    }
}
```

`renounce_admin` is the one-way door: zeroing the admin slot freezes the logic pointer forever, so the contract becomes non-upgradeable from that point on.

In `otigen.toml` the storage layout is declared declaratively:

```toml
[state]
schema = [
    { name = "proxy_admin", type = "address" },
    { name = "proxy_logic", type = "address" },
    { name = "value",       type = "uint64" },
]
```

The `proxy_` prefix on the privileged fields is intentional. Pyde's storage slots are derived as `Poseidon2(self_address || field_name)`, and under delegate-call the logic sees the proxy's `self_address`, so a logic contract that happens to declare a field named `admin` would otherwise clobber the proxy's admin slot. Prefixing makes the collision a loud, deliberate choice rather than a silent footgun.

The proxy address never changes. Storage lives in the proxy. The logic contract is a pure code blob: its address rotates each upgrade. Callers point at the proxy's address forever.

Trade-offs vs a native engine upgrade:

- **Cost**: every call pays a `delegate_call` indirection, a flat 1,200 gas + 8 gas per calldata byte on top of the sub-call's own gas (per `HOST_FN_ABI_SPEC` §7.8).
- **Storage discipline**: the logic's storage slot derivation lives in the proxy's address space. Renaming a field is a wire break across upgrades (the slot hash changes); use append-only field order.
- **Admin key risk**: lose the admin key, lose upgradability. Pair with a multisig for production (see [`simple-multisig`](https://github.com/pyde-net/otigen/tree/main/examples/simple-multisig)). Lifecycle ops then go through multisig proposals + signature collection.

### 2.2 Pause: author-declared boolean

Add a `paused: bool` field and assert it at every state-mutating entrypoint. Reads stay open by convention.

```rust
pyde::declare_storage!();

fn require_unpaused() {
    if storage::paused().read() {
        pyde::revert("contract: paused");
    }
}

fn require_owner() {
    if pyde::ctx::caller() != storage::owner().read() {
        pyde::revert("contract: not owner");
    }
}

#[pyde::entry]
fn pause() {
    require_owner();
    storage::paused().write(true);
}

#[pyde::entry]
fn unpause() {
    require_owner();
    storage::paused().write(false);
}

#[pyde::entry]
fn transfer(to: Address, amount: u128) {
    require_unpaused();
    // ... transfer logic
}
```

The matching `otigen.toml` `[state]` block declares `owner: address`, `paused: bool`, plus whatever other fields your contract needs.

In-flight transactions that were already accepted into the mempool before the `pause` tx commits will still execute (the pause only affects waves committed AFTER the pause). View calls via `otigen call <addr> <view-fn>` always work regardless; they don't enter consensus.

### 2.3 Kill: author-declared terminal flag

Same shape as `paused`, but the entry assertions never check for an unpause counterpart. Once set, the contract refuses every mutation forever.

```rust
fn require_alive() {
    if storage::killed().read() {
        pyde::revert("contract: killed");
    }
}

#[pyde::entry]
fn kill() {
    require_owner();
    storage::killed().write(true);
}
```

Storage is retained on-chain: there is no v1 mechanism to free the contract's slot space or release its name. If a future chain release adds a native `kill` tx, the engine ask proposes zeroing `code_hash` (effectively deleting the bytecode while keeping the address registered to prevent name-squatting).

---

## 3. What the CLI subcommands do today

The four subcommands (`upgrade`, `pause`, `unpause`, `kill`) are scaffolded against the future `TxType::Lifecycle` wire shape:

```bash
otigen upgrade my-counter --bundle ./artifacts/my-counter.bundle --from deployer
otigen pause my-counter --from deployer
otigen unpause my-counter --from deployer
otigen kill my-counter --from deployer --yes
```

All four sign txs with `tx_type = Standard` and a borsh-encoded `LifecyclePayload` in `tx.data`. The engine sees a Standard tx to a contract address, tries to decode `tx.data` as a `CallPayload { function: String, calldata: Vec<u8> }`, and reverts with `decode CallPayload: Unexpected length of input`, burning gas on a guaranteed-failed tx.

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

Exit code is `1` (`VALIDATION_FAILURE`, the same code as `--rpc-url` without `--chain-id`).

### When you'd ever want the bypass

`--i-know-engine-rejects` is for two narrow cases:

1. **CLI development against a stub engine.** Submitting the tx exercises the FALCON signing path, the wave-canonical tx-hash computation, and the wallet keystore flow. The tx itself reverts but everything up to submission is real.
2. **CI / regression tests** that mock the chain side. The wire bytes are still meaningful for test fixtures.

For everyday contract work, **don't pass it.** Burn no gas on a guaranteed-failed tx.

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

When the engine catches up and lifecycle ops actually submit, the on-chain `Account.deployer` field will gate them. Until then, treat the `auth_keys` of whatever account you used to deploy + write `storage::owner` with the same level of paranoia.

- **Don't reuse your dev keystore for production deployments.** Spin a separate wallet via `otigen wallet new prod-owner`.
- **Plan for a multisig.** The path forward is to set the multisig contract's address as the proxy's admin (and as `storage::owner` for any direct-pause contracts). Lifecycle ops then go through multisig proposals + signature collection.
- **Test the upgrade flow on devnet before mainnet.** The canonical drill:

  ```bash
  otigen devnet --rpc-listen 127.0.0.1:9933
  otigen new my-proxy --lang rust --from upgradeable-proxy
  otigen deploy --from deployer
  # then sign a tx that calls upgrade_to(new_logic) on the proxy
  ```

---

## What's next

[Debugging](./debugging.md) catalogs the error surfaces you'll hit and how to recover, including the `EngineNotReady` gate above, the `--rpc-url` + `--chain-id` consistency check, and the common deploy + call failure modes.
