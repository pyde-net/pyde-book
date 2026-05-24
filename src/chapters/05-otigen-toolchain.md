# Chapter 5: Otigen Toolchain

`otigen` is Pyde's developer toolchain — a single binary that **validates** the author's WASM build, **generates** the ABI from `otigen.toml`, **packages** the deploy bundle, and handles **on-chain lifecycle commands** (deploy, upgrade, pause, kill, inspect, wallet, console).

What `otigen` deliberately does NOT do: it does not compile WASM, it does not generate code, it does not interface with any language's build pipeline. Authors run their own `cargo build` / `asc` / `tinygo build` / `clang --target=wasm32` and `otigen` checks the result. This keeps the toolchain minimal and language-agnostic, and lets authors keep their full native toolchain experience.

The name carries forward from an earlier design phase, when Otigen was Pyde's domain-specific smart-contract language. The language is retired; the name now describes the role it occupies best — the lightweight verifier and packager that makes WebAssembly deployment on Pyde coherent without forcing authors out of their language ecosystems. See [The Pivot](../preface/pivot.md) for the full story.

This chapter covers the toolchain's design, the subcommand surface, the `otigen.toml` schema, the per-language workflow, build verification, attributes, deploy/upgrade, wallet, and the console.

For the underlying execution layer that contracts run on, read [Chapter 3: Execution Layer](./03-virtual-machine.md). For the host functions contracts call, read the Host Function ABI spec.

---

## 5.1 Design Principles

The toolchain is built around four principles, each chosen deliberately.

### Author owns the build; otigen verifies

`otigen` does not compile WASM. The author runs their language's native build command (`cargo build --target wasm32-unknown-unknown --release`, `asc assembly/index.ts -O`, `tinygo build -target wasm-unknown`, `clang --target=wasm32 -O3`) themselves. They get the full diagnostics, the full IDE integration, the full test workflow their language ecosystem provides.

`otigen build` then **verifies** the result: confirms the `.wasm` file exists at the path declared in `otigen.toml`, validates the WASM module structure, cross-checks that the module imports only allowed host functions and exports every function declared in `[functions]`, and generates the deploy bundle. If anything is missing or wrong, `otigen` says so; if everything checks out, it prints "ready to deploy."

This keeps the toolchain minimal (no per-language compiler invocation logic to maintain) and respects the author's native toolchain.

### Zero extra code in the author's project

A contract project contains only the author's contract logic and an `otigen.toml`. No bundler files, no glue code, no manifest-handling boilerplate. The author writes what their language requires (a `Cargo.toml` for Rust, `package.json` for AssemblyScript, `go.mod` for Go, `Makefile` for C/C++) and the contract source itself.

State access and host-function calls go through whatever helper pattern the author or community provides for their language. `otigen` doesn't ship those helpers, doesn't generate them, doesn't depend on them. It only requires that the resulting `.wasm` imports the Host Function ABI correctly.

### Native test runners

Each language has a mature test framework. The toolchain does not wrap them. Rust authors run `cargo test`. AssemblyScript authors run `npm test`. Go authors run `go test`. C authors use whatever they already use. The toolchain does not impose its own test command.

### Attributes and ABI declared in otigen.toml, enforced at runtime

Function attributes (`view`, `payable`, `reentrant`, `sponsored`, `constructor`, `fallback`, `receive`, `entry`) and state schema are declared in `otigen.toml`. `otigen build` reads them, builds a `ContractAbi` struct, Borsh-encodes it, and **injects it as a WASM custom section named `pyde.abi`** directly into the .wasm artifact the language compiler produced. There is no separate `abi.json` file at deploy time — the ABI travels with the code as one binary. At runtime, the WASM execution layer extracts the `pyde.abi` section once, caches the parsed ABI alongside the compiled Module, and applies attribute-driven guards before every call (reentrancy block, view-mode state-write rejection, payable-mode value check, sponsored gas-tank debit, etc.). The WASM module itself does not carry attribute markers — the engine enforces them at the call boundary based on the parsed ABI. Full mechanics: [Host Function ABI Spec §3.5–§3.7](../companion/HOST_FN_ABI_SPEC.md).

---

## 5.2 Subcommand Surface

