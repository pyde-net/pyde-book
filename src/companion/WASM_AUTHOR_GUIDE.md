# WASM Contract Author Guide

**Version:** v1.0 (draft)
**Status:** Companion to [HOST_FN_ABI_SPEC.md](./HOST_FN_ABI_SPEC.md). Pedagogical / authoring reference. Non-normative — when this guide and the ABI spec disagree, the spec wins.

> **Applies equally to smart contracts and parachains.** This guide describes the WASM-level patterns a Pyde author must understand to write any on-chain code. The same patterns apply identically to:
>
> - Base-chain smart contracts deployed via `otigen` (`type = "contract"`)
> - Parachain modules deployed via `otigen` (`type = "parachain"`)
>
> Parachains are simply WASM modules with an *extended* host-function allowlist (see [PARACHAIN_DESIGN.md §11](./PARACHAIN_DESIGN.md) and [HOST_FN_ABI_SPEC §8](./HOST_FN_ABI_SPEC.md)). The boundary mechanics — value types, linear memory, pointer + length conventions, byte staging, host-side reads — are identical in both contexts.

---

## Why this guide exists

Pyde does not ship a maintained per-language SDK. The contract surface is a WASM ABI plus a bundling CLI (`otigen`) plus canonical examples — nothing more. Authors compile their own WASM in any `wasm32`-target language, declare host imports manually, and stage bytes into linear memory themselves.

That design keeps the chain's surface minimal and audit-friendly, but it pushes more responsibility onto the author. This guide is the conceptual bridge between the formal [HOST_FN_ABI_SPEC](./HOST_FN_ABI_SPEC.md) (which is normative but terse) and the working code in [`otigen/examples/`](https://github.com/pyde-net/otigen/tree/main/examples).

If you only read one section: §5 (host-fn declarations), §7 (field-keyed storage), §8 (cross-contract calls), §9 (FALCON-512 verification), and §10 (upgradeable proxy pattern) cover 90% of the patterns a real contract needs.

---

## 1. The WASM type model

### 1.1 Value types at the function boundary

The WebAssembly core specification defines exactly five value types that can appear in function signatures crossing the WASM module boundary:

| WASM value type | Bits | What it represents |
|---|---|---|
| `i32` | 32 | Signed or unsigned 32-bit integer. **Also serves as the type for linear-memory pointers** since Pyde uses the `wasm32` address space. |
| `i64` | 64 | Signed or unsigned 64-bit integer. Used for gas budgets, timestamps, block heights, the low/high halves of `u128`. |
| `f32` | 32 | IEEE-754 single-precision float. *Discouraged in contracts* — floating-point determinism across NaN encodings is fragile. |
| `f64` | 64 | IEEE-754 double-precision float. *Discouraged in contracts* — same caveat. |
| `v128` | 128 | SIMD vector. **Disabled in Pyde** (`config.wasm_simd(false)` per [Chapter 3 §3.2](../chapters/03-virtual-machine.md)). |

That is the entire universe of types that can appear in the parameter list or return position of a function crossing the host ⇄ contract boundary. There are also reference types (`externref`, `funcref`) in the WASM spec, but they are also disabled in Pyde for the same determinism / footprint reasons SIMD is disabled.

**Practical implication:** any time you want to pass a 32-byte address, a 16-byte `u128` balance, a string, a struct, or a variable-length blob across the boundary, you decompose it into the four primitives + pointer-into-linear-memory patterns described in §4.

### 1.2 Internal types (Rust / Go / AS) are unrestricted

Inside the body of a function, between the open and close braces, the WASM-primitive restriction does **not** apply. The compiler is free to use whatever the source language supports:

```rust
// EXPORT — the function signature crosses the boundary, so each parameter
// and the return type must be a WASM primitive.
#[no_mangle]
pub extern "C" fn example_export() -> i64 {

    // INSIDE the function body — arbitrary Rust. The compiler will lower
    // these to WASM stack manipulation, linear-memory loads/stores, and
    // arithmetic instructions. Nothing crosses the module boundary here.
    let nums: [u128; 10] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    let sum: u128 = nums.iter().sum();

    // Narrow back to a WASM primitive at the return site.
    sum as i64
}
```

The same holds for AssemblyScript (classes, arrays, strings — all fine internally), TinyGo (structs, slices, maps — all fine internally), and C (structs, unions, function pointers — all fine internally). The only constraint is on the surface that the WASM runtime sees.

### 1.3 Why the restriction exists

The WASM core specification is intentionally minimal. It exists to be a portable, sandboxed, verifiable bytecode format. Every type at the boundary adds complexity to:

- The validator (must check well-formedness)
- The compiler backend (must lower the type to native code deterministically)
- The host (must marshal the type across the FFI)

By restricting boundary types to a tiny set of primitives, WASM keeps the runtime and the toolchain attack surface narrow. Anything richer — structs, lists, strings — is built on top of pointers + lengths, which the chain can audit byte-by-byte rather than trusting a typed serialization layer.

---

## 2. `std` vs `no_std` (Rust-specific)

A common confusion: the WASM-primitives restriction is **separate from** the question of whether the standard library is available. Different layers, different concerns.

### 2.1 The three Rust WASM targets

| Target triple | std available? | Why |
|---|---|---|
| `wasm32-unknown-unknown` | **No** | No operating system to host std's syscalls. Pyde uses this target. |
| `wasm32-wasip1` | Yes | The WebAssembly System Interface provides an OS-shaped syscall ABI; std maps `std::fs`, `std::time`, `std::net`, etc. onto WASI imports. |
| `wasm32-unknown-emscripten` | Yes | Emscripten provides a JavaScript-hosted faux-OS; std maps onto emscripten's runtime. |

Pyde's wasmtime configuration explicitly does not enable any WASI snapshot (`// (No WASI imports allowed; not enabled at all.)` — see Chapter 3 §3.2 of the book), so even a `wasm32-wasip1`-compiled binary's WASI imports would be rejected at deploy time by the import allowlist check.

### 2.2 Why Pyde uses `wasm32-unknown-unknown`

Three reasons, in descending order of importance:

1. **Determinism.** `std::time::SystemTime::now()` returns the wall clock — a value that differs across the 128 validators executing the same transaction. Threading primitives (`std::sync::Mutex`, `std::thread`) introduce scheduling non-determinism. The chain would halt the moment two validators diverged on `now()`. The import allowlist (HOST_FN_ABI_SPEC §3.1) enforces this by rejecting `wasi:*` imports at deploy time.

2. **Audit surface.** A trivial `no_std` contract compiles to ~5 KB of WASM. The same contract with std drags in ~150–250 KB of runtime initialization code. Every byte costs gas to deploy + adds attack surface to audit.

3. **Sandbox cleanliness.** WASI's API surface (filesystem, network, environment, clocks) is exactly what a contract should *not* be able to touch. Even if individual imports were filtered, leaving the std-on-WASI scaffolding in place encourages authors to write code that would be portable to non-blockchain hosts — which is the wrong mental model for a contract.

### 2.3 What you actually have in a `no_std` contract

```rust
//! A canonical no_std contract module preamble.

// (a) — Disable the standard library. This is REQUIRED for wasm32-unknown-unknown
//       since std is not built for that target.
#![no_std]

// (b) — You still get `core`, which is std minus the OS-dependent parts.
//       `core::convert`, `core::mem`, `core::option::Option`, `core::result::Result`,
//       `core::cmp`, slices, arrays, integers, floats, traits, generics — all here.
use core::convert::TryFrom;
use core::mem;

// (c) — Optionally pull in `alloc` if you want heap-allocated types like
//       Vec, Box, String, BTreeMap. `alloc` is part of the Rust standard
//       distribution but is split out from `std` precisely so no_std
//       targets can use it without dragging in the OS scaffolding.
//
//       Requires you to wire a GLOBAL ALLOCATOR (see (d)).
extern crate alloc;
use alloc::vec::Vec;
use alloc::string::String;

// (d) — Provide a global allocator. The chain doesn't care which one;
//       common choices for size-conscious contracts:
//         - `dlmalloc-rs` (~12 KB, full malloc/free semantics)
//         - `wee_alloc`   (~1 KB, smallest, slowest)
//         - `talc`        (~3 KB, modern dlmalloc alternative)
//       If you skip this, `alloc::*` types are compile errors. That's
//       fine if you never allocate (counter-token uses static slot
//       buffers and stack-allocated calldata only).
#[global_allocator]
static ALLOCATOR: dlmalloc::GlobalDlmalloc = dlmalloc::GlobalDlmalloc;

// (e) — Define a panic handler. wasm32-unknown-unknown has no default;
//       you MUST provide one or the linker rejects the build.
//
//       For a contract, "panic" should be "trap and revert" — the chain's
//       per-tx overlay handles state rollback automatically.
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    // Trap the WASM execution. The engine catches the trap and converts
    // it into a transaction revert with rollback of the per-tx overlay.
    core::arch::wasm32::unreachable()
}
```

### 2.4 What you do NOT have

```rust
// All of the following are COMPILE ERRORS in a wasm32-unknown-unknown contract:

use std::fs::File;                          // no filesystem
use std::time::SystemTime;                  // no clock
use std::net::TcpStream;                    // no network
use std::thread;                            // no threading
use std::sync::Mutex;                       // would compile (it's a no_std-able
                                            //   primitive in core/alloc) but
                                            //   the std re-export is gone

println!("...");                            // no stdout
eprintln!("...");                           // no stderr
```

You can implement contract-side logging by emitting an event via `pyde::emit_event` (see HOST_FN_ABI_SPEC §7.5), which writes to the transaction receipt log. That is the contract-author equivalent of `println!`.

---

## 3. Linear memory model

### 3.1 The 64 MB sandbox

Every contract instance has its own **linear memory** — a contiguous, byte-addressable region that starts at offset 0 and grows in 64 KB *pages* up to a hard cap of **64 MB** (1024 pages, per [Chapter 3 §3.5b](../chapters/03-virtual-machine.md)).

```
  Linear memory layout (conceptual):

   offset 0                                        offset 64 MB (max)
   ┌──────────────────────────────────────────────────────────────┐
   │ data segments │ stack │ heap (if allocator)  │ free          │
   │ (constants)   │       │                      │               │
   └──────────────────────────────────────────────────────────────┘
       grows ↓        ↑                  ↑              ↓
       at compile    stack pointer       allocator      grow on demand
       time          decreases on        bump pointer
                     function call
```

- **Data segments** at the bottom hold compile-time constants (string literals, static `[u8; 32]` arrays). Read-only by convention; the language compiler emits initialization instructions that the wasmtime engine runs once at instantiation.
- **Stack** grows downward from a fixed offset chosen by the linker. Function locals + small fixed-size arrays live here.
- **Heap** is only present if your contract instantiates a global allocator. Vec / Box / String allocations carve from here.

### 3.2 WASM ⇄ host is NOT shared memory

This is the single most important mental model to internalize:

> The host (engine) and the contract (WASM instance) live in **separate address spaces**. When the contract passes a "pointer" to a host function, it is passing a **32-bit offset into its own linear memory** — a number, not a memory address the host can dereference.

When the host needs to *read* what the contract wrote, it goes through the wasmtime `Memory` API, which performs an **explicit byte copy** from the contract's linear memory into the host's regular Rust heap:

```rust
// Host-side: this is real memcpy, not a pointer dereference.
let mut buf = [0u8; 32];
memory.read(&caller, offset as usize, &mut buf)?;
```

