# Examples

The fastest way to start a new contract is to clone one of the canonical templates:

```bash
otigen new my-contract --from <template-name>
```

The eight templates `otigen new --list` exposes are the curated entry points — each one demonstrates a concrete pattern with a working `[state]` schema, host-fn usage, and (where applicable) a TOML test suite. Beyond the eight, the [`otigen/examples/`](https://github.com/pyde-net/otigen/tree/main/examples) directory carries additional reference contracts that aren't yet promoted to first-class scaffold templates — clone them with `git` if you want to study them.

---

## Scaffold-able templates

What `otigen new --list` returns today, with honest status:

| Template | Status | What it demonstrates |
| --- | :--- | --- |
| [`counter`](https://github.com/pyde-net/otigen/tree/main/examples/counter-rust) | ✅ builds, 3/3 tests green | Minimum viable contract — single `u64` counter via `#[pyde::declare_storage]` + `#[pyde::entry]`. Equivalent of `otigen init --lang rust`. |
| [`erc20-token`](https://github.com/pyde-net/otigen/tree/main/examples/erc20-token) | ✅ builds, 1/1 test green | ERC20-style fungible token. Typed-arg marshalling: `otigen call` automatically encodes function arguments per `[functions.<fn>].inputs` (e.g. `address`, `u128`) — see [Typed arguments](./commands.md#typed-arguments) in the command reference. Mapping + composite-key mapping (`balances`, `allowances`). |
| [`erc721-token`](https://github.com/pyde-net/otigen/tree/main/examples/erc721-token) | ✅ builds, 1/1 test green | ERC721-shape NFT. Per-token ownership, `balance_of(owner)`, single-spender per-token approval cleared atomically on `transfer_from`. |
| [`upgradeable-proxy`](https://github.com/pyde-net/otigen/tree/main/examples/upgradeable-proxy) | ⚠️ builds, **shipped tests broken** | Upgradeable proxy via `delegate_call`. Admin-controlled implementation slot. The shipped `tests/contract.test.toml` references entrypoint names that no longer match the source — tests fail 0/7 until the fixture is regenerated. The contract itself deploys + delegates fine. |
| [`dao-governance`](https://github.com/pyde-net/otigen/tree/main/examples/dao-governance) | ✅ builds, 1/1 test green | FALCON-signed votes + time phases + `hash_blake3`-committed execution. The most-composed v1 example. |
| [`simple-multisig`](https://github.com/pyde-net/otigen/tree/main/examples/simple-multisig) | ✅ builds, 9/9 tests green | 3-signer FALCON-512 multisig with `falcon_verify` + signer-ID lookup. Macro substrate (`#[pyde::entry]` + `declare_storage!()` + `declare_events!()`) over typed-storage maps. |
| [`merkle-claim-airdrop`](https://github.com/pyde-net/otigen/tree/main/examples/merkle-claim-airdrop) | ✅ builds, 10/10 tests green | Merkle-tree airdrop claim. Off-chain commitment + on-chain inclusion verification via `hash_blake3`. Macro substrate; `Vec<u8>`-typed proof argument. |
| [`vesting`](https://github.com/pyde-net/otigen/tree/main/examples/vesting) | ✅ builds, 10/10 tests green | Linear vesting with cliff. Time-locked allocation via `wave_timestamp`. Macro substrate. |

---

## Reference contracts in the `examples/` tree

These live on disk but aren't (yet) promoted to first-class `otigen new` templates. Clone them via `git` if you want to study a specific pattern:

| Reference | Pattern |
| --- | --- |
| [`hello-rust`](https://github.com/pyde-net/otigen/tree/main/examples/hello-rust) | Minimal void-void entry + `pyde::return` without the `#[pyde::entry]` macro — useful for understanding the macro's expansion. |
| [`counter-rust`](https://github.com/pyde-net/otigen/tree/main/examples/counter-rust) | Source of the `counter` scaffold template. Identical surface; included for direct browsing. |
| [`counter-go`](https://github.com/pyde-net/otigen/tree/main/examples/counter-go) / [`counter-as`](https://github.com/pyde-net/otigen/tree/main/examples/counter-as) / [`counter-c`](https://github.com/pyde-net/otigen/tree/main/examples/counter-c) | Same counter surface ported to TinyGo / AssemblyScript / C. Demonstrates the four-language scaffold output of `otigen init --lang go|as|c`. |
| [`counter-pair-a`](https://github.com/pyde-net/otigen/tree/main/examples/counter-pair-a) + [`counter-pair-b`](https://github.com/pyde-net/otigen/tree/main/examples/counter-pair-b) | Cross-contract calls via `pyde::cross_call`. Test runner pre-deploys both via `[[contracts]]` in the test TOML. |
| [`escrow`](https://github.com/pyde-net/otigen/tree/main/examples/escrow), [`multisig-wallet`](https://github.com/pyde-net/otigen/tree/main/examples/multisig-wallet), [`nft-marketplace`](https://github.com/pyde-net/otigen/tree/main/examples/nft-marketplace), [`payment-channel`](https://github.com/pyde-net/otigen/tree/main/examples/payment-channel) | Higher-order patterns. Status varies — read each example's `README.md`. |
| [`profile-registry`](https://github.com/pyde-net/otigen/tree/main/examples/profile-registry) | First parachain example. Variable-length-keyed storage exercising the v1-mocked `parachain_storage_*` host fns. |
| [`borsh-coverage`](https://github.com/pyde-net/otigen/tree/main/examples/borsh-coverage), [`struct-storage`](https://github.com/pyde-net/otigen/tree/main/examples/struct-storage), [`state-and-emit`](https://github.com/pyde-net/otigen/tree/main/examples/state-and-emit) | Type-coverage + storage-encoding reference contracts. |
| `*-smoke`, `*-stress`, `e2e-soak` | Test fixtures consumed by otigen's own CI — not contracts you'd scaffold from. |

To clone one of these into a fresh project:

```bash
git clone https://github.com/pyde-net/otigen
cd otigen/examples/<name>
# Read the README, copy the bits you need into your own project tree.
```

There is no `otigen new --from <reference>` path for these yet — they aren't in the template registry.

---

## Running an example end-to-end

```bash
# Scaffold from a template:
otigen new my-counter --from counter
cd my-counter

# Build + test the local way:
otigen build
otigen test

# Or, against a live devnet:
otigen devnet --rpc-listen 127.0.0.1:9933 &      # in another terminal
otigen wallet import --from-devnet                # pull the 10 prefunded devnet-N wallets
otigen deploy --from devnet-0
otigen call <addr> increment --from devnet-0
otigen call <addr> get                            # view mode — no --from
```

Verbose test output (with traces + storage diffs + events) is available via:

```bash
otigen test -vv     # per-call summary
otigen test -vvv    # adds storage diff per call
otigen test -vvvv   # adds full event payloads
```

---

## When to add a new example

The `examples/` directory carries the reference contracts; the `otigen new --list` registry carries the curated subset users land on first. To promote an existing reference to the scaffold registry (or add a wholly new one), the template needs to:

1. **Demonstrate a host fn or pattern not yet covered** by the eight current templates.
2. **Compile cleanly under the current `HOST_FN_ABI_SPEC` §3.5.2** entry shape — use `#[pyde::entry]` for Rust, not the pre-spec `#[no_mangle] pub extern "C"`.
3. **Ship a `tests/contract.test.toml`** that passes `otigen test` against the live source.
4. **Stay under ~200 lines** of contract code unless the pattern genuinely needs more.

When in doubt, [`counter`](https://github.com/pyde-net/otigen/tree/main/examples/counter-rust) and [`erc20-token`](https://github.com/pyde-net/otigen/tree/main/examples/erc20-token) are the calibration points for "right-sized canonical demo".
