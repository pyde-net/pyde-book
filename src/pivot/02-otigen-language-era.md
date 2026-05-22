# 02 — The Otigen Language Era

The second large pivot Pyde went through was the retirement of the custom execution stack — language, VM, AOT, toolchain — in favor of WebAssembly via wasmtime. This document summarizes what we built in the Otigen-language era, why we built it that way, what we learned, and where the original material lives.

## What we built

A complete custom execution stack for Pyde, four interlocking components:

### Otigen — the language

`.oti` source files, surface syntax inspired by Rust, semantics tuned for blockchain execution:

- Reentrancy blocked by default; opt-in via the `#[reentrant]` attribute.
- Checked arithmetic by default; wrapping operations explicit.
- Typed storage via the `storage { ... }` block.
- No `tx.origin` — the language did not expose it.
- `#[view]` / `#[payable]` / `#[constructor]` function attributes.
- Compile-time access-list inference for the parallel scheduler.
- 4-byte function selectors derived from signature hashes.

### otic — the compiler

`.oti` source → PVM bytecode + JSON ABI. Architecturally a four-stage pipeline: lex → parse → resolve → typecheck → safety analysis → bytecode emit. Implemented in Rust as a standalone library + binary.

### pyde-vm — the virtual machine

A custom register-based VM:

- 16 × 64-bit general-purpose registers.
- 8 × 256-bit wide registers (for token amounts, hashes, signature components).
- 32-bit fixed-width instruction encoding.
- 62 opcodes covering ALU, memory, storage, crypto, host calls, and control flow.
- Static 4MB memory map with gas-metered page allocation.
- Trap-on-overflow by default.

### pyde-aot — the ahead-of-time compiler

PVM bytecode → native x86 / aarch64 machine code, via the Cranelift code generator. Compiled at contract deploy time; the resulting native function was cached forever (contracts were immutable).

### wright — the developer toolchain

Project-level CLI (init, build, test, deploy, wallet, console) analogous to Foundry for Solidity. Wrapped the otic compiler with project conventions and a deployment client.

## Why we built it that way

The original argument: Pyde was going to be opinionated about every layer (consensus, cryptography, state, MEV protection), so the language layer should be opinionated too. Otigen would be designed from day one around Pyde's semantics — encryption-aware, threshold-decryption-friendly, nonce-window-native, with tight gas accounting and a clean compilation target.

The constraints we wanted the language to address:

- **Reentrancy footguns** in Solidity contributed to billions of dollars of lost funds historically. Block by default.
- **Arithmetic overflow** caused the bZx incidents, the YAM rebase bug, others. Check by default.
- **Untyped storage** in EVM led to slot-collision bugs. Type it.
- **tx.origin** was a phishing vector. Do not expose it.
- **Dynamic dispatch unpredictability** broke parallel execution in EVM. Infer access lists at compile time.

These were real problems we wanted addressed structurally, not via developer discipline.

We also believed at the time that a custom VM with a custom instruction set, tightly designed for blockchain operations, would outperform a general-purpose runtime. The PVM's wide-register file was specifically designed for 256-bit token amounts and hash operations.

So we built the whole stack.

## What went right

Several pieces of the design worked exactly as intended:

- **Otigen's safety defaults** caught a class of contract bugs at compile time that would have been runtime failures in EVM.
- **Compile-time access-list inference** enabled the parallel scheduler to run non-conflicting transactions concurrently, a real performance win.
- **The wide-register file** was clean for 256-bit operations.
- **The AOT compiler** produced native code via Cranelift; benchmarks showed 10× speedup on tight ALU loops vs the interpreter.
- **The wright toolchain** offered a Foundry-quality developer experience.

The engineering work was real. The design was coherent. The team built it carefully.

## What went wrong

Two things, accumulating over time:

### One — the maintenance commitment was not one-shot

Building a language is a permanent commitment, not a one-time deliverable. Toolchain churn (Cranelift API updates breaking the AOT), feature requests from authors, security advisories, fuzzing, audit prep, documentation, IDE support — all of it had to be sustained continuously. The language was a parallel track of work that competed with the rest of the protocol for attention.

### Two — the speed argument did not hold

The case for keeping a custom VM rested on the assumption that custom-AOT would outperform a general-purpose WASM runtime. Investigation showed otherwise:

