# Chapter 17: Developer Tools

Pyde's developer toolchain is the set of command-line programs, SDKs,
and RPC endpoints that let people write, test, deploy, and interact with
contracts. This chapter is the reference.

What's in scope for mainnet:

- `otic` — the Otigen compiler.
- `wright` — the project-level CLI (build, test, deploy, wallet, etc.).
- `pyde` — the node binary (validator + full node) with JSON-RPC.
- `pyde-rust-sdk` — Rust client SDK.
- `pyde-crypto-wasm` — WASM bindings for browser/Node.

What's **not** in scope for mainnet (tracked post-launch):

- A TypeScript SDK (the WASM crate is the bridge until a dedicated TS
  package lands).
- A dedicated Pyde block explorer frontend (the backend indexer is on the
  Phase 7 list; the UI is ecosystem work).
- A proprietary IDE; standard editors + tree-sitter grammar for `.oti` are
  the intended path.

---

## 17.1 `otic` — The Otigen Compiler

The compiler for `.oti` source files. Produces a JSON artifact with PVM
bytecode, an ABI, and metadata.

### Commands

```
otic build <file.oti>    Compile to .json artifact (bytecode + ABI)
otic check <file.oti>    Type check without emitting bytecode
otic test  <file.oti>    Run #[test] functions on an embedded PVM
otic abi   <file.oti>    Print only the ABI JSON
otic lex   <file.oti>    (debug) Dump the token stream
```

Most projects call `otic` indirectly through `wright build` / `wright
test`, which adds project-level conventions (multiple files, dependency
resolution, `pyde.toml` config).

See Chapter 5 for language reference, ABI structure, and test harness
details.

---

## 17.2 `wright` — Project CLI

The Foundry-style project CLI. This is the tool most contract developers
use day-to-day.

### Project lifecycle

```
wright init <name>               Create a new project (src/, test/, pyde.toml, pyde.lock)
wright build                     Compile all .oti files under src/
wright test [--filter] [-v|-vv]  Run #[test] functions across test/
wright fmt                       Auto-format .oti sources
wright clean                     Remove out/ artifacts
wright doc                       Generate docs from contract sources
```

### Deployment and interaction

```
wright deploy [--network N] [--contract C] [--value V] [--private-key K | --wallet W] [--verify]
wright script <file.oti[:Contract]> [--network N] [--private-key K | --wallet W]
wright call   <address> <function()> [--network N]
wright send   <address> <function()> [--network N] [--value V] [--private-key K | --wallet W]
wright tx     <hash> [--network N]
```

`call` runs read-only (no state mutation); `send` builds, signs, and
broadcasts a real transaction.

### Wallet management

```
wright wallet create [--name N]
wright wallet import <pk_hex> <sk_hex> [--name N]
wright wallet list
wright wallet balance [--name N] [--network NET]
wright transfer <to> <amount> [--wallet W] [--network NET]
```

Wallets live in `~/.pyde/wallets/`, encrypted with AES-256-GCM under a
user-provided password.

### Package management

```
wright install [<git-url>] [--rev R] [--name N]
wright remove <name>
```

Dependencies are git-based (no central registry at launch). `pyde.lock`
pins the resolved revisions.

### Dev loop

```
wright console [--network N] [--private-key K | --wallet W]    REPL
wright verify <address> [--contract C] [--network N]           Re-deploy and diff
```

The `console` REPL lets you poke at deployed contracts interactively —
load ABI, call functions, inspect state.

---

## 17.3 The Node Binary (`pyde`)

The binary that runs validators and full nodes. Covered in Chapter 2
(architecture) and Chapter 12 (networking); this section is the CLI-level
reference.

### Subcommands

```
pyde run              Run a node (validator or full)
pyde default-config   Print a default node config TOML
pyde default-genesis  Print a default devnet genesis TOML
pyde testnet          Generate a multi-validator testnet directory tree
pyde faucet           Run a public faucet HTTP server
```

### `pyde run` flags

```
pyde run
   --role <validator|full>      default: full
   --config <path>              TOML config (else use defaults + CLI overrides)
   --port <port>                P2P listen port (default 30303)
   --datadir <path>             data directory (default ~/.pyde)
   --log-level <info|debug>
   --log-json
   --metrics-port <port>        Prometheus endpoint (default 9090)
   --rpc-port <port>            JSON-RPC port (default 8545)
   --dev                        use 31337 chain_id with dev_skip_signature=true
   --bootstrap <multiaddr>      add a bootstrap peer (repeatable)
```