When the host wants to *write* into the contract's linear memory (e.g., return data, sload result), it goes the other way:

```rust
// Host-side: also real memcpy.
memory.write(&mut caller, offset as usize, &data)?;
```

The implications:
1. There is **no zero-copy shared buffer** between contract and host.
2. Every byte that crosses the boundary in either direction is **metered** — the per-byte gas costs in the ABI table (e.g., `+ 8 per byte of calldata` for `cross_call`) are paying for these copies plus any host-side processing.
3. The contract's linear memory is **opaque to the engine outside of explicit `memory.read` / `memory.write` calls**. Host functions cannot inspect contract state by reaching into linear memory uninvited.
4. The sandbox is enforced: `memory.read` / `memory.write` perform a bounds check against the current memory size. Out-of-bounds access traps with `MemoryOutOfBounds` (HOST_FN_ABI_SPEC §3.4). Contracts cannot escape the sandbox via crafted offsets.

### 3.3 Memory ownership and lifetimes

A contract's linear memory is **owned by the wasmtime Store** that wraps the contract's instance. The Store lives for the duration of a single transaction (or sub-call within a transaction). At the end of that scope:

- Stack and heap are torn down (the Store is dropped).
- Anything the contract wrote to linear memory is gone — unless the contract explicitly called `sstore` to persist a byte to the chain's state.

So passing a pointer to a host function works only because the host **synchronously copies the bytes out** before the WASM call frame is destroyed. There is no facility for the host to retain a contract-side pointer across calls.

---

## 4. Pointer + length conventions

Pyde's host functions follow four pointer-shape conventions, summarized in HOST_FN_ABI_SPEC §3.2 and reproduced here with worked examples.

### 4.1 Fixed-size input (`ptr: i32`)

When a parameter has a fixed size known to both contract and host (e.g., a 32-byte address), only the pointer is passed. The length is implicit in the function's contract.

```text
pyde::balance(account_ptr: i32, balance_out_ptr: i32) -> i32
                ────────────────                ─────
                 reads 32 bytes                 writes 16 bytes
                 from contract's                into contract's
                 linear memory                  linear memory
```

Used for: 32-byte addresses, 32-byte hashes, 16-byte `u128` values.

### 4.2 Variable-length input (`ptr: i32, len: i32`)

When a parameter has variable size (e.g., calldata, a function name, an event payload), both the pointer and the length are passed.

```text
pyde::emit_event(
    topics_ptr: i32, n_topics: i32,           ; n_topics × 32 bytes
    data_ptr: i32, data_len: i32              ; data_len bytes
) -> i32
```

### 4.3 Fixed-size output (`out_ptr: i32`)

When a host function returns fixed-size data (e.g., the 32 bytes of `caller()`), the caller pre-allocates the buffer and passes its offset. The host writes exactly the documented number of bytes.

```text
pyde::caller(out_ptr: i32) -> i32             ; host writes 32 bytes at out_ptr
```

### 4.4 Variable-size output (`out_ptr: i32, out_len_ptr: i32`)

When the return data's size is not known in advance, the caller passes both:
- An output buffer (whatever size it deems sufficient).
- A pointer to an `i32` location where the host writes the actual length used.

```text
pyde::calldata_copy(
    dst_ptr: i32, dst_capacity: i32,          ; caller's buffer + its capacity
    src_offset: i32, copy_len: i32            ; what to read from calldata
) -> i32                                       ; host returns actual bytes copied
```

If the host's data exceeds the caller's capacity, the spec defines the behavior per host fn (usually `ERR_BUFFER_TOO_SMALL` with the `out_len_ptr` set to the required size, so the caller can re-call with a larger buffer).

### 4.5 Byte order: always little-endian

All multi-byte integers crossing the boundary are **little-endian**, matching the WASM linear-memory native byte order (HOST_FN_ABI_SPEC §3.2). This applies to:

- The 16 bytes of a `u128` value
- The 8 bytes of a `u64` block height or timestamp
- The 4 bytes of an `i32` length written via `out_len_ptr`

Big-endian encoding would require the host to byte-swap on every read/write — wasted cycles for no portability benefit, since the only consumer is the wasmtime instance that already speaks little-endian.

### 4.6 Sizes summary

| Type | Bytes | Encoding |
|---|---|---|
| Address | 32 | Raw bytes (Poseidon2 output is canonical) |
| Slot hash | 32 | Raw bytes |
| Hash output (Blake3, Poseidon2, Keccak256) | 32 | Raw bytes |
| `u128` (balance, value, amount) | 16 | Little-endian |
| `u64` (block height, wave id, chain id, timestamp) | 8 | Little-endian |
| `u32` (gas, length, counter) | 4 | Little-endian |

---

## 5. Declaring host function imports (per language)

A "host function import" is the contract telling the WASM runtime: *"I want to call a function named `foo` from module `pyde`; here is the signature I expect it to have."* The toolchain emits a WASM `(import "pyde" "foo" (func ...))` declaration. At instantiation time, wasmtime binds each import to the Rust function the host registered with the linker. If the contract declares an import the host doesn't recognize, instantiation fails and the deploy is rejected.

### 5.1 Rust

```rust
// Tell the Rust compiler that the FFI function `sload` is provided by the
// WASM import module named "pyde". When the contract is compiled to WASM,
// this becomes a `(import "pyde" "sload" (func ...))` declaration in the
// resulting binary.
#[link(wasm_import_module = "pyde")]

// `extern "C"` selects the C ABI for the function. On wasm32-unknown-unknown,
// the C ABI is essentially the WASM ABI — primitives go through directly,
// pointers are i32, no name mangling. This is what we want for host fn imports.
extern "C" {
    // `sload` reads a 32-byte slot from contract storage.
    //
    //   slot_ptr      — i32 offset in linear memory pointing to 32 bytes
    //                   representing the slot hash to read.
    //   value_out_ptr — i32 offset in linear memory where the host writes
    //                   the 32-byte slot value on success.
    //
    // Returns: 0 on success; ERR_SLOT_NOT_FOUND if the slot is unset;
    //          negative error codes for other failures (HOST_FN_ABI_SPEC §4).
    fn sload(slot_ptr: i32, value_out_ptr: i32) -> i32;

    // `sstore` writes a 32-byte slot.
    fn sstore(slot_ptr: i32, value_ptr: i32) -> i32;

    // `emit_event` appends an event log entry to the transaction receipt.
    fn emit_event(
        topics_ptr: i32, n_topics: i32,
        data_ptr: i32, data_len: i32,
    ) -> i32;
}
```

Notes:
- The `#[link(wasm_import_module = "pyde")]` attribute is parsed by `rustc` and emitted into the `linking` custom section of the resulting `.wasm`. The wasm-ld linker picks it up and produces the corresponding WASM `import` declarations.
- You can have multiple `extern "C"` blocks, each with its own `#[link]` attribute, if you need to import from multiple modules. Pyde only uses `pyde` as the module name, so one block is sufficient.
- `unsafe fn` is not required at the declaration site; calls to these functions DO require `unsafe { ... }` because they take raw pointers and can violate memory safety if the offsets are wrong.

### 5.2 TinyGo

```go
package contract

import "unsafe"

// The //go:wasmimport directive (Go 1.21+ / TinyGo 0.30+) tells the
// compiler to emit a WASM import declaration. The two arguments are
// the WASM module name and the WASM function name, in that order.
//
// Note: Go's calling convention is normally NOT compatible with the
// WASM ABI (Go uses its own register-spilling scheme). The
// //go:wasmimport directive switches the relevant function to the
// WASM ABI for ONLY that import declaration — the rest of the
// program keeps Go's normal calling convention.

//go:wasmimport pyde sload
func sload(slotPtr int32, valueOutPtr int32) int32

//go:wasmimport pyde sstore
func sstore(slotPtr int32, valuePtr int32) int32

//go:wasmimport pyde emit_event
func emitEvent(
    topicsPtr int32, nTopics int32,
    dataPtr int32, dataLen int32,
) int32
```

Notes:
- TinyGo's `wasmimport` was stabilized in TinyGo 0.30 (March 2024). Earlier versions used the experimental `//go:wasm-module` directive with separate `//go:export-name` lines.
- The function body MUST be empty / absent — `wasmimport` is a declaration, not a definition. The Go compiler will reject any body.
- Go's `int` type is platform-dependent (32 or 64 bits); always use explicit `int32` / `int64` for WASM imports.

### 5.3 AssemblyScript

```typescript
// The @external decorator tells the AssemblyScript compiler to emit a
// WASM import declaration. The two arguments are the WASM module name
// and the WASM function name.
//
// AssemblyScript's `usize` type is the linear-memory offset type:
// 32-bit on wasm32 (which is Pyde's target), so it's effectively a
// type alias for u32 / i32 at the binary level.

@external("pyde", "sload")
declare function sload(slot_ptr: usize, value_out_ptr: usize): i32;

@external("pyde", "sstore")
declare function sstore(slot_ptr: usize, value_ptr: usize): i32;

@external("pyde", "emit_event")
declare function emit_event(
    topics_ptr: usize, n_topics: i32,
    data_ptr: usize, data_len: i32,
): i32;
```

Notes:
- The `declare` keyword tells AS this is a declaration only — no body.
- AssemblyScript also supports declaring imports via the `@external.js` decorator (for hosted JS environments), but that's not applicable here. Always use plain `@external`.
- AS does not have an `unsafe` keyword; all linear-memory access is implicitly unsafe. Use the `memory.fill`, `memory.copy`, `load<T>`, `store<T>` builtins to interact with memory.

### 5.4 C (clang `--target=wasm32`)

```c
// In C, host function imports are just `extern` declarations with an
// attribute selecting the WASM import module.

// The __attribute__((import_module(...))) and ((import_name(...)))
// pair tells clang's WASM backend to emit a WASM import declaration
// with the given module and name. Without these attributes, the
// linker would try to resolve the symbol locally and fail.

__attribute__((import_module("pyde"), import_name("sload")))
extern int32_t sload(int32_t slot_ptr, int32_t value_out_ptr);

__attribute__((import_module("pyde"), import_name("sstore")))
extern int32_t sstore(int32_t slot_ptr, int32_t value_ptr);

__attribute__((import_module("pyde"), import_name("emit_event")))
extern int32_t emit_event(
    int32_t topics_ptr, int32_t n_topics,
    int32_t data_ptr, int32_t data_len
);
```

Notes:
- C is the lowest-level option and gives you the most direct mapping to WASM. The `__attribute__` syntax is the only way to declare a WASM import in C.
- You'll need `-Wl,--no-entry` at link time since contracts don't have a `main`.
- The `wasm32-wasi` libc (provided by `wasi-libc`) gives you the usual C library functions, but using it implicitly imports WASI functions that Pyde rejects. For Pyde contracts, link against a freestanding setup (no libc) or use a libc that compiles to no WASI imports (e.g., a custom static `memcpy` and `memset`).

---

## 6. Staging data for host calls

The pattern is identical regardless of language:
1. Place the bytes you want to pass in linear memory (stack array, static buffer, or heap allocation).
2. Take the offset (the "pointer") of that memory location.
3. Pass the offset to the host function.

The host then copies the bytes out using `wasmtime::Memory::read`.

### 6.1 Rust: stack-allocated buffers