- Both pyde-aot and wasmtime use the same Cranelift backend.
- WebAssembly is the workload Cranelift was originally optimized for.
- Our Otigen front-end was newer, less battle-tested, less fuzzed.
- Direct benchmarks showed wasmtime-AOT throughput in the same range as pyde-aot.
- On storage-bound workloads (the workload shape that matters for blockchain TPS), the AOT-vs-interpreter advantage collapsed to roughly 1× regardless of which AOT was running.

Measured numbers from the existing PVM stack on commodity hardware:

| Workload | PVM Interpreter | PVM AOT | AOT speedup |
|----------|-----------------|---------|-------------|
| ALU dispatch | ~279M instr/sec | ~2.9B instr/sec | 10.4× |
| DEX swap | ~27M swaps/sec | ~100M swaps/sec | 3.7× |
| Token transfer | ~231K tps | ~243K tps | 1.05× (storage-bound) |

Token transfer — the canonical real-world workload — showed no meaningful AOT advantage because RocksDB IO dominates. WASM-AOT sits in the same range as PVM-AOT on the same backend. The custom VM was not faster on the workloads that matter.

## What we learned

The lessons that survived the pivot intact, expressed now in the WASM-era architecture:

1. **The VM is not the bottleneck.** Real blockchain throughput is signature verification + IO + consensus + network bandwidth, in roughly that order. The VM is the fifth contributor. A 10% VM-level slowdown is invisible to TPS.

2. **Sandboxing, determinism, gas semantics matter.** All three. The WASM execution layer enforces them via wasmtime's feature-flag config, fuel-based metering, and deploy-time validation. The Otigen-era discipline about these properties carried forward.

3. **Author safety is a property of host functions, not language syntax.** Reentrancy guards, checked arithmetic, type-safe storage access — all of these can be expressed as patterns in the WASM host-function ABI and the binding generators, without requiring authors to learn a new language. The current `otigen` toolchain (the binary; same name, new role) emits language-specific bindings that preserve these guarantees in Rust, AssemblyScript, Go, and C.

4. **Compile-time access lists work, regardless of source language.** The current architecture preserves access-list-inferred parallel scheduling; the lists are now produced by the binding generators from the `otigen.toml` state schema rather than by the Otigen compiler. Same property, different surface.

5. **A custom language costs more than its benefit returns.** The language was not Pyde's differentiator. The work spent on it was work not spent on the post-quantum consensus + crypto + state stack that actually is the differentiator. The pivot redirected that work.

## What survived

A lot, in fact:

- The **safety properties** Otigen aimed for — reentrancy guards, checked arithmetic, typed storage, no `tx.origin` — are preserved in the host-function ABI and the binding generators.
- The **compile-time access-list inference** is preserved (now produced by the binding generators from `otigen.toml`).
- The **state model** (JMT, PIP-2 clustering, dual-hash) was already architecturally separate from the VM; no changes needed.
- The **wave model**, **gas accounting**, **threshold encryption**, and all the consensus-side properties were preserved without change.
- The **otigen name** itself — repurposed for the developer toolchain, where it now describes the role of "making the ergonomics layer feel coherent and opinionated."

The pivot was localized to the VM and the language. Everything around it stayed.

## Where the original material lives

- **The otigen-book** — the canonical reference for the Otigen language. Preserved as a published historical artifact at `pyde-net/otigen-book` with a pivot-notice preface explaining the current status.
- **otic compiler source** — `pyde-net/otic` repo, archived (read-only).
- **wright toolchain source** — `pyde-net/wright` repo, archived (read-only).
- **pyde-vm and pyde-aot crate source** — `archive/crates/pvm/` and `archive/crates/aot/` in the umbrella repo, preserved with git history.
- **Original Otigen-era documentation** — `archive/` more broadly contains the pre-pivot READMEs, design notes, and benchmark plans.
- **Benchmark numbers** — see the bench files in `archive/crates/pvm/benches/` and `archive/crates/aot/benches/`. The numbers used in this document and in the preface were captured by running those benchmarks one final time before archival.

## Reading on

- [01 — The HotStuff Consensus Era](./01-hotstuff-consensus-era.md) — the first pivot.
- [Chapter 3: Execution Layer (WASM)](../chapters/03-virtual-machine.md) — the current execution model.
- [Chapter 5: Otigen Toolchain](../chapters/05-otigen-toolchain.md) — the new role for the Otigen name.
- [Preface: The Pivot](../preface/pivot.md) — the narrative version of both pivots.
