# Inspect & Verify

Reading state from a deployed contract. Confirming the on-chain bytes match what you built locally.

---

## 1. `otigen inspect`

Read-only query against a deployed account or contract.

```bash
otigen inspect 0xe37844e3800a70e82f18828ed603e49e3db5a0d234e307a3419a4c98ad1c4209
```

```text
  Target:       0xe37844e3800a70e82f18828ed603e49e3db5a0d234e307a3419a4c98ad1c4209
  Address:      0xe37844e3800a70e82f18828ed603e49e3db5a0d234e307a3419a4c98ad1c4209
  Account type: contract
  Balance:      0x0 (hex quanta)
  Nonce:        0
  Code hash:    0x4ac6059a67dea1d8...
  Code size:    5077 bytes
  State root:   0x0000000000000000000000000000000000000000000000000000000000000000
```

What's shown:

- **`Account type`** — `eoa`, `contract`, or `system`. The chain's [`AccountType`](https://github.com/pyde-net/engine/blob/main/crates/types/src/account.rs) discriminant.
- **`Balance`** — current balance in hex quanta (10⁹ quanta = 1 PYDE).
- **`Nonce`** — next acceptable nonce. The chain uses a 16-slot sliding window; this number is `nonce_window.base + bitmap.trailing_ones()`.
- **`Code hash`** — `Poseidon2(runtime_wasm)`. Zero for EOA / system accounts; non-zero for deployed contracts.
- **`Code size`** — length of the deployed bytecode in bytes.
- **`State root`** — Blake3 summary of the contract's storage sub-trie. (V1 keeps this all-zero; the chain uses one global JMT.)

There is no `version` / `total_versions` / `owner` / `status` surface in v1 inspect — the engine doesn't carry those fields on `Account` ([Lifecycle](./lifecycle.md) covers what v1 actually provides and the v2 plan).

### Read a state field

For contracts written with `#[pyde::declare_storage]` (the substrate path, used by every `otigen new` template), use `--state-field`:

```bash
otigen inspect <addr> --state-field counter
```

```text
  Contract:    0xe37844e3800a70e82f18828ed603e49e3db5a0d234e307a3419a4c98ad1c4209
  Field:       counter (uint64)
  Slot:        0xbb4077a4bc85738f57b9b7e95e40b473eeed3c6bb6d0b7b4f9f49718bd903511
  Slot bytes:  0x0300000000000000
  Value:       3
```

