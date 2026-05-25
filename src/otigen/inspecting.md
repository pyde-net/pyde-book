# Inspect & Verify

Reading state from a deployed contract. Confirming the on-chain bytes match what you built locally.

---

## 1. `otigen inspect`

Read-only query against a deployed contract.

```bash
otigen inspect my-counter --network devnet
```

```text
contract:    my-counter
address:     0x4d5e6f7a8b9c0d1e...
type:        contract
version:     1 (deployed at wave 42)
total versions: 1
owner:       0x9b8c7d6e5f4a3b2c... (the deployer)
status:      active
wasm size:   1,234 bytes (blake3 a3f2b8c5d6e7f1a2)
```

What's shown:

- **`type`** — `contract` or `parachain`.
- **`version`** — current version number. Bumped on each `otigen upgrade`.
- **`total versions`** — historical version count. Per [`PARACHAIN_DESIGN.md`](../companion/PARACHAIN_DESIGN.md), old versions are retained forever for replay correctness.
- **`owner`** — who can call `upgrade` / `pause` / `kill`.
- **`status`** — `active`, `paused`, or `killed`. Pause/kill semantics covered in the next chapter.
- **`wasm size + blake3`** — the deployed bytes' hash. Compare against your local bundle to verify (next section does this automatically).

### Read a state field

```bash
otigen inspect my-counter --network devnet --field counter
```

```text
slot:    0x385c70800d89d51e8e16020368f3aa4584636d39404da3abe01489289c1b5445
         (Poseidon2 of contract_addr || "counter")
value:   0x0000000000000000000000000000000000000000000000000000000000000003
decoded: 3 (uint64, decoded per otigen.toml [state] schema)
```

The `--field` flag resolves the field name to a slot hash via the same `Poseidon2(contract_addr || field_name)` derivation the contract uses, then queries `pyde_getStorageAt(address, slot)`. The decoded value comes from the `[state]` schema in `otigen.toml`.

For mapping fields:

```bash
otigen inspect my-token --network devnet --field "balances[0x...]"
```

The key inside the brackets is also Poseidon2-hashed into the slot derivation, matching the canonical convention.

### Call a view function

```bash
otigen inspect my-counter --network devnet --call get
```

```text
calling view function "get" at 0x4d5e6f7a8b9c0d1e...
result:  3 (int64)
gas:     147 (estimated)
```

View calls are **free** — they go through the RPC's view path, don't create a transaction, don't consume gas in the user's wallet. The runner's gas number is informational (a wasmtime fuel estimate).

For functions with arguments:

```bash
otigen inspect my-token --network devnet --call balance_of --args 0x9b8c...
```

---

## 2. `otigen verify`

The reproducibility check. Pulls the on-chain bytes, recomputes them locally, compares.

```bash
make verify
```

```text
verifying my-counter on devnet ...
  fetching on-chain wasm        → 1,234 bytes (blake3 a3f2b8c5d6e7f1a2)
  reading local bundle          → 1,234 bytes (blake3 a3f2b8c5d6e7f1a2)
  comparing                     → byte-identical ✓

  Wasm size: 1,234 bytes ✓
  Blake3:    a3f2b8c5d6e7f1a2... ✓
  ABI:       142 bytes ✓

✓ on-chain bytes match local bundle
```

If they don't match:

```text
✗ verification failed
  Expected: 1,234 bytes (blake3 a3f2b8c5d6e7f1a2)
  Got:      1,189 bytes (blake3 b4c5d6e7f8a9b1c2)
  Size delta: -45 bytes
  First differing byte at offset 0x1a3

  Either:
  - the contract was upgraded after you built locally
    → re-run `otigen build` against the upgraded source, then verify
  - the chain shipped tampered bytes (extremely unlikely if you trust the RPC)
    → query the contract from a different RPC and compare
```

### Why verify matters

Three scenarios it catches:

1. **Build drift.** Two team members build from the same commit and one gets a different bundle. Verify catches it before the inconsistency makes it to production.
2. **Supply-chain attack.** Someone substitutes a bundle between `otigen build` and `otigen deploy`. Verify catches it after deploy.
3. **Compromised RPC.** A malicious RPC serves modified bytes. Verify catches it if you trust the chain's actual storage but not the gateway.

For auditors: re-build from source on a clean machine, run `otigen verify`. Mismatch ⇒ either the deployed contract was modified post-deploy, or the source you have isn't the source that was deployed. Both are red flags.

### --at-wave

```bash
otigen verify my-counter --network devnet --at-wave 42
```

Verifies against a specific historical version. Useful for auditing upgrades: deploy → audit → wave N → upgrade → wave N+1; you can verify the wave-N bytes are still what was deployed at that wave.

---

## 3. Off-chain queries via RPC

For programmatic access, the chain exposes a JSON-RPC. The same RPC `otigen inspect` uses under the hood. See [Chapter 17 — Developer Tools](../chapters/17-developer-tools.md) for the full catalog. Relevant methods for contract state:

| Method | What it returns |
|---|---|
| `pyde_getAccount` | Account metadata (balance, nonce, code hash if contract) |
| `pyde_getContractCode` | The deployed WASM bytes (what `otigen verify` calls) |
| `pyde_getStorageAt` | Read a specific slot |
| `pyde_call` | Execute a view function (free, no tx) |
| `pyde_estimateGas` | Estimate gas for a write call |
| `pyde_getReceipt` | Fetch a tx receipt by hash |
| `pyde_resolveName` | Resolve a contract name to its address |

Example raw call:

```bash
curl -X POST http://localhost:9933 \
     -H 'Content-Type: application/json' \
     -d '{
       "jsonrpc": "2.0",
       "id": 1,
       "method": "pyde_call",
       "params": [
         "0x4d5e6f7a8b9c0d1e...",  // contract address
         "get",                    // function name
         "0x"                      // calldata (empty for nullary)
       ]
     }'
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": "0x0000000000000000000000000000000000000000000000000000000000000003"
}
```

The result is the raw 32-byte return value, hex-encoded.

---

## What's next

You can now deploy a contract, query its state, and prove the on-chain bytes match your local source. The remaining piece of the lifecycle is operating it over time: upgrading the logic, pausing it during incidents, killing it permanently. That's [Lifecycle](./lifecycle.md).