```rust
// Read the balance of `account` (a 32-byte address) into the local `balance`.
pub fn read_balance(account: &[u8; 32]) -> Result<u128, i32> {

    // Allocate a 16-byte output buffer on the function's STACK FRAME.
    // The compiler reserves 16 bytes in linear memory by adjusting the
    // stack pointer; the address of `balance_buf` is that reserved offset.
    let mut balance_buf = [0u8; 16];

    // SAFETY: `account` is a valid 32-byte slice in linear memory because
    // it was passed in by a caller who satisfied the same invariant;
    // `balance_buf` is a live local on this stack frame. Both pointers
    // are valid for the duration of the host call.
    let rc = unsafe {
        // `account.as_ptr() as i32` reinterprets the 32-bit linear-memory
        // offset as a signed i32. On wasm32, a *const u8 is a 32-bit
        // value; the cast is a bit-pattern reinterpretation, not a
        // truncation.
        balance(
            account.as_ptr() as i32,
            balance_buf.as_mut_ptr() as i32,
        )
    };

    // Map the i32 status code to a Result.
    if rc != 0 {
        return Err(rc);
    }

    // Decode the 16 bytes the host wrote as a little-endian u128
    // (matches HOST_FN_ABI_SPEC §3.2 byte-order rule).
    Ok(u128::from_le_bytes(balance_buf))
}
```

### 6.2 Rust: static buffers (when you need stable offsets)

```rust
// A static buffer lives at a fixed linear-memory offset for the lifetime
// of the contract instance. Useful when you need to pass the same buffer
// across multiple host calls without restaging.

// `static mut` is technically unsafe but is the standard pattern for
// no_std contract scratch space. The wasmtime sandbox prevents any
// real race condition since there is only one thread per instance.
static mut SCRATCH_32: [u8; 32] = [0u8; 32];

pub fn read_self_address() -> [u8; 32] {
    // SAFETY: single-threaded WASM, exclusive access to SCRATCH_32 within
    // this function call. The host call below is the only writer.
    unsafe {
        // Call the host fn that writes our own contract's 32-byte address
        // into the scratch buffer.
        self_address(SCRATCH_32.as_mut_ptr() as i32);

        // Return a copy of the populated buffer. The copy is necessary
        // because `static mut` cannot be safely returned by reference.
        SCRATCH_32
    }
}
```

### 6.3 Rust: heap-allocated buffers (when you need variable-length)

```rust
// If your contract has a global allocator (see §2.3), you can use
// `Vec<u8>` for variable-length staging.

extern crate alloc;
use alloc::vec::Vec;

pub fn emit_typed_event(topic_zero: &[u8; 32], payload: &[u8]) {
    // The topics array for emit_event is contiguous 32-byte entries.
    // We have one topic, so it's 32 bytes.
    let topics = topic_zero;  // already in linear memory; no copy needed

    // The payload is variable-length and might have been built up by
    // concatenating fields. If `payload` is already a contiguous slice
    // we don't need to allocate at all.
    //
    // SAFETY: topics is &[u8; 32] (32 bytes); payload is a contiguous
    // &[u8] in linear memory. Both stay alive for the duration of the
    // host call.
    unsafe {
        emit_event(
            topics.as_ptr() as i32,      // topics_ptr
            1,                            // n_topics (just topic-0 here)
            payload.as_ptr() as i32,     // data_ptr
            payload.len() as i32,        // data_len
        );
    }
}
```

### 6.4 TinyGo: same pattern, different syntax

```go
// Stack-allocated buffer in TinyGo.
func readBalance(account *[32]byte) (lo uint64, hi uint64, err int32) {
    // Local array: lives in the function's stack frame.
    var balanceBuf [16]byte

    // Convert &balanceBuf[0] to int32 via unsafe.Pointer + uintptr.
    // TinyGo's WASM target makes pointers 32 bits, so int32 fits.
    rc := balance(
        int32(uintptr(unsafe.Pointer(&account[0]))),
        int32(uintptr(unsafe.Pointer(&balanceBuf[0]))),
    )

    if rc != 0 {
        return 0, 0, rc
    }

    // Decode the 16-byte LE u128 into two uint64 halves.
    lo = binary.LittleEndian.Uint64(balanceBuf[0:8])
    hi = binary.LittleEndian.Uint64(balanceBuf[8:16])
    return lo, hi, 0
}
```

### 6.5 AssemblyScript: allocate explicitly

```typescript
// AssemblyScript exposes the runtime allocator via `memory.allocate`,
// which returns a `usize` (linear-memory offset). For contracts, this
// is the standard way to stage buffers.

export function readBalance(accountPtr: usize): u64 {
    // Allocate a 16-byte buffer in linear memory and zero it.
    const balanceBuf = changetype<usize>(memory.allocate(16));
    memory.fill(balanceBuf, 0, 16);

    // Call the host fn. AssemblyScript's usize is identical at the
    // binary level to i32 on wasm32, so no cast is needed.
    const rc = balance(accountPtr, balanceBuf);
    if (rc != 0) {
        // Convention: encode the error code in the high bits of the
        // return, or use a separate error-out mechanism.
        return u64.MAX_VALUE;
    }

    // Read the lower 8 bytes as a u64 (assumes balance fits in 64 bits;
    // for full u128 you'd return two u64 halves like Go).
    return load<u64>(balanceBuf);
}
```

---

## 7. Field-keyed storage (recommended)

The §7.1 host-fn catalog lists six storage primitives: the three raw slot-addressed ones (`sload` / `sstore` / `sdelete`) and the three field-keyed ones (`sload_by_field` / `sstore_by_field` / `sdelete_by_field`). **Default to the field-keyed trio.** They take the field name + optional key as raw bytes and the engine derives the slot internally:

```text
slot = Poseidon2(self_address || field_bytes || key_bytes)
```

What you save by using them:

| Without (`sload` / `sstore` raw) | With (`sload_by_field` / `sstore_by_field`) |
|---|---|
| Declare a `slot_<field>()` helper per storage field | None |
| Call `self_address` to seed the hash | Engine does it host-side |
| Allocate a scratch buffer for `addr ‖ field ‖ key` | None |
| Call `hash_poseidon2` to compute the slot | Folded into the host-fn base cost |
| `sload(slot, value_out)` / `sstore(slot, value)` | `sload_by_field(field, field_len, key, key_len, value_out)` |
| **~5 lines + 2 imports** | **1 line** |

Gas is **identical** — the host-side derivation is included in the 200/5000/150 base cost. Use the raw fns only when you need to address a slot you derived yourself (cross-contract storage proofs, custom-keyed slots, or layouts inherited from a delegated implementation).

### 7.1 Calling convention

All three by-field fns share the same head:

```text
pyde::sX_by_field(field_ptr, field_len, key_ptr, key_len, [value_ptr_or_out_ptr]) -> i32
```

- `field_ptr` / `field_len` — pointer + length of the field-name bytes (`b"balances"`, `b"total_supply"`, etc.). Length is the count of bytes, not characters.
- `key_ptr` / `key_len` — pointer + length of the key bytes.
  - For **scalar** slots (no key), pass `0, 0`.
  - For **mapping** slots, pass a 32-byte address (or any unique key bytes) + its length.
  - For **composite-key** mappings (`allowances[owner][spender]`), pack into a single buffer (e.g., 64 bytes = `owner ‖ spender`) and pass that pointer + 64.
- The final pointer is the value buffer:
  - `sload_by_field`: `value_out_ptr` — a 32-byte buffer the host writes into.
  - `sstore_by_field`: `value_ptr` — a 32-byte buffer the host reads from.
  - `sdelete_by_field`: no value pointer.

### 7.2 Rust — scalar + mapping + composite-key

```rust
#[link(wasm_import_module = "pyde")]
extern "C" {
    fn sload_by_field(
        field_ptr: *const u8, field_len: i32,
        key_ptr:   *const u8, key_len:   i32,
        value_out_ptr: *mut u8,
    ) -> i32;

    fn sstore_by_field(
        field_ptr: *const u8, field_len: i32,
        key_ptr:   *const u8, key_len:   i32,
        value_ptr: *const u8,
    ) -> i32;
}

const FIELD_TOTAL_SUPPLY: &[u8] = b"total_supply";
const FIELD_BALANCES:     &[u8] = b"balances";
const FIELD_ALLOWANCES:   &[u8] = b"allowances";

/// One helper covers scalar + mapping + composite-key uniformly.
/// Pass `key = &[]` for scalars.
fn read_u128(field: &[u8], key: &[u8]) -> u128 {
    let mut buf = [0u8; 32];
    let key_ptr = if key.is_empty() { core::ptr::null() } else { key.as_ptr() };
    unsafe {
        sload_by_field(
            field.as_ptr(), field.len() as i32,
            key_ptr,        key.len() as i32,
            buf.as_mut_ptr(),
        );
    }
    let mut amt = [0u8; 16]; amt.copy_from_slice(&buf[16..]);
    u128::from_be_bytes(amt)
}

fn write_u128(field: &[u8], key: &[u8], value: u128) {
    let mut buf = [0u8; 32];
    buf[16..].copy_from_slice(&value.to_be_bytes());
    let key_ptr = if key.is_empty() { core::ptr::null() } else { key.as_ptr() };
    unsafe {
        sstore_by_field(
            field.as_ptr(), field.len() as i32,
            key_ptr,        key.len() as i32,
            buf.as_ptr(),
        );
    }
}

// Usage:
let supply  = read_u128(FIELD_TOTAL_SUPPLY, &[]);              // scalar
let balance = read_u128(FIELD_BALANCES, &owner);               // mapping (key = 32-byte addr)

// Composite key — pack inline:
let mut k = [0u8; 64]; k[..32].copy_from_slice(&owner); k[32..].copy_from_slice(&spender);
let allowed = read_u128(FIELD_ALLOWANCES, &k);                 // nested mapping
```

### 7.3 TinyGo — same shape, `//go:wasmimport`

```go
//go:wasmimport pyde sload_by_field
func sload_by_field(
    fieldPtr int32, fieldLen int32,
    keyPtr   int32, keyLen   int32,
    valueOutPtr int32,
) int32

//go:wasmimport pyde sstore_by_field
func sstore_by_field(
    fieldPtr int32, fieldLen int32,
    keyPtr   int32, keyLen   int32,
    valuePtr int32,
) int32

var fieldBalances = []byte("balances")

func readBalance(owner [32]byte) uint64 {
    var buf [32]byte
    sload_by_field(
        int32(uintptr(unsafe.Pointer(&fieldBalances[0]))),
        int32(len(fieldBalances)),
        int32(uintptr(unsafe.Pointer(&owner[0]))), 32,
        int32(uintptr(unsafe.Pointer(&buf[0]))),
    )
    return binary.BigEndian.Uint64(buf[24:32])
}

func writeBalance(owner [32]byte, value uint64) {
    var buf [32]byte
    binary.BigEndian.PutUint64(buf[24:32], value)
    sstore_by_field(
        int32(uintptr(unsafe.Pointer(&fieldBalances[0]))),
        int32(len(fieldBalances)),
        int32(uintptr(unsafe.Pointer(&owner[0]))), 32,
        int32(uintptr(unsafe.Pointer(&buf[0]))),
    )
}
```

For a scalar slot pass `0, 0` for the key pair.

### 7.4 AssemblyScript — same shape, `@external`

