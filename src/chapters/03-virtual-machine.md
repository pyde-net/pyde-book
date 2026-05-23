# Chapter 3: Execution Layer

Pyde's execution layer is **WebAssembly** via [wasmtime](https://wasmtime.dev), with ahead-of-time compilation through Cranelift. Smart contracts and parachains run in sandboxed wasmtime instances, interacting with the chain through a fixed set of host functions that the engine implements in Rust.

This chapter covers the runtime architecture, the host function ABI surface, how compilation and caching work, gas metering, the determinism boundary, and the performance properties of the layer.

For context on why Pyde uses WebAssembly rather than a custom virtual machine, read the preface ([The Pivot](../preface/pivot.md)).

---

## 3.1 Why WebAssembly

WebAssembly was designed to be a compilation target: a small, well-specified, sandboxed instruction set that any source language can lower into and any runtime can execute deterministically. For Pyde, this gives us four properties simultaneously, none of which a custom VM could deliver without years of additional work.

1. **Universal language support.** Authors write contracts in whatever language they already know. Rust is the primary path; AssemblyScript, Go (via TinyGo), and C/C++ (via clang's `--target=wasm32`) are first-class alternatives. The chain does not impose a language preference.

2. **Battle-tested runtime.** Wasmtime is maintained by the [Bytecode Alliance](https://bytecodealliance.org/), used in production at Fastly, Microsoft, and Shopify, continuously fuzzed under adversarial workloads, and audited as a security-critical system. Pyde inherits this hardening at zero engineering cost.

3. **Strong sandbox.** WebAssembly's linear memory model and structured control flow eliminate entire categories of vulnerabilities (buffer overflows, control-flow hijacks, type confusion). The validation step at module load rejects any malformed binary before it can run. Importing forbidden functions (network, filesystem, threads) is gated at deploy time.

4. **ZK-ready path.** Active research on zero-knowledge proving of WebAssembly execution (zk-WASM) is converging on practical provers within a multi-year horizon. Pyde's contract bytecode is positioned to benefit from this without re-tooling — when zk-WASM provers mature, they slot in as an attestation layer over execution that has already happened.

The price for these properties: a small overhead on the order of 5-15% relative to a hand-tuned custom VM on tight compute loops, vanishing entirely for storage-bound workloads where the VM is not the bottleneck. The performance section at the end of this chapter quantifies this with real numbers.

---

## 3.2 Runtime Architecture

Execution sits inside the `wasm-exec` crate of the engine workspace. The crate exposes a single `WasmExecutor` type that owns the wasmtime engine, the compiled-module cache, and the host function bindings. The transaction pipeline calls into `WasmExecutor` per invocation; the executor handles the rest.

```
┌────────────────────────────────────────────────────────────┐
│  Engine transaction pipeline                                │
│  (mempool → access-list scheduler → execution dispatch)     │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
              ┌───────────────┐
              │ WasmExecutor   │  ← single per node, owned by node
              └──────┬────────┘
                     │
       ┌─────────────┼──────────────────┐
       ▼             ▼                  ▼
  ┌─────────┐  ┌──────────┐     ┌─────────────────┐
  │ wasmtime │  │ Module    │     │ Host functions  │
  │ Engine   │  │ cache     │     │ (host_fns.rs)   │
  │ (Crane-  │  │ (per-     │     │ — sload         │
  │  lift)   │  │ contract) │     │ — sstore        │
  └─────────┘  └──────────┘     │ — transfer       │
                                  │ — emit_event    │
                                  │ — threshold_*    │
                                  │ — hash_*         │
                                  │ — cross_call    │
                                  │ — ...            │
                                  └─────────────────┘
                                            │
                                            ▼
                                  ┌─────────────────┐
                                  │ JMT state, fee  │
                                  │ accounting,     │
                                  │ event log, etc. │
                                  └─────────────────┘
```

**WasmExecutor responsibilities:**
- Hold the wasmtime `Engine` (singleton, configured at startup with deterministic feature flags).
- Cache compiled `Module`s by contract address (compile once, reuse across invocations).
- Instantiate per-invocation `Store`s with isolated linear memory and the current execution context.
- Wire host function calls through the linker.
- Track fuel consumption (gas).
- Handle trap conditions and propagate them as transaction failures.

**Engine configuration (set once at node startup):**

```rust
let mut config = wasmtime::Config::new();
config.strategy(wasmtime::Strategy::Cranelift);
config.cranelift_opt_level(wasmtime::OptLevel::Speed);
config.consume_fuel(true);
config.epoch_interruption(true);

// Determinism enforcement:
config.cranelift_nan_canonicalization(true);
config.wasm_threads(false);
config.wasm_simd(false);
config.wasm_relaxed_simd(false);
config.wasm_reference_types(false);
config.wasm_bulk_memory(true);  // safe, deterministic, useful
config.wasm_multi_memory(false);
config.wasm_memory64(false);
config.wasm_function_references(false);
config.wasm_gc(false);
config.wasm_component_model(false);
// (No WASI imports allowed; not enabled at all.)
```

This config produces deterministic execution suitable for consensus: every validator running the same module on the same input produces bit-identical state changes and identical fuel consumption.

---

## 3.3 The Host Function ABI

Smart contracts cannot directly access state, signatures, or anything outside their sandbox. They reach the chain through **host functions** — Rust functions registered with wasmtime's linker that contracts call by name. The full set of host functions is the **Host Function ABI**, versioned and documented separately in the upcoming Host Function ABI specification (the spec doc is one of the next design-stage deliverables; see the [Roadmap](../roadmap.md)).

This section gives the conceptual surface; the spec gives the binary signatures.

**Storage:**
- `sload(slot_hash) -> value` — read a 32-byte slot.
- `sstore(slot_hash, value)` — write a 32-byte slot. Costs increase for new slot allocations.
- `sdelete(slot_hash)` — explicitly delete a slot (lower cost than `sstore`; no refund in v1, per Chapter 10).

**Balances and transfers:**
- `balance(addr) -> u128` — read an account's PYDE balance.
- `transfer(to_addr, amount)` — move PYDE from the caller to `to_addr`. Fails if insufficient balance.

**Execution context:**
- `caller() -> addr` — the address that invoked the current call.
- `origin() -> addr` — the externally-owned address that initiated the transaction. (Deliberately distinct from `caller()` to avoid the `tx.origin` footgun from Ethereum.)
- `block_height() -> u64`, `wave_id() -> u64`, `block_timestamp() -> u64`.
- `chain_id() -> u64`.

**Events:**
- `emit_event(topic, data)` — append to the transaction's event log. Topics are queryable; data is opaque bytes.

**Hashing primitives:**
- `keccak256(input) -> hash32` — for compatibility with cross-chain interfaces.
- `blake3(input) -> hash32` — fast general-purpose hashing.
- `poseidon2(input) -> hash32` — ZK-friendly hashing (used in state commitments).

**Post-quantum cryptography:**
- `threshold_encrypt(plaintext, committee_pubkey) -> ciphertext` — encrypt a payload under the current committee's threshold key.
- `threshold_decrypt_share(ciphertext) -> share` — produce a decryption share (validator-only, gated).
- `falcon_verify(pubkey, message, signature) -> bool` — verify a FALCON-512 signature.

**Cross-contract / cross-parachain:**
- `cross_call(target_addr, function_id, args, callback_spec, max_gas)` — invoke another contract or parachain.

**Gas:**
- `consume_gas(amount)` — explicit metering for operations the runtime cannot price automatically (used by binding generators for collection-traversal patterns).

**Forbidden by design:**
- Network calls (any kind).
- Filesystem access.
- System clock (use `block_timestamp` instead — deterministic).
- Non-deterministic entropy (use a VRF-based host function when randomness is needed).
- Direct RocksDB access (everything routes through `sload`/`sstore`).

The deploy-time validator rejects any WASM module whose import section references functions outside this allowlist. Hard-enforced.

---

## 3.4 Compilation and Caching

The wasmtime engine compiles WebAssembly bytecode to native machine code via Cranelift. Compilation is expensive (tens to hundreds of milliseconds per contract); execution after compilation is fast. The cache strategy makes this acceptable.

**Compilation lifecycle:**

```
Deploy time
  │
  ├─ Wasm bytes submitted with deploy transaction
  ├─ Engine validates bytes (wasmtime::Module::validate)
  ├─ Engine rejects forbidden imports
  ├─ Engine compiles bytes via Cranelift → Module
  ├─ Engine serializes Module to bytes (Module::serialize)
  ├─ Engine stores both source bytes AND serialized Module in state
  └─ Contract is live

Subsequent invocations
  │
  ├─ Engine looks up contract address in module cache
  │     ├─ Hit: use cached Module immediately
  │     └─ Miss: read serialized Module from state, deserialize, cache it
  ├─ Engine creates per-invocation Store with execution context
  ├─ Engine instantiates Module against Store (sub-millisecond)
  └─ Engine calls the entry function
```

**Cache properties:**
- In-memory cache keyed by contract address.
- LRU-style eviction with a configurable size budget (default ~256 modules resident).
- Serialized modules persist on disk so cold validators warm quickly.
- On contract upgrade, the cache entry is invalidated; the new module is compiled and cached on next use.

**Per-contract compilation cost (measured on commodity hardware against PVM-era proxies; WASM-era numbers to be re-measured):**
- A simple contract (~100 instructions): ~10ms.
- A medium contract (~1000 instructions): ~50-100ms.
- A large contract (~10000 instructions): ~500ms-1s.

These costs are paid once per contract per node restart, then amortized across all subsequent invocations.

---

## 3.5 Gas Metering

Pyde uses wasmtime's **fuel** mechanism for gas accounting. Fuel is a per-execution budget; every WebAssembly instruction consumes a configurable amount of fuel, and execution traps when fuel reaches zero. Host function calls also consume fuel manually (charged by the host based on operation cost — `sstore` is heavier than `add`, for example).

**Gas-to-fuel mapping:**
At node startup, the engine establishes a deterministic mapping from gas units (the chain-level metering unit) to wasmtime fuel units. The mapping accounts for:
- Per-instruction baseline cost (each WASM instruction costs a fixed amount of fuel).
- Per-host-function cost (specific to each host function, defined in the ABI gas table).
- Per-byte storage costs (`sload` reads, `sstore` writes, allocation surcharge for new slots).
- Per-byte event emission cost.

A transaction declares its gas budget at submission; the engine converts that to fuel and runs the contract with that fuel limit. The fuel actually consumed is converted back to gas for the transaction receipt.

**Why fuel and not opcode-counting:**
Fuel is built into wasmtime's Cranelift backend. Every basic block is instrumented to decrement a fuel counter; when the counter goes negative, execution traps with an out-of-fuel error. The instrumentation is efficient enough not to dominate execution time. Implementing custom opcode-counting on top of wasmtime would be slower and add maintenance burden for no functional gain.

**Charging model — no refunds in v1:**
The ingress check confirms `balance ≥ gas_limit × base_fee`, but only `gas_used × base_fee` is actually debited at execution time. Unused fuel costs the sender nothing — it is never debited and therefore never refunded. Pyde v1 has no operation-level gas refunds either (no `sstore_refund`, no `sdelete` refund). See [Chapter 10 §10.1](./10-gas-and-fee-model.md) for the full charging pipeline and the EIP-3529 reasoning.

---

## 3.5b Per-Transaction Execution Isolation

Every transaction executes against an **overlay** layered on top of the shared DashMap state cache. The overlay isolates the tx's writes so a revert can throw them away without affecting other txs in the same wave.

```text
Per-tx state isolation:

  Before tx execution:
    tx_overlay: HashMap<SlotHash, Vec<u8>> = empty

  During execution:
    Reads:  
      1. check tx_overlay  (any writes this tx made)
      2. check dashmap     (prior committed-in-this-wave writes from other txs)
      3. check state_cf    (current persistent state on disk)
    Writes:
      go into tx_overlay only (not dashmap yet)

  On successful completion:
    merge tx_overlay into dashmap (marking entries Dirty)
    generate success receipt
    drop tx_overlay (memory freed)

  On trap (revert):
    discard tx_overlay entirely
    state unchanged in dashmap
    generate revert receipt with reason
    sender still pays gas_used × base_fee (see Chapter 10)
```

**Why no separate undo log:** failed writes never landed in shared state. Dropping the overlay throws them away. Simpler than journaled undo.

**Nested cross-calls:** when tx A calls contract B which calls contract C, each call gets its own overlay layered on top:

```text
A's overlay
  ↓
B's overlay (reads check B's overlay first, then A's, then dashmap, then state_cf)
  ↓
C's overlay (reads check C's, then B's, then A's, then dashmap, then state_cf)

Inner call succeeds → merge inner overlay into parent overlay
Inner call traps    → drop inner overlay; parent continues
Outer tx traps      → drop outer overlay (including all merged inner state)
```

This is standard transactional-memory layering. wasmtime's host functions are aware of the active overlay and route reads/writes through it.

### Memory bounds on the overlay

The overlay can grow during a tx, but is bounded by two factors:

1. **Gas budget.** Every write into the overlay charges fuel via `sstore`. A tx with `gas_limit = 10_000_000` can write at most ~50K slots (varying by slot size). Author can't write infinitely without paying.

2. **Linear memory cap.** wasmtime's per-instance linear memory is capped (64MB default, configurable per chain release). Even if gas were infinite, the WASM module can't allocate beyond this cap.

Together: a tx can use up to (gas_limit / sstore_cost) × value_size of overlay memory, but capped by linear memory. We don't impose a separate "tx overlay memory cap" — gas + wasmtime config bound it.

---

## 3.6 The Determinism Boundary

For consensus to hold, every validator must produce bit-identical state changes when executing the same transaction. This requires deterministic execution at every layer.

**Deterministic-by-default in WebAssembly:**
- Integer arithmetic (well-specified, no platform-dependent behavior).
- Memory operations (bounds-checked, no undefined behavior).
- Control flow (structured, no goto, no jump tables that vary by platform).

**Determinism risks WebAssembly admits, which we disable:**
- Floating-point: most operations are deterministic by IEEE-754, but NaN bit patterns can vary. We enable `cranelift_nan_canonicalization` so NaN outputs are canonicalized identically across all validators.
- Threads: non-deterministic by definition; we disable the threads proposal.
- SIMD: most SIMD is deterministic, but certain operations (relaxed SIMD) are not. We disable both the SIMD and relaxed-SIMD proposals for now; we may re-enable a deterministic-only SIMD subset in a future version.
- Reference types, GC, function references, component model: complexity surface we don't need yet, disabled.

**Determinism risks the runtime introduces, which we control:**
- Module compilation may produce different machine code on different platforms (different architectures, different Cranelift versions). We pin the wasmtime version per chain release and require validators to upgrade in coordinated forks. Cached serialized modules are not portable across versions.
- Fuel consumption per host function is defined in the gas table, identical across validators.

**What contracts cannot observe:**
- Wall-clock time. Use `block_timestamp` (deterministic, set by consensus).
- True randomness. Use a VRF-derived host function when randomness is required (deterministic per block, unpredictable beforehand).
- The host machine. No CPU info, no OS info, no environment access.

**Deploy-time validation:**
Every contract's WASM is validated at deploy time against the determinism rules. Any module that imports a forbidden function, uses a disabled feature, or fails wasmtime's structural validator is rejected. The validation gate is non-negotiable — it prevents bad code from ever reaching consensus.

---

## 3.7 State Access from the Author's Perspective

Host functions are low-level: they take pointers + lengths into WASM linear memory and return raw bytes. Contract authors write the slot derivation themselves in their source language, following the PIP-2 slot layout described in [Chapter 4: State Model](./04-state-model.md). The `otigen` toolchain does NOT generate code; authors write a small helper module (or copy one from a canonical example) that turns ergonomic API calls into the right `pyde_storage_read` / `pyde_storage_write` host calls.

The pattern (in Rust):

```rust
// Author writes (or copies from the canonical example):

// 1. Host function imports (one-time declaration):
extern "C" {
    fn pyde_storage_read(slot_hash_ptr: *const u8, slot_hash_len: usize) -> i64;
    fn pyde_storage_write(slot_hash_ptr: *const u8, slot_hash_len: usize, value_ptr: *const u8, value_len: usize);
    fn pyde_poseidon2(input_ptr: *const u8, input_len: usize, out_ptr: *mut u8);
}

// 2. Contract-name prefix, derived once at startup:
//    (Rust patterns include lazy_static!, OnceCell, const fn — author's choice.)
fn contract_addr_prefix() -> &'static [u8; 16] { /* ... */ }

// 3. Discriminator constants from otigen.toml [state] section:
const BALANCE_DISC: u8 = 0;       // matches [state] balance.disc

// 4. Slot derivation following PIP-2 layout (address[..16] || hash(disc||key)[..16]):
fn balance_slot(addr: &[u8; 32]) -> [u8; 32] {
    let mut slot = [0u8; 32];
    slot[..16].copy_from_slice(contract_addr_prefix());
    let mut input = [0u8; 33];
    input[0] = BALANCE_DISC;
    input[1..].copy_from_slice(addr);
    let mut inner = [0u8; 32];
    unsafe { pyde_poseidon2(input.as_ptr(), input.len(), inner.as_mut_ptr()); }
    slot[16..].copy_from_slice(&inner[..16]);
    slot
}

// 5. Ergonomic accessor (author writes this small wrapper):
fn read_balance(addr: &[u8; 32]) -> u128 {
    let slot = balance_slot(addr);
    let mut value = [0u8; 32];
    unsafe { /* call pyde_storage_read, copy into value */ }
    u128::from_le_bytes(value[..16].try_into().unwrap())
}
```

**Where the hashing happens:**

- The **contract-name prefix** (`contract_addr_prefix()`) is computed **once** at startup using whatever caching pattern the author's language provides. Rust authors use `OnceCell` / `lazy_static!` / a `const fn` if possible. AssemblyScript uses a module-level constant initializer. Go uses `init()`. C uses a `static const` array initialized at first call. After the first computation, it's free.
- The **discriminator** (`BALANCE_DISC = 0`) is a compile-time constant — never re-hashed.
- The **dynamic part** (the `addr` argument) is hashed at runtime — one `pyde_poseidon2` call per slot reference. That's the irreducible cost.

This is the same end-state as if `otigen` were generating bindings — same hash count at runtime, same memory layout, same gas profile. The difference: the author owns the code, can inspect it, can audit it, can replace pieces with optimized hot-path versions, and isn't dependent on a chain-team-maintained code generator. The canonical example projects in `pyde-net/otigen` ship one workable pattern per supported language as a starting point.

The same pattern adapts to AssemblyScript, Go (TinyGo), and C/C++ — each language has its own idioms for module-level constants, lazy initialization, and FFI to host functions. See `pyde-net/otigen/examples/` for a working version in each language.

---

---

## 3.8 Performance Characteristics

The honest numbers, measured against PVM-era proxies (WASM-era numbers will replace these as benchmarks are re-run):

**Compute-bound workloads (tight ALU loops):**
- Wasmtime AOT runs within roughly 80-95% of native code on most workloads. Measured benchmarks on PVM-era code showed AOT throughput around 2.9 billion instructions per second for ALU dispatch; wasmtime-AOT sits in the same range because both use the same Cranelift backend.
- Interpreted execution (cold cache, no AOT yet) runs at roughly 10-30% of native. Pyde's WASM interpreter path is similar in throughput to the previous PVM interpreter measured at ~279 million instructions per second.

**Storage-bound workloads (typical real-world smart contracts):**
- The AOT-vs-interpreter advantage collapses. Token transfers measured around 231K tps interpreted and 243K tps AOT — essentially identical, because RocksDB IO dominates and neither the interpreter nor the AOT can speed it up.
- This is the workload shape that actually determines blockchain throughput. The VM choice barely affects it.

**Module compilation:**
- Sub-millisecond for small contracts.
- ~1 second for the largest realistic contracts.
- Paid once per contract per node startup, then cached forever.

**End-to-end TPS:**
The realistic v1 target on commodity validator hardware is **10,000-30,000 plaintext TPS** sustained, **500-2,000 encrypted TPS**. These numbers come from the full-chain performance harness (consensus + execution + state + network), not from VM microbenchmarks alone. The VM is approximately the fifth-most-important contributor to that number, behind signature verification, network bandwidth, consensus latency, and disk I/O.

The "claim 1/3 of measured peak" discipline applies: published TPS numbers are derived conservatively from sustained measurement under realistic conditions, never from microbenchmark peaks.

---

## 3.9 Failure Modes and Traps

When a contract execution fails, it traps. The transaction reverts, no state changes persist, the sender pays gas up to the trap point.

**Trap conditions:**
- **Out of fuel** — exceeded the transaction's gas budget.
- **Out of bounds** — WASM linear memory access outside allocated range.
- **Integer overflow** (when checked arithmetic is requested by host function gating).
- **Forbidden import attempt** — caught at deploy, not at runtime; deploy fails instead.
- **Stack overflow** — wasmtime's configurable stack limit reached.
- **Unreachable** — the WebAssembly `unreachable` instruction was executed (typically Rust's `panic!()` lowers to this).
- **Host function error** — `sstore` to a write-locked slot, `transfer` with insufficient balance, etc.

**Engine-level protections:**
- Per-call wall-clock timeout (epoch interruption). Prevents a buggy contract from spinning forever even if fuel accounting is somehow bypassed.
- Per-call linear memory limit (capped well below host memory).
- Per-call stack depth limit.

Trap conditions are reported in transaction receipts as structured error codes, queryable by clients.

---

## 3.9b Native Transactions vs WASM Calls

Not every transaction invokes wasmtime. Pyde has a small set of **native transaction types** that the engine executes directly, without WASM overhead.

### Native tx types (no wasmtime invocation)

```text
- Transfer        — move PYDE between two accounts; ~21,000 gas; engine handles balance update directly
- ValidatorRegister — stake-account-binding system tx
- ValidatorUnbond  — initiate unbonding
- ValidatorRotateKey — FALCON key rotation
- ValidatorUnjail   — exit jailed state after grace period
- Multisig          — treasury / governance multisig spend
- Slashing          — system-emitted from evidence
```

These all bypass wasmtime and execute as Rust code in the engine. They're cheaper, faster, and don't carry the per-tx WASM instantiation cost.

### WASM tx types (wasmtime executes)

```text
- ContractCall    — invoke a function on a deployed WASM contract
- ContractDeploy  — register new WASM bytes + ABI as a contract
- ParachainCall   — invoke a function on a deployed parachain WASM (cross-call routing)
```

These instantiate the target module via wasmtime, call the entry function, execute under the per-tx overlay, and produce a receipt.

### Why split this way

- **Performance.** Simple transfers don't need a sandbox or fuel metering — they're trivially provable state updates.
- **Gas predictability.** Native transfers have a fixed gas cost (~21K) known in advance; no fuel-counting needed.
- **Common-case optimization.** Simple value transfers are the most common tx type on any chain. Avoiding WASM overhead per-transfer materially improves end-to-end TPS for high-volume payment workloads.

WASM contracts that need to move value internally still call `pyde_transfer` as a host function, which does the same balance-update logic the native transfer does. Authors don't have to choose; the chain serves both paths.

---

## 3.10 Contract Lifecycle

```
Author writes contract → otigen build → .wasm + ABI
       │
       ▼
Author runs otigen deploy
       │
       ├─ Pays registration fee for name (ENS-style, see Account Model chapter)
       ├─ Pays owner deposit (forfeit on misbehavior)
       └─ Submits deploy tx with .wasm bytes
              │
              ▼
       Engine validates module (validator, deterministic-features gate, import allowlist)
              │
              ▼
       Engine compiles via Cranelift, caches serialized module
              │
              ▼
       Engine writes (contract_address → wasm_hash, serialized_module, owner, deposit) to state
              │
              ▼
       Contract is live; callable by anyone holding its address or name
```

Upgrade path mirrors deploy but routes through governance for parachain contracts. Smart contracts (non-parachain) follow a simpler owner-only upgrade flow with grace periods to give users time to verify the new code.

---

## 3.11 Where the Code Lives

The WASM execution layer is implemented post-pivot in a fresh `engine` workspace that does not exist yet. The pre-pivot `pvm` and `aot` crates are preserved in [`pyde-net/archive`](https://github.com/pyde-net/archive) for historical reference and bench comparison. The table below names the components and their planned crate layout once the fresh engine repo is cut.

| Component | Planned crate / file (post-pivot) |
|-----------|-----------------------------------|
| WasmExecutor entry point | `wasm-exec/src/lib.rs` |
| Host function implementations | `wasm-exec/src/host_fns.rs` |
| Module cache | `wasm-exec/src/module_cache.rs` |
| Fuel-to-gas mapping | `wasm-exec/src/gas_meter.rs` |
| Validation gate | `wasm-exec/src/validate.rs` |
| Deploy-tx processing | `tx/src/deploy.rs` |
| State binding code generators (per language) | `otigen` repo (`otigen/crates/codegen-*`) |
| Host Function ABI specification | [`companion/HOST_FN_ABI_SPEC.md`](../companion/) — to be written; tracked on the roadmap |

---

## 3.12 Open Questions

These are tracked in the roadmap and resolved as the execution layer matures:

- **Re-enabling deterministic SIMD.** Pyde currently disables SIMD entirely. A deterministic SIMD subset (excluding relaxed operations) would benefit crypto-heavy contracts. Pending implementation work and conservative validation.
- **WASM module hash-content-addressing.** Two contracts with identical WASM bytes could share a single compiled module entry. Optimization opportunity; not blocking.
- **zk-WASM proving integration.** When zk-WASM provers reach production quality, slot one in as an optional execution attestation layer. Tracked as a v2/v3 direction in the roadmap.
- **Hot-reload of compiled modules across version pins.** Currently a wasmtime version bump invalidates the cache; coordinated upgrades are required. Hot-reload research may relax this.

---

## 3.13 Reading on

- [Chapter 4: State Model](./04-state-model.md) — how `sload` and `sstore` reach the JMT.
- [Chapter 5: Otigen Toolchain](./05-otigen-toolchain.md) — how authors interact with the execution layer through the developer tool.
- [Chapter 6: Consensus](./06-consensus.md) — how execution outcomes commit to the chain.
- [Chapter 8: Cryptography](./08-cryptography.md) — what FALCON, Kyber, and Poseidon2 actually do, and how the host functions expose them.
- [Preface: The Pivot](../preface/pivot.md) — why the execution layer is WebAssembly rather than a custom VM.