| Command | Purpose | v1 status |
|---------|---------|-----------|
| `otigen init <name> --lang <rust\|as\|go\|c>` | Scaffold a new project directory from the language template. Writes `otigen.toml` + a hello-world contract + language-specific build config (Cargo.toml / package.json + asconfig.json / go.mod / Makefile). | ✅ |
| `otigen build` | **Verify + package.** Reads `otigen.toml`, locates the `.wasm` at the declared path, validates the WASM module (well-formed, imports allowed only, no `wasi:*` / `env`), cross-checks declared `[functions]` exist as WASM exports, builds the `ContractAbi`, Borsh-encodes it, injects as the `pyde.abi` custom section, writes `<contract>.bundle/`. Does NOT compile WASM — the author runs their own language build. | ✅ |
| `otigen deploy` | Sign and submit a deploy transaction. Loads the bundle, re-validates, fetches nonce, builds the canonical `Tx`, FALCON-signs the Poseidon2 hash, submits via `pyde_sendRawTransaction`, polls the receipt. `--dry-run` to inspect without submitting; `--no-wait` to skip the receipt poll. | ✅ |
| `otigen upgrade <target>` | Submit an upgrade transaction. Same pipeline as deploy but `TxType::Standard` with `LifecyclePayload::Upgrade { new_wasm }`. | ✅ contract owner-signed upgrade; ⏳ parachain governance flow (`--parachain` / `--finalize <proposal-id>`) deferred to the parachain rollout post-mainnet. |
| `otigen pause` / `unpause` / `kill` | Operational lifecycle. Owner-signed `LifecyclePayload::{Pause, Unpause, Kill}`. `kill --yes` skips the retype-the-target confirmation. | ✅ |
| `otigen inspect <target>` | Read deployed contract state via the rpc client. Surfaces address, account type, balance, nonce, code hash, code size, state root. `--field <name>` queries `Poseidon2(name)`-derived storage slots; `--at-wave <id>` is forwarded for archive nodes. | ✅ account + state fields; ⏳ owner / version history / ABI summary land when the RPC catalog grows the corresponding endpoints. |
| `otigen verify <target>` | Reproducibility check: compares the local bundle's `contract.wasm` against the chain-stored bytes from `pyde_getContractCode`. Exit 0 on match, 1 on mismatch with blake3 hashes + size delta + first-diff offset. | ✅ |
| `otigen wallet` | FALCON-512 keystore management. Subcommands: `new <name>`, `list`, `show <name>`, `import <name>` (interactive), `delete <name> [--yes]`, `password <name>`. | ✅ six subcommands; ⏳ chain-side `rotate` (`KeyRotationTx`), `export <name>` (encrypted backup), and `sign <name> <hex>` deferred to a later pass. |
| `otigen console` | Interactive REPL against a Pyde node. | ⏳ post-v1. Every read / write surface is already scriptable via the other subcommands; the REPL is a UX nicety that benefits more from being built after the chain is live than before. |

There is no `otigen test`. Authors use their language's native test runner.

There is no `otigen compile`. Authors use their language's native compiler.

---

## 5.3 The otigen.toml Schema

A single TOML file declares everything `otigen` needs to know about the project.

```toml
[project]
name = "my_token"
version = "1.0.0"
language = "rust"            # one of: rust, assemblyscript, go, c

[build]
wasm_path = "target/wasm32-unknown-unknown/release/my_token.wasm"
# Author runs their own language build to produce this file.
# otigen build verifies it exists, validates it, and packages it.

[contract]
type = "smart_contract"      # or "parachain"
description = "A simple PYDE-flavored token contract."

[name_registry]
name = "mytoken"             # ENS-style unique name (see Account Model)
extension = "pyde"           # reserved for v2; v1 uses flat namespace

[state]
# Declares the contract's state schema. Used for ABI generation,
# explorer indexing, and cross-validation against runtime access patterns.
# Authors derive slot_hash values themselves in their contract code.
balance        = { type = "map<address, uint128>", disc = 0 }
nonce          = { type = "map<address, uint64>",  disc = 1 }
allowances     = { type = "map<address, map<address, uint128>>", disc = 6 }
total_supply   = { type = "uint128",                disc = 7 }

[functions.transfer]
attributes = ["entry", "payable"]
inputs     = ["address", "uint128"]
outputs    = []

[functions.balance]
attributes = ["entry", "view"]
inputs     = ["address"]
outputs    = ["uint128"]

[functions.complex_callback]
attributes = ["entry", "reentrant"]   # opts INTO reentrancy; default is BLOCKED
inputs     = ["bytes"]

[functions.user_signup]
attributes = ["entry", "sponsored"]   # gas paid from contract's gas_tank
inputs     = ["address"]

[functions.init]
attributes = ["constructor"]          # callable only at deploy time
inputs     = ["uint128"]

[deploy]
network        = "testnet"   # or "mainnet" or a named local node
owner_wallet   = "alice"     # name of the wallet to sign with
deposit        = 1000        # in PYDE; forfeited on misbehavior

[gas]
max_per_tx     = 10_000_000  # cap; can be raised at deploy time
```