```ts
@external("pyde", "sload_by_field")
declare function sload_by_field(
  fieldPtr: usize, fieldLen: i32,
  keyPtr:   usize, keyLen:   i32,
  valueOutPtr: usize,
): i32;

@external("pyde", "sstore_by_field")
declare function sstore_by_field(
  fieldPtr: usize, fieldLen: i32,
  keyPtr:   usize, keyLen:   i32,
  valuePtr: usize,
): i32;

const FIELD_BALANCES: StaticArray<u8> = [
  0x62, 0x61, 0x6c, 0x61, 0x6e, 0x63, 0x65, 0x73,  // "balances"
];

function readBalance(owner: StaticArray<u8>): u64 {
  const buf = new StaticArray<u8>(32);
  sload_by_field(
    changetype<usize>(FIELD_BALANCES), FIELD_BALANCES.length,
    changetype<usize>(owner), 32,
    changetype<usize>(buf),
  );
  let v: u64 = 0;
  for (let i = 0; i < 8; i++) v = (v << 8) | u64(buf[24 + i]);
  return v;
}
```

For a scalar slot pass `0, 0` for the key pair.

### 7.5 C — same shape, `import_module`

```c
__attribute__((import_module("pyde"), import_name("sload_by_field")))
extern int32_t sload_by_field(
    const uint8_t* field_ptr, int32_t field_len,
    const uint8_t* key_ptr,   int32_t key_len,
    uint8_t* value_out_ptr);

__attribute__((import_module("pyde"), import_name("sstore_by_field")))
extern int32_t sstore_by_field(
    const uint8_t* field_ptr, int32_t field_len,
    const uint8_t* key_ptr,   int32_t key_len,
    const uint8_t* value_ptr);

static const uint8_t FIELD_BALANCES[8] = {'b','a','l','a','n','c','e','s'};

static uint64_t read_balance(const uint8_t owner[32]) {
    uint8_t buf[32];
    sload_by_field(
        FIELD_BALANCES, sizeof FIELD_BALANCES,
        owner, 32,
        buf);
    uint64_t v = 0;
    for (int i = 0; i < 8; i++) v = (v << 8) | (uint64_t)buf[24 + i];
    return v;
}

static void write_balance(const uint8_t owner[32], uint64_t value) {
    uint8_t buf[32] = {0};
    for (int i = 7; i >= 0; i--) { buf[24 + i] = (uint8_t)(value & 0xff); value >>= 8; }
    sstore_by_field(
        FIELD_BALANCES, sizeof FIELD_BALANCES,
        owner, 32,
        buf);
}
```

For a scalar slot pass `(const uint8_t*)0, 0` for the key pair.

### 7.6 When to fall back to raw `sload` / `sstore`

The by-field forms cover the canonical `Poseidon2(self_addr ‖ field ‖ key)` derivation. Use the raw forms when:

- **You need to address a foreign-contract slot.** Cross-contract storage proofs derive the slot from a *different* contract's address, not your own — `sload_by_field` would derive it from yours.
- **You inherited a layout that uses a non-canonical derivation.** Migrated contracts, ports from other chains with different slot schemes, etc.
- **You want a fully custom hash recipe.** Maybe `Blake3` instead of `Poseidon2`, or a multi-step keccak ladder. Compute the slot yourself, pass it to raw `sstore`.

Mixing forms in the same contract is fine — they read/write the same JMT.