`--state-field` derives the slot `Poseidon2(self_address ‖ field_name)` (matching the chain's `sstore_scalar` / `sload_scalar` host fns) and decodes the bytes per the type token declared in your `otigen.toml`'s `[state].schema`. Unset slots render as `<unset>`.

For legacy pre-substrate contracts (those that called `sload` / `sstore` directly with their own `derive_slot` helper), use `--field`:

```bash
otigen inspect <addr> --field counter
```

`--field` derives `Poseidon2(name.as_bytes())` — the convention the hand-written examples used before the substrate macros existed. Picking the wrong flag returns the wrong slot; both produce a hash that hits an unset slot rather than failing loudly, so match the flag to how the contract was written.

For mapping fields the slot derivation includes the key; the inspect surface for mapping reads is currently best-driven through `otigen call <addr> <view-fn>` (next section), which routes through the contract's typed getter rather than computing the slot externally.

### Call a view function

`otigen inspect` does **not** invoke contract code — it only reads state directly. To call a view function (read state through the contract's own logic), use `otigen call`:

```bash
otigen call <addr> get
```

```text
  Call get on 0xe37844e3800a70e82f18828ed603e49e3db5a0d234e307a3419a4c98ad1c4209 (devnet)
  Target:   0xe37844e3800a70e82f18828ed603e49e3db5a0d234e307a3419a4c98ad1c4209
  RPC:      http://127.0.0.1:9933
  Mode:     view (pyde_call — no tx, no gas, no nonce)
  ✓ Call succeeded.
  Return:   0x0300000000000000
```

`otigen call` without `--from` runs in view mode against `pyde_call` — no tx, no gas, no nonce, no signing. Pass `--from <wallet>` to switch to a state-mutating signed call. For arguments:

```bash
otigen call <addr> balance_of 0x9b8c7d6e5f4a3b2c...
```

For the structured-output variant, add `--json`:

```bash
otigen call <addr> get --json
```

The emitted `call_included` NDJSON event includes a `return_data` field with the hex-encoded bytes — useful for scripted consumers.

---

## 2. `otigen verify`

The reproducibility check. Pulls the on-chain bytes, recomputes them locally, compares.

```bash
otigen verify <addr>
```

```text
verifying my-counter on devnet ...
  fetching on-chain wasm        → 5,077 bytes (blake3 4ac6059a67dea1d8)
  reading local bundle          → 5,077 bytes (blake3 4ac6059a67dea1d8)
  comparing                     → byte-identical ✓

  Wasm size:  5,077 bytes ✓
  Blake3:     4ac6059a67dea1d8... ✓
  ABI:        147 bytes ✓

✓ on-chain bytes match local bundle
```

The CLI fetches `pyde_getContractCode(addr)`, re-derives the Blake3 hash of your local `./artifacts/<name>.bundle/contract.wasm`, and compares both byte length and hash. The `--strict-toolchain` flag also compares the toolchain version pin baked into the bundle's `manifest.json` against the running rustc / TinyGo / asc / clang — useful when reproducing audited builds.

If they don't match:

```text
✗ verification failed
  Expected: 5,077 bytes (blake3 4ac6059a67dea1d8)
  Got:      4,989 bytes (blake3 b4c5d6e7f8a9b1c2)
  Size delta: -88 bytes
  First differing byte at offset 0x1a3
```

Possible causes:
- The contract was deployed from different source. Re-build from the source the deployment actually used, then re-verify.
- The chain shipped tampered bytes (only possible if you don't trust the RPC). Query a second RPC and compare.

### Submit to an external verifier

```bash
otigen verify <addr> --explorer https://explorer.pyde.network --api-key-env PYDE_EXPLORER_KEY
```

Uploads `(contract.wasm, manifest.json, metadata.json)` to a verifying explorer's `/api/v1/contracts/<addr>/verify` endpoint. The `--api-key-env` variant reads the bearer token from an env var; `--api-key-stdin` reads from stdin. The CLI redacts the key when echoing the endpoint.

### Why verify matters

Three scenarios it catches:

1. **Build drift.** Two team members build from the same commit and get different bundles. Verify catches it before the inconsistency makes it to production.
2. **Supply-chain interference.** Someone substitutes a bundle between `otigen build` and `otigen deploy`. Verify catches it after deploy.
3. **Compromised RPC.** A malicious RPC serves modified bytes. Verify catches it if you trust the chain's actual storage but not the gateway.

For auditors: re-build from source on a clean machine, run `otigen verify`. Mismatch ⇒ either the deployed contract was modified post-deploy, or the source you have isn't the source that was deployed. Both are red flags.

---

## 3. Off-chain queries via RPC

For programmatic access, the chain exposes a JSON-RPC. The same RPC `otigen inspect` uses under the hood. See [Chapter 17 — Developer Tools](../chapters/17-developer-tools.md) for the full catalog. Relevant methods for contract state:

| Method | What it returns |
| --- | --- |
| `pyde_chainId` | The chain id as `0x...`-hex (`0x7a69` = 31337 for devnet). |
| `pyde_getAccount` | Account metadata (type, balance, nonce, code_hash, state_root). |
| `pyde_getContractCode` | The deployed WASM bytes (what `otigen verify` calls). |
| `pyde_getStorageSlot` | Read a specific slot by its 32-byte hash. |
| `pyde_call` | Execute a view function (free, no tx, no gas charged to a wallet). |
| `pyde_estimateGas` | Estimate gas for a write call. |
| `pyde_getTransactionReceipt` | Fetch a tx receipt by hash. |
| `pyde_resolveName` | Resolve a contract name to its address. |

Example raw call:

```bash
curl -X POST http://127.0.0.1:9933 \
     -H 'Content-Type: application/json' \
     -d '{
       "jsonrpc": "2.0",
       "id": 1,
       "method": "pyde_call",
       "params": [{
         "target": "0xe37844e3800a70e82f18828ed603e49e3db5a0d234e307a3419a4c98ad1c4209",
         "function": "get",
         "calldata": "0x"
       }]
     }'
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": "0x0300000000000000"
}
```

The result is the contract's borsh-encoded return value as hex. For `u64` the bytes are little-endian (`0x03...` = 3). The CLI's view-mode `otigen call` decodes this for you; the raw RPC leaves it to the caller.

---

## What's next

You can now deploy a contract, query its state, and prove the on-chain bytes match your local source. The remaining piece of the lifecycle is operating it over time: upgrading the logic, pausing it during incidents, retiring it permanently. That's [Lifecycle](./lifecycle.md).
