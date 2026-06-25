# Shipping

Building a deploy bundle, configuring a wallet, picking a network, then submitting the contract.

By the end of this chapter, your counter contract is live on devnet and you've held the transaction receipt.

---

## 1. `otigen build`

```bash
otigen build
```

```text
→ Compiling (rust) — cargo build --target wasm32-unknown-unknown --release
    Finished `release` profile [optimized] target(s) in 0.27s
✓ Compiled → ./target/wasm32-unknown-unknown/release/my_counter.wasm
  ✓ Built "my-counter" → ./artifacts/my-counter.bundle
  wasm: 5077 bytes (blake3 4ac6059a67dea1d8)
  abi:  147 bytes (blake3 e8cc4b94b095fecc)
```

`otigen build` runs two steps:

1. **Language compile.** `cargo build --target wasm32-unknown-unknown --release` for Rust, or `tinygo build` / `asc` / `clang` for the other languages. Produces a `.wasm` at the path declared in `otigen.toml`'s `[contract.lang].output`.
2. **Validate + bundle.** Reads the `.wasm`, validates it against the host-fn allowlist + the `[functions.*]` export consistency rules, embeds a `pyde.abi` custom section derived from the manifest, and writes everything into `artifacts/<name>.bundle/`.

`--no-compile` skips step 1 and packages whatever's already on disk.

### What's in the bundle

```text
artifacts/my-counter.bundle/
├── contract.wasm        # the WASM with the pyde.abi section injected
├── otigen.toml          # snapshot of the project manifest
├── abi.json             # decoded ABI (functions + events + state schema)
└── manifest.json        # build provenance (otigen version, language toolchain pin, timestamp, hashes)
```

The bundle is the **only** thing the chain ever sees. Source, tests, `Cargo.lock` stay local.

### What gets validated

Per [`OTIGEN_BINARY_SPEC §3.2`](../companion/OTIGEN_BINARY_SPEC.md):

| Check | What fails |
| --- | --- |
| Well-formed WASM | `wasmparser` rejects malformed bytes. |
| Import allowlist | Any import outside `pyde::*` ⇒ rejected. |
| Function allowlist | Imports of `pyde::*` fns not in `HOST_FN_ABI_SPEC` §7 ⇒ rejected. |
| Parachain gating | A non-parachain contract importing §8 fns ⇒ rejected. |
| Export consistency | Every `[functions.X]` in `otigen.toml` must be exported by the WASM. Every non-underscored export must be declared. |
| Entry shape | Every entry must export `() -> ()` (`HOST_FN_ABI_SPEC §3.5.2`). The `#[pyde::entry]` macro generates this shim; hand-rolled `#[no_mangle] pub extern "C" fn foo(args, ...) -> ret` is rejected. |
| Forbidden features | Threads, SIMD, GC, reference types, multi-memory, memory64, component model ⇒ rejected (deterministic-execution subset only). |

A clean `otigen build` = a deployable bundle. If validation fails, the error message points at the exact violation; fix the source + re-run. The process exit code is `VALIDATION_FAILURE` (1) — scripts can rely on it.

### Reproducibility

`otigen build` is deterministic modulo a `build_timestamp` field. Two clean rebuilds of the same source + the same toolchain pin produce bundles that hash byte-identical (apart from that timestamp). That's the property `otigen verify` (next chapter) relies on. Auditors re-build from source on a clean machine, then `otigen verify <addr> --strict-toolchain` against the deployed contract.

---

## 2. Wallets

Pyde signs transactions with **FALCON-512** (post-quantum, per [`HOST_FN_ABI_SPEC §7.7`](../companion/HOST_FN_ABI_SPEC.md)). Keys are managed via `otigen wallet`.

### Create

```bash
otigen wallet new deployer
```

```text
Enter a strong password (>= 12 chars): ************
Re-enter to confirm:                   ************

✓ created account "deployer"
  address:   0x9b8c7d6e5f4a3b2c... (32 bytes, Poseidon2-derived from the pubkey)
  keystore:  ~/.pyde/keystore.json
```

`[NAME]` is positional. Under `--json` mode or piped stdin, supply it on the command line (interactive prompts disabled). Use `--password-stdin` to pipe the password (two consecutive lines: password + confirmation):

```bash
printf 'pw\npw\n' | otigen wallet new alice --password-stdin
```

The keystore is a single file at `~/.pyde/keystore.json`. Argon2id-derived keys encrypt each account's secret with AES-256-GCM. Multiple accounts live in one file; passwords are per-account.

### Other wallet commands

```bash
otigen wallet list                                # list every account
otigen wallet show <NAME>                         # print address + pubkey
otigen wallet delete <NAME>                       # remove (asks confirmation)
otigen wallet password <NAME>                     # rotate the password (TTY only)
otigen wallet import <NAME> --from-file <PATH>    # restore a backup
otigen wallet import --from-devnet                # bulk-import the 10 prefunded devnet accounts
otigen wallet export <NAME> --out <PATH>          # write a portable encrypted backup
otigen wallet sign <NAME> --message <MSG>         # off-chain FALCON sig (NOT for chain txs)
otigen wallet verify [NAME] --message <MSG> --signature <HEX>
```

Full reference: [`commands.md`](./commands.md) and [`OTIGEN_BINARY_SPEC §3.7`](../companion/OTIGEN_BINARY_SPEC.md).

### Funding

A fresh account has zero balance. On devnet, **don't create a wallet from scratch — import the 10 deterministic prefunded accounts** the embedded `otigen devnet` bootstraps at genesis:

```bash
otigen devnet --rpc-listen 127.0.0.1:9933 &       # in another terminal
otigen wallet import --from-devnet                # imports devnet-0..devnet-9
```

```text
✓ imported 10 prefunded accounts (devnet-0..devnet-9, 10 PYDE each)
  keystore: ~/.pyde/keystore.json
```

The accounts are derived via `Blake3("pyde-devnet-v1/" || i)` and re-derive identically across machines. Their secrets are **public** by design — they're for tests, not for anything that matters.

For real funding (testnet / mainnet), real PYDE is required. There is no `POST /faucet` HTTP endpoint on the devnet RPC; the prefund-at-genesis path above is the only auto-funding the binary provides today. A testnet faucet UI is planned but not yet live.

---

## 3. Networks

`otigen.toml` declares one or more networks:

```toml
[network.default]
name = "devnet"

[network.devnet]
rpc_url  = "http://127.0.0.1:9933"
chain_id = 31337

[network.testnet]
rpc_url  = "https://rpc.testnet.pyde.network"
chain_id = 2

[network.mainnet]
rpc_url  = "https://rpc.pyde.network"
chain_id = 1
```

(Per [`OTIGEN_BINARY_SPEC §6.1`](../companion/OTIGEN_BINARY_SPEC.md), `chain_id = 2` is the testnet sentinel; `chain_id = 31337` is the canonical devnet "don't replay" sentinel.)

`[network.default]` picks which is used when no `--network` flag is passed. You can declare arbitrarily many; the `--network <name>` flag overrides per-command.

### One-shot RPC override

For ad-hoc invocations against an alt port — e.g. a CI worker spinning a devnet on `127.0.0.1:29933` because `9933` is taken by a multi-validator cluster — `deploy` / `upgrade` / `pause` / `unpause` / `kill` all accept `--rpc-url` + `--chain-id`:

```bash
otigen deploy --from devnet-0 --password-stdin \
              --rpc-url http://127.0.0.1:29933 \
              --chain-id 31337 \
              <<< pw
```

`--rpc-url` requires `--chain-id` (signed-tx replay protection). Passing one without the other returns `InvalidArgs` with exit `1`.

---

## 4. `otigen deploy`

```bash
otigen deploy --from devnet-0 --password-stdin <<< pw
```

```text
  Deploying "my-counter" (Contract) to devnet
  Bundle:   artifacts/my-counter.bundle
  RPC:      http://127.0.0.1:9933
  Account:  devnet-0 (chain 31337)
  Nonce:    0
  Gas:      10000000 (limit)
  Tx hash:  0x6400519b791aa353488443b66b98c37b2f8bb1aa148fed313c013fe6b5bf62dd
  Wire:     6037 bytes
  Submitted. Server tx hash: 0x6400519b791aa353488443b66b98c37b2f8bb1aa148fed313c013fe6b5bf62dd
  Waiting for inclusion (timeout 60s)...
  Contract: 0x5224c65fbc03fc63ab4cc6c30906e593342edd42b540f489d6b279dbc689f413
  ✓ Deployed. Try: otigen call 0x5224c65fbc03fc63ab4cc6c30906e593342edd42b540f489d6b279dbc689f413 <fn>
```

What happened, step by step (per [`OTIGEN_BINARY_SPEC §3.3`](../companion/OTIGEN_BINARY_SPEC.md)):

1. **Bundle re-validation.** `otigen` re-runs every validator from `otigen build` against the bundle. Catches a hand-edited bundle.
2. **Network resolution.** Selects the network. Reads `rpc_url` + `chain_id` from `[network.<X>]`, or from `--rpc-url` + `--chain-id` if supplied.
3. **Wallet unlock.** Prompts for the deployer password (or reads stdin under `--password-stdin`).
4. **Nonce fetch.** Queries `pyde_getTransactionCount` for the deployer's next nonce.
5. **Canonical tx hash.** Computes the sig-excluded Poseidon2 tx hash the chain verifier reproduces.
6. **FALCON-512 sign.** Produces a ~666-byte signature.
7. **Submit.** POSTs to `pyde_sendRawTransaction`. Receipt poll timeout is **60 seconds, constant** (not CLI-configurable).
8. **Print contract address.** Surfaced from the receipt.

Gas values come from `[deploy]` in `otigen.toml`:

```toml
[deploy]
gas_limit = 10_000_000
gas_price = "auto"          # base_fee + 10% headroom at submission time
```

There is no `--gas-limit` / `--gas-price` CLI flag — change the manifest instead.

### `--dry-run`

```bash
otigen deploy --dry-run --from deployer
```

Goes through steps 1–6, prints the would-be tx, exits without submitting. Useful for inspecting wire bytes before pulling the trigger.

### `--no-wait`

```bash
otigen deploy --no-wait --from deployer
```

Submits without polling for the receipt. Returns immediately with the server tx hash. Useful for scripts that want fire-and-forget; query `pyde_getTransactionReceipt` later.

### Contract addresses

The deployed address is `Poseidon2(self_namespace ‖ contract.name)` — derived deterministically from the contract's registered name. Two consequences:

- You can compute the address before deploy (e.g. for hard-coding into dependent contracts).
- Two contracts can't share a name on the same chain. The chain's name registry rejects duplicate names at deploy time; the failure surfaces as an RPC error from `pyde_sendRawTransaction`.

For parachains, the namespace differs (`pyde-parachain:` vs `pyde-contract:`); they share no name with the contract registry.

---

## 5. After deploy

The contract exists on-chain. The next chapter — [Inspect & Verify](./inspecting.md) — shows you how to read its state, call its functions off-chain (free, via RPC), and prove the on-chain bytes match what you built locally.