The [`erc20-token`](https://github.com/pyde-net/otigen/tree/main/examples/erc20-token) example exercises all three storage layouts in one contract: scalar `total_supply`, mapping `balances[owner]`, and composite-key mapping `allowances[owner][spender]`. The same `read_u128(field, key)` helper handles all three by passing different `key` byte slices.

---

## 8. Cross-contract call patterns

This section walks through the most complex per-language pattern: calling another contract via `pyde::cross_call`. The mechanics generalize to every other variable-data host function (`emit_event`, `calldata_copy`, `parachain_storage_write`, etc.).

### 8.1 The host function signature (recap)

From [HOST_FN_ABI_SPEC §7.8](./HOST_FN_ABI_SPEC.md):

```text
pyde::cross_call(
    target_ptr: i32,                          ; → 32 bytes (target address)
    fn_name_ptr: i32, fn_name_len: i32,       ; → UTF-8 function name
    calldata_ptr: i32, calldata_len: i32,     ; → encoded args
    value_ptr: i32,                           ; → 16 bytes (u128 PYDE value)
    gas_limit: i64,                           ; sub-call gas budget
    return_data_out_ptr: i32,                 ; ← caller's output buffer
    return_data_out_len_ptr: i32              ; ← caller's i32 length slot
) -> i32                                       ; status code
```

### 8.2 Rust — calling `token.transfer(recipient, amount)`

```rust
// Import the host fn (see §5.1).
#[link(wasm_import_module = "pyde")]
extern "C" {
    fn cross_call(
        target_ptr: i32,
        fn_name_ptr: i32, fn_name_len: i32,
        calldata_ptr: i32, calldata_len: i32,
        value_ptr: i32,
        gas_limit: i64,
        return_data_out_ptr: i32,
        return_data_out_len_ptr: i32,
    ) -> i32;
}

// Invoke `transfer(recipient, amount)` on the contract at `token_addr`.
//
// Parameters:
//   token_addr — 32-byte address of the token contract to call into.
//   recipient  — 32-byte address that should receive the tokens.
//   amount     — quantity to transfer, as a u128 (16 bytes LE on wire).
//
// Returns:
//   Ok(())              — sub-call succeeded; tokens transferred.
//   Err(rc)             — sub-call failed with the engine's error code.
pub fn transfer_via_token(
    token_addr: &[u8; 32],
    recipient:  &[u8; 32],
    amount:     u128,
) -> Result<(), i32> {

    // ── 1. Encode the calldata ────────────────────────────────────
    //
    // The target's `transfer(address, uint128)` expects its inputs
    // serialized as:
    //   bytes  0..32  — recipient address (raw 32 bytes)
    //   bytes 32..48  — amount as little-endian u128 (16 bytes)
    //
    // Total calldata length: 48 bytes. We stage it in a stack-frame
    // array since the size is fixed and small.
    let mut calldata = [0u8; 48];
    calldata[..32].copy_from_slice(recipient);              // recipient slot
    calldata[32..48].copy_from_slice(&amount.to_le_bytes());// amount slot

    // ── 2. Stage the constants ─────────────────────────────────────
    //
    // `fn_name` is a byte literal; literals live in the contract's
    // data segment at a fixed offset. `as_ptr()` returns that offset.
    let fn_name: &[u8] = b"transfer";

    // No PYDE value attached. cross_call requires a 16-byte u128 even
    // when zero, so we stage a zeroed buffer.
    let zero_value = [0u8; 16];

    // ── 3. Reserve a return-data buffer + length slot ──────────────
    //
    // `transfer` returns no data in most ERC20-style contracts, but
    // we provision a small buffer anyway in case the target returns
    // a status code. Sized at 32 bytes (one word).
    let mut return_buf = [0u8; 32];
    let mut return_len: i32 = 0;

    // ── 4. Issue the host call ─────────────────────────────────────
    //
    // SAFETY: every pointer below references a live local on this
    // stack frame. The host copies the bytes out synchronously, so
    // the locals only need to remain valid through the duration of
    // the call. After the call returns, we no longer need them.
    let rc = unsafe {
        cross_call(
            // target_ptr      → contract to call
            token_addr.as_ptr() as i32,

            // fn_name_ptr     → "transfer"
            // fn_name_len     → 8 (length of "transfer")
            fn_name.as_ptr() as i32,
            fn_name.len() as i32,

            // calldata_ptr    → start of the 48-byte encoded args
            // calldata_len    → 48
            calldata.as_ptr() as i32,
            calldata.len() as i32,

            // value_ptr       → 16-byte zero buffer (no value attached)
            zero_value.as_ptr() as i32,

            // gas_limit       → 100,000 gas budget for the sub-call.
            //                   The engine deducts this from our remaining
            //                   gas; the sub-call's actual usage is
            //                   refunded above its own consumption.
            100_000,

            // return_data_out_ptr     → where the host writes return data
            // return_data_out_len_ptr → where the host writes the actual
            //                           number of bytes it returned
            return_buf.as_mut_ptr() as i32,
            (&mut return_len) as *mut i32 as i32,
        )
    };

    // ── 5. Translate status code into Rust Result ──────────────────
    //
    // 0 = success. Anything else is an error code documented in
    // HOST_FN_ABI_SPEC §4. We propagate it up as-is so the caller
    // can decide whether to retry, revert, etc.
    if rc == 0 {
        // `return_buf[..return_len as usize]` is the return data slice
        // if the caller wants to inspect it. transfer() conventionally
        // returns nothing, so we ignore it here.
        Ok(())
    } else {
        Err(rc)
    }
}
```

### 8.3 TinyGo — same pattern

```go
package contract

import (
    "encoding/binary"
    "unsafe"
)

//go:wasmimport pyde cross_call
func crossCall(
    targetPtr int32,
    fnNamePtr int32, fnNameLen int32,
    calldataPtr int32, calldataLen int32,
    valuePtr int32,
    gasLimit int64,
    returnDataOutPtr int32,
    returnDataOutLenPtr int32,
) int32

// transferViaToken invokes the named token's transfer(address, uint128)
// function on behalf of this contract.
//
// Note: Go has no native u128, so the amount is split into two uint64s
// (low + high) and reassembled into 16 little-endian bytes before the call.
func transferViaToken(
    tokenAddr *[32]byte,
    recipient *[32]byte,
    amountLo uint64,
    amountHi uint64,
) int32 {

    // ── 1. Encode calldata = recipient (32) + amount (16 LE) = 48 bytes ─
    var calldata [48]byte
    copy(calldata[:32], recipient[:])
    binary.LittleEndian.PutUint64(calldata[32:40], amountLo)
    binary.LittleEndian.PutUint64(calldata[40:48], amountHi)

    // ── 2. Stage constants ────────────────────────────────────────────
    fnName := []byte("transfer")     // backing array lives on heap
    var zeroValue [16]byte           // stack-allocated; auto-zeroed

    // ── 3. Reserve return buffer + length slot ────────────────────────
    var returnBuf [32]byte
    var returnLen int32 = 0

    // ── 4. Issue the host call ────────────────────────────────────────
    //
    // unsafe.Pointer + uintptr is Go's standard way to obtain a raw
    // address. Cast to int32 because wasm32 pointers are 32 bits.
    return crossCall(
        int32(uintptr(unsafe.Pointer(&tokenAddr[0]))),         // target_ptr
        int32(uintptr(unsafe.Pointer(&fnName[0]))),            // fn_name_ptr
        int32(len(fnName)),                                     // fn_name_len
        int32(uintptr(unsafe.Pointer(&calldata[0]))),          // calldata_ptr
        int32(len(calldata)),                                   // calldata_len
        int32(uintptr(unsafe.Pointer(&zeroValue[0]))),         // value_ptr
        100_000,                                                // gas_limit
        int32(uintptr(unsafe.Pointer(&returnBuf[0]))),         // return_data_out_ptr
        int32(uintptr(unsafe.Pointer(&returnLen))),            // return_data_out_len_ptr
    )
}
```

### 8.4 AssemblyScript — same pattern

```typescript
// Host fn declaration.
@external("pyde", "cross_call")
declare function cross_call(
    target_ptr: usize,
    fn_name_ptr: usize, fn_name_len: i32,
    calldata_ptr: usize, calldata_len: i32,
    value_ptr: usize,
    gas_limit: i64,
    return_data_out_ptr: usize,
    return_data_out_len_ptr: usize,
): i32;

// transferViaToken invokes transfer(address, uint128) on a target token.
//
// Parameters take usize (linear-memory offsets) because AssemblyScript
// has no native fixed-array-by-value convention — the caller stages the
// bytes themselves and passes the offsets in.
export function transferViaToken(
    tokenAddrPtr: usize,    // ← caller has staged 32 bytes here
    recipientPtr: usize,    // ← ...and 32 bytes here
    amount_lo: u64,
    amount_hi: u64,
): i32 {

    // ── 1. Allocate calldata buffer (48 bytes) + copy recipient + amount ──
    const calldata = changetype<usize>(__alloc(48));
    memory.copy(calldata, recipientPtr, 32);
    store<u64>(calldata + 32, amount_lo);
    store<u64>(calldata + 40, amount_hi);

    // ── 2. Stage fn_name as a UTF-8 byte buffer ───────────────────────────
    const fnName = String.UTF8.encode("transfer", false);
    const fnNamePtr = changetype<usize>(fnName);
    const fnNameLen = fnName.byteLength;

    // ── 3. Zero-value buffer ──────────────────────────────────────────────
    const zeroValue = changetype<usize>(__alloc(16));
    memory.fill(zeroValue, 0, 16);

    // ── 4. Return buffer + length slot ────────────────────────────────────
    const returnBuf = changetype<usize>(__alloc(32));
    const returnLenPtr = changetype<usize>(__alloc(4));
    store<i32>(returnLenPtr, 0);

    // ── 5. Issue the host call ────────────────────────────────────────────
    return cross_call(
        tokenAddrPtr,
        fnNamePtr, fnNameLen,
        calldata, 48,
        zeroValue,
        100_000,
        returnBuf,
        returnLenPtr,
    );
}
```

### 8.5 The four cross_call invariants — pattern + example

When a primary contract calls `pyde::cross_call(target, fn_name, calldata, value, ...)`, four properties hold per `HOST_FN_ABI_SPEC §7.8` — properties that distinguish cross_call from a regular function call within the same contract:

1. **Target's storage context.** Sub-call sstores land in the TARGET's slot namespace (`Poseidon2(target_address ‖ field ‖ key)`), not the caller's. Storage isolation is implicit because slot hashes include each contract's `self_address`.
2. **`caller()` shift.** Inside the callee, `caller()` returns the **immediate** caller-contract's address — the contract that issued the `cross_call`, NOT the tx originator (`origin`). Useful for the callee to authorise the call source; common pitfall to confuse it with `origin()`.
3. **Value transfer.** The `value` parameter debits the caller's native-PYDE balance and credits the target's. Inside the callee, `tx_value()` returns the same `value`. The transfer happens in the parent's frame, so even if the sub-call reverts (and the runner snapshots state), the transfer rolls back too.
4. **Revert rollback.** Sub-call trap (revert / unreachable / out-of-fuel / etc.) does NOT propagate to the parent. Instead the host fn returns `ERR_CROSS_CALL_FAILED = -10` and rolls back all of the sub-call's storage / balance / event mutations. The parent observes the rc and decides whether to handle the failure or revert further.

The [`counter-pair`](https://github.com/pyde-net/otigen/tree/main/examples/counter-pair-a) example pair (counter-pair-a + counter-pair-b) exercises all four invariants in a six-test suite. counter-pair-a's `bump_via_b(b, n)` cross_calls counter-pair-b's `bump_remote` (storage + caller-shift); `send_value_to_b(b, n)` cross_calls with `value = n` (value transfer); `bump_via_b_revert(b)` triggers a sub-call revert (rollback). One composition test runs success → revert → success and asserts the parent survived every revert without trapping. Read the contracts side-by-side as a calibration point for any cross-contract design.

#### Sub-call dispatch convention

The mock runner invokes the target's named export with the canonical `(calldata_ptr: i32, calldata_len: i32) -> i32` shape — `calldata_ptr` is an offset into the **callee's** linear memory (the mock copies bytes from caller's to callee's at the boundary), `calldata_len` is the byte count, and the return value is the rc. Production engine dispatch goes through the contract's ABI metadata instead; the calldata-driven shape is a v1 runner convenience that keeps every example uniform.

---

## 9. FALCON-512 verification pattern

`pyde::falcon_verify` lets a contract check post-quantum signatures inside its own execution — the building block for multisig wallets, gasless / meta-transaction relayers, ZK-coupled off-chain authorizations, and anything else that needs in-contract sig checks against a known FALCON-512 public key.

### 9.1 Host function signature (recap)

```rust
#[link(wasm_import_module = "pyde")]
extern "C" {
    /// Verify a FALCON-512 signature.
    ///
    /// `pk_ptr` must point to exactly 897 readable bytes (the
    /// `FalconPublicKey::SIZE` constant). `msg` and `sig` are
    /// variable-length.
    ///
    /// Returns 0 on valid, ERR_SIGNATURE_INVALID = -17 otherwise.
    /// Malformed pubkey or signature bytes are rejected as invalid
    /// rather than trapping — the contract can recover gracefully.
    pub fn falcon_verify(
        pk_ptr:  *const u8,
        msg_ptr: *const u8, msg_len: i32,
        sig_ptr: *const u8, sig_len: i32,
    ) -> i32;
}
```

Per HOST_FN_ABI_SPEC §7.7. Gas: **50,000 base** — verification is intentionally expensive because FALCON's algebra is heavy; design contracts so authors can amortize multiple sigs in one tx rather than one-sig-per-tx.

### 9.2 Storing FALCON pubkeys on-chain

A FALCON-512 pubkey is 897 bytes. Storing the full pubkey per-signer is wasteful (≈ 28 storage slots, each at 5,000 gas to write). The canonical optimization:

```rust
// Store the 32-byte Poseidon2 hash of the pubkey as the "signer ID".
// Callers provide the full pubkey at verify time; the contract
// recomputes the hash and matches against its registered set.
const FIELD_SIGNERS: &[u8] = b"signers";

fn register_signer(slot_idx: u8, pubkey: &[u8]) {
    let mut hash = [0u8; 32];
    unsafe { host_fns::hash_poseidon2(pubkey.as_ptr(), pubkey.len() as i32, hash.as_mut_ptr()); }
    unsafe {
        host_fns::sstore_by_field(
            FIELD_SIGNERS.as_ptr(), FIELD_SIGNERS.len() as i32,
            &slot_idx as *const u8, 1,
            hash.as_ptr(),
        );
    }
}
```

One slot per signer instead of 28. The test framework's `@pubkey_hash:NAME` DSL prefix (see `OTIGEN_TEST_SPEC §5.5`) computes the identical hash at plan time so test init calls register the same IDs.

### 9.3 The verify-and-count loop

For a multi-signer check (threshold M-of-N), three contract-side checks bracket every `falcon_verify` call: pubkey-is-known, pubkey-not-already-counted, sig-actually-verifies. Skipping any of them leaks signature-forgery surface; doing them in the wrong order (e.g. verify before checking the pubkey is registered) wastes gas on attacker-supplied sigs that would never have counted anyway.

```rust
fn verify_signer_set(
    msg_ptr: *const u8, msg_len: i32,
    pubkeys: &[(*const u8, i32)],   // each (ptr, len). len==0 ⇒ unused slot.
    sigs:    &[(*const u8, i32)],
    threshold: u8,
) -> u8 {
    let mut seen: u8 = 0;       // bitmap of signer-indices already counted
    let mut valid: u8 = 0;

    for ((pk_ptr, pk_len), (sig_ptr, sig_len)) in pubkeys.iter().zip(sigs) {
        if *pk_len == 0 { continue; }

        // 1. Identify which registered signer this pubkey is.
        let mut pk_hash = [0u8; 32];
        unsafe { host_fns::hash_poseidon2(*pk_ptr, *pk_len, pk_hash.as_mut_ptr()); }
        let Some(idx) = lookup_signer_idx(&pk_hash) else { fail(b"UnknownSigner"); };

        // 2. Anti-double-count.
        let bit = 1u8 << idx;
        if seen & bit != 0 { fail(b"DuplicateSigner"); }
        seen |= bit;

        // 3. FALCON-verify.
        let rc = unsafe {
            host_fns::falcon_verify(*pk_ptr, msg_ptr, msg_len, *sig_ptr, *sig_len)
        };
        if rc != 0 { fail(b"BadSignature"); }
        valid += 1;
    }

    if valid < threshold { fail(b"InsufficientApprovals"); }
    valid
}
```

### 9.4 Canonical message construction

A FALCON sig binds a public key to a specific message. If the contract and the off-chain wallet disagree about what bytes go into that message, every verify fails. Two well-trodden conventions:

**Action hash (Safe-style):** the off-chain wallet pre-computes a 32-byte digest covering the full intent (`Poseidon2(self_address ‖ target ‖ amount ‖ nonce ‖ chain_id)`) and feeds *that* to each signer. The contract receives the hash as a `bytes32` arg, verifies sigs against it, then uses the hash itself as the anti-replay key. Used by [`simple-multisig`](https://github.com/pyde-net/otigen/tree/main/examples/simple-multisig).

**Structured message:** the contract receives the structured fields (`target`, `amount`, etc.) and re-derives the canonical message at verify time. Cheaper for the wallet UI (no upfront hash computation), more gas inside the contract. Pick this when wallet ergonomics dominate.

### 9.5 Testing FALCON contracts

`otigen test` mocks `falcon_verify` with `pyde_crypto::falcon::falcon_verify` — the same primitive the engine uses. Combined with the `[accounts]` keypair declaration (`OTIGEN_TEST_SPEC §4.1`) and the `@sig:NAME:args.IDX` DSL (§5.5), authors write multisig tests without ever hand-pasting kilobyte FALCON blobs:

```toml
[accounts]
alice = { keypair = "falcon512" }
bob   = { keypair = "falcon512" }

[[tests.calls]]
function = "execute"
args = [
  "recipient", "500",
  "0x4141414141414141414141414141414141414141414141414141414141414141",  # action_hash
  "@pubkey:alice", "@sig:alice:args.2",
  "@pubkey:bob",   "@sig:bob:args.2",
  "0x", "0x",
]
```

The full live example — including replay protection, duplicate-signer rejection, and malformed-sig handling — is in [`otigen/examples/simple-multisig/`](https://github.com/pyde-net/otigen/tree/main/examples/simple-multisig).

---

## 10. Upgradeable proxy pattern

The canonical upgradeable contract ships as two roles: a tiny **proxy** that owns the storage and an admin-controlled implementation pointer, plus one or more **implementation** contracts that hold the actual logic. Users always call the proxy; the proxy `delegate_call`s the current implementation to run that code against the proxy's own storage slots. Upgrading is a single sstore — point the slot at a new contract address.

### 10.1 Why delegate_call (vs cross_call)

`delegate_call` and `cross_call` are siblings under `HOST_FN_ABI_SPEC §7.8` but enforce opposite storage semantics:

| | Code from | Storage context | `caller()` value | Use for |
|---|---|---|---|---|
| `cross_call` | target | target's slots | the calling contract | Inter-contract APIs ("call into the token contract") |
| `delegate_call` | target | **caller's slots** | preserved (whoever called the proxy) | Proxies, libraries that mutate caller's state, hot-swappable logic |

When the proxy `delegate_call`s into the impl, the impl's `sstore`s land on the proxy's slots. The proxy "borrows" the impl's code; the impl never touches its own storage when called this way.

### 10.2 Slot layout

The proxy owns two reserved slots plus whatever the impl logic uses:

| Slot | Type | Purpose |
|---|---|---|
| `admin` | `address` | Who can call `upgrade()`. Set once at `init`. |
| `impl` | `address` | Current implementation pointer. Mutated only by `upgrade()`. |
| ...impl slots... | various | Whatever fields the impl writes via delegate_call (`value`, `balances`, `total_supply`, etc.). |

**Storage-layout compatibility is a hard contract between the proxy and every impl.** An impl that reads/writes slot `X` for purpose A is fundamentally incompatible with one that uses `X` for purpose B — the upgrade silently corrupts state. Two mitigations:

1. **Field-keyed storage (§7).** Slots are derived from `Poseidon2(self_address ‖ field ‖ key)`. Two impls using the same field-name strings for the same data type collide cleanly; mismatched naming surfaces as obvious "fresh slot" reads.
2. **Append-only impl evolution.** New impls may add fields (new names) but must never repurpose an existing name. Document the slot-name vocabulary explicitly.

### 10.3 The proxy entry points (Rust)

```rust
const FIELD_ADMIN: &[u8] = b"admin";
const FIELD_IMPL:  &[u8] = b"impl";
const INNER_SET:   &[u8] = b"_inner_set_value";

/// One-shot constructor.
#[no_mangle]
pub extern "C" fn init(impl_addr_ptr: *const u8) -> i32 {
    let impl_addr = unsafe { read_32(impl_addr_ptr) };
    write_slot(FIELD_ADMIN, &[], &caller_addr());
    write_slot(FIELD_IMPL,  &[], &impl_addr);
    0
}

/// Admin-only impl pointer swap.
#[no_mangle]
pub extern "C" fn upgrade(new_impl_ptr: *const u8) -> i32 {
    if read_slot(FIELD_ADMIN, &[]) != caller_addr() { fail(b"NotAdmin"); }
    let new_impl = unsafe { read_32(new_impl_ptr) };
    write_slot(FIELD_IMPL, &[], &new_impl);
    0
}

/// Forwarded write — calls the impl's inner export in this proxy's
/// storage context. The impl's sstore lands on the proxy's `value`
/// slot.
#[no_mangle]
pub extern "C" fn set_value(value_ptr: *const u8) -> i32 {
    let impl_addr = read_slot(FIELD_IMPL, &[]);
    let mut ret_data = [0u8; 32];
    let mut ret_len: i32 = 0;
    let rc = unsafe {
        host_fns::delegate_call(
            impl_addr.as_ptr(),
            INNER_SET.as_ptr(), INNER_SET.len() as i32,
            value_ptr, 16,           // pass through caller's 16-byte u128
            i64::MAX,                // gas — chain-side enforces real limits
            ret_data.as_mut_ptr(),
            &mut ret_len as *mut i32,
        )
    };
    if rc != 0 { fail(b"DelegateFailed"); }
    0
}
```

### 10.4 The impl side

The impl exports functions that take `(calldata_ptr: i32, calldata_len: i32) -> i32` — calldata-driven dispatch, matching how the engine's real `delegate_call` will route. The impl decodes its own args from the calldata buffer:

```rust
/// Called via delegate_call from the proxy's `set_value`.
#[no_mangle]
pub extern "C" fn _inner_set_value(calldata_ptr: *const u8, calldata_len: i32) -> i32 {
    if calldata_len < 16 { return -1; }  // malformed input
    let v = unsafe { read_u128(calldata_ptr) };  // 16-byte LE u128
    let mut slot_value = [0u8; 32];
    slot_value[16..].copy_from_slice(&v.to_be_bytes());  // BE u128 in upper 16 bytes
    write_slot(b"value", &[], &slot_value);  // lands on PROXY's slot (delegate_call!)
    0
}
```

### 10.5 Auth pitfalls

- **`caller()` semantics across delegate_call**: the impl's `caller()` returns whoever called the PROXY, not the proxy. If the impl gates a function on a specific caller, that gate triggers against the user — not what proxies want. Workaround: gate at the proxy layer (`upgrade` is admin-only), and treat the impl as logic-only.
- **Re-entrancy under upgrade**: if the impl is mid-execution when `upgrade()` swaps the slot, the still-running impl reads the OLD code (`delegate_call` is per-invocation, not a permanent binding). New calls run the NEW impl. Practical implication: don't make the upgrade behaviour depend on state half-touched by the old impl.
- **`init()` re-execution**: on chain, the `constructor` attribute prevents post-deploy calls. In tests, each test starts from fresh state so re-running `init` is a clean overwrite; treat it the same way in your test design.

### 10.6 Testing under the v1 runner

The runner's `delegate_call` mock requires `target == self_address` (single-wasm v1 limitation). For tests this means the proxy + impl live in the SAME wasm — both exported, the proxy `delegate_call`s into its own module. Functionally identical to delegate-to-different-contract because the storage context is what matters, not the code source.

The full live example — including 7 behaviour tests covering admin-only upgrade, slot updates via delegate, multi-call overwrite, and a round-trip after upgrade — is in [`otigen/examples/upgradeable-proxy/`](https://github.com/pyde-net/otigen/tree/main/examples/upgradeable-proxy).

---

## 11. Hash-based commitments and Merkle proofs

Pyde exposes three hash host fns and a real PQ signature primitive — together they cover every commitment-style pattern devs reach for: airdrops, allowlists, batched offchain-state proofs, content-addressed storage, leaderboard snapshots, and ZK-coupled inclusion claims. This chapter ties the three hashes to their use cases and walks through the canonical pattern (Merkle inclusion) end-to-end so the surrounding tradeoffs aren't buried in a single example file.

### 11.1 The hash host fn surface

| Host fn | Output | Gas (base + per word) | When to reach for it |
|---|---|---|---|
| `hash_blake3` | 32 B | 15 + 3/8B | The performance default. ~2 GB/s on x86. Use for event topics, address derivation, merkle proofs, anything the contract recomputes hot. |
| `hash_poseidon2` | 32 B | 100 + 30/8B | ZK-friendly. ~10× slower than Blake3 native, but generates circuit-friendly outputs. Use for storage slot derivation (the engine does this internally), state-root commitments, and anything you might prove in a ZK circuit later. |
| `hash_keccak256` | 32 B | 30 + 6/8B | Cross-chain interop only. Use when you're verifying an Ethereum-side artifact (Merkle Patricia proof, EIP-712 hash) and the comparison must agree byte-for-byte with Ethereum. Don't pick this for fresh Pyde-native designs. |

All three have the same shape:

```rust
#[link(wasm_import_module = "pyde")]
extern "C" {
    pub fn hash_blake3   (in_ptr: *const u8, in_len: i32, out_ptr: *mut u8);
    pub fn hash_poseidon2(in_ptr: *const u8, in_len: i32, out_ptr: *mut u8);
    pub fn hash_keccak256(in_ptr: *const u8, in_len: i32, out_ptr: *mut u8);
}
```

`out_ptr` must point to at least 32 writable bytes. None of them return a value — the output lands in linear memory at `out_ptr`. Spec: HOST_FN_ABI_SPEC §7.6.

### 11.2 Domain separation: prepend a tag, always

If you hash both `(claimant, amount)` *leaves* and `(left, right)` *internal nodes* with the same function and no distinguishing prefix, an attacker who knows two leaves can claim a forged "leaf" whose 64-byte preimage exactly matches the 64-byte preimage of an internal node. The resulting hash collides — a *second-preimage attack* against the structure, not the hash function itself.

The fix is a domain-separation tag — a fixed byte prefix that's different for every distinct kind of input:

```rust
const LEAF_TAG: &[u8] = b"PYDE_LEAF";
const NODE_TAG: &[u8] = b"PYDE_NODE";

fn leaf_hash(claimant: &[u8; 32], amount: u128) -> [u8; 32] {
    let mut buf = [0u8; 9 + 32 + 16];
    buf[..9].copy_from_slice(LEAF_TAG);
    buf[9..41].copy_from_slice(claimant);
    buf[41..].copy_from_slice(&amount.to_be_bytes());
    let mut out = [0u8; 32];
    unsafe { host_fns::hash_blake3(buf.as_ptr(), buf.len() as i32, out.as_mut_ptr()); }
    out
}

fn node_hash(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut buf = [0u8; 9 + 32 + 32];
    buf[..9].copy_from_slice(NODE_TAG);
    buf[9..41].copy_from_slice(left);
    buf[41..].copy_from_slice(right);
    let mut out = [0u8; 32];
    unsafe { host_fns::hash_blake3(buf.as_ptr(), buf.len() as i32, out.as_mut_ptr()); }
    out
}
```

Tag length is irrelevant for security (Blake3 mixes input in 64 B chunks regardless). 4–16 bytes is conventional. The structure-level invariant the tag must hold: **any two inputs that play different roles in the protocol have non-overlapping byte prefixes**. Cross-protocol use too — `b"PYDE_FALCON_MSG"`, `b"PYDE_AIRDROP_LEAF"`, etc. — to keep separate apps from cross-colliding.

This is RFC 9162-style (Certificate Transparency v2) and the same approach OpenZeppelin, EIP-712, and Sigsum all use. Skipping it has bitten production systems.

### 11.3 Building a Merkle tree off-chain

The contract never builds the tree — it only commits to a root and verifies inclusion against it. The tree-build happens in whatever tool generates the (claimant, amount) allocation list:

```text
        root = node_hash(node_AB, node_CD)
              /                         \
     node_AB = node_hash(leaf_A, leaf_B)      node_CD = node_hash(leaf_C, leaf_D)
       /              \                              /              \
   leaf_A          leaf_B                       leaf_C          leaf_D
 (alice,100)    (bob,200)                     (carol,300)    (dave,400)
```

Pad odd levels by hashing the lone child with itself (or with a sentinel like `[0u8; 32]` — pick one and document it; the verifier needs to do the same). Pre-sort the (claimant, amount) list by claimant address for determinism — two different orderings produce two different roots, and a launcher who picks the wrong order will mint an unusable commitment.

The publisher commits `root` on-chain via a one-shot `set_root(bytes32)` call. They publish each `(claimant, amount, path)` tuple via whatever offchain channel makes sense (S3, IPFS, a Discord pin) — the path is just a witness, not a secret, so cheap-and-cheerful hosting is fine.

### 11.4 Encoding a proof

A merkle proof from leaf `i` to the root is `log₂(N)` levels deep. At each level you need:
1. The **sibling** at that level (32 bytes), and
2. The **position** of your current running hash — left or right child (1 bit).

The simplest sound encoding: pack each level as a 33-byte step, `[position_byte][sibling_32B]`. Total proof length is `33 × depth`. For a 1 M-leaf tree, the proof is `33 × 20 = 660 bytes`. Cheap.

Two common alternatives, and why I'd avoid them:

- **Sorted-pair hashing** (OpenZeppelin's default): hash `(min(a, b), max(a, b))` at each level so the position bit isn't needed. Saves a byte per level but lets attackers permute proofs — there's only one valid hash for any `(a, b)` regardless of which side `a` lives on. Easier to forge if the tree-builder later changes orderings; harder to extend with auxiliary metadata.
- **Bit-packed positions**: stash all the position bits in a single 4-byte prefix, then sibling-array. Saves `depth - 4` bytes (negligible at depth 10) at the cost of a manual bit-unpacking loop. Pick this only if proof size genuinely matters (block-space-sensitive proofs, on-chain *every* tx).

Stick with the byte-per-step encoding unless you have a concrete reason not to.

### 11.5 Verifying a proof on-chain

The verification loop is short, because the structure pushes complexity offchain. The contract:
1. Recomputes the leaf hash from `(caller, amount)`.
2. Walks the proof, applying each sibling at the position the byte specifies.
3. Compares the final hash against the stored root.

```rust
fn walk_proof(leaf: [u8; 32], proof: &[u8]) -> [u8; 32] {
    let mut hash = leaf;
    let mut i = 0;
    while i < proof.len() {
        let position = proof[i];
        let mut sibling = [0u8; 32];
        sibling.copy_from_slice(&proof[i + 1..i + 33]);
        hash = if position == 0 {
            // Running hash is on the LEFT this level.
            node_hash(&hash, &sibling)
        } else {
            // Running hash is on the RIGHT.
            node_hash(&sibling, &hash)
        };
        i += 33;
    }
    hash
}

#[no_mangle]
pub extern "C" fn claim(amount_ptr: *const u8, proof_ptr: *const u8, proof_len: i32) -> i32 {
    // SAFETY: typed-arg marshalling guarantees readable bytes.
    let amount = unsafe { read_u128_arg(amount_ptr) };

    // Sanity-check proof length BEFORE hashing — saves gas on garbage input.
    if (proof_len as usize) % 33 != 0 { revert(b"MalformedProof"); }

    let mut buf = [0u8; 33 * 32];                     // cap at 32 levels = 2^32 leaves
    let plen = proof_len as usize;
    if plen > buf.len() { revert(b"ProofTooLong"); }
    if plen > 0 {
        unsafe { core::ptr::copy_nonoverlapping(proof_ptr, buf.as_mut_ptr(), plen); }
    }

    let claimant = caller_addr();
    let leaf = leaf_hash(&claimant, amount);
    let computed = walk_proof(leaf, &buf[..plen]);

    if computed != stored_root() { revert(b"InvalidProof"); }

    // ... mark claimed, emit event, etc.
    0
}
```

The `caller_addr()` binding is the trick that makes this safe: the leaf commits to whoever's *actually calling*, not an address arg. An attacker who steals alice's path can't replay it because their `caller_addr()` would be different, so the leaf hashes wouldn't match.

Gas cost is `15 base + 3/word` per `hash_blake3` invocation, times `depth` per `claim`. For a 1 M-leaf tree (depth 20) verifying a 73 B node-hash preimage, that's ~`20 × (15 + 3×10) = 900 gas` for the hashes alone — cheaper than a single sstore.

### 11.6 Common pitfalls

- **Forgetting the sibling-vs-self ordering on odd levels.** If the tree-builder and the contract handle odd levels differently (one duplicates the lone child, the other uses zero-padding), roots disagree. Pick one rule. Pin it in a comment.
- **Hashing the address as ASCII.** The leaf's `claimant` field is 32 raw bytes, NOT the hex-string repr. If your offchain tool hashes the string `"0xabc…"`, the contract — which feeds raw bytes from `caller()` — will recompute a different leaf.
- **Forgetting to verify proof length.** A non-multiple-of-33 proof leaks garbage into the sibling buffer. Always `proof_len % 33 == 0` before walking.
- **Trusting the amount arg without rebinding to caller.** If `claim(claimant, amount, proof)` accepts the claimant as an *argument* instead of using `caller()`, anyone who knows alice's path can submit it under their own tx and the verification still passes — but the funds go to whoever the contract pays out to (often the arg, not the caller). Tie the leaf to `caller()`.
- **Reusing the same tree across protocols.** Two airdrops sharing a leaf scheme (no protocol-specific tag prefix) means proofs from one can be replayed against the other. Add a protocol identifier to the leaf tag: `b"PYDE_AIRDROP_V1_LEAF"`.

### 11.7 Live example

The full pattern — domain-separated hashing, 33-byte step encoding, proof verification, double-claim protection, all-error-path tests — lives in [`otigen/examples/merkle-claim-airdrop/`](https://github.com/pyde-net/otigen/tree/main/examples/merkle-claim-airdrop). 10 behaviour tests cover the happy path, every revert path, and the off-by-one edge cases (zero-length proofs, max-depth proofs, malformed lengths).

---

## 12. How the host reads it

The host (Pyde's engine, in Rust, hosted on top of wasmtime) registers `cross_call` as a linker function during executor initialization. The function signature on the host side mirrors the WASM signature, plus a `Caller` handle that gives access to the contract's linear memory.

### 12.1 Engine-side `cross_call` handler

```rust
// Register cross_call with the wasmtime linker. This wires the WASM-side
// import `pyde::cross_call` to the Rust closure below.
linker.func_wrap(
    "pyde",
    "cross_call",
    |
        // The Caller handle is wasmtime's way of giving host functions
        // access to the calling instance's exports — most importantly
        // its linear memory.
        mut caller: Caller<'_, HostState>,

        // The eight integer parameters from the WASM side, in exactly
        // the order the contract passed them.
        target_ptr: i32,
        fn_name_ptr: i32, fn_name_len: i32,
        calldata_ptr: i32, calldata_len: i32,
        value_ptr: i32,
        gas_limit: i64,
        return_data_out_ptr: i32,
        return_data_out_len_ptr: i32,
    | -> wasmtime::Result<i32> {

        // ── 1. Grab the contract's linear memory ─────────────────
        //
        // Every Pyde contract exports its linear memory under the
        // name "memory". (This is the wasm32 default; the linker
        // emits this export automatically.)
        let memory = caller
            .get_export("memory")
            .and_then(|e| e.into_memory())
            .ok_or_else(|| wasmtime::Error::msg("no memory export"))?;

        // ── 2. COPY the 32-byte target address out of linear memory ──
        //
        // memory.read performs a bounds-checked memcpy from the WASM
        // instance's linear memory into the host's `target` array.
        // If [target_ptr, target_ptr + 32) is out of bounds, this
        // returns Err(MemoryOutOfBounds) and the WASM call traps.
        let mut target = [0u8; 32];
        memory.read(&caller, target_ptr as usize, &mut target)?;

        // ── 3. COPY the function name (variable length) ──────────────
        //
        // We trust fn_name_len because the bounds check inside
        // memory.read will catch any out-of-bounds; we cap it at
        // a sane max upstream (in attribute validation) to prevent
        // accidental gigabyte allocations.
        let mut fn_name = vec![0u8; fn_name_len as usize];
        memory.read(&caller, fn_name_ptr as usize, &mut fn_name)?;
        let fn_name_str = core::str::from_utf8(&fn_name)
            .map_err(|_| wasmtime::Error::msg("fn_name not UTF-8"))?;

        // ── 4. COPY the calldata ─────────────────────────────────────
        let mut calldata = vec![0u8; calldata_len as usize];
        memory.read(&caller, calldata_ptr as usize, &mut calldata)?;

        // ── 5. COPY the 16-byte value (u128 little-endian) ───────────
        let mut value_bytes = [0u8; 16];
        memory.read(&caller, value_ptr as usize, &mut value_bytes)?;
        let value = u128::from_le_bytes(value_bytes);

        // ── 6. CHARGE gas for the byte-copy work ──────────────────────
        //
        // From HOST_FN_ABI_SPEC §7.8: 1,000 base + 8 per byte of
        // calldata. The base covers the dispatch overhead; the
        // per-byte rate covers the memcpy + the sub-call's serialized
        // input handling.
        caller.data_mut().consume_gas(
            1_000 + 8 * (calldata_len as u64),
        )?;

        // ── 7. Dispatch the actual sub-call ───────────────────────────
        //
        // This recurses into the engine: the engine pushes a nested
        // per-tx overlay, loads the target contract's WASM module
        // (from the module cache), invokes its named function with
        // the calldata as input, and either merges the overlay on
        // success or discards it on revert.
        let dispatch = caller.data_mut().dispatch_cross_call(
            &target,                  // target contract address
            fn_name_str,              // function name
            &calldata,                // serialized inputs
            value,                    // value to forward
            gas_limit,                // sub-call gas budget
        );

        // ── 8. Encode the result back into linear memory ──────────────
        match dispatch {
            // Sub-call returned successfully with some return data.
            Ok(return_data) => {

                // Write the return data into the contract's pre-allocated
                // output buffer. If the buffer is too small, the wasmtime
                // bounds check would catch it — but we should also enforce
                // that the contract's `return_data_out_ptr` had enough
                // capacity. (In practice, the contract should always
                // provision a large enough buffer or read the length
                // first and re-call.)
                memory.write(
                    &mut caller,
                    return_data_out_ptr as usize,
                    &return_data,
                )?;

                // Write the actual length into the contract's
                // return_data_out_len_ptr slot, so it knows how many
                // bytes are meaningful.
                let len_bytes = (return_data.len() as i32).to_le_bytes();
                memory.write(
                    &mut caller,
                    return_data_out_len_ptr as usize,
                    &len_bytes,
                )?;

                // Status code 0 = success.
                Ok(0)
            }

            // Sub-call failed with an error code.
            Err(error_code) => {
                // We still write a 0 into the length slot so the contract
                // doesn't accidentally read stale bytes from return_buf.
                let zero = 0i32.to_le_bytes();
                memory.write(
                    &mut caller,
                    return_data_out_len_ptr as usize,
                    &zero,
                )?;

                // Return the negative error code through the WASM call
                // return value. The contract pattern-matches on this.
                Ok(error_code)
            }
        }
    },
)?;
```

### 12.2 Why this design

Three properties fall out of this shape:

1. **The host never trusts the contract's pointers blindly.** Every `memory.read` and `memory.write` is bounds-checked by wasmtime. A malicious contract can pass nonsense offsets; the worst it can do is trap.

2. **The byte-copy cost is metered.** The 1,000-base + 8-per-byte formula isn't arbitrary — it directly reflects the real wall-clock cost of the memcpy operations in steps 2–5 + step 8. Big calldata = more wall-clock = more gas.

3. **The sub-call is a recursive engine entry.** When `dispatch_cross_call` runs, the engine handles the target's WASM exactly the same way it handled the calling contract: instantiate (or fetch cached `Module`), push overlay, invoke, charge gas, return. The target's `cross_call`s in turn recurse further. The only bound on call depth is the per-tx gas limit + an explicit stack-depth check (HOST_FN_ABI_SPEC §3.5b).

---

## 13. The end-to-end flow

Putting §6 (contract-side staging), §7 (the cross_call invocation), and §8 (host-side handling) together:

```
─────────────────────────────────────────────────────────────────────────
  CONTRACT A (e.g., a DEX router calling token.transfer)
─────────────────────────────────────────────────────────────────────────

  fn perform_swap(...) {
      ┌─────────────────────────────────────────────────────┐
      │ Stack frame in linear memory:                        │
      │   calldata:    [u8; 48]   ← recipient ++ amount     │
      │   zero_value:  [u8; 16]   ← no PYDE attached        │
      │   return_buf:  [u8; 32]   ← reserved for return data │
      │   return_len:  i32        ← reserved for length     │
      └─────────────────────────────────────────────────────┘

      cross_call(                              (a) WASM call ABI crosses
        target_ptr      = 0x1000,                  the boundary as 9 × i32
        fn_name_ptr     = 0x1080,                  + 1 × i64 raw value
        fn_name_len     = 8,                       words. NO data is
        calldata_ptr    = 0x1100,                  copied yet — just
        calldata_len    = 48,                      offset numbers.
        value_ptr       = 0x1200,
        gas_limit       = 100_000,
        return_data_out = 0x1300,
        return_len_out  = 0x1400,
      );
  }

                              │
                              ▼  wasmtime traps from WASM → registered host fn

─────────────────────────────────────────────────────────────────────────
  ENGINE (Rust on top of wasmtime)
─────────────────────────────────────────────────────────────────────────

  (b) Host now reads contract A's linear memory through wasmtime API.
      Each memory.read is a real memcpy from contract linear memory
      into the host's Rust heap.

      memory.read(0x1000, 32)  → target  = [u8; 32]    (target contract)
      memory.read(0x1080,  8)  → fn_name = "transfer"
      memory.read(0x1100, 48)  → calldata = recipient ++ amount
      memory.read(0x1200, 16)  → value = 0u128

  (c) Engine charges gas: 1,000 + 48 * 8 = 1,384 gas debit
                          from contract A's remaining budget.

  (d) Engine looks up `target` in the contract registry.
      Loads target's compiled wasmtime::Module from the cache.
      Pushes a nested per-tx overlay onto the state stack.

─────────────────────────────────────────────────────────────────────────
  CONTRACT B (target = token contract)
─────────────────────────────────────────────────────────────────────────

  (e) Engine instantiates target's module with a fresh wasmtime::Store.
      Engine invokes target's exported `transfer` function with the
      48-byte calldata loaded into target's linear memory at the
      conventional calldata location (or copied on-demand via
      pyde::calldata_copy host fn — depends on target's ABI choice).

      target executes — does its sload(balances[sender]) /
      sload(balances[recipient]) / sstore /  emit_event / etc.

  (f) target returns (or traps).
      On return: target's overlay merges into contract A's overlay.
      On trap:   target's overlay is discarded; contract A's overlay
                 is preserved (this is the per-call rollback semantics).

─────────────────────────────────────────────────────────────────────────
  ENGINE (after sub-call resolves)
─────────────────────────────────────────────────────────────────────────

  (g) Engine writes target's return data back into contract A's
      linear memory:
        memory.write(0x1300, &return_data)
        memory.write(0x1400, return_data.len().to_le_bytes())

  (h) Engine returns through wasmtime: i32 status code
      (0 on success, negative on error).

                              │
                              ▼  wasmtime returns from host fn → WASM

─────────────────────────────────────────────────────────────────────────
  CONTRACT A resumes
─────────────────────────────────────────────────────────────────────────

  (i) Contract A reads the status code from the WASM ABI return.
      If 0: contract A reads return_buf[..return_len] from its own
            linear memory to extract any return data.
      If negative: contract A pattern-matches on the error code and
                   decides whether to revert / retry / propagate.
```

### 13.1 What you actually pay for

For a single `cross_call` with 48 bytes of calldata and an empty return:

| Cost component | Amount |
|---|---|
| `cross_call` dispatch base | 1,000 gas |
| Calldata byte-copy (48 × 8) | 384 gas |
| Sub-call's actual `gas_used` | (varies; e.g., 5,000 for a typical transfer) |
| **Total deducted from caller** | ~6,384 gas |

The sub-call's `gas_used` is debited from the caller's remaining budget regardless of whether the sub-call succeeded or reverted — per HOST_FN_ABI_SPEC §7.8. This prevents an attacker from triggering expensive sub-calls and then reverting to avoid payment.

---

## 14. Common pitfalls

A non-exhaustive list of things that have bitten real Pyde contracts during development:

### 14.1 Endianness mismatch

**Symptom:** A contract writes `amount: u128 = 100` via `amount.to_be_bytes()`, the host reads via `u128::from_le_bytes` — you end up with a 16-byte big-endian on-wire representation interpreted as little-endian. The host sees `0x6400000000000000_00000000_00000000` instead of `100`.

**Fix:** Always little-endian on the wire. `to_le_bytes` / `from_le_bytes` on both sides.

### 14.2 Returning a pointer to a dropped local

```rust
// ❌ BROKEN: `local_buf` is dropped at the end of this function.
// The host fn copies bytes out synchronously, so within the call
// itself this works — but if you stash the offset and try to read
// it later (e.g., from another host fn callback), the offset now
// points into garbage.
pub fn broken_pattern() -> i32 {
    let local_buf = [42u8; 32];
    local_buf.as_ptr() as i32   // ← do NOT return this
}
```

**Fix:** For data that must survive past the current call, use `static mut` (§6.2) or heap allocation (§6.3). For data that only needs to live through one host call, stack-allocated is fine.

### 14.3 Forgetting to provision the return-length slot

**Symptom:** `cross_call` writes the actual return length into `return_data_out_len_ptr`, but you passed an uninitialized or shared slot — leading to garbage values for the length check.

**Fix:** Always declare `let mut return_len: i32 = 0;` (or equivalent in Go/AS) immediately before the call. Don't re-use a slot across multiple cross-calls without re-zeroing.

### 14.4 Returning a too-small buffer

**Symptom:** Sub-call returns 256 bytes of data; your `return_buf` is 32 bytes; wasmtime traps with `MemoryOutOfBounds` when the host tries to write past your buffer.

**Fix:** Size return buffers to the documented worst case for the target function. For unknown / variable-size returns, do a two-pass approach: first call with `return_buf = []` and read the length; second call with a buffer of that size. (Pyde's spec defers the formal "buffer too small" semantics to per-host-fn definitions — check the spec for each host fn before assuming.)

### 14.5 Forgetting that pointers are 32-bit

```rust
// ❌ BROKEN: `let ptr: i64 = my_array.as_ptr() as i64;`
//    On wasm32, my_array.as_ptr() is a 32-bit value. Casting to i64
//    sign-extends from i32 — which works numerically — but when passed
//    to a host fn declared with i32, the higher bits are silently
//    dropped, which is not what you want for any non-trivial pointer
//    pattern.
let ptr: i32 = my_array.as_ptr() as i32;   // ← correct
```

**Fix:** Always cast pointers to `i32` (or `usize` in AS / TinyGo). Host fn signatures use `i32` for pointers; matching exactly prevents subtle type-coercion bugs.

### 14.6 Importing a host fn that doesn't exist

**Symptom:** Deploy fails with `ERR_FORBIDDEN_IMPORT`.

**Fix:** Every imported function name must appear in the canonical ABI table (HOST_FN_ABI_SPEC §7 and §8). The deploy-time validator rejects unknown imports. Typos like `pyde::s_load` (extra underscore) vs `pyde::sload` (no underscore) are a frequent culprit.

### 14.7 Calling a parachain-only host fn from a non-parachain contract

**Symptom:** Deploy fails with `ERR_FORBIDDEN_IMPORT` for functions like `parachain_storage_read`, `send_xparachain_message`, `threshold_encrypt`, etc.

**Fix:** These functions are gated to parachain-typed modules at deploy time (HOST_FN_ABI_SPEC §9.2). If your contract needs them, declare `type = "parachain"` in `otigen.toml`; otherwise refactor to avoid the dependency.

### 14.8 Leaving `debug_log` calls in a production bundle

**Symptom:** `otigen build --strict` or `otigen deploy` fails with `import pyde.debug_log is a test-only host fn (forbidden on chain)`.

**Fix:** `pyde::debug_log` is a test-only host fn (HOST_FN_ABI_SPEC §9.3). `otigen build` (default) and `otigen test` accept it so the dev loop works. The production gate fires at `otigen build --strict` and at `otigen deploy` (which sets strict implicitly). Strip the calls — or guard them behind `#[cfg(feature = "debug")]` — before deploying.

```rust
// Development: print intermediate values during otigen test.
#[link(wasm_import_module = "pyde")]
extern "C" { fn debug_log(msg: *const u8, len: i32); }

fn dump(label: &str, value: u64) {
    let line = format!("{label}={value}");
    unsafe { debug_log(line.as_ptr(), line.len() as i32); }
}

// In a function:
dump("alice_balance", read_u128(FIELD_BALANCES, &alice) as u64);
```

Run `otigen test -v` and watch stderr for `[debug] <fn>: alice_balance=100`. Strip these calls (or guard them behind `#[cfg(feature = "debug")]`) before `otigen deploy`. A grep over the source tree (`grep -rn debug_log src/`) is sufficient.

---

## 15. References

- [HOST_FN_ABI_SPEC v1.0](./HOST_FN_ABI_SPEC.md) — normative ABI specification.
- [Chapter 3 — Execution Layer](../chapters/03-virtual-machine.md) — wasmtime runtime architecture, fuel metering, module caching.
- [Chapter 5 — Otigen Toolchain](../chapters/05-otigen-toolchain.md) — how `otigen build` invokes the language toolchain and emits the WASM binary.
- [PARACHAIN_DESIGN](./PARACHAIN_DESIGN.md) — parachain framework: registration, lifecycle, extended ABI surface, cross-parachain messaging.
- [OTIGEN_TEST_SPEC](./OTIGEN_TEST_SPEC.md) — test framework that runs contracts under the same wasmtime configuration the chain uses.
- [WebAssembly Core Specification](https://webassembly.github.io/spec/core/) — the upstream WASM spec for value types, linear memory, instruction semantics.
- **Examples catalog**: [`pyde-book/otigen/examples`](../otigen/examples.md) — full table of every canonical example with what each demonstrates, host fns exercised, and per-language test counts.
- [`otigen/examples/counter-token`](https://github.com/pyde-net/otigen/tree/main/examples/counter-token) — a canonical Rust contract demonstrating §2.3, §6.1, §6.2 patterns end-to-end. **Also available in TinyGo / AssemblyScript / C** at [`counter-token-go`](https://github.com/pyde-net/otigen/tree/main/examples/counter-token-go), [`counter-token-as`](https://github.com/pyde-net/otigen/tree/main/examples/counter-token-as), [`counter-token-c`](https://github.com/pyde-net/otigen/tree/main/examples/counter-token-c) — same TOML test suite runs against all four ports.
- [`otigen/examples/erc20-token`](https://github.com/pyde-net/otigen/tree/main/examples/erc20-token) — full ERC20-style fungible token. Exercises Phase 4 typed-arg marshalling (`address` / `uint128`), three storage layouts (scalar / mapping / composite-key), multi-topic events, and the `transfer_from` allowance flow.
- [`otigen/examples/simple-multisig`](https://github.com/pyde-net/otigen/tree/main/examples/simple-multisig) — 3-signer FALCON-512 multisig (§9 canonical example).
- [`otigen/examples/upgradeable-proxy`](https://github.com/pyde-net/otigen/tree/main/examples/upgradeable-proxy) — upgradeable proxy via `delegate_call` (§10 canonical example).
- [`otigen/examples/merkle-claim-airdrop`](https://github.com/pyde-net/otigen/tree/main/examples/merkle-claim-airdrop) — Merkle-tree airdrop claim with `hash_blake3` host fn (§11 canonical example).
- [RFC 9162 — Certificate Transparency v2](https://datatracker.ietf.org/doc/rfc9162/) — domain-separation conventions for hash-based commitment trees (§11.2 background).