### Schema notes

**`[project]`** — basic metadata. `language` is informational only; it tells humans (and explorers) what language the source is in. `otigen` does not use this to invoke a compiler.

**`[build]`** — the most important field: `wasm_path` tells `otigen build` where to find the `.wasm` file the author produced. If the file is missing, `otigen build` says so with a clear error and exits.

**`[contract]`** — for smart contracts, just descriptive. For parachains, this section grows to include consensus type, validator constraints, slashing preset (see Chapter 13).

**`[name_registry]`** — the human-readable name under which the contract will be registered. Names are globally unique (per the ENS-style registry in the account model chapter). Registration costs PYDE; renewal is yearly with a grace period.

**`[state]`** — the schema of the contract's storage. Each entry declares a state field name, its type, and its discriminator. Used for: ABI emission (so explorers can decode state), explorer indexing, and as a reference for the author's hand-written slot derivation. `otigen` does not generate accessor code — the author writes their state access using whatever pattern their language community settles on.

**`[functions.<name>]`** — declares each callable function in the contract along with its attributes and signature. Every function the runtime should be able to invoke must have an entry here; `otigen build` cross-checks that every `[functions.X]` corresponds to a WASM export named `X`. Attributes are enforced at runtime by the engine based on what's in the deployed ABI.

**`[deploy]`** — settings for `otigen deploy`. Overridable on the command line.

**`[gas]`** — gas cap for the contract. Defaults are usually fine; explicit setting allows larger budgets where needed.

---

## 5.4 Per-Language Workflow

Each language has its own template (scaffolded by `otigen init`) and its own native build command. The author runs the build; then `otigen build` verifies + packages.

### Rust

```bash
otigen init my_contract --lang rust
cd my_contract
# Edit src/main.rs with contract logic, declare entries + state in otigen.toml

# Author runs their own build:
cargo build --release --target wasm32-unknown-unknown

# otigen verifies and packages:
otigen build
otigen deploy --network testnet
```

Scaffolded project tree:
```
my_contract/
├── otigen.toml                 # author edits state + functions sections
├── Cargo.toml                  # pre-configured for wasm32-unknown-unknown
├── .cargo/config.toml          # target defaults
├── src/
│   └── main.rs                 # template with extern host-fn declarations + one example entry
├── tests/
└── .gitignore
```

`otigen build` does:
- Read `otigen.toml`; confirm `[build].wasm_path` points to an existing file.
- Validate the WASM module (parses cleanly, only imports allowed host functions, only uses allowed WASM features).
- Cross-check: every `[functions.X]` has a matching WASM export named `X`.
- Generate `artifacts/<contract_name>.abi.json` from the `[state]` and `[functions]` tables.
- Package `artifacts/<contract_name>.bundle` containing the `.wasm` + ABI + deploy metadata.
- Print "ready to deploy" with the resolved paths.

### AssemblyScript

```bash
otigen init my_contract --lang assemblyscript
cd my_contract
# Edit assembly/index.ts, declare entries + state in otigen.toml

npm run asbuild      # or: npx asc assembly/index.ts -O --outFile build/my_contract.wasm

otigen build         # verify + package
otigen deploy --network testnet
```

### Go (TinyGo)

```bash
otigen init my_contract --lang go
cd my_contract
# Edit main.go, declare entries + state in otigen.toml

tinygo build -target wasm-unknown -o build/my_contract.wasm

otigen build         # verify + package
otigen deploy --network testnet
```

### C/C++

```bash
otigen init my_contract --lang c
cd my_contract
# Edit src/main.c, declare entries + state in otigen.toml

clang --target=wasm32 -O3 -Wl,--no-entry -o build/my_contract.wasm src/main.c

otigen build         # verify + package
otigen deploy --network testnet
```

