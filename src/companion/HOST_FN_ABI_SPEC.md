# Pyde Host Function ABI Specification

**Version:** v1.0 (draft)
**Status:** Authoritative for v1 mainnet. Subject to revision until mainnet genesis; frozen at v1 launch and only extended in backwards-compatible ways thereafter.

This document is the canonical specification of the **Host Function ABI** — the surface a WebAssembly contract or parachain uses to interact with the Pyde chain. The execution layer (`wasm-exec`) is the implementation of this spec. The `otigen` toolchain validates contracts against this spec at build and deploy time. Independent auditors verify the implementation matches the spec.

If the wasm-exec implementation and this document disagree, **this document is authoritative**. Implementation bugs are bugs in wasm-exec, not in the spec.

For the conceptual surface and rationale, see [Chapter 3 — Execution Layer](../chapters/03-virtual-machine.md). For parachain-only extensions, see [Chapter 13 — Parachains](../chapters/13-cross-chain.md) and [companion/PARACHAIN_DESIGN.md](./PARACHAIN_DESIGN.md).

---

## 1. Scope

This spec defines:

- The WASM **import module name** under which host functions are registered
- The **signature** of every host function (parameters, returns)
- The **semantics** of every host function (what it does, what it returns, when it traps)
- The **gas cost** of every host function (fuel charged per call)
- The **error codes** returned by every host function
- The **memory layout conventions** for passing data across the WASM ⇄ host boundary
- The **forbidden imports list** — functions a deployed module is rejected for importing
- The **ABI versioning rules** that govern how this spec evolves post-v1

This spec does **not** define:

- The WASM core instruction set (that is the [WebAssembly Core Specification](https://webassembly.github.io/spec/))
- The wasmtime runtime configuration (see [Chapter 3 §3.2](../chapters/03-virtual-machine.md))
- The toolchain mechanics for declaring host imports in source language (see [Chapter 5 — Otigen Toolchain](../chapters/05-otigen-toolchain.md))
- The fuel-to-gas mapping internals (see [Chapter 10 §10.1](../chapters/10-gas-and-fee-model.md))

---

## 2. ABI versioning

### 2.1 Version field

Every deployed contract declares an **ABI version** at deploy time. The version is recorded on-chain in the contract's account record. The engine refuses to execute a contract whose declared ABI is newer than the engine's supported ABI.

```text
pyde_abi_version: u32   // semver-packed: high 16 = major, low 16 = minor
```

Example: `0x0001_0000` = ABI v1.0.

### 2.2 Compatibility rules

- **Major version bump (v1 → v2)** — breaking change. *Not permitted post-mainnet.* If a future protocol upgrade fundamentally re-shapes the ABI, it ships as v2 alongside v1; the engine supports both forever; old contracts continue to execute under v1 semantics. Major bumps cost the network a hard fork.

- **Minor version bump (v1.0 → v1.1)** — backwards-compatible addition. New host functions may be added. Existing function signatures, semantics, gas costs, and error codes are **frozen**. Old contracts continue to execute without re-deployment.

- **No deprecation, no removal.** Once a function is in the ABI, it exists forever at the same signature with the same semantics. This is a one-way ratchet, identical in spirit to Ethereum's opcode discipline.

- **Engine support is monotonic.** An engine running ABI v1.7 supports every contract deployed against v1.0 through v1.7. It refuses contracts declaring v1.8 or higher.

> **Worked example.** The `pyde::debug_log` test-only host fn (§9.3) is a canonical backwards-compatible minor bump: one new function added (in the test runner's allowlist; rejected on chain), no existing signature touched, no gas / error-code redefinition. Old contracts that don't import it are unaffected; new contracts get the printf-debug capability during development.

### 2.3 What does *not* count as a breaking change

- Bug fixes in the engine's implementation that bring observed behavior into compliance with this spec
- Performance improvements that do not change observable semantics
- Changes to internal data layouts that don't affect WASM-visible byte order
- Adding new gas-cost-zero diagnostics (debug logs, traces) under a `#[cfg(debug)]` gate

---

## 3. WASM import module + calling conventions

### 3.1 Import module name

All host functions are registered under the WASM module name **`pyde`**. A contract imports functions like:

```wat
(import "pyde" "sload" (func (param i32 i32 i32) (result i32)))
(import "pyde" "sstore" (func (param i32 i32 i32)))
(import "pyde" "emit_event" (func (param i32 i32 i32 i32)))
```

Parachain-only host functions are also registered under `pyde`; they are gated at deploy time by the validator rejecting them for non-parachain contracts (§9.2).

### 3.2 Pointer + length convention

Pyde host functions pass data across the WASM ⇄ host boundary using **i32 byte-pointers into WASM linear memory** plus **i32 lengths** for variable-length data. The conventions are:

| Pattern | Use |
|---|---|
| `ptr: i32, len: i32` | Caller-allocated input buffer of known length |
| `ptr: i32` (no length) | Caller-allocated input buffer of fixed length (e.g., 32-byte hash, 32-byte address, 16-byte u128) |
| `out_ptr: i32` (no length) | Caller-allocated output buffer of fixed length; host writes exactly that many bytes |
| `out_ptr: i32, out_len_ptr: i32` | Caller-allocated output buffer + a separate i32 pointer where the host writes the actual length used |

All multi-byte integers are **little-endian** (matching WASM linear memory's native byte order).

Fixed sizes used by the ABI:

| Type | Size (bytes) |
|---|---|
| Address | 32 |
| Slot hash | 32 |
| Hash output (Blake3, Poseidon2, Keccak256) | 32 |
| u128 (balance, value, amount) | 16 |
| u64 (block height, wave id, chain id, timestamp) | 8 |
| u32 (gas, length, counter) | 4 |

### 3.3 Return values

Every host function returns an **i32 result code**:

- `0` — success
- Positive non-zero — currently unused; reserved for future warning/info codes
- Negative — error (see §4)

Functions that conceptually return data (e.g., `balance()`) write the data to a caller-provided output pointer and return the i32 result code. Functions that conceptually return a small scalar (e.g., `wave_id()`) return the scalar directly via WASM's normal return mechanism (e.g., `-> i64`).

Convention summary:

| Return shape | Function category |
|---|---|
| `-> i32` (error code only) | Mutating ops without return data (`transfer`) |
| `-> ()` (no return) | Mutating ops that trap on failure (`sstore`, `sdelete`, `emit_event`) |
| `-> i32` + writes to out_ptr | Returns fixed-size data (`caller`, `balance`) — writes a known byte width into `out_ptr` |
| `-> i32` (actual_len) + writes to out_ptr (up to `out_max_len`) | **Variable-size storage reads** (`sload`) — caller passes a max length, host writes `min(actual, max)` and returns the true length. `-1` for missing. |
| `-> i32` + writes to out_ptr + out_len_ptr | Returns variable-size data with separate length out-param (`calldata_copy`, `parachain_storage_read`) |
| `-> i64` | Returns a single u64/i64 scalar (`wave_id`, `wave_timestamp`) |
| `(never returns)` | Halt operations (`return`, `revert`) trap to end execution |

### 3.4 Memory safety

A host function that receives a pointer + length **must validate** that the range `[ptr, ptr + len)` lies entirely within the WASM module's linear memory. Out-of-bounds access traps with `MemoryOutOfBounds`. This is enforced by the engine; contracts cannot escape the sandbox by passing a malicious pointer.

Maximum linear memory size: **64 MB** (hard cap, see [Chapter 3 §3.5b](../chapters/03-virtual-machine.md)). Any read or write past 64 MB traps regardless of pointer value.

### 3.5 Function attributes

WebAssembly itself has no concept of `view`/`payable`/`reentrant`/etc. — those are chain-level constraints applied at the **engine ⇄ WASM boundary**. The `otigen` toolchain reads attributes from `otigen.toml` and embeds them as a WASM custom section (§3.7) for the engine to consume at runtime.

The attribute set:

| Attribute | Meaning | Enforced by |
|---|---|---|
| `view` | Function must not modify state, transfer value, or emit events | Engine sets `view_mode` flag on `HostState`; `sstore`/`sdelete`/`transfer`/`emit_event` return `ERR_FORBIDDEN` while flag is set |
| `payable` | Function accepts attached PYDE value (tx.value > 0). Non-payable functions reject value transfers | Engine checks attribute before call; returns `ERR_VALUE_TRANSFER_NOT_PAYABLE` if `value > 0` and attribute absent |
| `reentrant` | Function opts in to being called while already on the call stack. Default is non-reentrant | Engine tracks `(contract_addr, fn_name)` active set; rejects re-entry of non-`reentrant` fn with `ERR_REENTRANCY_BLOCKED` |
| `sponsored` | Gas costs charged to the contract's gas tank instead of the caller | Engine routes gas accounting to contract's tank balance before invocation |
| `constructor` | Callable only at contract deploy time. Subsequent calls are rejected | Deploy validator allows; engine rejects post-deploy with `ERR_CONSTRUCTOR_REENTRANT` (re-using the reentrancy code is incorrect; treat constructor lockout as a distinct conceptual error category in implementation) |
| `fallback` | Invoked when a call's function selector matches no declared function. At most one per contract. Function signature: `(calldata_ptr: i32, calldata_len: i32) -> i32`. Default if absent: unmatched selector returns `ERR_INVALID_FUNCTION_NAME` | Engine dispatches to fallback after selector-table miss |
| `receive` | Invoked on bare PYDE transfers (no selector, value > 0). At most one per contract. Function takes no arguments. **Must also be `payable`** (otherwise it would reject the value it's meant to accept). Default if absent: bare value transfers return `ERR_VALUE_TRANSFER_NOT_PAYABLE` | Engine dispatches to receive on bare-value tx |
| `entry` | Declares the function is callable from outside the contract (top-level tx or cross_call). Required for any function not marked with another dispatch attribute (constructor, fallback, receive). Internal helpers omit this and are not exposed | Deploy validator strips non-`entry` non-dispatch fns from the public selector table |

**Storage:** the attribute bitfield is part of the `pyde.abi` custom section (§3.7), not the WASM bytecode. The same `.wasm` would behave identically regardless of attributes — the engine wraps every call with attribute-driven pre-checks.

### 3.5.1 Attribute compatibility rules

Some combinations are nonsensical or unsafe. The build (`otigen build`) and the deploy validator BOTH check these. Defense in depth: an author might hand-edit the `pyde.abi` section to bypass the build check, but the deploy validator catches it.

| Combination | Status | Reason |
|---|---|---|
| `view` + `payable` | ❌ Rejected | View = no state changes; payable = receives value (state change) |
| `view` + `constructor` | ❌ Rejected | Constructors initialise state; view can't |
| `view` + `reentrant` | ❌ Rejected | Views are inherently reentrant (they make no state changes there's no guard to opt out of); the attribute is meaningless on a view |
| `view` + `sponsored` | ❌ Rejected | Views are FREE (§7.8); sponsoring zero gas is meaningless |
| `view` + `fallback` | ❌ Rejected | Fallback is the catch-all dispatch; restricting it to read-only is a footgun — authors expect to be able to do anything in a fallback |
| `view` + `receive` | ❌ Rejected | Receive accepts value; view can't accept value |
| `payable` + `constructor` | ✅ Allowed | Constructors can initialise with funds |
| `payable` + `reentrant` | ⚠️ Warning, allowed | DAO-attack pattern. Build emits warning; deploy accepts |
| `payable` + `fallback` | ✅ Allowed | Generic handler that also accepts value |
| `constructor` + `reentrant` | ❌ Rejected | Constructors are deploy-only; can't be re-entered |
| `constructor` + `sponsored` | ❌ Rejected | No gas tank exists at deploy time |
| `constructor` + `fallback` | ❌ Rejected | Distinct call shapes; constructor is deploy-time, fallback is run-time |
| `constructor` + `receive` | ❌ Rejected | Same; distinct dispatch contexts |
| `sponsored` + `reentrant` | ⚠️ Warning, allowed | DAO-attack pattern (contract pays gas for its own re-entry) |
| `fallback` + `receive` | ❌ Rejected | Distinct triggers (selector-miss vs bare-value); can't be the same handler |
| `receive` + `payable` | ✅ Required | Receive without payable is a no-op contradiction |
| `receive` + `reentrant` | ❌ Rejected | Recursive receive is meaningless and dangerous |

### 3.5.2 Per-call dispatch flow

When the engine invokes a function (top-level tx or cross_call):

```
1. Look up fn_name in cached ContractAbi
   if not found:
     if FALLBACK fn exists:  dispatch to fallback
     else if bare value transfer && RECEIVE fn exists:  dispatch to receive
     else:  return ERR_INVALID_FUNCTION_NAME

2. Read attribute bitfield + access list
3. Apply pre-checks (constructor lockout, payable, reentrancy, sponsored,
   view-mode flag, access list install)
4. Apply value transfer (if value > 0 and payable)
5. Push per-tx overlay (nested for cross_call)
6. Invoke WASM function body via wasmtime
7. On return: merge or discard overlay; pop call stack; charge gas
```

The host-side reference implementation of this dispatch wrapper is the subject of §12.6 + §13.

### 3.6 Module cache

After the engine compiles a contract's WASM (via Cranelift AOT, see [Chapter 3](../chapters/03-virtual-machine.md)), the compiled `wasmtime::Module` is large in memory (typically ~2–10× the input WASM size) but expensive to re-derive. Pyde caches it.

```text
ModuleCache (in-memory, per node):
  Key:    contract_address ([u8; 32])
  Value:  CachedModule {
    compiled:    wasmtime::Module,        // post-AOT
    parsed_abi:  ContractAbi,             // extracted from pyde.abi custom section
    last_used:   WaveId,                  // updated on every invocation
    size_bytes:  usize,                   // estimated memory footprint
  }

Eviction policy:
  - LRU by `last_used` wave
  - Hard size cap: MODULE_CACHE_MAX_BYTES (default 1 GB; node-configurable)
  - TTL: drop entries with last_used < (current_wave - MODULE_CACHE_TTL_WAVES)
    Default TTL: 8 epochs ≈ ~1 day on commodity hardware
  - On cache miss: fetch raw .wasm from state_cf, compile via Cranelift,
    extract pyde.abi custom section, install entry, return

Properties:
  - Hot contracts stay resident → near-zero invocation overhead after first call
  - Cold contracts evict → bounded memory footprint
  - First-call latency for a cold contract: ~50–200 ms (Cranelift AOT pass)
  - Subsequent calls within cache window: ~few μs (cache lookup) + actual exec
  - Mirrors the dashmap state cache's design pattern: max size + LRU + TTL
```

This is conceptually identical to the [PIP-4 write-back state cache](../chapters/04-state-model.md) at the state layer: in-memory hot-path, bounded size, transparent eviction. Cold contracts pay one disk-read + one AOT-compile on revival; hot contracts skip both.

### 3.7 The `pyde.abi` custom section

Pyde does not store ABI metadata as separate on-chain state. Instead, the `.wasm` carries its ABI inside a WebAssembly **custom section** (a standard WASM binary feature) named `pyde.abi`. The chain stores only the `.wasm` bytes; the section travels with the code.

Layout:

```text
.wasm file contains:
  [WASM header]
  [Type section, Import, Function, Memory, Global, Export, Code, ...]
  [Custom section: name="pyde.abi", contents=BORSH(ContractAbi)]
```

The `ContractAbi` struct (Borsh-encoded):

```rust
struct ContractAbi {
    pyde_abi_version:    u32,            // semver-packed, must match engine's supported
    contract_type:       ContractType,   // Contract | Parachain
    functions:           Vec<FunctionAbi>,
    state_schema_hash:   [u8; 32],       // Blake3 of the canonical state schema
    constructor_index:   Option<u32>,    // index into functions of the constructor, if any
    fallback_index:      Option<u32>,    // index into functions of the fallback, if any
    receive_index:       Option<u32>,    // index into functions of the receive, if any
}

struct FunctionAbi {
    name:        String,                 // matches the exported WASM function name
    selector:    [u8; 4],                // first 4 bytes of Blake3(name) — for dispatch
    attributes:  u32,                    // bitfield (see §3.5)
    access_list: Vec<AccessListEntry>,   // declared slot patterns
}

bitflags! {
    struct Attributes: u32 {
        const VIEW        = 1 << 0;
        const PAYABLE     = 1 << 1;
        const REENTRANT   = 1 << 2;
        const SPONSORED   = 1 << 3;
        const CONSTRUCTOR = 1 << 4;
        const FALLBACK    = 1 << 5;
        const RECEIVE     = 1 << 6;
        const ENTRY       = 1 << 7;
    }
}
```

**Build-time:** `otigen build` reads `otigen.toml`, builds this struct, Borsh-encodes it, and uses a WASM custom-section writer (e.g., the `wasm-encoder` crate) to inject the section into the .wasm file produced by the language compiler. The code section is untouched; only the metadata appendix is added.

**Deploy-time:** the deploy validator extracts and parses the `pyde.abi` section and runs a three-layer validation pipeline (the build-time check is best-effort author ergonomics; the deploy-time re-check is the chain-facing defense; the runtime is the definitive guarantee):

1. **Schema check** — version compatibility (`pyde_abi_version` ≤ engine's max supported), well-formed Borsh decoding, every required field present.
2. **Cross-reference check** — every `FunctionAbi.name` matches a WASM `(export "name" (func ...))`; every WASM-exported function (other than internal helpers — TBD how to mark) appears in `functions[*]`. No drift between declarations and code.
3. **Attribute compatibility check** — every function's `attributes` bitfield is a legal combination per §3.5.1. At most one `FALLBACK`, at most one `RECEIVE`, `RECEIVE` implies `PAYABLE`, etc.
4. **Static call-graph check (view enforcement)** — for each function with the `VIEW` attribute, build the call graph from its body. Walk every transitively-reachable function. If any reachable function imports `pyde::sstore`, `pyde::sdelete`, `pyde::transfer`, `pyde::emit_event`, `pyde::parachain_storage_write`, `pyde::parachain_storage_delete`, or `pyde::parachain_emit_event`, REJECT the deploy with `DeployRejected: ViewMutatesState(<fn_name>, <mutating_import>)`. Indirect calls (`call_indirect`) are conservatively treated as potentially-anything; a view that uses `call_indirect` is rejected unless every possible target is also statically provable to be view-safe.
5. **Static access-list check (best-effort)** — for each function with a declared access list, scan all statically-resolvable `pyde::sload`/`sstore` call sites; verify the slot pattern matches the declared list. Dynamic slot computation can't be checked statically — runtime enforcement (Layer 3, below) is the actual guarantee.

On any check failure: deploy is rejected with a specific error code identifying the failing step. On success: the entire .wasm (with custom section intact) is stored in `state_cf` at the contract's code slot.

**Runtime (Layer 3 — the definitive guarantee):**

The static checks above are best-effort and cannot catch everything (indirect calls, computed slot hashes, transitive-through-table calls). The runtime is the actual enforcement boundary:

- The engine sets `host_state.view_mode = true` before invoking a `VIEW` function. `host_sstore`, `host_sdelete`, `host_transfer`, `host_emit_event`, and the parachain mutating variants all check the flag and return `ERR_FORBIDDEN` if set. **A view function that tries to mutate state at runtime traps**; the calling tx reverts; the chain is protected.
- The engine installs the declared `access_list` in `host_state.access_list` before invoking. `host_sload`/`host_sstore` check membership; reject with `ERR_ACCESS_LIST_VIOLATION` on miss.
- The engine maintains the active call stack and rejects re-entry into non-`reentrant` functions.

The chain is therefore safe even if a malicious author hand-crafts a `.wasm` that bypasses the deploy validator's static checks (e.g., via cleverly-constructed `call_indirect` patterns) — the runtime catches mutations at the point of attempt. The cost of a bypass attempt is paid by the attacker (gas burned up to the trap, tx reverts, no harm done).

**Runtime:** the engine loads the .wasm into wasmtime, extracts and parses the `pyde.abi` section once, caches the parsed `ContractAbi` alongside the compiled module in the ModuleCache (§3.6). All subsequent invocations of the contract read attributes from this in-memory cache. There is no per-call disk read for ABI metadata.

**Wallets and indexers:** fetch the .wasm via the RPC `pyde_getContractCode(addr)` method, parse the `pyde.abi` custom section client-side (SDKs ship a small helper), and have the full ABI without an extra round trip.

One artifact, one source of truth.

---

## 4. Error codes

Negative i32 values returned by host functions. Each function lists which codes it can return; this is the master table.

| Code | Symbol | Meaning |
|---|---|---|
| `-1` | `ERR_INVALID_INPUT` | Malformed input bytes (e.g., non-32-byte hash, non-canonical encoding) |
| `-2` | `ERR_NOT_FOUND` | Reserved. Storage reads return zero values on missing slots (see `sload`, `balance`, `parachain_storage_read`). Currently only used as a sub-call failure indicator in some cross_call paths. Do not introduce new uses without ABI council review. |
| `-3` | `ERR_INSUFFICIENT_BALANCE` | Caller balance too low for the requested operation |
| `-4` | `ERR_OUT_OF_GAS` | Gas budget exhausted (typically a trap, but returned here for `consume_gas`) |
| `-5` | `ERR_FORBIDDEN` | Operation not permitted in this context (e.g., `sstore` from a `view` function) |
| `-6` | `ERR_ACCESS_LIST_VIOLATION` | Accessed slot not in declared access list |
| `-7` | `ERR_OUTPUT_BUFFER_TOO_SMALL` | Caller's output buffer was smaller than required |
| `-8` | `ERR_INVALID_ADDRESS` | Address format invalid (e.g., 32-byte all-zero, reserved sentinel) |
| `-9` | `ERR_REENTRANCY_BLOCKED` | Cross-call would re-enter a non-`reentrant` function |
| `-10` | `ERR_CROSS_CALL_FAILED` | Sub-call trapped or returned non-zero error code |
| `-11` | `ERR_CROSS_CALL_OUT_OF_GAS` | Sub-call exhausted forwarded gas |
| `-12` | `ERR_VALUE_TRANSFER_NOT_PAYABLE` | Attempted transfer to a function not marked `payable` |
| `-13` | `ERR_INVALID_FUNCTION_NAME` | `cross_call` target function does not exist |
| `-14` | `ERR_XCALL_RATE_LIMITED` | Parachain cross-message budget exceeded for this wave (parachain only) |
| `-15` | `ERR_PARACHAIN_ONLY` | Function callable only from parachain context |
| `-16` | `ERR_CIPHERTEXT_INVALID` | Threshold-decryption input malformed |
| `-17` | `ERR_SIGNATURE_INVALID` | FALCON signature verification failed |
| `-100` | `ERR_INTERNAL` | Engine-side bug or unexpected state. Should never occur in a correct implementation; surfaces as a trap in practice. Document for completeness. |

Critical failures (`MemoryOutOfBounds`, `StackOverflow`, `OutOfFuel`, `IntegerDivideByZero`, `UnreachableCodeReached`, host-fn-invariant violations) **trap**. Traps are unrecoverable; the transaction reverts; gas is consumed up to the trap point.

---

## 5. Gas metering

Every host function call consumes a fixed base gas cost plus, for variable-length inputs, a per-byte cost. Gas is charged **before** the host function's work begins. If charging would exceed the contract's remaining gas, the host function traps with `OutOfFuel` and does not execute.

Gas costs are listed inline with each function and are summarized in the **Gas Table** at §10. Values in this spec are **canonical**; the engine's `crates/wasm-exec/src/gas_table.rs` is the implementation of this table.

The fuel-to-gas mapping is documented in [Chapter 10 §10.1](../chapters/10-gas-and-fee-model.md). For purposes of this spec, **gas = fuel** (1:1 at the wasmtime boundary).

### 5.1 No refunds

Per [Chapter 10 §10.1](../chapters/10-gas-and-fee-model.md), Pyde v1 has **zero gas refunds**. `sdelete` is cheaper than `sstore` but does not refund. No host function returns gas to the caller.

### 5.2 Dynamic gas via `consume_gas`

Contracts that perform off-fuel work (e.g., synchronous loops bounded by external data) can charge gas explicitly via `consume_gas(amount)`. This is metered identically to host-function gas.

---

## 6. Determinism rules

A correct Pyde host function call **must produce bit-identical results on every honest validator**. The following are forbidden in host function implementations:

- Wall-clock time (`std::time::Instant::now()`, `SystemTime::now()`)
- Floating-point operations outside the WASM canonical NaN regime
- Non-deterministic RNG (use `beacon_get` for chain-derived randomness)
- File system access
- Network calls
- Threading or any concurrency primitive observable to the contract
- Memory allocation patterns that depend on system state (engine uses a fixed-size arena per call)

Host functions that *appear* to depend on time (`wave_timestamp`) actually return chain-state-derived values that are deterministic across validators. Same for `beacon_get`.

The wasmtime configuration (see [Chapter 3 §3.2](../chapters/03-virtual-machine.md)) enforces WASM-side determinism (canonical NaN, no threads, no SIMD, no relaxed-SIMD, no bulk-memory non-determinism, no GC). Host-side determinism is the spec's contract; implementations that violate it are bugs.

---

## 7. Core host functions

All functions below are available to **every** deployed module (contracts + parachains). The `pyde::` prefix in WAT examples corresponds to the `(import "pyde" "<name>" ...)` form.

### 7.1 Storage

Pyde's storage model is a **key-value store with variable-length values** (up to `MAX_STORAGE_VALUE_BYTES = 16 KB` per slot), NOT EVM-style fixed 32-byte words. Keys are 32 bytes (Poseidon2-derived); values are arbitrary raw bytes — Borsh-encoded structs, packed arrays, anything the contract author chooses to write. The width is the contract's call, the chain only enforces the 16 KB upper bound.

**Why variable-length, not 32-byte words.** WASM operates on linear memory, not 256-bit words; forcing slot values into 32 bytes would (a) require contracts to manually pack non-uint256 data, and (b) burn one slot per logical field regardless of size — blowing up state-tree node count for the common case of small structs. Variable-length lets a `Position { trader, size, entry, leverage }` at ~80 bytes fit in one slot, one read, one decode. For values larger than 16 KB the canonical pattern is slot-chunking: `slot[H(base ‖ i)] = chunk_i`.

The 16 KB cap is a RocksDB write-amplification budget (per-slot write costs scale with size; >16 KB starts to hurt LSM compaction). It's a chain-spec parameter, tunable via a future PIP if load demands.

#### `sload`

```text
pyde::sload(slot_ptr: i32, out_ptr: i32, out_max_len: i32) -> i32

slot_ptr      — pointer to a 32-byte slot key (Poseidon2-derived)
out_ptr       — pointer to a contract-allocated buffer to receive the value
out_max_len   — size of that buffer (caller-supplied upper bound)

Returns:
  >= 0  — actual length of the stored value (may be 0 for an empty value).
         The host writes min(actual, out_max_len) bytes into out_ptr.
  -1    — SLOAD_MISSING: this slot has never been written, or has been sdeleted.

Gas: GAS_SLOAD = 100 base + 1 per byte copied to out_ptr.
     (Cache-warm reads cost the same gas; gas is paid against the worst-case
     disk-fetch cost.)

Semantics: a never-written slot returns SLOAD_MISSING (-1), distinct from a slot
that was written with a zero-length value (returns 0). This is a deliberate
departure from EVM's "empty == zero" conflation. The only failure modes are
gas exhaustion (traps) and a malformed out_max_len (negative → traps).

If actual > out_max_len, the contract sees a truncated value AND the true
length as the return value, so the caller knows to retry with a bigger buffer.
```

#### `sstore`

```text
pyde::sstore(slot_ptr: i32, val_ptr: i32, val_len: i32) -> ()

slot_ptr  — pointer to a 32-byte slot key
val_ptr   — pointer to the raw value bytes to write
val_len   — length of the value in bytes (0..=MAX_STORAGE_VALUE_BYTES)

Traps (no return code) on:
  - val_len > MAX_STORAGE_VALUE_BYTES (= 16 KB)
  - negative val_len
  - ERR_FORBIDDEN when called from view mode (cross_call_static sub-call)
  - gas exhaustion

Gas: GAS_SSTORE_BASE = 5_000 + GAS_SSTORE_PER_BYTE = 32 per byte of value.
     (Same cost for new and overwrite; no cold/warm distinction in v1.
     Per-byte component is what makes large writes proportionally expensive.)
```

#### `sdelete`

```text
pyde::sdelete(slot_ptr: i32) -> ()

slot_ptr  — pointer to a 32-byte slot key

Traps on:
  - ERR_FORBIDDEN when called from view mode
  - gas exhaustion

Gas: GAS_SDELETE = 5_000 base.
     (Same cost as sstore base — clearing a slot writes a tombstone, which is
     a state-tree update equivalent to a write. No refund per PIP-4 gas-no-
     refund-v1; the user pays gas_used regardless of the storage delta.)

Semantics: subsequent sload at this slot returns SLOAD_MISSING (-1). Sdelete
on a slot that was never written is a no-op but still charges full gas.
```

#### Deriving storage slots

Pyde's canonical slot derivation is:

```text
slot = Poseidon2(self_address || field_bytes [|| key_bytes])
```

`field_bytes` is whatever raw bytes the contract chooses (e.g., `b"balances"`). `key_bytes` is optional — used for mappings like `balances[user_address]`.

Contracts compute this themselves via `hash_poseidon2` + `self_address`, then call the raw `sload` / `sstore` / `sdelete` above. A typical 5-line helper:

```rust
fn derive_slot(field: &[u8], key: &[u8]) -> [u8; 32] {
    let mut preimage = [0u8; 32 + 96];
    let total = 32 + field.len() + key.len();
    unsafe { host_fns::self_address(preimage.as_mut_ptr()); }
    preimage[32..32 + field.len()].copy_from_slice(field);
    preimage[32 + field.len()..total].copy_from_slice(key);
    let mut out = [0u8; 32];
    unsafe { host_fns::hash_poseidon2(preimage.as_ptr(), total as i32, out.as_mut_ptr()); }
    out
}
```

This was previously offered as a host-side convenience trio (`sload_by_field` / `sstore_by_field` / `sdelete_by_field`) — dropped in the variable-length storage migration to keep the storage host fn surface minimal and uniform with the engine's executor. The 5-line helper recovers the ergonomics without adding host fns.

### 7.2 Account & balance

#### `balance`

```text
pyde::balance(addr_ptr: i32, balance_out_ptr: i32) -> i32

addr_ptr         — pointer to 32-byte address
balance_out_ptr  — pointer to 16-byte buffer where the u128 balance is written (LE)

Returns: 0 on success, ERR_INVALID_ADDRESS if address malformed.

Gas: 100 base.

Semantics: an address that has never been funded reads back as balance = 0 — NOT
an error. Querying a non-existent account is a normal operation. ERR_INVALID_ADDRESS
fires only for structurally-bad addresses (e.g., reserved sentinel values).
```

#### `transfer`

```text
pyde::transfer(to_ptr: i32, amount_ptr: i32) -> i32

to_ptr      — pointer to 32-byte recipient address
amount_ptr  — pointer to 16-byte u128 amount (LE)

Returns: 0 on success, ERR_INSUFFICIENT_BALANCE if caller balance < amount,
         ERR_INVALID_ADDRESS if recipient malformed,
         ERR_FORBIDDEN if called from a view function.

Gas: 7,000 base.
```

### 7.3 Execution context

All context functions return chain-state-derived values that are bit-identical across validators.

#### `caller`

```text
pyde::caller(addr_out_ptr: i32) -> i32

addr_out_ptr — pointer to 32-byte buffer

Returns: 0 always (caller always exists).

Gas: 5 base.

Semantics: returns the immediate caller's address. For top-level transactions,
caller == origin == the externally-owned account that signed the tx.
For nested cross-calls, caller is the contract that issued the cross_call.
```

#### `origin`

```text
pyde::origin(addr_out_ptr: i32) -> i32

addr_out_ptr — pointer to 32-byte buffer

Returns: 0 always.

Gas: 5 base.

Semantics: returns the externally-owned account that signed the original transaction,
regardless of cross-call nesting depth. Deliberately distinct from caller() to avoid
the tx.origin phishing footgun from Ethereum (origin should rarely be checked for
authorization).
```

#### `self_address`

```text
pyde::self_address(addr_out_ptr: i32) -> i32

addr_out_ptr — pointer to 32-byte buffer

Returns: 0 always.

Gas: 5 base.

Semantics: returns the address of the currently-executing contract or parachain.
```

#### `wave_id`

```text
pyde::wave_id() -> i64

Returns: the current wave id as a u64. Pyde's consensus-round counter,
monotonically increasing.

Gas: 2 base.
```

#### `wave_timestamp`

```text
pyde::wave_timestamp() -> i64

Returns: the canonical timestamp of the wave being committed, in seconds since Unix epoch.
This value is committee-attested and identical across all validators.

Gas: 2 base.
```

#### `chain_id`

```text
pyde::chain_id() -> i64

Returns: the chain identifier (1 = mainnet, 31337 = devnet, others TBD).

Gas: 2 base.
```

### 7.4 Transaction context

#### `tx_hash`

```text
pyde::tx_hash(hash_out_ptr: i32) -> i32

hash_out_ptr — pointer to 32-byte buffer

Returns: 0 always; writes the current transaction's Blake3 hash.

Gas: 5 base.
```

#### `tx_value`

```text
pyde::tx_value(value_out_ptr: i32) -> i32

value_out_ptr — pointer to 16-byte buffer (u128, LE)

Returns: 0 always; writes the PYDE value attached to the current call.
For non-payable functions this is always zero; for payable functions, it is the
amount passed in by the caller (top-level tx.value or cross_call's value argument).

Gas: 5 base.
```

#### `tx_gas_remaining`

```text
pyde::tx_gas_remaining() -> i64

Returns: remaining gas (fuel) in the current call frame.

Gas: 2 base.
```

#### `calldata_size`

```text
pyde::calldata_size() -> i32

Returns: total length in bytes of the calldata buffer for the current invocation.

Gas: 2 base.
```

#### `calldata_copy`

```text
pyde::calldata_copy(offset: i32, len: i32, out_ptr: i32) -> i32

offset   — byte offset into the calldata buffer
len      — number of bytes to copy
out_ptr  — pointer to len-sized buffer

Returns: 0 on success, ERR_INVALID_INPUT if (offset + len) exceeds calldata_size().

Gas: 8 base + 1 per byte copied.
```

### 7.5 Events

#### `emit_event`

```text
pyde::emit_event(
    topics_ptr: i32,        — pointer to (topics_count × 32) bytes of topic data
    topics_count: i32,      — number of topics; must be 1 ≤ topics_count ≤ 4
    data_ptr: i32,
    data_len: i32,
) -> i32

topics_ptr     — pointer to topics_count consecutive 32-byte topic values
topics_count   — 1 to 4 inclusive; topic[0] is conventionally Blake3(signature)
data_ptr, len  — variable-length non-indexed event payload

Returns: 0 on success,
         ERR_FORBIDDEN if called from a view function,
         ERR_INVALID_INPUT if topics_count < 1 or topics_count > 4,
         ERR_INVALID_INPUT if data_len > MAX_EVENT_DATA_SIZE.

Gas: 100 base + 50 × topics_count + 8 per data byte.
     (Each topic adds 32 bytes of state-commitment cost; 50 gas per topic
      covers the bloom-set + per-topic index write.)

Semantics:
  Appends an event record to the current overlay's events buffer. Topic
  semantics follow the §14.1 convention:
  - topic[0] = Blake3(canonical_event_signature). Identifies the event type;
    this is what subscribers and indexers match on as the primary filter.
  - topic[1..topics_count] = indexed field values, in declaration order.
    Each indexed field's value occupies one 32-byte topic slot. Authors
    declare which fields are indexed in otigen.toml (§14.1).

  At wave commit (§15), the events buffer flushes atomically with state:
  - One row to events_cf (primary, keyed by (wave_id, tx_index, event_index))
  - topics_count rows to events_by_topic_cf (one per topic value)
  - One row to events_by_contract_cf (keyed by contract_addr)
  - Every topic + the contract_addr is added to the wave's events_bloom
  - The event participates in the wave's events_root Merkle tree

  Events from a reverted (sub-)call are discarded along with the overlay;
  the chain never sees events from a path that did not commit.
```

### 7.6 Hashing primitives

All three accept variable-length input and write a 32-byte output.

#### `hash_blake3`

```text
pyde::hash_blake3(in_ptr: i32, in_len: i32, out_ptr: i32) -> i32

Returns: 0 always.

Gas: 15 base + 3 per word (8 bytes), rounded up.
```

#### `hash_poseidon2`

```text
pyde::hash_poseidon2(in_ptr: i32, in_len: i32, out_ptr: i32) -> i32

Returns: 0 always.

Gas: 100 base + 30 per word (8 bytes), rounded up.

Notes: ZK-friendly hash; significantly more expensive than Blake3 in native execution.
Use where ZK-circuit-friendly output is required (state-root commitments, address
derivation). Use Blake3 everywhere else.
```

#### `hash_keccak256`

```text
pyde::hash_keccak256(in_ptr: i32, in_len: i32, out_ptr: i32) -> i32

Returns: 0 always.

Gas: 30 base + 6 per word (8 bytes), rounded up.

Notes: provided for cross-chain interoperability. Pyde's native hashes are Blake3
(performance path) and Poseidon2 (ZK path). Keccak256 is for verifying Ethereum-style
inputs (Merkle Patricia proofs, etc.).
```

### 7.7 Post-quantum cryptography

#### `falcon_verify`

```text
pyde::falcon_verify(
    pk_ptr: i32,       — pointer to ~897-byte FALCON-512 public key
    msg_ptr: i32, msg_len: i32,
    sig_ptr: i32, sig_len: i32
) -> i32

Returns: 0 if signature is valid, ERR_SIGNATURE_INVALID otherwise.

Gas: 50,000 base. (Reflects the ~80μs cost on commodity x86_64 commodity hardware.)
```

### 7.8 Cross-contract calls

#### `cross_call`

```text
pyde::cross_call(
    target_ptr: i32,                   — pointer to 32-byte target contract address
    fn_name_ptr: i32, fn_name_len: i32,— UTF-8 function name to invoke
    calldata_ptr: i32, calldata_len: i32,
    value_ptr: i32,                    — pointer to 16-byte u128 value to attach (0 = no transfer)
    gas_limit: i64,                    — gas budget for the sub-call
    return_data_out_ptr: i32,
    return_data_out_len_ptr: i32       — pointer to i32 written with actual return length
) -> i32

Returns: 0 on success; sub-call's negative error code on failure;
         ERR_CROSS_CALL_FAILED if sub-call trapped;
         ERR_CROSS_CALL_OUT_OF_GAS if sub-call exhausted forwarded gas;
         ERR_REENTRANCY_BLOCKED if target function is non-`reentrant` and caller would
         re-enter it;
         ERR_INVALID_FUNCTION_NAME if target function does not exist;
         ERR_VALUE_TRANSFER_NOT_PAYABLE if value > 0 and target is non-`payable`.

Gas: 1,000 base + 8 per byte of calldata + sub-call's actual gas_used.

Semantics: synchronous call to another contract within the same wave. The sub-call
runs in a nested per-tx overlay (see [Chapter 3 §3.5b](../chapters/03-virtual-machine.md)).
On sub-call success: the overlay merges into the parent on cross_call return.
On sub-call trap or non-zero error: the overlay is discarded; parent state untouched.

Caller's remaining gas is decremented by sub-call's actual gas_used regardless of outcome.
```

#### `cross_call_static`

```text
pyde::cross_call_static(
    target_ptr: i32,
    fn_name_ptr: i32, fn_name_len: i32,
    calldata_ptr: i32, calldata_len: i32,
    gas_limit: i64,
    return_data_out_ptr: i32,
    return_data_out_len_ptr: i32
) -> i32

Returns: as above, but target must be a `view`-attributed function (returns
ERR_FORBIDDEN otherwise).

Gas: 50 base for the dispatch (caller pays). Sub-call execution itself is FREE
to the caller — see "View calls are free" below.

Semantics: view-only variant. Sub-call may not modify state, emit events, or
transfer value. Useful for safe queries across contracts.

View calls are free:
  - Off-chain via RPC pyde_call(contract, fn, calldata): completely free; no
    tx, no consensus, no gas accounting.
  - On-chain via this host fn: ALSO free for the caller. The dispatch base
    cost (50 gas) covers setup; the sub-call's actual execution does not
    debit the caller's remaining gas.
  - View functions cannot mutate state, so the chain doesn't need to charge
    for them as an economic incentive — the rationale for charging state-
    mutating ops doesn't apply.

Bounding mechanism (DoS prevention):
  - Each cross_call_static invocation initialises its wasmtime instance with
    a per-call FUEL CAP, default VIEW_FUEL_CAP = 10_000_000 (~3ms commodity).
  - Configurable per node operator (NodeConfig.view_fuel_cap).
  - If the view exhausts the cap: trap with OutOfFuel; cross_call_static
    returns ERR_CROSS_CALL_OUT_OF_GAS to caller; caller's actual gas budget
    is NOT debited for the sub-call's work.
  - The cap exists purely to bound per-call wall-clock time so a malicious
    contract can't burn unbounded validator CPU via view spam.
```

#### `delegate_call`

```text
pyde::delegate_call(
    target_ptr: i32,                   — pointer to 32-byte target contract address
                                         (whose CODE will run)
    fn_name_ptr: i32, fn_name_len: i32,
    calldata_ptr: i32, calldata_len: i32,
    gas_limit: i64,
    return_data_out_ptr: i32,
    return_data_out_len_ptr: i32
) -> i32

Returns: 0 on success; sub-call's negative error code on failure;
         ERR_CROSS_CALL_FAILED if sub-call trapped;
         ERR_CROSS_CALL_OUT_OF_GAS if sub-call exhausted forwarded gas;
         ERR_INVALID_FUNCTION_NAME if target function does not exist;
         ERR_REENTRANCY_BLOCKED if (caller_addr, target_fn) is already on the call stack
         and target_fn is not `reentrant`.

Gas: 1,200 base + 8 per byte of calldata + sub-call gas_used.
(Slightly higher base than cross_call because the engine must keep the caller's
overlay active rather than push a fresh one.)

Semantics: execute target contract's CODE in the CALLER'S STORAGE CONTEXT.
Concretely:
  - Loads target's WASM + parsed ABI
  - Invokes target's named function, but with the engine's HostState configured
    so that:
      * sload/sstore hit the caller's slots (NOT the target's)
      * self_address() returns the caller's address (NOT the target's)
      * caller() returns the original caller of the OUTER function
      * origin() unchanged (still tx originator)
      * tx_value() unchanged (still the value attached to the outer call)
  - Access list enforcement is against the CALLER'S declared list (not the
    target's) — the target's code may try to access slots the caller hasn't
    declared, which fails with ERR_ACCESS_LIST_VIOLATION
  - No value transfer happens (delegate_call doesn't move PYDE — the called
    code operates on the caller's balance directly)
  - Reentrancy guard applies to (caller_addr, target_fn_name)

Use cases:
  - Upgradeable contracts: proxy contract holds state; delegate_call to an
    implementation contract for logic. Upgrade = swap which implementation
    address the proxy delegates to.
  - Libraries: shared logic deployed once; per-caller state via delegate_call.

Risks for authors:
  - Target's code can corrupt caller's storage if their slot layouts differ.
  - Target's code can transfer caller's funds (self_address is the caller).
  - This is the same risk model as EVM's delegatecall; the v1 spec does not
    add any structural guardrails beyond access-list enforcement. Authors are
    expected to use delegate_call only with target contracts they fully trust.
```

### 7.9 Halt operations

#### `return`

```text
pyde::return(data_ptr: i32, data_len: i32) -> (never returns)

Sets the current call frame's return data and exits successfully. The data is
visible to the caller via cross_call's return_data_out_ptr.

Gas: 0 base (the trap exits the call frame).
```

#### `revert`

```text
pyde::revert(reason_ptr: i32, reason_len: i32) -> (never returns)

Reverts the current call frame. All state changes since the call started are
discarded (the per-tx overlay is dropped). The reason bytes are made available
to the caller as the failure payload.

Gas: 0 base.
```

### 7.10 Explicit gas metering

#### `consume_gas`

```text
pyde::consume_gas(amount: i64) -> i32

Returns: 0 on success, ERR_OUT_OF_GAS if amount exceeds remaining gas (and the
function traps with OutOfFuel — the i32 return is for documentation only).

Gas: 2 base + amount (so `consume_gas(N)` total cost is N+2).

Use case: contracts that perform off-fuel work (synchronous loops bounded by
external data, expensive computations charged against the user's gas budget) call
consume_gas explicitly to make the charge visible.
```

### 7.11 VRF beacon

#### `beacon_get`

```text
pyde::beacon_get(out_ptr: i32) -> i32

out_ptr — pointer to 32-byte buffer

Returns: 0 always; writes the current wave's committee-derived VRF beacon
(XOR of all members' beacon shares from the prior anchor round).

Gas: 50 base.

Semantics: deterministic, public randomness, identical across all validators. Use as
a chain-derived random source. Note that the beacon is *publicly predictable* within a
wave — adversaries cannot bias it, but they *can* observe it. Use threshold encryption
if you need adversary-private randomness.
```

---

## 8. Parachain-only host functions

These functions are available **only** to modules deployed with `type = "parachain"`. The deploy-time validator rejects any non-parachain module that imports any function in this section. Attempting to call a parachain function from a non-parachain context (theoretically impossible after deploy validation, surfaces as an engine bug) returns `ERR_PARACHAIN_ONLY`.

For the parachain design rationale, see [companion/PARACHAIN_DESIGN.md](./PARACHAIN_DESIGN.md).

### 8.1 Parachain storage

#### `parachain_storage_read`

```text
pyde::parachain_storage_read(
    key_ptr: i32, key_len: i32,
    value_out_ptr: i32,
    value_out_len_ptr: i32
) -> i32

Returns: 0 on success,
         ERR_OUTPUT_BUFFER_TOO_SMALL if the value exists but caller's buffer is too small.

Gas: 250 base + 1 per byte returned.

Semantics: read from this parachain's state subtree (PIP-2 clustered under
parachain_id[..16]). Variable-length **keys** (unlike core `sload`, which takes
a fixed 32-byte slot key); variable-length values up to MAX_STORAGE_VALUE_BYTES
(same 16 KB cap as core `sload`). A key that was never written returns success
with *out_len_ptr written as 0 — NOT an error. Callers check the written length
to distinguish "empty value" from "value too large for my buffer."
```

#### `parachain_storage_write`

```text
pyde::parachain_storage_write(
    key_ptr: i32, key_len: i32,
    value_ptr: i32, value_len: i32
) -> i32

Returns: 0 on success, ERR_FORBIDDEN if called from a view function.

Gas: 5,500 base + 10 per byte stored.
```

#### `parachain_storage_delete`

```text
pyde::parachain_storage_delete(key_ptr: i32, key_len: i32) -> i32

Returns: 0 on success (even if key did not exist), ERR_FORBIDDEN if view fn.

Gas: 250 base.
```

### 8.2 Parachain context

#### `parachain_id`

```text
pyde::parachain_id(out_ptr: i32) -> i32

out_ptr — pointer to 32-byte buffer

Returns: 0 always; writes this parachain's ID (Poseidon2 of "pyde-parachain:" || name).

Gas: 5 base.
```

#### `parachain_version`

```text
pyde::parachain_version() -> i32

Returns: the current parachain's active version (u32).

Gas: 5 base.
```

### 8.3 Parachain events

#### `parachain_emit_event`

```text
pyde::parachain_emit_event(
    topics_ptr: i32,
    topics_count: i32,    — 1 to 4 inclusive; topic[0] = Blake3(signature)
    data_ptr: i32,
    data_len: i32,
) -> i32

Returns: 0 on success,
         ERR_FORBIDDEN if view fn,
         ERR_INVALID_INPUT if topics_count out of range or data oversized.

Gas: 100 base + 50 × topics_count + 8 per data byte.

Semantics: identical to the core emit_event (§7.5) including multi-topic
support and the indexed-field convention. The event is filed under the
parachain's own event-stream namespace (the contract_addr field of the
EventRecord carries the parachain_id) so subscribers can filter for a
specific parachain's events. Same storage layout and indexing as core
events (§15.3).
```

### 8.4 Cross-parachain messaging

#### `send_xparachain_message`

```text
pyde::send_xparachain_message(
    target_id_ptr: i32,                 — pointer to 32-byte destination parachain ID
    msg_ptr: i32, msg_len: i32,         — opaque payload
    callback_fn_name_ptr: i32, callback_fn_name_len: i32, — function on this parachain
    max_callback_gas: i64,
    timeout_waves: i64                  — give up after this many waves
) -> i64

Returns: positive XCallId (u64) on success;
         negative error code: ERR_XCALL_RATE_LIMITED if budget exceeded,
         ERR_INVALID_INPUT if target_id is malformed, ERR_INVALID_FUNCTION_NAME if
         callback function does not exist on this parachain.

Gas: 10,000 base + 8 per byte of msg_len.

Semantics: queue an asynchronous message to the target parachain. The calling
parachain's committee threshold-signs the message; the target parachain's committee
verifies and dispatches. Result (or timeout) arrives later as a callback transaction
that invokes the named callback_fn on this parachain. See PARACHAIN_DESIGN §9 for
the full flow.

Rate limit: 64 outgoing messages per wave per parachain by default
(parachain-configurable).
```

### 8.5 Threshold cryptography

These are exposed to parachains for application-level confidentiality use cases
(blinded auctions, sealed-bid markets, MEV-protected DEX matching at parachain layer).

#### `threshold_encrypt`

```text
pyde::threshold_encrypt(
    plaintext_ptr: i32, plaintext_len: i32,
    ciphertext_out_ptr: i32,
    ciphertext_out_len_ptr: i32
) -> i32

Returns: 0 on success, ERR_OUTPUT_BUFFER_TOO_SMALL if buffer insufficient.

Gas: 80,000 base + 100 per byte.

Semantics: encrypt under the current epoch's threshold public key. Result is a
Kyber-768 KEM envelope + ChaCha20-Poly1305 ciphertext. Decryption requires ≥85
shares (combined by the chain at appropriate ceremony points).
```

#### `threshold_decrypt`

```text
pyde::threshold_decrypt(
    ciphertext_ptr: i32, ciphertext_len: i32,
    plaintext_out_ptr: i32,
    plaintext_out_len_ptr: i32
) -> i32

Returns: 0 on success, ERR_CIPHERTEXT_INVALID if malformed,
         ERR_FORBIDDEN if the calling parachain has not yet hit a wave where the
         committee has combined shares for this ciphertext.

Gas: 100,000 base + 50 per byte.

Semantics: decrypt a ciphertext for which the committee has already executed the
threshold-decryption ceremony. The combined plaintext is materialized into the
output buffer. This is parachain-only because cross-parachain ceremony coordination
requires the parachain-specific committee infrastructure.
```

---

## 9. Forbidden imports

### 9.1 Hard-rejected at deploy time

The deploy validator rejects any module whose WASM import section references any of the following. Attempting to deploy such a module returns `DeployRejected: ForbiddenImport(<name>)`.

| Module | Function | Reason |
|---|---|---|
| `wasi_snapshot_preview1` | (any) | File I/O, system clock, env vars — non-deterministic |
| `wasi_unstable` | (any) | Same |
| `wasi:*` | (any) | Same |
| `env` | (any) | Generic env-namespace functions out of scope for Pyde ABI |
| `pyde` | `debug_log` | **Test-only.** Provided by the otigen-test runner for `console.log`-style printf debugging. Production deployments MUST strip these calls before deploy. See §9.3. |
| `pyde` | other functions not in this spec | Future-proofing; rejects modules built against an unreleased ABI version |
| Any other module name | (any) | Single permitted namespace is `pyde`. |

### 9.2 Parachain functions called from non-parachain modules

If a non-parachain module imports a function from §8, the deploy validator rejects the deployment with `DeployRejected: ParachainOnly(<name>)`. The eligible-import set is determined by the contract's declared `type` in `otigen.toml`.

### 9.3 Test-only imports (otigen-test runner)

The otigen-test runner provides one extra `pyde::*` import that is **forbidden on the chain** but available during local development for `console.log`-style debugging.

#### `debug_log`

```text
pyde::debug_log(msg_ptr: i32, msg_len: i32) -> ()

msg_ptr — pointer to UTF-8 message bytes (lossy decoding tolerates non-UTF-8)
msg_len — message length (max 4 KB; exceeding traps)

Returns: nothing.

Gas: untracked (test-only).

Semantics (test runner): writes "[debug] <fn_name>: <msg>" to stderr. Also
captured in TestEnv.debug_logs for programmatic access in trace renderers.

Semantics (chain): rejected at deploy time. The contract MUST NOT import this
fn in any module shipped to mainnet or testnet.
```

Use cases: ad-hoc value dumps, breadcrumb traces, asserting intermediate state in tests without polluting events. Bridges the gap that previously forced devs to call `revert(b"value=42")` to surface intermediate values.

**Stripping for deploy:** `otigen build --strict` rejects any bundle that imports `pyde::debug_log`, surfacing `ValidationError::TestOnlyHostFn`. `otigen deploy` runs the same gate implicitly — so authors who skip the explicit `--strict` step still get the production check before anything reaches the network. The chain's deploy validator hard-rejects modules whose import section names `debug_log` regardless of how they were bundled.

| Path | Test-only fns accepted? |
|---|---|
| `otigen build` (default) | yes — dev loop unobstructed |
| `otigen build --strict` | **no** — production gate |
| `otigen check` | yes |
| `otigen deploy` | **no** — implicit `--strict` |
| `otigen test` runner | mocked (writes to stderr) |

The honour-system rule is therefore: drop `debug_log` calls (or guard them behind `#[cfg(feature = "debug")]`) before pushing. A grep over the source tree (`grep -rn debug_log src/`) is a fast pre-flight check.

### 9.4 WASM features rejected at instantiation time

The wasmtime config (see [Chapter 3 §3.2](../chapters/03-virtual-machine.md)) rejects modules that use:

- Threads (`wasm_threads`)
- SIMD (`wasm_simd`, `wasm_relaxed_simd`)
- Reference types (`wasm_reference_types`)
- GC (`wasm_gc`)
- Function references (`wasm_function_references`)
- Multiple memories (`wasm_multi_memory`)
- Memory64 (`wasm_memory64`)
- Component model (`wasm_component_model`)

These cannot be opted into per-contract. They are network-wide forbidden.

---

## 10. Gas table

Authoritative gas costs for every host function. This table is the source of truth; if the engine implementation diverges, the engine is wrong.

| Function | Base gas | Per-byte / per-word | Notes |
|---|---|---|---|
| `sload` | 100 | 1 / byte copied | Returns actual length or `-1` (`SLOAD_MISSING`) |
| `sstore` | 5,000 | 32 / byte | Variable-length value (≤ 16 KB) |
| `sdelete` | 5,000 | — | No refund (PIP-4 `gas-no-refund`) |
| `balance` | 100 | — | |
| `transfer` | 7,000 | — | |
| `caller`, `origin`, `self_address` | 5 | — | |
| `wave_id`, `wave_timestamp`, `chain_id` | 2 | — | |
| `tx_hash` | 5 | — | |
| `tx_value` | 5 | — | |
| `tx_gas_remaining` | 2 | — | |
| `calldata_size` | 2 | — | |
| `calldata_copy` | 8 | 1 / byte | |
| `emit_event` | 100 | + 50 / topic + 8 / data byte | 1 to 4 topics; topic[0] conventionally signature hash |
| `hash_blake3` | 15 | 3 / word (8 bytes) | |
| `hash_poseidon2` | 100 | 30 / word | ZK-friendly, expensive |
| `hash_keccak256` | 30 | 6 / word | EVM-compat |
| `falcon_verify` | 50,000 | — | ~80μs commodity |
| `cross_call` | 1,000 | 8 / byte calldata + sub-call gas | |
| `cross_call_static` | 50 | — | Sub-call execution is FREE; caller pays only the dispatch base. Sub-call bounded by VIEW_FUEL_CAP (default 10M instructions ≈ 3ms) |
| `delegate_call` | 1,200 | 8 / byte calldata + sub-call gas | Caller's storage context |
| `return` | 0 | — | Halt op |
| `revert` | 0 | — | Halt op |
| `consume_gas` | 2 | + amount | Pure manual metering |
| `beacon_get` | 50 | — | |
| `parachain_storage_read` | 250 | 1 / byte returned | Parachain only |
| `parachain_storage_write` | 5,500 | 10 / byte | Parachain only |
| `parachain_storage_delete` | 250 | — | Parachain only |
| `parachain_id` | 5 | — | Parachain only |
| `parachain_version` | 5 | — | Parachain only |
| `parachain_emit_event` | 100 | + 50 / topic + 8 / data byte | Parachain only; same multi-topic surface as core emit_event |
| `send_xparachain_message` | 10,000 | 8 / byte | Parachain only |
| `threshold_encrypt` | 80,000 | 100 / byte | Parachain only |
| `threshold_decrypt` | 100,000 | 50 / byte | Parachain only |

Per-word = per-8-bytes, rounded up. Per-byte = per-1-byte, no rounding.

These values are **initial calibration**, set against representative benchmarks for commodity validator hardware. The benchmark harness (see [companion/PERFORMANCE_HARNESS.md](./PERFORMANCE_HARNESS.md)) is the authority for production calibration; pre-mainnet sweeps may revise these numbers up or down by ≤2× without changing the ABI version (gas tables are an implementation detail, not part of the binary signature).

---

## 11. Native (non-WASM) transaction types

Several transaction types **bypass the WASM execution layer entirely** and run as native handlers in the engine. These do not use the Host Function ABI — they are listed here for completeness so contract authors understand which operations are "free of WASM overhead":

| Transaction type | Cost | Path |
|---|---|---|
| `Transfer` (account-to-account) | ~21,000 gas | Native handler; no wasmtime instantiation |
| `ValidatorRegister` | Native | |
| `ValidatorUnbond` | Native | |
| `Stake` / `Unstake` | Native | |
| `RotateKeys` (account key rotation) | Native | |
| `NameRegister` (system contract) | Native (via system contract) | |

See [Chapter 3 §3.9b](../chapters/03-virtual-machine.md) for the dispatch logic.

---

## 12. Invoking host functions from contract code

This section explains the WASM imports mechanism with concrete language examples — the most-asked question from contract authors.

### 12.1 What an import declaration actually is

A WebAssembly module's binary format includes an **import section** listing every external function the module needs. Each entry pairs a `(module_name, function_name)` with a function type signature. The module body never includes the implementation; it just declares "I'll call this — somebody provide it at instantiation time."

Pyde reserves the module name **`pyde`** for all host functions. A contract that declares an import like:

```wat
(import "pyde" "sload" (func (param i32 i32 i32) (result i32)))
```

is saying: "Give me a function named `sload` from module `pyde`, taking (i32, i32, i32) and returning i32 (the `(slot_ptr, out_ptr, out_max_len) -> actual_len` shape)." At instantiation time, wasmtime walks the import section and looks each one up in a host-provided `Linker`. If the entry exists, the contract's call is wired to the host's Rust implementation. If not, instantiation fails — and the deploy validator rejects the contract before it ever reaches a node.

### 12.2 Rust contract — declaring imports

```rust
// All host functions go under module "pyde"
#[link(wasm_import_module = "pyde")]
extern "C" {
    fn sload(slot_ptr: u32, value_out_ptr: u32) -> i32;
    fn sstore(slot_ptr: u32, value_ptr: u32) -> i32;
    fn caller(addr_out_ptr: u32) -> i32;
    fn emit_event(
        topic_ptr: u32, topic_len: u32,
        data_ptr: u32, data_len: u32,
    ) -> i32;
    fn hash_blake3(in_ptr: u32, in_len: u32, out_ptr: u32) -> i32;
}

#[no_mangle]
pub extern "C" fn store_and_read() -> i32 {
    let slot = [0x42u8; 32];
    let value_in = [0xAAu8; 32];
    let mut value_out = [0u8; 32];

    unsafe {
        sstore(slot.as_ptr() as u32, value_in.as_ptr() as u32);
        sload(slot.as_ptr() as u32, value_out.as_mut_ptr() as u32)
    }
}
```

Compile with `cargo build --target wasm32-unknown-unknown --release`. Inspect with `wasm-objdump -x`:

```
Import[5]:
 - func[0] sig=2 <pyde.sload>
 - func[1] sig=2 <pyde.sstore>
 - func[2] sig=3 <pyde.caller>
 - func[3] sig=4 <pyde.emit_event>
 - func[4] sig=5 <pyde.hash_blake3>
```

No Pyde library dependency. No code generation. Just `extern` declarations and the attribute that targets the `pyde` import namespace.

### 12.3 AssemblyScript contract — same imports

```typescript
// AssemblyScript uses @external decorators
@external("pyde", "sload")
declare function sload(slotPtr: usize, valueOutPtr: usize, valueMaxLen: i32): i32;

@external("pyde", "sstore")
declare function sstore(slotPtr: usize, valuePtr: usize, valueLen: i32): void;

@external("pyde", "caller")
declare function caller(addrOutPtr: usize): i32;

@external("pyde", "emit_event")
declare function emit_event(
  topicPtr: usize, topicLen: usize,
  dataPtr: usize, dataLen: usize
): i32;

@external("pyde", "hash_blake3")
declare function hash_blake3(inPtr: usize, inLen: usize, outPtr: usize): i32;

export function store_and_read(): i32 {
  const slot = new ArrayBuffer(32);
  const valueIn = new ArrayBuffer(32);
  const valueOut = new ArrayBuffer(32);

  // Fill slot with 0x42, valueIn with 0xAA
  const slotPtr = changetype<usize>(slot);
  const valueInPtr = changetype<usize>(valueIn);
  for (let i: i32 = 0; i < 32; i++) {
    store<u8>(slotPtr + i, 0x42);
    store<u8>(valueInPtr + i, 0xAA);
  }

  sstore(slotPtr, valueInPtr);
  return sload(slotPtr, changetype<usize>(valueOut));
}
```

Compile with `npx asc store_and_read.ts -o store_and_read.wasm --target release`. Resulting WASM has the same import structure. The runtime can't tell which language produced it.

### 12.4 Go (TinyGo) contract — same imports

```go
//go:wasmimport pyde sload
func sload(slotPtr uint32, valueOutPtr uint32) int32

//go:wasmimport pyde sstore
func sstore(slotPtr uint32, valuePtr uint32) int32

//go:wasmimport pyde emit_event
func emit_event(topicPtr, topicLen, dataPtr, dataLen uint32) int32

//go:export store_and_read
func StoreAndRead() int32 {
    slot := [32]byte{}
    for i := range slot { slot[i] = 0x42 }
    valueIn := [32]byte{}
    for i := range valueIn { valueIn[i] = 0xAA }
    var valueOut [32]byte

    slotPtr := uint32(uintptr(unsafe.Pointer(&slot[0])))
    valueInPtr := uint32(uintptr(unsafe.Pointer(&valueIn[0])))
    valueOutPtr := uint32(uintptr(unsafe.Pointer(&valueOut[0])))

    sstore(slotPtr, valueInPtr)
    return sload(slotPtr, valueOutPtr)
}
```

Compile with `tinygo build -target=wasm-unknown -o store_and_read.wasm`. Same WASM output shape.

### 12.5 C / C++ contract — same imports

```c
__attribute__((import_module("pyde"), import_name("sload")))
extern int32_t sload(int32_t slot_ptr, int32_t value_out_ptr);

__attribute__((import_module("pyde"), import_name("sstore")))
extern int32_t sstore(int32_t slot_ptr, int32_t value_ptr);

__attribute__((import_module("pyde"), import_name("emit_event")))
extern int32_t emit_event(int32_t topic_ptr, int32_t topic_len,
                          int32_t data_ptr, int32_t data_len);

__attribute__((export_name("store_and_read")))
int32_t store_and_read(void) {
    uint8_t slot[32];     for (int i = 0; i < 32; i++) slot[i] = 0x42;
    uint8_t value_in[32]; for (int i = 0; i < 32; i++) value_in[i] = 0xAA;
    uint8_t value_out[32];

    sstore((int32_t)(uintptr_t)slot, (int32_t)(uintptr_t)value_in);
    return sload((int32_t)(uintptr_t)slot, (int32_t)(uintptr_t)value_out);
}
```

Compile with `clang --target=wasm32 -nostdlib -Wl,--no-entry -o store_and_read.wasm store_and_read.c`. Same WASM output shape.

### 12.6 Host side — how the engine handles invocations

In Pyde's `wasm-exec` Rust crate, every function in this spec is registered with wasmtime's `Linker` at engine startup. When a contract is instantiated, wasmtime walks the contract's import section and binds each one to its registered handler:

```rust
// Engine startup — once per node lifetime
pub fn build_linker(engine: &wasmtime::Engine) -> Linker<HostState> {
    let mut linker = Linker::new(engine);

    // Register every host function from §7 and §8
    linker.func_wrap("pyde", "sload", host_sload).unwrap();
    linker.func_wrap("pyde", "sstore", host_sstore).unwrap();
    linker.func_wrap("pyde", "caller", host_caller).unwrap();
    linker.func_wrap("pyde", "emit_event", host_emit_event).unwrap();
    linker.func_wrap("pyde", "hash_blake3", host_hash_blake3).unwrap();
    // ... 30+ more
    linker
}

// sload implementation (variable-length value, returns actual_len or
// SLOAD_MISSING = -1 for never-written slots)
fn host_sload(
    mut caller: Caller<'_, HostState>,
    slot_ptr: i32,
    out_ptr: i32,
    out_max_len: i32,
) -> i32 {
    // 1. Charge base gas FIRST (before any work); per-byte gas charged
    //    after we know the value length.
    if caller.consume_fuel(SLOAD_BASE_GAS).is_err() {
        return ERR_OUT_OF_GAS;  // documentation; wasmtime traps with OutOfFuel
    }

    // 2. Get the contract's exported linear memory
    let memory = match caller.get_export("memory") {
        Some(wasmtime::Extern::Memory(m)) => m,
        _ => return ERR_INTERNAL,
    };

    // 3. Read the slot hash from WASM memory (bounds-checked by wasmtime)
    let mut slot_bytes = [0u8; 32];
    if memory.read(&caller, slot_ptr as usize, &mut slot_bytes).is_err() {
        return ERR_INVALID_INPUT;
    }

    // 4. Access-list check
    if !caller.data().access_list.contains(&slot_bytes) {
        return ERR_ACCESS_LIST_VIOLATION;
    }

    // 5. Look up the value — variable-length; missing returns SLOAD_MISSING
    let value_bytes = match caller.data().state_get(&slot_bytes) {
        Some(bytes) => bytes,
        None => return -1, // SLOAD_MISSING
    };
    let actual_len = value_bytes.len() as i32;

    // 6. Charge per-byte gas based on what we'll copy to the caller
    let to_copy = actual_len.min(out_max_len.max(0)) as usize;
    if caller.consume_fuel(to_copy as u64).is_err() {
        return ERR_OUT_OF_GAS;
    }

    // 7. Write back to WASM memory (truncated to out_max_len)
    if memory.write(&mut caller, out_ptr as usize, &value_bytes[..to_copy]).is_err() {
        return ERR_INVALID_INPUT;
    }

    actual_len  // contract sees the true length even if truncated
}
```

The flow when a contract executes `sload(slot_ptr, value_out_ptr)`:

```
Contract WASM (any language)              wasm-exec (Rust)
─────────────────────────────             ───────────────────────────────
[author's compiled WASM]                  [engine startup, once per node]
  (import "pyde" "sload" ...)             linker.func_wrap("pyde", "sload",
                                              host_sload)

                                          ↓
[at instantiation]                        [wasmtime walks contract's
                                           import section, binds each
                                           import to a linker entry]
                                          ↓
[at execution]                            [contract's `sload` stub now
sload(slot_ptr, value_out_ptr)            points to host_sload]
   │
   ▼
[wasmtime traps into Rust]    ──────→    host_sload(caller, slot_ptr, value_out_ptr)
                                            │
                                            ├─ charge gas via consume_fuel
                                            ├─ read 32 bytes from WASM memory at slot_ptr
                                            ├─ access-list check
                                            ├─ state_get(slot_bytes).unwrap_or([0; 32])
                                            ├─ write 32 bytes back at value_out_ptr
                                            ▼
                              ← return i32  return 0
   │
   ▼
[contract resumes execution
 with sload's return value]
```

---

## 13. Cross-contract call mechanics

`cross_call` is the most complex host function. This section spells out the exact flow when contract A calls contract B.

### 13.1 The 12-step flow

When A invokes `cross_call(B_addr, "fn_name", calldata, value, gas_limit, return_data_out_ptr, return_data_out_len_ptr)`:

1. **Wasmtime traps into `host_cross_call`** with all arguments.
2. **Charge A's gas**: `1,000 base + 8 × calldata_len + (gas_limit reserved)`. If A's remaining budget is insufficient, trap A with `OutOfFuel`.
3. **Validate target B**: state-lookup `B_addr`; must have a non-empty `code_hash`. If not, return `ERR_CROSS_CALL_FAILED`.
4. **Validate function name**: lookup `"fn_name"` in B's deployed ABI metadata (cached at deploy time). If not found, return `ERR_INVALID_FUNCTION_NAME`.
5. **Reentrancy check**: walk the current call stack of `(contract, fn)` pairs. If `(B_addr, "fn_name")` is already on the stack AND `"fn_name"` is not `#[reentrant]`, return `ERR_REENTRANCY_BLOCKED`.
6. **Payable check**: if `value > 0` and `"fn_name"` is not `#[payable]`, return `ERR_VALUE_TRANSFER_NOT_PAYABLE`.
7. **Push a new overlay** onto the per-tx overlay stack. Call it `overlay_B`. Reads from B's `sload` walk: `overlay_B → overlay_A → dashmap → state_cf`. Writes from B's `sstore` go to `overlay_B` only.
8. **Create a new wasmtime Store + Instance** for B with: fresh linear memory (B cannot see A's memory directly); fuel = `gas_limit`; the same `Linker` (so B has the same host functions available); `HostState` pointing to `overlay_B` and the active call stack with B pushed on.
9. **Copy calldata** from A's memory into B's memory at a host-chosen offset (typically the start of B's memory's calldata region).
10. **Apply value transfer**: if `value > 0`, atomically debit A's balance and credit B's by `value`. This happens before B's code runs so B's first `tx_value()` call sees the right amount.
11. **Invoke B's entry function** with calldata. B's WASM executes in isolation — its `sload`/`sstore` operate on `overlay_B`; its own `cross_call` would push *another* overlay on top.
12. **On B's exit**, handle the outcome:
    - **Success (B returned normally)**: merge `overlay_B` into `overlay_A`; copy return data from B's memory into A's memory at `return_data_out_ptr`; write actual length at `return_data_out_len_ptr`; consume B's actual fuel from A's remaining budget; return `0` to A.
    - **Trap (B hit OutOfFuel, MemoryOutOfBounds, reverted, etc.)**: discard `overlay_B` entirely; revert the value transfer from step 10; consume B's actual fuel from A's remaining; return `ERR_CROSS_CALL_FAILED` to A.
    - **OutOfFuel specifically**: same as trap, but return `ERR_CROSS_CALL_OUT_OF_GAS` to distinguish.

### 13.2 The overlay stack

The per-tx overlay stack is the load-bearing data structure here:

```
At depth 0 (top of stack — what B's writes go to):
   overlay_B = HashMap<SlotHash, Value>     (initially empty)

At depth 1:
   overlay_A = HashMap<SlotHash, Value>     (A's pending writes from before cross_call)

At depth 2:
   wave overlay = HashMap<SlotHash, Value>  (writes from prior committed txs in this wave)

At depth 3:
   dashmap                                  (write-back cache, hot recent state)

At depth 4:
   state_cf                                 (canonical disk-backed state)

At depth 5:
   jmt_cf                                   (versioned tree; only for state-root computation)
```

**Reads** walk top-down until a value is found. **Writes** always go to the top of the stack. **Merge on success** copies overlay_B's entries into overlay_A. **Discard on trap** drops overlay_B.

This is the same nesting pattern at every depth: a tx that issues a `cross_call` becomes one frame deeper; that sub-call issuing another `cross_call` becomes one deeper still.

### 13.3 Memory isolation

A and B have **completely separate WASM linear memories**. They cannot see each other's memory. The only communication channels are:

- **A → B**: the calldata bytes copied at step 9
- **B → A**: the return data copied at step 12 (success path)
- **A ↔ B (shared)**: state, but only through the overlay stack — there is no shared memory region

This means a malicious B cannot read A's stack, A's locals, A's other variables. The sandbox is per-instance.

### 13.4 Stack depth cap

To prevent runaway recursion (e.g., a contract that calls itself unboundedly through different addresses), the call stack has a hard depth limit. Default: **1024 frames**. Exceeding it returns `ERR_CROSS_CALL_FAILED` from the offending `cross_call` invocation.

### 13.5 Gas accounting

- **Reservation**: A pre-charges `gas_limit` from its remaining budget at step 2 (the host function refuses to start the sub-call if A can't afford the reservation).
- **Forwarding**: B receives a fresh fuel counter of `gas_limit`.
- **Consumption**: After B exits, A's budget is debited by B's *actual* fuel consumed (which may be less than `gas_limit`).
- **No refund**: any unused portion of `gas_limit` is *not* returned to A (consistent with the no-refund policy). A consumed gas it didn't end up using — that's the tradeoff for the simpler accounting model. Authors are advised to size `gas_limit` carefully.

### 13.6 Why `cross_call_static` exists

`cross_call_static` is the read-only variant. It enforces:

- Target function must be marked `#[view]` — if not, returns `ERR_FORBIDDEN`.
- Sub-call cannot mutate state, emit events, or transfer value (the view-mode flag in the overlay rejects writes).
- No new overlay is needed (no writes possible); reads walk the existing stack.

This is cheaper (no overlay push/merge) and safer (no reentrancy risk — view functions can't change anything observable).

---

## 14. Event encoding convention

Each event carries **1 to 4 topics** (each 32 bytes) plus an **opaque data payload**. The chain stores both verbatim. For wallets, indexers, and SDKs to decode events consistently, Pyde defines a canonical convention for both.

### 14.1 Topics

Topics are how events are indexed and filtered on-chain. Each event has 1 to 4 topics. By convention:

- **`topic[0]`** is *always* `Blake3(canonical_event_signature)`. This is the event-type identifier — what subscribers and indexers match on as the primary filter.
- **`topic[1..topics_count]`** are indexed-field values, in author-declared order.

Authors mark fields as indexed in `otigen.toml`:

```toml
[events.Transfer]
signature = "Transfer(address,address,uint128)"
fields = [
    { name = "from",   type = "address",  indexed = true },
    { name = "to",     type = "address",  indexed = true },
    { name = "amount", type = "uint128" },   # not indexed → goes in data
]
```

Up to **3 fields can be `indexed`** (giving a total of 4 topics — signature plus 3 — matching EVM's LOG4 limit).

#### Topic value encoding

How each indexed-field value becomes a 32-byte topic:

| Field type | Encoding rule |
|---|---|
| `address` ([u8; 32]) | Stored as-is (already 32 bytes) |
| `uint64`, `int64` | Left-padded to 32 bytes (zeros in MSB) |
| `uint128`, `int128` | Left-padded to 32 bytes |
| `bool` | Left-padded to 32 bytes (`0x00...00` or `0x00...01`) |
| `[u8; N]` where N ≤ 32 | Left-padded to 32 bytes |
| `string` | `Blake3(utf8_bytes)` |
| `bytes` (`Vec<u8>`) | `Blake3(bytes)` |
| `T[]` (`Vec<T>`) | `Blake3(borsh_encode(value))` |
| `struct { ... }` | `Blake3(borsh_encode(value))` |
| `enum { ... }` | `Blake3(borsh_encode(value))` |

Rule: **fixed-size ≤32 bytes get stored as-is (padded); variable-size or >32 bytes get hashed**. Matches EVM's `indexed` semantics.

#### Canonical signature string

The signature string drives `topic[0]`. Type names mirror Solidity's for familiarity:

| Pyde type | Signature token |
|---|---|
| `[u8; 32]` (address) | `address` |
| `u64` | `uint64` |
| `u128` | `uint128` |
| `i64` | `int64` |
| `bool` | `bool` |
| `String` (UTF-8) | `string` |
| `Vec<u8>` | `bytes` |
| `Vec<T>` | `T[]` |
| `[T; N]` | `T[N]` |
| `enum X { ... }` | `enum` |
| Custom struct | `tuple` (with field types in parens; rare) |

Examples:

```
"Transfer(address,address,uint128)"
"Approval(address,address,uint128,uint64)"
"OrderFilled(address,string,uint128,uint64[],enum)"
```

The signature string is **not stored on chain** — only `Blake3(signature)` is, as `topic[0]`. Indexers and SDKs maintain a registry of signatures they care about and hash them locally to match against event topics. The `pyde.abi` custom section of the deployed contract carries the full signature for any explorer that wants to render the event with field names.

### 14.2 Data

### 14.2 Data

The **data** field is the event payload as bytes. The chain stores it verbatim — encoding is the author's choice.

**Borsh is the recommended encoding.** Pyde's toolchain, SDKs, indexers, wallets, and example contracts all assume Borsh by default; choosing it gets you out-of-the-box decoding everywhere. `otigen` ships Borsh helpers as part of the canonical project templates. `pyde-rust-sdk` and `pyde-ts-sdk` ship Borsh decoders that match topics to signature registries and auto-deserialize. Block explorers built on these SDKs render Borsh-encoded events without any per-contract integration.

Authors picking a different encoding (raw bytes for tiny events, Protobuf for cross-team contracts, custom format for niche cases) are free to do so — the chain doesn't care — but they take on the integration burden: SDK consumers need custom decoders, wallet previews can't auto-render the event, indexers need per-contract logic.

Borsh chosen as the recommended default over alternatives:

- **vs JSON**: smaller (no whitespace, no field names in the wire format), deterministic byte ordering, no integer-precision issues
- **vs Protobuf**: simpler, no schema-evolution complexity, language-agnostic implementations more uniform, no `.proto` toolchain dependency
- **vs SCALE**: better Rust-ecosystem support, simpler grammar
- **vs EVM ABI encoding**: simpler, more compact, no padding-to-32-bytes overhead, no special handling for dynamic-length fields
- **vs MsgPack/CBOR**: deterministic by construction (canonical encoding), no implementation-defined behaviors

Borsh is supported in: Rust (`borsh` crate), TypeScript (`@dao-xyz/borsh-ts`, `borsh-js`), AssemblyScript (community `as-borsh`), Go (`github.com/near/borsh-go`), C (community), Python (`borsh-construct`). Pyde's recommendation tracks this ecosystem; if a language gains a high-quality Borsh implementation, contracts in that language get first-class event support without Pyde shipping bindings.

### 14.3 Example: Rust emitter (with indexed fields)

The author declares the event in `otigen.toml` (per §14.1). The SDK generates a typed emit helper. The author's code stays clean:

```rust
use pyde_contract::events;

// Inside a contract function:
events::Transfer {
    from:   caller_address,
    to:     recipient,
    amount: 100u128,
}.emit();
```

Behind the scenes, the SDK helper (generated from `otigen.toml`) builds the call:

```rust
// Generated by SDK from otigen.toml — author doesn't write this
impl Transfer {
    pub fn emit(self) -> i32 {
        // 1. Build topics
        let mut topics = [0u8; 4 * 32];

        // topic[0] = Blake3(signature) — precomputed constant
        topics[0..32].copy_from_slice(&TRANSFER_SIGNATURE_HASH);

        // topic[1] = padded(from) — address is already 32 bytes
        topics[32..64].copy_from_slice(&self.from);

        // topic[2] = padded(to)
        topics[64..96].copy_from_slice(&self.to);

        // No topic[3] — we only have 2 indexed fields.

        // 2. Borsh-encode non-indexed fields (just amount)
        let data = borsh::to_vec(&self.amount).unwrap();

        // 3. Call the host function
        unsafe {
            emit_event(
                topics.as_ptr() as u32, 3,                      // topics_count = 3
                data.as_ptr() as u32, data.len() as u32,
            )
        }
    }
}

// Precomputed at otigen build time:
const TRANSFER_SIGNATURE_HASH: [u8; 32] = blake3_const(b"Transfer(address,address,uint128)");
```

For events without indexed fields, the SDK emits with `topics_count = 1` (just the signature hash) and Borsh-encodes all fields into data.

### 14.4 Example: TypeScript decoder (in pyde-ts-sdk, with indexed fields)

```typescript
import { deserialize } from "@dao-xyz/borsh-ts";
import { blake3 } from "@noble/hashes/blake3";

// Borsh schema only needs the NON-indexed fields:
class TransferEventData {
  amount: bigint;    // u128
}

const transferTopic = blake3("Transfer(address,address,uint128)");

for await (const event of subscription) {
  // Match by signature hash at topic[0]
  if (!uint8ArrayEqual(event.topics[0], transferTopic)) continue;

  // Indexed fields come from topics[1..]:
  const from = event.topics[1];   // 32-byte address (no padding for addresses)
  const to   = event.topics[2];

  // Non-indexed fields come from Borsh-decoded data:
  const { amount } = deserialize(event.data, TransferEventData);

  console.log(`Transfer from ${hex(from)} to ${hex(to)} amount ${amount}`);
}
```

A wallet or explorer that doesn't statically know the event type can still decode it dynamically:

1. Fetch the contract's `.wasm` via `pyde_getContractCode(addr)`
2. Parse the `pyde.abi` custom section to find the event matching `topics[0]`
3. The ABI declares which fields are indexed (→ pair them with `topics[1..]`) and which are not (→ Borsh-decode them from `data`)
4. Render the typed event with field names and values

### 14.5 Authors are free to use a different encoding

The data field is opaque to the chain. An author who has reason to use a custom encoding (raw bytes for ultra-simple events, Protobuf for cross-team consistency, etc.) is free to do so. The cost: SDK consumers must write custom decoders for those events; standard wallet preview / explorer tooling won't auto-decode them.

The recommendation stands: use Borsh unless you have a specific reason not to.

---

## 15. Event storage, indexing, and subscriptions

This section specifies how events emitted via `pyde::emit_event` (§7.5) and `pyde::parachain_emit_event` (§8.3) are committed on-chain, stored at each node, indexed for query, and delivered to real-time subscribers.

### 15.1 Per-overlay buffering during execution

Each per-tx overlay (see §3 of [Chapter 3](../chapters/03-virtual-machine.md)) maintains its own ordered events buffer alongside its state writes. Calls to `emit_event` append to the current top-of-stack overlay's buffer.

```text
On overlay merge (success):  parent.events.extend(child.events)
On overlay discard (revert): child.events dropped along with state writes
```

This means: **events from a reverted (sub-)call are not committed**. A top-level tx that reverts emits zero events. A cross_call'd sub-call that traps loses its events when its overlay is discarded; if the parent then succeeds, only the parent's pre-call events plus its post-call events (if any) survive.

The wave's final events list = the topmost overlay's events buffer at wave commit time, with positions assigned as `(wave_id, tx_index, event_index)` in canonical order.

### 15.2 On-chain commitment

Every wave commit record includes both an `events_root` (deterministic Merkle commitment) and an `events_bloom` (probabilistic summary).

```rust
struct WaveCommitRecord {
    wave_id:        u64,
    anchor_hash:    VertexHash,
    state_root:     (Blake3Hash, Poseidon2Hash),    // unchanged from Ch 4
    events_root:    Blake3Hash,                      // NEW: see §15.2.1
    events_bloom:   [u8; 256],                       // NEW: 2048-bit, see §15.2.2
    included_txs:   Vec<TxHash>,
    tx_count:       u32,
    events_count:   u32,                             // total events in this wave
    gas_used:       u128,
}
```

The wave commit record is what the committee threshold-signs as part of the `HardFinalityCert`. `events_root` and `events_bloom` therefore inherit consensus-level integrity.

#### 15.2.1 events_root

A binary Merkle tree over the wave's events in canonical order:

```text
leaf_i  = Blake3(borsh_encode(EventRecord_i))
node    = Blake3(left || right)
events_root = top of tree (padded with zero-leaves to next power of two)

For a wave with zero events:
events_root = [0u8; 32]   (sentinel — no events to commit)
```

**Light client inclusion proof:** to prove "event E was emitted in wave W", a light client needs:
1. The wave's `HardFinalityCert` containing the signed `events_root`.
2. The `EventRecord` itself.
3. A Merkle proof from the event's leaf position to the root (log₂(events_count) hashes).

Proof verification: recompute the leaf hash, walk the proof to reconstruct the root, compare against the cert's `events_root`. If equal, the event is provably committed to that wave.

Cost per event ~32-byte hash; cost per wave ~few hundred μs (events_count is typically thousands at most, not millions). Negligible compared to wave-commit fixed costs.

**Future ZK extension:** v2 may add a `events_root_poseidon2` parallel field for ZK-circuit-friendly proofs, mirroring the dual-hash state-root pattern (Chapter 4 §4.1b). v1 ships Blake3 only.

#### 15.2.2 events_bloom

A 256-byte (2048-bit) bloom filter over the wave's events. Used for cheap "did any event matching X happen in wave W?" queries without fetching the event list.

```text
For each event in the wave:
    for each topic in event.topics:             // 1 to 4 topics per event
        insert(bloom, topic)
    insert(bloom, event.contract_addr)          // 32-byte contract address

insert(bloom, item):
    h1 = blake3(item)[..8] mod 2048
    h2 = blake3(item)[8..16] mod 2048
    h3 = blake3(item)[16..24] mod 2048
    bloom.set_bit(h1)
    bloom.set_bit(h2)
    bloom.set_bit(h3)
```

Three hash functions, 2048-bit filter. Expected false-positive rate at typical wave loads:

| Events per wave | False-positive rate |
|---|---|
| 100 | ~0.001 % |
| 1,000 | ~1 % |
| 5,000 | ~17 % |
| 10,000 | ~52 % |

At v1 honest throughput (~10-30K TPS plaintext, most txs not emitting events), a typical wave has <2,000 events and the bloom is highly selective. At peak load it becomes less useful but never lies (no false negatives). Historical query (§15.4) uses the bloom as a pre-filter and the indexes for exact matches.

### 15.3 Per-node storage layout

Three RocksDB column families. Big-endian numeric encoding throughout so RocksDB's lexicographic iterator order matches numeric order.

```text
events_cf  (primary store)
  key:   wave_id (8 BE) || tx_index (4 BE) || event_index (4 BE)
  value: borsh_encode(EventRecord)

  EventRecord {
      wave_id:        u64,
      tx_index:       u32,
      event_index:    u32,
      contract_addr:  [u8; 32],
      topics:         Vec<[u8; 32]>,   // 1 to 4 topics; topic[0] = signature hash
      data:           Vec<u8>,
  }


events_by_topic_cf  (index)
  key:   topic (32) || wave_id (8 BE) || tx_index (4 BE) || event_index (4 BE)
  value: ()   // empty — the key contains all the lookup info

  Prefix scan with topic_X → all events whose ANY topic equals X, in wave order.
  An event with N topics writes N rows to this CF (one per topic value).


events_by_contract_cf  (index)
  key:   contract_addr (32) || wave_id (8 BE) || tx_index (4 BE) || event_index (4 BE)
  value: ()

  Prefix scan with contract_X → all events from that contract, in wave order.
```

**Atomicity:** on every wave commit, the engine writes one RocksDB `WriteBatch` containing all three CFs' updates plus the wave commit record. Atomic: either all three indexes update together or none does.

**Write cost per event:** `1 + topics_count + 1` RocksDB puts — one primary, one per topic, one contract index. At sustained ~2,000 events/wave with an average of ~2 topics each, that's ~8,000 puts/wave, which RocksDB handles in single-digit ms with the existing PIP-4 write-back cache architecture (Chapter 4).

### 15.4 Historical query

JSON-RPC method `pyde_getLogs(filter)`:

```rust
struct GetLogsRequest {
    from_wave:  u64,                       // inclusive
    to_wave:    u64,                       // inclusive; capped: to_wave - from_wave ≤ 5,000
    topics:     [Option<Vec<[u8;32]>>; 4], // positional filter; index i matches event.topics[i].
                                           //   Some(list) at position i: event's i-th topic must be IN the list
                                           //   None at position i: any value at that position (or absent)
    contract:   Option<[u8; 32]>,          // None = any contract
    cursor:     Option<EventCursor>,       // continuation from prior page; None = start fresh
    limit:      u32,                       // max events to return; default 100, max 1,000
}

struct EventCursor {
    wave_id:     u64,
    tx_index:    u32,
    event_index: u32,
}

struct GetLogsResponse {
    events:       Vec<EventRecord>,
    next_cursor:  Option<EventCursor>,     // None = exhausted; Some = call again with this cursor
}
```

**Filter semantics (positional, EVM-style):**

```
match(event, filter) =
    (filter.contract == None OR event.contract_addr == filter.contract) AND
    (filter.from_wave == None OR event.wave_id >= filter.from_wave) AND
    for each position i in 0..4:
        if filter.topics[i] == None: skip (any value matches)
        else if event.topics.len() <= i: NOT a match (event missing this position)
        else: event.topics[i] must be IN filter.topics[i] (OR-list within a position)
```

Examples:

```
# "All Transfer events":
filter.topics = [Some([Blake3("Transfer(address,address,uint128)")]), None, None, None]

# "All Transfer events FROM address 0xAB...CD":
filter.topics = [
    Some([Blake3("Transfer(...)")]),
    Some([padded(0xAB...CD)]),
    None,
    None,
]

# "Either Transfer OR Approval from contract X":
filter.topics = [
    Some([Blake3("Transfer(...)"), Blake3("Approval(...)")]),
    None, None, None,
]
filter.contract = Some(contract_X)
```

**Query plan:**

1. **Validate** the request: `to_wave - from_wave ≤ 5,000`; per-position list size ≤ 8; `limit ≤ 1,000`.
2. **Wave-level bloom prefilter:** for each wave in `[from_wave, to_wave]`, load the wave's commit record and test the `events_bloom` against every concrete value in the filter (any positional topic OR the contract). Drop waves with no bloom hit.
3. **Per-wave exact lookup:** for surviving waves, pick the most selective filter element to drive the scan:
   - If a specific position has a single topic value: scan `events_by_topic_cf` for that value, then post-filter results against the remaining positional constraints + contract.
   - If no topic but contract is set: scan `events_by_contract_cf` prefix `contract || wave_id`, then post-filter against topic positions.
   - If multiple values at one position: scan each, merge sorted union.
4. **Stream results** in canonical order until `limit` is reached, building `next_cursor` to point to the next event past the limit.
5. **Return** the page + cursor.

Subsequent pages: client calls `pyde_getLogs` again with the same filter and the returned `cursor`. Server resumes scanning past the cursor.

Ordering is **wave-ascending only** in v1. Descending order is a v2 minor bump if needed.

### 15.5 Real-time subscription

JSON-RPC method `pyde_subscribe({method: "logs", filter})` over WebSocket:

```rust
struct LogSubscription {
    topics:    [Option<Vec<[u8;32]>>; 4],  // positional filter (same shape as pyde_getLogs)
    contract:  Option<[u8; 32]>,
    from:      Option<EventCursor>,        // for resume-on-reconnect; None = live from now
}
```

**Engine behavior:**

- On subscribe: add `(subscription_id, LogSubscription)` to in-memory registry; if `from` is provided, replay from disk via the historical-query machinery until caught up to the current wave, then transition to live.
- On every wave commit (after the wave's events land in disk): for each active subscription, walk the wave's events, match against the filter, push matches as `LogEventNotification` records over the WebSocket.
- On disconnect: drop subscription from registry. Subscriber must `pyde_subscribe` again on reconnect (with `from` cursor if it wants to resume from a specific position).

```rust
struct LogEventNotification {
    subscription_id:  SubscriptionId,
    event:            EventRecord,    // includes (wave_id, tx_index, event_index) for dedup
}
```

**Delivery guarantees:**

- **Post-commit only.** Subscribers receive events only after the event's wave has committed. No "pending event" notifications.
- **Canonical order.** Events arrive in `(wave_id, tx_index, event_index)` order. Subscribers can dedupe by cursor since each event carries its position.
- **At-least-once.** If the WebSocket disconnects mid-push, the subscriber must reconnect and use `from` cursor to resume from a known-processed position. The engine does *not* track which events a specific subscriber acknowledged; subscribers reconcile via cursor.

**Filter syntax (positional, EVM-style):** identical to `pyde_getLogs` (§15.4). Per-position topic constraints are AND'd; within each position, multiple values are OR'd; the contract filter is AND'd on top.

This covers EVM-equivalent filtering ("Transfer events from address X to anyone", "Approval OR Transfer events on token Y", etc.) and gives indexers parity with what they're used to.

### 15.6 Retention

Events follow the same retention tiering as state (Chapter 4):

| Node tier | Events retention |
|---|---|
| Archive | Forever |
| Full node | Last 90 days |
| Committee validator | Last 30 days |
| Light client | No primary storage; verifies inclusion proofs against signed `events_root` |

**Pruning:** at every epoch boundary, the engine sweeps `events_cf`, `events_by_topic_cf`, and `events_by_contract_cf` together, removing entries with `wave_id < (current_wave - retention_waves)`. Lockstep — never partial. The wave commit records themselves are retained per the wave-commit retention policy (longer than events; needed for chain-of-trust during state sync).

### 15.7 Light client model

A light client doesn't store events. It can:

- **Verify a specific event exists**: given an `EventRecord` (fetched from any full node) plus the wave's `HardFinalityCert` plus a Merkle proof to `events_root`, verify the event is committed to a finalised wave.
- **Probabilistically check existence**: given just the wave's `HardFinalityCert`, check `events_bloom` for a topic/contract match. False-positive rate per §15.2.2.
- **Subscribe to live events**: connect to a full node's `pyde_subscribe`. Trust the node's stream (or verify each event with an inclusion proof for high-stakes cases).

### 15.8 Cross-parachain event isolation

Events from `parachain_emit_event` (§8.3) are recorded with the parachain's `parachain_id` in their `contract_addr` field (parachains and contracts share the address space; see [PARACHAIN_DESIGN.md](./PARACHAIN_DESIGN.md) §4). Subscribers filter on `contract_addr = parachain_id` to listen for a specific parachain's events.

No separate parachain-events column family — they share the same `events_cf` / `events_by_topic_cf` / `events_by_contract_cf` machinery as ordinary contract events. The bloom filter aggregates both. The Merkle root commits to both. Parachain events are queryable identically.

### 15.9 Implementation notes for `wasm-exec`

Reference flow for the engine implementation (pseudocode):

```rust
// During tx execution
fn host_emit_event(
    mut caller: Caller<'_, HostState>,
    topics_ptr: i32,
    topics_count: i32,
    data_ptr: i32,
    data_len: i32,
) -> i32 {
    // 1. Validate + gas
    if topics_count < 1 || topics_count > 4 {
        return ERR_INVALID_INPUT;
    }
    if data_len > MAX_EVENT_DATA_SIZE {
        return ERR_INVALID_INPUT;
    }
    let gas = EMIT_EVENT_BASE_GAS
            + 50 * topics_count as u64
            + 8 * data_len as u64;
    if caller.consume_fuel(gas).is_err() {
        return ERR_OUT_OF_GAS;
    }
    if caller.data().view_mode {
        return ERR_FORBIDDEN;
    }

    // 2. Read topics + data from WASM memory
    let memory = /* get exported memory */;
    let total_topic_bytes = (topics_count as usize) * 32;
    let mut topics_buf = vec![0u8; total_topic_bytes];
    memory.read(&caller, topics_ptr as usize, &mut topics_buf)?;
    let topics: Vec<[u8; 32]> = topics_buf
        .chunks_exact(32)
        .map(|c| { let mut t = [0u8; 32]; t.copy_from_slice(c); t })
        .collect();

    let mut data = vec![0u8; data_len as usize];
    memory.read(&caller, data_ptr as usize, &mut data)?;

    // 3. Append to the current overlay's events buffer
    let event = EventRecord {
        wave_id: caller.data().current_wave,
        tx_index: caller.data().tx_index,
        event_index: caller.data().overlay_top().events.len() as u32,
        contract_addr: caller.data().self_address,
        topics,
        data,
    };
    caller.data_mut().overlay_top_mut().events.push(event);
    0
}

// At wave commit
fn finalize_wave_events(wave: &mut WaveCommit) {
    let all_events = wave.collect_committed_events();   // walks committed overlays
    wave.events_count = all_events.len() as u32;

    // Build bloom — every topic + contract_addr of every event
    let mut bloom = [0u8; 256];
    for e in &all_events {
        for topic in &e.topics {
            bloom_insert(&mut bloom, topic);
        }
        bloom_insert(&mut bloom, &e.contract_addr);
    }
    wave.events_bloom = bloom;

    // Build Merkle root over canonical-ordered events
    let leaves: Vec<Blake3Hash> = all_events.iter()
        .map(|e| blake3_hash(&borsh::to_vec(e).unwrap()))
        .collect();
    wave.events_root = merkle_root_blake3(&leaves);

    // Write to disk (atomic batch with state + wave commit)
    let mut batch = WriteBatch::new();
    for e in all_events {
        let primary_key = (e.wave_id, e.tx_index, e.event_index).encode_be();
        batch.put_cf(events_cf, primary_key, borsh::to_vec(&e).unwrap());

        // One row per topic in events_by_topic_cf
        for topic in &e.topics {
            let topic_key = (topic, e.wave_id, e.tx_index, e.event_index).encode_be();
            batch.put_cf(events_by_topic_cf, topic_key, &[]);
        }

        let contract_key = (e.contract_addr, e.wave_id, e.tx_index, e.event_index).encode_be();
        batch.put_cf(events_by_contract_cf, contract_key, &[]);
    }
    db.write(batch).expect("atomic events write");

    // Notify subscribers (positional filter match per §15.5)
    for (sub_id, sub) in subscription_registry.iter() {
        for e in &wave.events {
            if matches(e, &sub.filter) {
                websocket_push(sub_id, LogEventNotification { subscription_id: sub_id, event: e.clone() });
            }
        }
    }
}
```

### 15.10 Open items deferred to v2

- **Address-list filters.** v1 supports one contract per subscription. v2 could allow `contracts: Vec<Address>` (OR-list of contracts).
- **Descending wave queries.** v1 returns events ascending only. v2 could add `direction: Ascending | Descending`.
- **events_root_poseidon2.** ZK-friendly parallel root for the events tree, mirroring the dual-hash state-root pattern. v2 work; not on v1 critical path.
- **Indexed wildcards / set matching on contract.** v1 contract filter is a single optional address. v2 could allow set membership and contract-name pattern matching.

Note: multi-topic native (up to 4 topics per event with EVM-style indexed-field marking) **ships at v1** — see §14.1 for the encoding and §15.3-§15.5 for storage / query / subscription.

---

## 16. Conformance test surface

A conformance test suite — implementation of which is post-mainnet hardening work — must exercise every function in §7 and §8 with:

- Valid inputs returning expected outputs
- Each error code's trigger condition
- Each gas cost (charged before execution begins)
- Memory bounds at the WASM limits (0, 1, 64 MB - 1, 64 MB boundary)
- Each forbidden-import case at deploy time
- Determinism: run the same input on 128 simulated validators; outputs must match bit-for-bit

The conformance test suite ships in the post-pivot engine repo under `wasm-exec/tests/conformance/`. It is run as part of CI on every wasm-exec commit and as a gate on protocol upgrades that touch this spec.

---

## 17. Evolution & deprecation policy

### 17.1 Adding a new function (minor version bump)

1. PIP describing the new function: signature, semantics, gas cost, error codes, use case.
2. PIP review + acceptance per [Chapter 15 — Governance](../chapters/15-governance.md).
3. Engine implements the function under a `pyde_abi_v1_<N+1>` feature gate.
4. New function is callable only by modules declaring `pyde_abi_version >= 1.(N+1)`.
5. Modules built against earlier versions continue executing unchanged.

### 17.2 Changing existing function semantics (NOT permitted)

Existing function semantics, gas costs, and error codes are **frozen** at v1.0 mainnet. Any change requires a v2.0 major bump, which is a hard fork.

If a v1.x function is discovered to have an implementation bug that diverges from this spec, the **engine** is patched to match the spec. If a v1.x function is discovered to have a *spec* bug (the spec itself is wrong), the spec is amended, the engine is patched to match the corrected spec, and the change is documented in the [Migration Notes](../MIGRATION_NOTES.md) as a clarification (not a new function and not a major bump).

### 17.3 Reserving for v2

Functions known to be useful but requiring substantial design work (e.g., a streaming I/O abstraction, an account-abstraction policy invocation primitive, session-key authorization hooks) are *not* added to v1. They are tracked on the [Roadmap](../roadmap.md) under "Beyond V1" and ship as part of v2 when ready.

### 17.4 Per-language SDK alignment

Pyde does not ship per-language SDKs (see [PARACHAIN_DESIGN §10](./PARACHAIN_DESIGN.md)). Community-maintained Rust, AssemblyScript, Go (TinyGo), and C/C++ bindings against this spec are encouraged. Each binding library is responsible for translating this spec's WAT signatures into idiomatic language-native function declarations; the canonical example projects shipped with `otigen` demonstrate the expected wrapping for each language.

---

## 18. References

- [Chapter 3 — Execution Layer](../chapters/03-virtual-machine.md) — conceptual overview, wasmtime config, per-tx overlay model
- [Chapter 5 — Otigen Toolchain](../chapters/05-otigen-toolchain.md) — how authors declare host imports in their language of choice
- [Chapter 10 — Gas and Fee Model](../chapters/10-gas-and-fee-model.md) — fuel-to-gas mapping, EIP-1559, no-refund policy
- [Chapter 13 — Parachains](../chapters/13-cross-chain.md) — parachain framework overview
- [companion/PARACHAIN_DESIGN.md](./PARACHAIN_DESIGN.md) — full parachain design + ABI extension rationale
- [companion/PERFORMANCE_HARNESS.md](./PERFORMANCE_HARNESS.md) — gas-table calibration authority
- [companion/THREAT_MODEL.md](./THREAT_MODEL.md) — security review of every host function
- [WebAssembly Core Specification](https://webassembly.github.io/spec/) — the WASM ISA itself
- [wasmtime documentation](https://docs.wasmtime.dev/) — the runtime Pyde uses

---

**Document version:** 0.1 (draft for v1 mainnet)

**License:** See repository root