### `pyde testnet` flags

Generates a local multi-node testnet layout.

```
pyde testnet
   --validators <N>             default 2
   --full-nodes <N>             default 0
   --out <dir>                  target directory
   --base-port <port>           default 30303
   --base-rpc-port <port>       default 8545
   --dev                        auto-use chain_id=31337 + skip sigs
   --chain-id <id>              default 31337
   --round-period-ms <ms>       default 150 (DAG round cadence)
```

Produces a directory per node with its own config, genesis, and validator
identity. Run each one with `pyde run --config <per-node.toml>`.

### Config file format

Top-level sections of `pyde.toml` (partial list — see
`pyde default-config` for the full template):

```toml
[node]
role = "full"
chain_id = 31337
datadir = "~/.pyde"
dev_mode = false

[network]
port = 30303
max_peers = 50
max_inbound = 30
max_outbound = 20
rate_limit_per_ip = 5
bootstrap_peers = [
    "/dns4/boot1.pyde.network/udp/30303/quic-v1/p2p/12D3Koo...",
]

[consensus]
round_period_ms = 150            # DAG round cadence
wave_commit_target_ms = 500      # median commit latency target
gas_target = 400_000_000
gas_ceiling = 1_600_000_000
initial_ws_checkpoint_wave = 0

[storage]
db_path = "state"            # relative to datadir
cache_size = 65536

[rpc]
enabled = true
listen = "127.0.0.1"
port = 8545

[fast_tx]
enabled = true
listen = "0.0.0.0"
port = 9545

[metrics]
enabled = true
port = 9090

[logging]
level = "info"
json = false
```

---

## 17.4 JSON-RPC

The node exposes a `pyde_`-prefixed JSON-RPC API on the configured port
(default 8545). See `crates/node/src/rpc.rs`.

### State query

| Method                             | Params                      | Returns                           |
| ---------------------------------- | --------------------------- | --------------------------------- |
| `pyde_getBalance`                  | address                     | string balance (quanta)           |
| `pyde_getTransactionCount`         | address                     | u64 — sender's nonce base         |
| `pyde_getCode`                     | address                     | hex bytecode                      |
| `pyde_getStorageAt`                | (address, slot)             | hex value                         |
| `pyde_chainId`                     | —                           | 0x-prefixed hex chain_id          |
| `pyde_blockNumber`                 | —                           | 0x-prefixed hex head block number |
| `pyde_gasPrice`                    | —                           | current base fee (quanta)         |
| `pyde_stateRoot`                   | —                           | current state root (hex)          |
| `pyde_syncing`                     | —                           | `{headBlock, epoch, stateRoot}`   |
| `pyde_getValidators`               | —                           | validators with status + stake    |
| `pyde_getBlockByNumber`            | block_number                | BlockHeader                       |
| `pyde_getBlockByHash`              | hash                        | BlockHeader                       |
| `pyde_getTransactionReceipt`       | tx_hash                     | receipt with logs + fee breakdown |
| `pyde_getLogs`                     | filter                      | matching logs                     |
| `pyde_mempoolSize`                 | —                           | pending tx count                  |

### Transaction submission

| Method                                    | Params                      | Returns                           |
| ----------------------------------------- | --------------------------- | --------------------------------- |
| `pyde_sendRawTransaction`                 | signed plaintext tx (hex)   | `{"txHash": "0x..."}`             |
| `pyde_sendRawEncryptedTransaction`        | signed Kyber-encrypted tx   | `{"txHash": "0x..."}`             |
| `pyde_sendTransaction`                    | unsigned tx obj (dev only)  | tx hash (dev_skip_signature only) |
| `pyde_call`                               | call obj                    | hex return data (no mutation)      |
| `pyde_estimateGas`                        | call obj                    | gas estimate                      |
| `pyde_estimateAccess`                     | call obj                    | `{ gas, access_list }` combined   |
| `pyde_createAccessList`                   | call obj                    | inferred access list (legacy)     |

`pyde_sendRawTransaction` is what production wallets use. Its handler
(`crates/node/src/rpc.rs::ingress_validate`) validates:

- `chain_id` match.
- FALCON signature verification (skipped only for chain_id 31337).
- Nonce bitmap window.
- Balance vs `gas_limit * base_fee + value`.
- Gas bounds (`21_000 <= gas_limit <= GAS_CEILING`).
- Deadline (if set) > current block number.
- Access list dedup.
- Tx size (≤ 128 KB), calldata size (≤ 64 KB).

On failure, returns a JSON-RPC error. On success, **synchronously publishes
the tx to the gossip channel before returning OK** — no async race where
the client thinks acceptance but the network never hears.

### WebSocket subscriptions

| Method                     | Streams                         |
| -------------------------- | ------------------------------- |
| `pyde_subscribe`           | new block headers               |
| `pyde_subscribePending`    | pending tx hashes                |
| `pyde_subscribeLogs`       | event logs matching a filter     |

### Deprecated / dev-only

`pyde_sendTransaction` (unsigned) is accepted only when `chain_id = 31337`
and `dev_skip_signature = true`. Production networks reject it.

---

## 17.5 `pyde-rust-sdk` — Rust Client SDK

A Rust crate for writing clients, bots, and integration tests against a
Pyde node. Lives in `crates/pyde-rust-sdk`.

### Provider

```rust
use pyde_rust_sdk::{Provider, ProviderOptions};

let provider = Provider::new("http://localhost:8545", ProviderOptions::default())?;
let balance = provider.get_balance(&alice).await?;
let nonce   = provider.get_transaction_count(&alice).await?;
let chain   = provider.chain_id().await?;
```

The provider wraps the `pyde_*` JSON-RPC methods. `get_nonce_and_chain_id`
fetches both in parallel.

### Wallet

```rust
use pyde_rust_sdk::Wallet;

let w = Wallet::generate();                               // random FALCON keypair
let w = Wallet::from_private_key("0x...")?;               // from hex (pk + sk)
let w = Wallet::from_keystore("./keys/alice.json", password)?;
```

Wallet files use AES-256-GCM; the keystore format mirrors Foundry's for
ecosystem compatibility.

### Transaction building

```rust
let tx = wallet.transfer(&recipient, 1_000_000_000).await?;   // 1 PYDE
let tx = wallet.send_call(&contract_addr, calldata, 150_000).await?;
let tx = wallet.send_call_with_value(&contract_addr, calldata, value, 150_000).await?;
let tx = wallet.deploy(bytecode, 1_000_000).await?;
```

The SDK auto-fetches nonce + chain_id, runs `pyde_createAccessList` if an
access list isn't provided, signs with FALCON, and broadcasts. Returns a
`TransactionResponse` the caller can `.await_receipt()` on.

### Contract ABI

```rust
use pyde_rust_sdk::{Contract, Interface};

let iface = Interface::from_abi_file("./out/Token.json")?;
let token = Contract::new(addr, iface, provider.clone());

let total: u256 = token.call("total_supply").await?.try_into()?;

let receipt = token
    .call_mut("transfer")
    .arg(&recipient)
    .arg(&amount)
    .send(&wallet)
    .await?;

for log in receipt.logs {
    if log.topic0() == token.event("Transfer") {
        let (from, to, amount) = log.decode::<(Address, Address, u256)>()?;
    }
}
```

### Encoding / decoding

Public utilities: `hexlify`, `parse_address`, `format_address`,
`parse_quanta`, `format_quanta` (quanta ↔ PYDE conversion). Constants:
`PYDE_DECIMALS = 9`, `ZERO_ADDRESS`.

---

## 17.6 `pyde-crypto-wasm` — WASM Bindings

A WASM crate that exposes Pyde cryptographic primitives and transaction
construction to browser and Node environments. Lives in
`crates/pyde-crypto-wasm`.

### Exported functions

```js
// Key generation + address derivation
const { publicKey, secretKey, address } = generateKeypair();
const addr = deriveAddress(pk_hex);

// Signing + verification
const sig = signMessage(sk_hex, message_hex);
const ok  = verifySignature(pk_hex, message_hex, sig_hex);

// Hashing
const h        = poseidon2Hash(data_hex);
const selector = computeSelector("transfer");         // FNV-1a -> u32

// Transactions
const txHash = hashTransaction({
    from, to, value, data, gasLimit, nonce, chainId, txType, accessList
});
const wireBytes = signTransaction(
    { from, to, value, data, gasLimit, nonce, chainId, txType, accessList },
    sk_hex
);
```