### Why this split

Authors keep their full language toolchain (build errors, IDE integration, dependency management, test runners, fuzzers, profilers — everything). The chain-specific concerns (ABI generation, deploy packaging, on-chain lifecycle) are owned by `otigen`. The interface between them is the `.wasm` file + the `otigen.toml` schema; both are inspectable, neither is generated by the other.

---

## 5.5 Build Verification + Packaging

`otigen build` is purely a validator + packager. It runs in roughly this order:

```
1. Load otigen.toml; reject if required sections are missing.
2. Resolve [build].wasm_path; reject if the file doesn't exist.
3. Parse the .wasm file; reject if the binary is malformed.
4. Walk the WASM import table; reject any import outside the Host Function ABI allowlist.
5. Walk the WASM export table; cross-check every [functions.X] has a matching export named X.
6. Validate attribute combinations per function (no view+payable, no constructor outside [functions], etc.).
7. Validate state schema: discriminator uniqueness, type validity, map-key types declared.
8. Generate artifacts/<contract_name>.abi.json from [state] + [functions].
9. Package artifacts/<contract_name>.bundle:
     - .wasm bytes
     - abi.json
     - otigen.toml snapshot
     - manifest with sha256 hashes
10. Print "ready to deploy" with the bundle path and contract name.
```

If any step fails, `otigen build` exits non-zero with a structured error message identifying what's missing or wrong. No partial bundles are written.

### How authors do state access (without otigen-generated code)

Because `otigen` doesn't generate bindings, the author writes their state access using whatever pattern their language community supplies (or just uses raw extern declarations + a small helper module they write themselves). Pyde does not ship per-language SDKs (see [no-SDK approach](../preface/pivot.md)) — the canonical example projects in `pyde-net/otigen` show one workable pattern per language.

A typical Rust pattern looks like this (the author writes the entire file; `otigen` never touches it):

```rust
// src/main.rs (author writes all of this)

// Host function imports (declared once, used everywhere):
extern "C" {
    fn pyde_storage_read(slot_hash_ptr: *const u8, slot_hash_len: usize) -> i64;
    fn pyde_storage_write(slot_hash_ptr: *const u8, slot_hash_len: usize, value_ptr: *const u8, value_len: usize);
    fn pyde_caller(out_ptr: *mut u8);
    fn pyde_emit_event(topic_ptr: *const u8, topic_len: usize, data_ptr: *const u8, data_len: usize);
    fn pyde_poseidon2(input_ptr: *const u8, input_len: usize, out_ptr: *mut u8);
}

// Slot derivation: author derives slot_hash according to the PIP-2 layout
// described in Chapter 4. They can precompute the contract's address prefix
// as a `const fn` invocation, or compute on first use and cache.
const CONTRACT_NAME: &[u8] = b"mytoken";
const BALANCE_DISC: u8 = 0;  // from otigen.toml

fn balance_slot(addr: &[u8; 32]) -> [u8; 32] {
    let mut slot = [0u8; 32];
    let contract_prefix = poseidon2_const_prefix(CONTRACT_NAME);  // computed at startup; cached
    slot[..16].copy_from_slice(&contract_prefix[..16]);
    let mut inner_input = [0u8; 33];
    inner_input[0] = BALANCE_DISC;
    inner_input[1..].copy_from_slice(addr);
    let mut inner = [0u8; 32];
    unsafe { pyde_poseidon2(inner_input.as_ptr(), inner_input.len(), inner.as_mut_ptr()); }
    slot[16..].copy_from_slice(&inner[..16]);
    slot
}

// Entry function — name must match [functions.transfer] in otigen.toml
#[no_mangle]
pub extern "C" fn transfer(to_ptr: *const u8, amount_lo: u64, amount_hi: u64) -> i32 {
    // ... read inputs, derive slots, call pyde_storage_read/write, etc.
    0  // success
}
```

The author has total control over how slot derivation is done. They can precompute prefix hashes at startup (Rust `lazy_static!`, AssemblyScript module-level init, Go `init()`), keep them in module-level constants, or call `pyde_poseidon2` per access. None of this is `otigen`'s concern — `otigen` just checks that the resulting `.wasm` is well-formed and matches the declared `[functions]`.

