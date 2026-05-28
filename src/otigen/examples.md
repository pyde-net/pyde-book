# Examples

Every example below ships in the [otigen repo](https://github.com/pyde-net/otigen/tree/main/examples). Each one is a real, deployable Pyde contract with a TOML behaviour-test suite that the toolchain exercises end-to-end. `make verify-examples` in the workspace root rebuilds + tests every example as a single CI gate.

## Catalog

| Example | Lang | Tests | What it demonstrates | Host fns exercised |
|---|---|---:|---|---|
| [`counter-rust`](https://github.com/pyde-net/otigen/tree/main/examples/counter-rust) | Rust | 3 | The minimum viable contract. `otigen init --lang rust` output. | `sload`, `sstore`, `self_address`, `hash_poseidon2` (canonical `derive_slot` helper) |
| [`counter-go`](https://github.com/pyde-net/otigen/tree/main/examples/counter-go) | TinyGo | 3 | Same surface, TinyGo `//go:wasmimport` / `//go:wasmexport`. | same as above |
| [`counter-as`](https://github.com/pyde-net/otigen/tree/main/examples/counter-as) | AssemblyScript | 3 | Same surface, AS `@external` + `changetype<usize>` pattern. | same as above |
| [`counter-c`](https://github.com/pyde-net/otigen/tree/main/examples/counter-c) | C | 3 | Same surface, clang `--target=wasm32 -nostdlib`. | same as above |
| [`counter-token`](https://github.com/pyde-net/otigen/tree/main/examples/counter-token) | Rust | 7 | Per-user `mint` / `burn` with `caller()` auth + multi-topic `Mint` / `Burn` events + insufficient-balance revert with rollback. | + `caller`, `emit_event`, `revert` |
| [`counter-token-go`](https://github.com/pyde-net/otigen/tree/main/examples/counter-token-go) | TinyGo | 7 | TinyGo port of `counter-token`. **Identical** TOML test suite. | same as `counter-token` |
| [`counter-token-as`](https://github.com/pyde-net/otigen/tree/main/examples/counter-token-as) | AssemblyScript | 7 | AS port of `counter-token`. Identical TOML test suite. | same |
| [`counter-token-c`](https://github.com/pyde-net/otigen/tree/main/examples/counter-token-c) | C | 7 | C port of `counter-token`, uses `__uint128_t` for native 128-bit arithmetic. Identical TOML test suite. | same |
| [`erc20-token`](https://github.com/pyde-net/otigen/tree/main/examples/erc20-token) | Rust | 10 | Full ERC20-style fungible token: `total_supply`, `balance_of`, `transfer`, `approve`, `allowance`, `transfer_from`. Phase 4 typed-arg marshalling (`address`, `uint128`). Three storage layouts (scalar, mapping, composite-key mapping). | + Phase 4 typed args |
| [`simple-multisig`](https://github.com/pyde-net/otigen/tree/main/examples/simple-multisig) | Rust | 9 | **In-contract FALCON-512 verification.** 3-signer multisig storing `Poseidon2(pubkey)` as signer IDs. Action-hash anti-replay. The canonical Pyde post-quantum signature example. See [§9 of the WASM Author Guide](../companion/WASM_AUTHOR_GUIDE.md). | + `falcon_verify`, `hash_poseidon2`, `transfer`, `bytes` typed-arg |
| [`upgradeable-proxy`](https://github.com/pyde-net/otigen/tree/main/examples/upgradeable-proxy) | Rust | 7 | **Upgradeable proxy pattern via `delegate_call`.** Admin-controlled implementation pointer + storage-context-preserving delegation. See [§10 of the WASM Author Guide](../companion/WASM_AUTHOR_GUIDE.md). | + `delegate_call`, `self_address` |
| [`counter-pair-a`](https://github.com/pyde-net/otigen/tree/main/examples/counter-pair-a) + [`counter-pair-b`](https://github.com/pyde-net/otigen/tree/main/examples/counter-pair-b) | Rust | 6 | **Cross-contract calls via `cross_call`.** Two-contract pair (`[[contracts]]` in the test TOML deploys the secondary) demonstrating all four §7.8 invariants in one suite: storage isolation, `caller()` shift, value transfer, revert rollback. See [§8.5 of the WASM Author Guide](../companion/WASM_AUTHOR_GUIDE.md). | + `cross_call`, `tx_value` |
| [`profile-registry`](https://github.com/pyde-net/otigen/tree/main/examples/profile-registry) | Rust (`type = "parachain"`) | 7 | **First parachain example.** Variable-length-keyed user profile registry exercising every v1-mocked §8 host fn: `parachain_storage_{read,write,delete}` with the spec's pre-state-limit / read-actual convention, `parachain_id`, `parachain_version`, `parachain_emit_event`. Uses the Phase 4 `bytes` typed-arg for arbitrary-length blobs. | parachain §8.1 / §8.2 / §8.3 |
| [`erc721-token`](https://github.com/pyde-net/otigen/tree/main/examples/erc721-token) | Rust | 10 | **ERC721-shape NFT.** Per-token ownership (one slot per token, uint64-keyed), `balance_of[owner]`, single-spender per-token approval cleared atomically on `transfer_from`. Demonstrates three-topic indexed events (right at the §7.5 4-topic max). | + variable-length storage with uint64 mapping keys (via `derive_slot`), 3-topic events |
| [`merkle-claim-airdrop`](https://github.com/pyde-net/otigen/tree/main/examples/merkle-claim-airdrop) | Rust | 10 | **Merkle-tree airdrop claim.** Off-chain commits a (claimant, amount) set to a single 32-byte root; claimants present a path that hashes back. Domain-separated leaf vs node (RFC-9162 style), 33-byte/step proof encoding, one-shot init. | + `hash_blake3` host fn, `bytes`-typed variable-length input, proof verification loop |
| [`vesting`](https://github.com/pyde-net/otigen/tree/main/examples/vesting) | Rust | 10 | **Linear vesting with cliff.** One-shot configure(beneficiary, total, start, cliff, duration). Permissionless `release()` pays vested-but-unreleased portion to the configured beneficiary. Linear-from-start with cliff delay (matches OpenZeppelin VestingWallet semantics). | + `wave_timestamp` host fn, time-travel via per-test `[tests.cheats].now`, u128-promotion overflow-safe math |
| [`dao-governance`](https://github.com/pyde-net/otigen/tree/main/examples/dao-governance) | Rust | 15 | **Composed example.** Fixed-3-signer DAO with FALCON-signed votes (off-chain sig, on-chain verify, anyone can submit), time-phased state machine, composite-key per-proposal storage, hash_blake3-committed calldata. Demonstrates how the v1 primitives compose into a production-shape pattern. | + composed: FALCON + self_address domain-sep + composite-key storage + wave_timestamp + hash_blake3 commitment |

All examples build + test green end-to-end via `make verify-examples` from the workspace root. Counter-pair counts as two contract bundles deployed together in a single test suite (counter-pair-a is the primary; counter-pair-b is declared via `[[contracts]]` in the test TOML and pre-deployed by the runner).

## Cross-language test invariant

The four `counter-token-*` ports share a single TOML test suite. Each port's `otigen.toml` declares the same state schema + function signatures + event signatures as the Rust reference, so the contract's `pyde.abi` custom section hashes **byte-identical across all four languages**:

```
abi: 169 bytes (blake3 0617b1d55b725b5d)   ← same across Rust / Go / AS / C
```

Practical consequence: the test framework is language-agnostic by design. The same `tests/contract.test.toml` runs against the Rust source, the TinyGo source, the AssemblyScript source, and the C source — same assertions, same return values, same emitted events. If a port diverges, the divergence is in the contract code, never in the test fixture.

## Size comparison

After `cargo build --release` / `tinygo build` / `npm run build` / `clang --target=wasm32 -nostdlib -O3 -flto`:

| Port | wasm | Notes |
|---|---:|---|
| Rust (counter-token reference) | ~1.5 KB | smallest; no language-runtime overhead |
| AssemblyScript | 3.1 KB | StaticArray overhead |
| C | 3.3 KB | `__uint128_t` native; some clang scaffolding |
| TinyGo | 65 KB | TinyGo runtime overhead — unavoidable today; tracked for the TinyGo team's future minimization |

## Running an example

```bash
# Clone the workspace
git clone https://github.com/pyde-net/otigen
cd otigen

# Build + test ONE example
cd examples/simple-multisig
make build       # cargo --release + otigen build
make test        # otigen test
make test-vvvv   # full Foundry-style trace + events + storage diffs

# Or, from the workspace root, build + test ALL examples in one go
cd /path/to/otigen
make verify-examples
```

Each example carries its own `README.md` with the contract's surface, the test suite walk-through, and "how to extend this" notes.

## When to add a new example

Examples earn their slot in this catalog when they:

1. **Demonstrate a host fn or pattern not yet covered elsewhere.** Single-host-fn redundancy is fine for early ports; redundancy for an established pattern isn't (the catalog gets noisy).
2. **Ship with a full TOML test suite that runs green under `make verify-examples`.** Source code without tests is a tutorial in the README, not an example here.
3. **Stay under ~200 lines of contract code** unless the pattern genuinely needs more. Examples are for learning; production-shape contracts go in user repos.

When in doubt, the [`simple-multisig`](https://github.com/pyde-net/otigen/tree/main/examples/simple-multisig) and [`upgradeable-proxy`](https://github.com/pyde-net/otigen/tree/main/examples/upgradeable-proxy) examples are the calibration point for "right-sized canonical demo".
