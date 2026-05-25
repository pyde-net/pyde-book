# Shipping

Building a deploy bundle, configuring a wallet, picking a network, then submitting the contract.

By the end of this chapter, your counter contract is live on devnet and you've held the transaction receipt.

---

## 1. `otigen build`

```bash
make build
```

```text
   Compiling my-counter v0.1.0
    Finished `release` profile [optimized] target(s) in 0.27s
✓ built "my-counter" → ./artifacts/my-counter.bundle
  wasm: 1,234 bytes (blake3 a3f2b8c5d6e7f1a2)
  abi:  142 bytes (blake3 9b8c7d6e5f4a3b2c)
```

`make build` runs two steps:

1. **Language compile.** `cargo build --target wasm32-unknown-unknown --release` (or `tinygo build` / `asc` / `clang` for the other languages). Produces a `.wasm` at the path declared in `otigen.toml`'s `[contract.lang].output`.
2. **`otigen build`.** Reads that `.wasm`, validates it, embeds a `pyde.abi` custom section derived from `otigen.toml`, and writes everything into `artifacts/<name>.bundle/`.

### What's in the bundle

```text
artifacts/my-counter.bundle/
├── contract.wasm        # the WASM with the pyde.abi section injected
├── abi.json             # decoded ABI (functions + events + state schema)
└── manifest.json        # build provenance (otigen version, language toolchain, timestamp, hashes)
```

The bundle is the **only** thing the chain ever sees. Everything else in your project (source, tests, Cargo.lock) stays local.

### What gets validated

Per [`OTIGEN_BINARY_SPEC §3.2`](../companion/OTIGEN_BINARY_SPEC.md):

| Check | What fails |
|---|---|
| Well-formed WASM | `wasmparser` rejects malformed bytes |
| Import allowlist | Any import outside the `pyde::*` module ⇒ rejected |
| Function allowlist | Imports of `pyde::*` fns not in HOST_FN_ABI_SPEC §7 ⇒ rejected |
| Parachain gating | A non-parachain contract importing §8 fns ⇒ rejected |
| Export consistency | Every `[functions.X]` in `otigen.toml` must be exported by the WASM. Every non-underscored export must be declared. |
| Forbidden features | Threads, SIMD, GC, reference types, multi-memory, memory64, component model ⇒ rejected (deterministic-execution subset only) |

A clean `otigen build` = a deployable bundle. If validation fails, the error message points at the exact violation; fix the source + re-run.

### Reproducibility

`otigen build` is deterministic. Two clean rebuilds of the same source + the same toolchain produce byte-identical bundles. That's the property `otigen verify` (next chapter) relies on. The build's `manifest.json` records the language toolchain version + timestamp; auditors can re-build from source and check.

---

## 2. Wallets

Pyde signs transactions with **FALCON-512** (post-quantum, per [HOST_FN_ABI_SPEC §7.7](../companion/HOST_FN_ABI_SPEC.md)). Keys are managed via `otigen wallet`.

### Create

```bash
otigen wallet new --name deployer
```

```text
Enter a strong password (>= 12 chars): ************
Re-enter to confirm:                   ************

✓ created account "deployer"
  address:   0x9b8c7d6e5f4a3b2c... (32 bytes, Poseidon2-derived)
  keystore:  ~/.pyde/keystore.json
```

The keystore is a single file at `~/.pyde/keystore.json`, Argon2id-derived key encrypts each account's secret with AES-256-GCM. Multiple accounts live in one file; passwords are per-account.

### Other wallet commands

```bash
otigen wallet list                      # list all accounts
otigen wallet show <name>               # print address + metadata
otigen wallet delete <name>             # remove (asks confirmation)
otigen wallet password <name>           # rotate the password
otigen wallet import <name> <key.json>  # import an existing keystore
```

Full reference: [`OTIGEN_BINARY_SPEC §3.7`](../companion/OTIGEN_BINARY_SPEC.md).

### Funding

A fresh account has zero balance. To fund it on devnet, the devnet has a faucet endpoint:

```bash
curl -X POST http://localhost:9933/faucet \
     -H 'Content-Type: application/json' \
     -d '{"address": "0x9b8c7d6e5f4a3b2c..."}'
```

For testnet / mainnet, real PYDE is required. Acquire via an exchange or the testnet faucet at <https://faucet.testnet.pyde.network>.

---

## 3. Networks

`otigen.toml` declares one or more networks:

```toml
[network.default]
name = "devnet"

[network.devnet]
rpc_url  = "http://localhost:9933"
chain_id = 31337

[network.testnet]
rpc_url  = "https://rpc.testnet.pyde.network"
chain_id = 99999

[network.mainnet]
rpc_url  = "https://rpc.pyde.network"
chain_id = 1
```

`[network.default]` picks which is used when no `--network` flag is passed. You can declare arbitrarily many; the `--network <name>` flag overrides per-command.

---

## 4. `otigen deploy`

```bash
otigen deploy --network devnet --from deployer
```

```text
Enter password for "deployer": ************

building tx:
  type:        ContractDeploy
  contract:    my-counter
  bundle:      ./artifacts/my-counter.bundle (sha256:a3f2b8c5...)
  network:     devnet (chain_id=31337)
  from:        0x9b8c7d6e5f4a3b2c...
  nonce:       0
  gas_limit:   10000000
  gas_price:   125e9 (auto, base fee + 10%)
  fee_payer:   self
  total_fee:   ~1.25 PYDE (cap)

submitting → http://localhost:9933 ...
tx submitted:  tx_hash=0xab12cd34ef56...
waiting for receipt ...

✓ contract "my-counter" deployed
  address:     0x4d5e6f7a8b9c0d1e... (32 bytes, deterministic from contract.name)
  tx_hash:     0xab12cd34ef56...
  block:       42
  gas_used:    1,234,567
  fee:         0.154 PYDE
```

What happened, step by step (per [`OTIGEN_BINARY_SPEC §3.3`](../companion/OTIGEN_BINARY_SPEC.md)):

1. **Bundle re-validation.** `otigen` re-runs every validator from `otigen build` against the bundle. Catches the rare case where someone hand-edited a bundle file between build and deploy.
2. **Network resolution.** Selects the network. Reads `rpc_url` + `chain_id` from `[network.<X>]`.
3. **Wallet unlock.** Prompts for the deployer password.
4. **Nonce fetch.** Queries the network for the deployer's next nonce.
5. **Canonical tx hash.** Computes `tx_hash = Poseidon2(chain_id ‖ from ‖ ...)` — the hash the signature commits over.
6. **FALCON-512 sign.** Produces a ~666-byte signature.
7. **Submit.** POSTs to the RPC's `pyde_sendRawTransaction`.
8. **Poll for receipt.** Until the tx lands in a wave or 30s timeout (configurable).
9. **Print summary.** Deploy outcome + address + gas + fee.

### --dry-run

```bash
otigen deploy --dry-run --from deployer
```

Goes through steps 1-5, prints the would-be tx, exits without submitting. Useful for inspecting tx contents before pulling the trigger.

### --no-wait

```bash
otigen deploy --no-wait --from deployer
```

Submits without polling for the receipt. Returns immediately with the tx hash. Useful for scripts that want fire-and-forget.

### Contract addresses are deterministic

The deployed address is `Poseidon2("pyde-contract:" ‖ contract.name)`. Two consequences:

- You know the address before you deploy. Useful for hard-coding it in dependent contracts.
- Two contracts with the same name collide. The on-chain name registry rejects duplicate names at deploy time; you'll get a clear `ERR_NAME_TAKEN` error before any state changes.

For parachains, the derivation is `Poseidon2("pyde-parachain:" ‖ name)` — separate namespace, can't collide with a contract of the same name.

---

## 5. After deploy

The contract exists on-chain. The next chapter — [Inspect & Verify](./inspecting.md) — shows you how to read its state, call its functions off-chain (free, via RPC), and prove the on-chain bytes match what you built locally.