### Build-time pre-hashing is the author's responsibility (and easy)

The build-time pre-hashing optimization (computing contract-name prefix once at compile time) is a per-language pattern. In Rust it's a `const fn` or a `lazy_static!`. In AssemblyScript it's a top-level constant initializer. In Go it's an `init()`. In C it's a `static const` array. The author follows their language's idioms; `otigen` doesn't get involved.

---

## 5.6 Safety Attributes via otigen.toml

Otigen the language had a set of compiler attributes that made common safety properties default and explicit. **Every one of those properties carries forward unchanged in the WASM era.** Authors declare them in `otigen.toml` `[functions.<name>] attributes = [...]`; `otigen build` includes them in the generated ABI; the runtime enforces them by reading the ABI before invocation and applying the appropriate guards.

The mechanism changed (config-declared metadata enforced at the call boundary instead of compiler-extracted markers in bytecode), but the safety guarantees are identical to the Otigen-language era.

### Reentrancy is still blocked by default

This is the most important property to preserve. Every public function gets an automatically generated reentrancy guard. To **opt OUT** of the guard — for a function that genuinely needs to allow re-entry — add the `#[reentrant]` attribute.

If you write nothing, you are protected.

### The attribute set

| Attribute     | Effect                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------- |
| `view`        | Read-only function. Runtime rejects any state-modifying host call inside it. View calls are FREE (no gas) — see [HOST_FN_ABI_SPEC §7.8](../companion/HOST_FN_ABI_SPEC.md). |
| `payable`     | Function accepts PYDE attached to the call. Non-`payable` functions reject any attached amount. |
| `reentrant`   | **Opts INTO** allowing reentrancy. Default for every function is reentrancy-blocked.            |
| `constructor` | Initialization-only. Callable exactly once, at deploy time.                                     |
| `sponsored`   | Gas charged to the contract's `gas_tank` rather than the caller's balance. Enables gasless UX.  |
| `fallback`    | Invoked when the call's function selector matches no declared function. At most one per contract. |
| `receive`     | Invoked on bare PYDE transfers (no selector, value > 0). At most one per contract. **Must also be `payable`**. |
| `entry`       | Marks the function as callable from outside the contract (top-level tx or cross_call). Required for any function not marked with another dispatch attribute (`constructor`/`fallback`/`receive`). Internal helpers omit `entry` and are not exposed in the public selector table. |

For attribute compatibility rules (which combinations are rejected at build + deploy), see [HOST_FN_ABI_SPEC §3.5.1](../companion/HOST_FN_ABI_SPEC.md).

### How attributes are declared

Attributes are declared in `otigen.toml`, per function. The author writes plain TOML; the source code is whatever they write in their language. No per-language macro syntax is needed and no source-code parsing is required.

```toml
[functions.balance]
attributes = ["entry", "view"]
inputs     = ["address"]
outputs    = ["uint128"]

[functions.deposit]
attributes = ["entry", "payable"]
inputs     = []

[functions.complex_callback]
attributes = ["entry", "reentrant"]   # opts INTO reentrancy; default is BLOCKED
inputs     = ["bytes"]

[functions.user_signup]
attributes = ["entry", "sponsored"]   # gas paid by contract's gas_tank
inputs     = ["address"]

[functions.init]
attributes = ["constructor"]          # callable only at deploy time
inputs     = ["uint128"]
```

The author writes the corresponding WASM exports in their language as normal exported functions. There is no required annotation pattern in source — the function just needs to be exported under the name declared in `[functions.<name>]`. In Rust, this is `#[no_mangle] pub extern "C" fn balance(...)`. In AssemblyScript, `export function balance(...)`. In Go (TinyGo), `//go:wasmexport balance`. In C, `__attribute__((export_name("balance")))`. Standard WASM-export idioms for each language.

### What the build tool does with attributes

`otigen build` validates them (e.g., a function cannot be both `view` and `payable`) and writes them into the generated ABI:

```json
{
  "functions": [
    {
      "name": "transfer",
      "selector": "0xa9059cbb",
      "attributes": ["entry"],
      "inputs": [...],
      "outputs": [...]
    },
    {
      "name": "balance",
      "selector": "0x70a08231",
      "attributes": ["entry", "view"],
      "inputs": [...],
      "outputs": [...]
    },
    {
      "name": "user_signup",
      "selector": "0x...",
      "attributes": ["entry", "sponsored"],
      "inputs": [...],
      "outputs": [...]
    }
  ]
}
```

