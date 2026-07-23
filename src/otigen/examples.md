# Examples

The fastest way to start a new contract is to clone one of the canonical templates:

```bash
otigen new my-contract --from <template-name>
```

The eight templates `otigen new --list` exposes are the curated entry points: each one demonstrates a concrete pattern with a working `[state]` schema, host-fn usage, and (where applicable) a TOML test suite. Beyond the eight, the [`otigen/examples/`](https://github.com/pyde-net/otigen/tree/main/examples) directory carries additional reference contracts that aren't yet promoted to first-class scaffold templates. Clone them with `git` if you want to study them.

---

## Scaffold-able templates

What `otigen new --list` returns today, with honest status:

| Template | Status | What it demonstrates |
| --- | :--- | --- |
| [`counter`](https://github.com/pyde-net/otigen/tree/main/examples/counter-rust) | ✅ builds, 3/3 tests green | Minimum viable contract: single `u64` counter via `pyde::declare_storage!{}` + `#[pyde::entry]`. The default `otigen new counter --lang rust` scaffold, and the starter member `otigen init` seeds a workspace with. |
| [`fungible-token`](https://github.com/pyde-net/otigen/tree/main/examples/fungible-token) | ✅ builds, 1/1 test green | PTS-F reference token (pts-f/1). Typed-arg marshalling: `otigen call` automatically encodes function arguments per `[functions.<fn>].inputs` (e.g. `address`, `u128`); see [Typed arguments](./commands.md#typed-arguments) in the command reference. Mapping + composite-key mapping (`balances`, `allowances`). |
| [`nft-token`](https://github.com/pyde-net/otigen/tree/main/examples/nft-token) | ✅ builds, 17/17 tests green | PTS-N reference NFT (pts-n/1). Per-token ownership, `balance_of(owner)`, single-spender per-token approval cleared atomically on `transfer_from`. |
| [`upgradeable-proxy`](https://github.com/pyde-net/otigen/tree/main/examples/upgradeable-proxy) | ✅ builds, 16/16 tests green | Upgradeable proxy via `delegate_call`. Admin-controlled implementation slot with `transfer_admin` / `renounce_admin` rotation and namespaced `proxy_admin` / `proxy_logic` storage slots. |
| [`dao-governance`](https://github.com/pyde-net/otigen/tree/main/examples/dao-governance) | ✅ builds, 13/13 tests green | FALCON-signed votes + time phases + `hash_blake3`-committed execution. The most-composed v1 example. |
| [`simple-multisig`](https://github.com/pyde-net/otigen/tree/main/examples/simple-multisig) | ✅ builds, 14/14 tests green | 3-signer FALCON-512 multisig. Demonstrates `falcon_verify` + signer-ID lookup + `action_digest(target, amount, nonce)` view for off-chain signers + nonce-bound replay protection. |
| [`merkle-claim-airdrop`](https://github.com/pyde-net/otigen/tree/main/examples/merkle-claim-airdrop) | ✅ builds, 17/17 tests green | Merkle-tree airdrop claim. Off-chain commitment + on-chain inclusion verification via `hash_blake3`. Macro substrate; `Vec<u8>`-typed proof argument. Ships a `#[payable] fn fund()` so the contract custodies native PYDE end-to-end and pays out on claim. |
| [`vesting`](https://github.com/pyde-net/otigen/tree/main/examples/vesting) | ✅ builds, 21/21 tests green | Linear vesting with cliff. Time-locked allocation via `wave_timestamp`. Ships a `#[payable] fn fund()` so the contract holds native PYDE and releases it to the beneficiary as time accrues. |

---

## Reference contracts in the `examples/` tree

These live on disk but aren't (yet) promoted to first-class `otigen new` templates. Clone them via `git` if you want to study a specific pattern:

| Reference | Pattern |
| --- | --- |
| [`hello-rust`](https://github.com/pyde-net/otigen/tree/main/examples/hello-rust) | Minimal void-void entry + `pyde::return` without the `#[pyde::entry]` macro; useful for understanding the macro's expansion. |
| [`counter-rust`](https://github.com/pyde-net/otigen/tree/main/examples/counter-rust) | Source of the `counter` scaffold template. Identical surface; included for direct browsing. |
| [`counter-go`](https://github.com/pyde-net/otigen/tree/main/examples/counter-go) / [`counter-as`](https://github.com/pyde-net/otigen/tree/main/examples/counter-as) / [`counter-c`](https://github.com/pyde-net/otigen/tree/main/examples/counter-c) | Same counter surface ported to TinyGo / AssemblyScript / C. The starter each `otigen new --lang <go\|as\|c>` (or the first member of an `otigen init --lang <go\|as\|c>` workspace) scaffolds. |
| [`counter-pair-a`](https://github.com/pyde-net/otigen/tree/main/examples/counter-pair-a) + [`counter-pair-b`](https://github.com/pyde-net/otigen/tree/main/examples/counter-pair-b) | Cross-contract calls via `pyde::cross_call`. Test runner pre-deploys both via `[[contracts]]` in the test TOML. |
| [`x-call-caller`](https://github.com/pyde-net/otigen/tree/main/examples/x-call-caller) + [`x-call-target`](https://github.com/pyde-net/otigen/tree/main/examples/x-call-target) | Typed cross-contract call surface: caller wraps `pyde::call::execute_call` against a target that exposes a declared `[functions.*]` surface. |
| [`proxy-logic-v1`](https://github.com/pyde-net/otigen/tree/main/examples/proxy-logic-v1) + [`proxy-logic-v2`](https://github.com/pyde-net/otigen/tree/main/examples/proxy-logic-v2) | Two implementation versions used as delegate targets by `upgradeable-proxy` end-to-end tests. Useful for understanding the upgrade-path data flow. |
| [`amm-uniswap-v2`](https://github.com/pyde-net/otigen/tree/main/examples/amm-uniswap-v2) | Uniswap-v2-shape constant-product AMM. Pair contract with reserves + LP-share accounting. Largest worked example. |
| [`escrow`](https://github.com/pyde-net/otigen/tree/main/examples/escrow), [`multisig-wallet`](https://github.com/pyde-net/otigen/tree/main/examples/multisig-wallet), [`nft-marketplace`](https://github.com/pyde-net/otigen/tree/main/examples/nft-marketplace), [`payment-channel`](https://github.com/pyde-net/otigen/tree/main/examples/payment-channel) | Higher-order patterns. Status varies; read each example's `README.md`. |
| [`profile-registry`](https://github.com/pyde-net/otigen/tree/main/examples/profile-registry) | First parachain example. Variable-length-keyed storage exercising the v1-mocked `parachain_storage_*` host fns. |
| [`borsh-coverage`](https://github.com/pyde-net/otigen/tree/main/examples/borsh-coverage), [`struct-storage`](https://github.com/pyde-net/otigen/tree/main/examples/struct-storage), [`state-and-emit`](https://github.com/pyde-net/otigen/tree/main/examples/state-and-emit) | Type-coverage + storage-encoding reference contracts. |
| `*-smoke`, `*-stress`, `e2e-soak` | Test fixtures consumed by otigen's own CI, not contracts you'd scaffold from. |

This is a curated subset; see the [`examples/`](https://github.com/pyde-net/otigen/tree/main/examples) tree for the full catalog.

To clone one of these into a fresh project:

```bash
git clone https://github.com/pyde-net/otigen
cd otigen/examples/<name>
# Read the README, copy the bits you need into your own project tree.
```

There is no `otigen new --from <reference>` path for these yet; they aren't in the template registry.

---

## Running an example end-to-end

```bash
# Scaffold from a template:
otigen new my-counter --lang rust --from counter   # or omit --lang on a TTY and pick it interactively
cd my-counter

# Build + test the local way:
otigen build
otigen test

# Or, against a live devnet:
otigen devnet --rpc-listen 127.0.0.1:9933 &        # in another terminal
otigen deploy --from devnet-0                      # banner shows BOTH `my-counter` (registered name) and 0x… hex
otigen call my-counter increment --from devnet-0   # by registered name
otigen call my-counter get                         # view mode — no --from
```

Verbose test output (with gas, events, traces, storage diffs) is available via:

```bash
otigen test -v      # + gas used per test
otigen test -vv     # + emitted event list (topic0 + sizes)
otigen test -vvv    # + per-call traces (fn args / return / gas)
otigen test -vvvv   # + storage diffs (slot → before / after)
```

---

## When to add a new example

The `examples/` directory carries the reference contracts; the `otigen new --list` registry carries the curated subset users land on first. To promote an existing reference to the scaffold registry (or add a wholly new one), the template needs to:

1. **Demonstrate a host fn or pattern not yet covered** by the eight current templates.
2. **Compile cleanly under the current `HOST_FN_ABI_SPEC` §3.5.2** entry shape: use `#[pyde::entry]` for Rust, not the pre-spec `#[no_mangle] pub extern "C"`.
3. **Ship a `tests/contract.test.toml`** that passes `otigen test` against the live source.
4. **Stay under ~200 lines** of contract code unless the pattern genuinely needs more.

When in doubt, [`counter`](https://github.com/pyde-net/otigen/tree/main/examples/counter-rust) and [`fungible-token`](https://github.com/pyde-net/otigen/tree/main/examples/fungible-token) are the calibration points for "right-sized canonical demo".
