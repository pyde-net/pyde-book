# 03 — Running the Pivot-Era Benchmarks

This document is the reproducer for the benchmark numbers cited in the [pivot preface](../preface/pivot.md) and in [02 — The Otigen Language Era](./02-otigen-language-era.md).

The benchmarks measure the **pre-pivot PVM execution layer** (the now-retired `pyde-vm` interpreter and `pyde-aot` Cranelift-AOT compiler) in isolation. The benchmark code lives in the `archive` repository at `archive/crates/pvm/benches/` and `archive/crates/aot/benches/` (preserved after engine cleanup). You can run it today on any machine that has Rust installed.

The point of running these is not to validate Pyde TPS. The point is to see for yourself the relationship between interpreter throughput, AOT throughput, and storage-bound real-world workloads — the relationship that drove the WASM-pivot decision. The numbers favor WASM because they show that on storage-bound workloads (the ones that determine real chain TPS), the AOT advantage collapses, which means the VM choice does not move the needle.

## Reference machine for the numbers in the book

| | |
|--|--|
| CPU | Apple M4 Pro |
| Cores | 14 physical / 14 logical |
| RAM | 24 GB |
| OS | macOS 26.3.1 |
| Rust toolchain | stable (any recent stable release works) |

If your machine is faster, you will see higher numbers. If slower, lower. The **ratios** (AOT-vs-interpreter speedup, storage-bound vs compute-bound) should hold across hardware.

## Prerequisites

You need:

- A clone of the `pyde-net/archive` repository (where the retired pre-pivot crates live).
- A stable Rust toolchain. `rustup install stable` if you do not have it.

That is all. No extra build tools, no test fixtures to download.

## Step by step

```sh
# 1. Get to the archive workspace.
cd <your-pyde-checkout>/archive

# 2. Run the PVM interpreter benchmark.
cargo bench -p pyde-vm --bench interpreter_bench
```

Expected output shape:

```
=== 0236: Interpreter throughput ===

--- ALU dispatch (no memory, no storage) ---

  Loop iterations:   100000
  Instructions/run:  800005
  Runs:              100
  Total time:        ~270-300ms (depends on CPU)
  Throughput:        ~280-300 million instructions/sec
  Latency:           ~3-4 ns/instruction

--- ALU dispatch (with trace recording) ---

  Throughput:        ~310-340 million instructions/sec
  (slightly faster than no-trace by design — see bench comments)

=== 0237: Token transfer execution time ===

--- Token transfer: setup cost ---
  Latency:           ~2-3 µs/setup

--- Token transfer: execution only ---
  Throughput:        ~220-240 thousand transfers/sec (execution only)
  Latency:           ~4-5 µs/transfer

--- Token transfer: full lifecycle ---
  Throughput:        ~140-160 thousand transfers/sec
  Latency:           ~6-7 µs/transfer
```

```sh
# 3. Run the AOT-vs-interpreter benchmark.
cargo bench -p pyde-aot --bench aot_bench
```

Expected output shape:

```
=== AOT vs Interpreter throughput ===

  Interpreter:        ~280 million instr/sec
  AOT:                ~2.9 billion instr/sec
  Speedup:            ~10x (compute-bound)

=== AOT Token Transfer ===

  Interpreter (exec only):   ~230 thousand transfers/sec
  AOT (exec only):           ~240 thousand transfers/sec
  Speedup:                   ~1.0x  (storage-bound — this is the point)

=== AOT DEX Swap (constant-product AMM) ===

  Interpreter:        ~27 million swaps/sec
  AOT:                ~100 million swaps/sec
  Speedup:            ~3.7x  (mixed compute + state)

=== AOT compilation time ===

      4 instructions:   ~50 µs
     16 instructions:   ~100 µs
     64 instructions:   ~250 µs
    256 instructions:   ~950 µs
```

That is everything. Two cargo-bench invocations, two text reports.

## What the numbers mean — and what they don't

These are **single-thread micro-benchmarks of the execution layer in isolation**. There is no consensus running, no network, no parallel scheduling, no real RocksDB IO under sustained write pressure. They measure how fast one VM runs one workload on one thread.

What you should take from them:

- **AOT crushes interpreter on tight compute** (10× on ALU loops, 3.7× on AMM math). Cranelift is doing real work.
- **AOT advantage collapses on storage-bound workloads** (token transfer: 1×). This is the workload shape that dominates real blockchain throughput. The VM is not the bottleneck for real applications; storage IO is.
- **The interpreter is already fast**, around 280 million instructions per second on this hardware. Cold-cache execution paths in production do not have catastrophic latency.

What you should **not** take from them:

- **These are not Pyde's TPS numbers.** Full-chain TPS depends on consensus latency, signature verification throughput, network bandwidth, the parallel scheduler, and disk IO in addition to VM execution. The realistic v1 target of 10–30K plaintext TPS on commodity hardware reflects all of those layers combined, not just the VM.
- **These do not include parallel execution.** Each benchmark above runs one workload on one thread. The production scheduler runs many workloads in parallel via static access lists + Block-STM speculation; that compounds throughput but is measured separately by the full-chain harness, not here.
- **These do not separate memory reads from memory writes, or from disk IO.** The token-transfer benchmark exercises storage IO end-to-end as a single number; it does not isolate "Sload cost" from "Sstore cost" from "leaf-hash recomputation cost." That level of decomposition is the job of the per-component micro-benchmark suite (in flight; see below) and the full-chain performance harness.

## More detailed benchmarks (in flight)

The benchmarks above are deliberately simple — they were enough to drive the pivot decision. A more sophisticated suite is part of the planned performance harness work, covering:

- **Per-host-function micro-benchmarks** — measuring the cost of each WASM host function (sload, sstore, transfer, threshold_*, hashing primitives, etc.) in isolation, so the gas-cost table can be calibrated against real hardware.
- **Sequential vs parallel execution** — measuring how the access-list-driven parallel scheduler scales with core count on workloads with various access-conflict ratios.
- **Memory read vs memory write vs disk IO** — splitting state-layer cost by category, so the JMT + RocksDB + write-back cache (PIP-4) stack can be profiled independently.
- **Workload mixes** — realistic blends of transfer / token-op / DEX / NFT-mint / encrypted txs, with the realistic-mix fraction tracked over time.
- **Multi-region full-chain TPS** — the end-to-end measurement with consensus, network, and IO all under load.

Those benchmarks live with the performance harness, not in the engine bench files. See the [Performance Harness](../companion/PERFORMANCE_HARNESS.md) document for the full testing methodology, what's planned, and the "claim 1/3 of measured peak" discipline that governs how numbers are published.

## What you can do with this guide

- **Reproduce the pivot-decision numbers on your own hardware** — see the ratios for yourself.
- **Sanity-check the WASM-pivot reasoning** — confirm that storage-bound workloads neutralize the AOT advantage, the empirical observation that drives the "VM choice does not move TPS" claim.
- **Establish a baseline** for comparing future WASM-execution numbers — once the WASM execution layer ships, equivalent benchmarks can be run against it; the numbers should sit in the same ballpark (within ~10%) per the pivot's expected outcome.

## Where the benchmark code lives

| Benchmark | Source |
|-----------|--------|
| `interpreter_bench` | `archive/crates/pvm/benches/interpreter_bench.rs` |
| `aot_bench` | `archive/crates/aot/benches/aot_bench.rs` |
| (future) WASM-equivalent benches | `wasm-exec/benches/` in the fresh post-pivot engine repo (to be added) |
| (future) host-function micro-benches | same crate |
| (future) full-chain harness | separate repo (planned) |

The benchmark files live in the `archive` repository under `archive/crates/pvm/benches/` and `archive/crates/aot/benches/` — preserved with git history intact, runnable indefinitely. When the WASM execution layer ships in the freshly-cut post-pivot engine repo, equivalent benchmarks will be added under `wasm-exec/benches/` so the same workload shapes can be measured on the WASM stack for comparison.

## Reading on

- [Preface: The Pivot](../preface/pivot.md) — narrative context for these numbers.
- [02 — The Otigen Language Era](./02-otigen-language-era.md) — the full design record for the system being benchmarked.
- [Performance Harness](../companion/PERFORMANCE_HARNESS.md) — the multi-layer testing methodology that succeeds these micro-benchmarks.
- [Chapter 3: Execution Layer](../chapters/03-virtual-machine.md) — the WASM execution architecture that replaces what's being measured here.