### How the runtime enforces them

The WASM execution layer reads the function's attribute set from the deployed ABI before invocation and applies the appropriate behavior:

| Attribute     | Runtime enforcement                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `view`        | Host functions `sstore`, `sdelete`, `transfer`, `emit_event` trap if called inside a view function.                                                              |
| `payable`     | If `tx.value > 0` and target function is not `payable`, transaction reverts at dispatch. No state change.                                                        |
| `reentrant`   | Runtime skips the reentrancy guard for this function. ALL OTHER functions get the guard.                                                                         |
| Not `reentrant` (default) | On entry, the runtime sets a per-contract reentrancy flag. Any host call that re-enters this contract checks the flag; if set, traps with `ReentrancyViolation`. On exit, flag is cleared. |
| `constructor` | Callable only by the deploy transaction. Subsequent calls trap.                                                                                                  |
| `sponsored`   | At dispatch time, the engine debits gas from the contract's `gas_tank` instead of the caller's balance. If the gas tank is empty, transaction reverts.            |

This is identical behavior to Otigen the language. The change is implementation venue: attributes now ride on the ABI declared in `otigen.toml` rather than on compiler-extracted markers in bytecode. The safety guarantees are the same. The author's per-function declaration moves from source-code annotation to a config file. Both equally explicit; the config form keeps `otigen` decoupled from per-language source parsing.

### Other Otigen design choices preserved

Beyond function attributes, several broader Otigen design choices carry forward as runtime properties of the engine:

| Otigen design choice                | How it's preserved in the WASM era                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Reentrancy off by default           | Runtime reentrancy guard for every function not marked `reentrant`.                                                       |
| Checked arithmetic by default       | Per-language SDK helper patterns; wrapping ops require explicit opt-in (e.g., Rust's `wrapping_add` is explicitly named). |
| Typed storage                       | `otigen.toml` `[state]` schema declares types; ABI includes the schema so the runtime + explorers know what each slot is. Authors implement type-safe access in their own code. |
| No `tx.origin`                      | Host function ABI exposes `caller()` (direct caller) but no `origin()`. The Solidity-style phishing footgun is absent.     |
| Compile-time access lists           | Build tool emits a static access list per function from the declared state schema; the parallel scheduler uses these.     |
| 4-byte function selectors           | Build tool emits `selector = first 4 bytes of Hash(function_signature)` in the ABI.                                       |
| Sponsored / gasless transactions    | `#[sponsored]` attribute + `gas_tank` per contract account, exactly as designed in the Otigen era.                        |
| Reserved-storage-slot guards        | Reentrancy guard uses a reserved slot in the contract's state subtree, never reachable by user-allocated slots.            |

The safety floor that Otigen provided is preserved end-to-end. The mechanism is different; the contract author's experience is the same.

---

## 5.7 Deploy and Upgrade Flow

### Deploy

```bash
otigen deploy --network testnet
```

What happens:

1. `otigen` reads `otigen.toml`, validates the contract is built (`artifacts/<name>.bundle` exists and is current).
2. `otigen` checks the name registry on-chain: is `mytoken` available? If taken, fail with a clear error.
3. `otigen` opens the wallet keystore, prompts for password if encrypted, signs the deploy transaction.
4. The deploy transaction includes:
   - Contract name (`mytoken`)
   - Registration fee payment (tiered by name length)
   - Owner deposit (forfeit on misbehavior)
   - WASM bytes
   - ABI JSON
   - Initial state values (if any from constructor)
5. `otigen` submits the transaction to the node.
6. `otigen` polls for inclusion, reports the contract address once committed.
7. Done.

### Upgrade

```bash
otigen upgrade --network testnet
```

What happens (smart contract path):

1. `otigen` builds the new version (same as `otigen build`).
2. `otigen` submits an upgrade transaction signed by the owner key.
3. The chain applies the upgrade after a grace period (configurable in `otigen.toml`; default 100 waves) to give users time to verify.
4. After grace period: new WASM takes effect, version field increments. The full version history is retained on-chain (see Chapter 13 for parachain upgrade details).

For parachain upgrades, the upgrade flow routes through equal-power validator voting instead of owner-only authorization.

---

## 5.8 Wallet Management

The wallet is built into the `otigen` binary directly — no separate wallet daemon, no external dependency, no extra install step. The implementation is ported forward from the wright toolchain that this binary replaces; the wallet protocol, the keystore format, the file layout, and the subcommand surface are all preserved unchanged.

### Why ported from wright

The wright wallet implementation was already production-quality: FALCON-512 keypair generation, AES-256-GCM keystore encryption, Argon2id key derivation from a user passphrase, in-memory key unlock with explicit re-lock. None of that needed to change with the WASM pivot — the wallet's job is to manage FALCON keys and sign transactions, both of which are unchanged across pivots.

So we copy it forward, preserving the format compatibility so wright-era wallet files (`~/.pyde/wallets/*.json`) can still be loaded by `otigen wallet` commands.

### Subcommand surface

```bash
otigen wallet create --name alice
    # Generate a new FALCON-512 keypair. Prompts for an encryption passphrase.
    # Writes ~/.pyde/wallets/alice.json (encrypted keystore).

otigen wallet import --name bob --from-file ./bob.key
    # Import an existing keypair (e.g., from a hardware backup).

otigen wallet import --name carol --pk-hex 0x... --sk-hex 0x...
    # Import from raw hex (e.g., from another tool's export).

otigen wallet list
    # Show all wallets in ~/.pyde/wallets/, with addresses and last-used timestamps.

otigen wallet export-pubkey alice
    # Print the FALCON public key (safe to share; not the signing key).

otigen wallet balance --name alice --network testnet
    # Query the live balance for this wallet's address.

otigen wallet remove --name old_wallet
    # Delete a wallet keystore (with confirmation prompt).
```

### Keystore format

A wallet is a single JSON file at `~/.pyde/wallets/<name>.json`:

```json
{
  "name": "alice",
  "version": 1,
  "address": "0xa1b2c3d4e5f6...",
  "falcon_pubkey": "0x...",
  "encrypted_secret_key": {
    "ciphertext": "0x...",         // AES-256-GCM ciphertext of the FALCON private key
    "nonce": "0x...",              // AES-GCM nonce
    "kdf": "argon2id",
    "kdf_params": {
      "salt": "0x...",
      "memory_cost": 65536,
      "time_cost": 3,
      "parallelism": 4
    }
  },
  "created_at": "...",
  "last_used_at": "..."
}
```

The encrypted private key is decrypted in-memory only when the wallet is unlocked for signing. The plaintext key never touches disk and is zeroized when the wallet locks (explicit `otigen wallet lock` or process exit).

### Signing flow

When `otigen deploy`, `otigen upgrade`, or any other subcommand that submits a transaction is invoked with `--wallet <name>`:

1. Read the encrypted keystore from `~/.pyde/wallets/<name>.json`.
2. Prompt for the passphrase (unless `--unlock-with-env PYDE_PASSPHRASE` is set, for CI use).
3. Derive the AES key from the passphrase via Argon2id.
4. Decrypt the FALCON private key in memory.
5. Construct the transaction, hash it, FALCON-sign with the private key.
6. Submit the signed transaction to the network.
7. Zeroize the in-memory private key.

### External signer protocol

For production deployment workflows requiring hardware signing or multi-party key custody, the toolchain supports an **external signer protocol** (modeled after ethers.js's external signer interface). Instead of `otigen` reading the keystore directly, it sends the transaction hash to an external process over a defined IPC protocol; that process returns a FALCON signature.

```bash
otigen deploy --network mainnet --external-signer "http://localhost:8765/sign"
```

This allows integration with:
- Hardware wallets (when FALCON-aware hardware wallets become available).
- HSM-backed signing services.
- Multi-party computation (MPC) signing.
- Air-gapped signing setups.

Native hardware wallet support and HSM integrations are planned post-mainnet; the external signer protocol is the v1 extension point.

### Compatibility note

Wallets created with the old wright toolchain (`~/.pyde/wallets/*.json` written by `wright wallet create`) are bit-compatible with `otigen wallet`. You do not need to re-create wallets after upgrading the toolchain. The `otigen` binary reads, signs with, and writes the same file format.

---

## 5.9 The Console

```bash
otigen console --network testnet
```

A REPL against a Pyde node, useful for exploration and debugging:

```
otigen> wallet alice
Loaded wallet 'alice'. Address: 0xa1b2c3d4e5f6...

otigen> balance 0xa1b2c3d4e5f6
1,000,000 PYDE

otigen> call mytoken total_supply
{ "result": 1000000000 }

otigen> send mytoken transfer 0xdeadbeef... 500
Submitted tx 0x9a3f...
Confirmed in wave 18345.
```

The console is convenient but not authoritative — for production scripts and CI, use `otigen` non-interactively or via the SDKs.

---

## 5.10 What the Toolchain Does NOT Do

Deliberately omitted:

- **Test runner** — use the language's native test framework.
- **Linter / formatter** — use the language's native tooling (`rustfmt`, `prettier`, `gofmt`, `clang-format`).
- **IDE integration** — uses the language's standard LSP; no Otigen-specific IDE extension required.
- **Documentation generator** — use the language's standard (`rustdoc`, `typedoc`, etc.).
- **Dependency manager** — use the language's standard (`cargo`, `npm`, `go mod`, etc.).
- **Custom syntax** — there is none; the contract is whatever the language allows.

The toolchain wraps deployment-specific concerns. Everything else stays in the language ecosystems the authors already know.

---

## 5.11 Performance

The whole toolchain side of the pipeline — parse `otigen.toml`, validate every cross-cutting rule, walk the compiled `.wasm` for imports + exports + deterministic-feature compliance, build the canonical `ContractAbi`, Borsh-encode it, inject the `pyde.abi` custom section — measures in **single-digit microseconds end-to-end**. Validation work is essentially free against the file-system overhead of reading the `.wasm` and writing the four bundle files; a typical `otigen build` invocation is dominated by I/O (~1–5 ms in practice), not by validator CPU.

Reference numbers on an Apple M-series dev machine (arm64, macOS 15), measured by the criterion benches committed under `crates/<crate>/benches/baseline/*.json` in the `pyde-net/otigen` repo. Reproduce with `cargo bench -p otigen-toml --bench parse_validate` and `cargo bench -p otigen-abi --bench abi_pipeline`.

| Operation | Median |
|---|---:|
| `selector_of` (Blake3 prefix, function-name → 4-byte selector) | **50 ns** |
| `Attributes::from_attributes` (3-attribute set) | **1 ns** |
| `from_project_config` (build canonical `ContractAbi` from parsed TOML) | **449 ns** |
| Borsh encode `ContractAbi` (3-function contract) | **39 ns** |
| Borsh decode `ContractAbi` | **156 ns** |
| `pyde.abi` custom-section inject (3-fn realistic WASM) | **494 ns** |
| `pyde.abi` custom-section extract | **154 ns** |
| WASM import validator (3 imports against the host-fn allowlist) | **196 ns** |
| WASM export validator (cross-reference vs `ContractAbi`) | **343 ns** |
| WASM deterministic-feature validator (full function-body opcode pass) | **2.3 µs** |
| `otigen.toml` parse (canonical spec example, ~50 lines) | **23 µs** |
| `otigen.toml` cross-cutting validation pass | **278 ns** |
| `otigen.toml` parse + validate (stress: 100 functions + 50 events + 30 state fields) | **488 µs** |
| **Full in-memory toolchain pipeline** (parse → validate → build → encode → inject) | **14.5 µs** |

These numbers are tracked from commit `pyde-net/otigen#6` forward. Future regressions surface on PRs that run `cargo bench --baseline=v1`.

The benches are intentionally tight scope — they measure the toolchain-side work, not the chain-side deploy validator (which redoes every check at deploy time per `HOST_FN_ABI_SPEC.md` §3.7 layer 3) and not the wasmtime AOT compilation step (which happens on the chain at first invocation of a deployed contract, not at `otigen build` time).

---

## 5.12 Reading on

- [Chapter 3: Execution Layer](./03-virtual-machine.md) — the runtime that contracts compile into.
- [Chapter 4: State Model](./04-state-model.md) — what `sload` and `sstore` see.
- [Chapter 11: Account Model](./11-account-model.md) — the ENS-style name registry that the toolchain registers against.
- [Chapter 13: Cross-Chain (Parachains)](./13-cross-chain.md) — parachain-specific deploy and upgrade flows.
- Host Function ABI spec — the binary contract between WASM modules and the engine.
- The Otigen binary design spec — the engineering detail for the toolchain itself (lives in the engine docs).