A browser wallet that wants to sign Pyde transactions uses `signMessage`
(FALCON-512) or `signTransaction` (full tx encoding + sign in one call).
A JS-based dApp can call `computeSelector` to work out the 4-byte function
selector at runtime without hard-coding it.

The module is published as a standard wasm-bindgen package; the build
output is consumed by any tool that can import WASM (bundlers, Node
require, browser script tags, etc.).

---

## 17.7 Faucet (`pyde faucet`)

For testnets, the node binary includes a simple faucet HTTP server.

```
pyde faucet
   --rpc <url>                    http://localhost:8545
   --port <port>                  default 8080
   --amount <PYDE>                default 100
   --from <address>               source account (must hold balance)
   --private-key <hex>            signing key for source
   --cooldown <secs>              per-IP cooldown
```

POSTs to `/faucet` drop the configured `amount` PYDE to the requested
address, subject to the cooldown. Meant for testnet onboarding and
integration tests, not mainnet.

---

## 17.8 Testnet Quickstart

A typical "join the testnet as a full node" flow:

```bash
# Install pyde (pre-compiled binary or from source)
cargo install --path crates/node    # from repo

# Initialize from defaults
mkdir mytestnet && cd mytestnet
pyde default-config > pyde.toml

# Edit pyde.toml: set chain_id, bootstrap_peers for the target testnet

# Start the node
pyde run --role full --config ./pyde.toml

# In another terminal, query the node
curl -X POST http://localhost:8545 \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"pyde_blockNumber","params":[],"id":1}'
```

A typical validator flow is the same, plus a validator identity file and
`--role validator`. The full-node flow is what most operators and
integrators want.

---

## 17.9 Deploying a Contract

End-to-end with `wright`:

```bash
# Create a project
wright init mytoken
cd mytoken

# Write src/Token.oti (see Chapter 5)
# ...

# Build
wright build

# Test
wright test

# Create a wallet
wright wallet create --name deployer

# Fund via faucet (testnet) or transfer
wright wallet balance --name deployer --network testnet

# Deploy
wright deploy \
    --network testnet \
    --contract Token \
    --wallet deployer
# >>> Deployed at 0xpyde1abc...
# >>> tx hash 0xdef123...

# Interact
wright call 0xpyde1abc... "total_supply()" --network testnet
wright send 0xpyde1abc... "transfer(Address,u256)" \
    --wallet deployer \
    --network testnet \
    --args 0xpyde1xyz... 100
```

`wright verify <addr>` re-builds the local sources and compares the
resulting bytecode to the on-chain deployment — the standard contract-
verification flow.

---

## 17.10 Tooling Gaps at Mainnet

Honest about what is not yet shipped:

| Tool / capability                         | Status at mainnet                  |
| ----------------------------------------- | ---------------------------------- |
| TypeScript SDK                            | Not shipped; WASM bridge available |
| Browser-native wallet                     | Ecosystem; WASM exposes primitives |
| Block explorer frontend                   | Backend in Phase 7; UI is ecosystem|
| IDE-specific plugins                      | tree-sitter grammar + LSP possible |
| Debugger (step-through in otic / PVM)     | Not shipped; `otic test` is the test loop |
| Persistent receipt archive                | Task 058, post-mainnet             |

The core path — write a contract, test it, deploy it, call it, read the
receipt — works end-to-end at mainnet.

---

## Summary

| Tool                  | Purpose                                              |
| --------------------- | ---------------------------------------------------- |
| `otic`                | Compile `.oti` → JSON artifact (bytecode + ABI)      |
| `wright`            | Project-level workflow (build, test, deploy, wallet) |
| `pyde` binary         | Run validator or full node; JSON-RPC on 8545         |
| `pyde-rust-sdk`       | Rust client SDK (provider, wallet, contract helpers) |
| `pyde-crypto-wasm`    | Browser / Node WASM for FALCON, Poseidon2, tx hash   |
| `pyde faucet`         | Testnet faucet HTTP server                            |

The next chapter covers protocol upgrades — the voluntary validator
upgrade flow, emergency pause windows, and migration patterns.
