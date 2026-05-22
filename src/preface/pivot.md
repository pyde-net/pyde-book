# The Pivot

A note on how this book came to describe what it describes, and what changed along the way.

---

## Starting from a question

Pyde began with a simple question that turned out to be much harder than it looked:

_Can we build a post-quantum L1 that is actually fast?_

Not "fast in the abstract." Not "fast in a research paper." Fast enough that real users would not notice it was post-quantum at all. Fast enough that the security upgrade was free at the point of use.

That question is what this book is about. Everything else — the consensus choice, the execution model, the state layer, the crypto primitives — is downstream of trying to answer it honestly.

This preface is the story of the answers we tried, the answers we kept, and the answers we threw away.

---

## The first instinct: a small, sandboxed VM

The earliest sketches of Pyde leaned on something close to a BPF-style virtual machine. Solana had shown that a tight, sandboxed, register-based VM could run blockchain workloads at speeds that older designs (the EVM in particular) had no path to. The appeal was obvious: instead of inheriting a heavy stack-based VM with decades of cruft, start lean.

The thinking was: a small instruction set, a tight verifier, a fast interpreter or AOT, and crypto-friendly opcodes. Let the rest of the system inherit that lightness.

What we did not appreciate at the time — and what took building to learn — was that the VM is rarely the bottleneck on a blockchain. The bottleneck is consensus tail latency, signature verification, network bandwidth, and disk I/O, in roughly that order. The VM is the part you write last and that matters least. We would learn this the hard way, more than once.

But the BPF idea seeded something useful. It taught us to think in terms of sandboxing as a first-class property, not an afterthought. It taught us that "your own VM" is a commitment to building, maintaining, and securing an entire compiler toolchain — not a one-shot decision. Those lessons stuck. The specific implementation did not.

---

## The HotStuff phase and a 400-millisecond wedge

> For the full design record of this era, see [hotstuff-consensus-era](../pivot/01-hotstuff-consensus-era.md).

For consensus, we tried HotStuff first. It is the orthodoxy of modern BFT — used by Diem (the version that did not ship), Aptos, several other production chains. The literature is clean. The proofs are tight. The reference implementations are credible.

We picked it up and started integrating it.

For a while, things looked promising. Throughput was reasonable. The committee structure made sense. The pipeline of view changes felt mostly orderly. We started building around it: the mempool, the block production, the early state machine.

And then we ran into a wedge.

Under load, in adversarial conditions — partial network partitions, slow validators, particular orderings of messages — HotStuff's tail latency would balloon. We saw commits taking 400 milliseconds where the median was under 100. That tail was not a curiosity. It meant a real chain running under real conditions would routinely freeze for fractions of a second, and that was unacceptable for the kind of UX we wanted Pyde to enable.

We spent weeks trying to engineer around it. Tuning timeouts. Re-ordering message handlers. Experimenting with leader rotation strategies. Adjusting the view-change protocol. Some of these helped at the margin. None of them got the tail under control.

Eventually the honest read became: HotStuff is not the right base for what we are trying to build. The tail latency is not a tuning problem; it is a structural property of how leader-based BFT handles adversarial conditions. We could keep grinding on it for another year and not get there.

That was the first hard pivot.

We turned to the DAG family — Mysticeti, Narwhal, Blueshark. The DAG approach decouples data availability from ordering, removes the single-leader bottleneck per round, and gives the kind of tail latency profile we needed. Mysticeti specifically had the freshest design and the best throughput numbers in the literature.

We adopted it as the consensus design direction. The implementation is currently in progress — the HotStuff-era consensus crates are archived, and the new Mysticeti-based consensus layer is being built design-first against the post-pivot architecture. The architecture chapters that follow describe Mysticeti as the design Pyde is being built around, not as code that has already shipped.

The HotStuff work was not wasted. Building it taught us what a BFT pipeline really looks like under load. The instinct that "the latency tail is what kills UX" carried forward. But the code itself got archived. We learned, and we moved.

---

## A smaller pivot worth recording: SMT to JMT

Around the same time we were working on the consensus layer, we were also evaluating the state-commitment structure. The clean theoretical answer was a Sparse Merkle Tree — a fixed-depth-256 tree, one of the most studied constructions for accountable state. Beautiful on paper.

Expensive in practice. Every state read or write touches roughly 256 nodes because of the fixed depth. At realistic TPS, that overhead dominates the disk IO budget. The math did not close.

We switched to the Jellyfish Merkle Tree (JMT) — radix-16, path-compressed, production-validated by Diem and Aptos. Same authentication properties (Merkle commitment, inclusion and exclusion proofs), but roughly 5-10 nodes touched per operation instead of 256. The IO budget closes. The chain ships at a realistic TPS instead of an aspirational one.

The SMT lessons did not disappear. They informed the current dual-hash JMT design, where the Poseidon2 path gives us the ZK-proof properties SMTs are known for, while the JMT structure underneath keeps the IO cost manageable. This was a smaller pivot than the consensus and execution ones, but it followed the same pattern: pick the cleanest theoretical answer first, run the numbers, switch to the production-grade variant when the cleanest answer does not survive contact with reality.

---

## Building Otigen the language

> For the full design record of this era, see [otigen-language-era](../pivot/02-otigen-language-era.md). The complete language reference, syntax, semantics, and standard library documentation are preserved in the [otigen-book](https://github.com/pyde-net/otigen-book) (now with a pivot-notice preface).

Around the same time, we made another decision that would also need revisiting later.

We decided to design and build our own smart-contract language.

Looking back, this was not an irrational decision. Given what we knew then, it was rational. The argument went like this: if Pyde is going to be opinionated about consensus, about cryptography, about state — about every layer of the stack — then the smart-contract language should be opinionated too. Otigen would be designed from day one around Pyde's semantics. Encryption-friendly. Threshold-decryption-aware. Nonce-window-native. Tight gas accounting. A clean compilation target for our pVM bytecode.

So we built it.

We built the compiler (`otic`). We built the bytecode interpreter (`pyde-vm`). We built the Cranelift-based ahead-of-time compiler (`pyde-aot`). We built the standard library. We built the developer toolchain (`wright`). We wrote a book about it (the otigen-book, still preserved as historical reference). We documented opcodes. We designed type semantics. We dogfooded contracts.

Real engineering. Real months of work.

For a while, the bet looked good. Otigen had personality. Its syntax was clean. The pVM was lean. The integration with Pyde's primitives — threshold encryption, access lists, nonce windows — was tighter than any general-purpose VM could match.

What we did not see clearly at the time was that building a smart-contract language is not a one-shot deliverable. It is a permanent commitment to a category of work that competes against everything else the chain needs. A language has to keep up with the host platform (toolchain updates, Cranelift API churn, security advisories). It has to add features real applications need that we did not predict in version one. It has to maintain backwards compatibility, or pay the cost of breaking it. It has to be fuzzed, audited, and hardened against an open adversary. It has to be documented for new developers, supported in IDEs, debuggers, profilers, linters, formatters. It has to be taught.

The deeper question, the one we eventually had to ask honestly, was whether all that ongoing work was paying for the right things. The language was not Pyde's differentiator. Solana's BPF is not why people use Solana. Polkadot's WASM is not why people use Polkadot. Aptos's Move-language is closer to a differentiator, but even there the chain competes on consensus and security, not on Move itself. Smart-contract languages are tools. They matter for developer experience. They do not move the needle on the question Pyde was created to answer — _can we build a post-quantum L1 that is actually fast?_

The work we were spending on the language was work we were not spending on the answer.

So we ran the honest math.

---

## The honest reckoning

The decision was not made all at once. It accumulated.

There was the moment when a routine Cranelift API update broke the AOT compiler and took two days to chase down. There was the moment when a community developer asked whether they could write contracts in Rust, and we had to say "no, you have to learn Otigen first."

There was the moment when we read another paper on zk-WASM proving and realized that the WASM ecosystem was approaching native ZK execution proofs — work being pushed forward by several research groups in parallel — while a zk-Otigen prover would have to be built from scratch by us, and audited from scratch, and maintained from scratch.

There was the moment when we counted the audit surface honestly. A custom VM means:

- An internal audit of the bytecode interpreter, the AOT compiler, the sandbox boundary, the gas accounting, the trap handling.
- An external audit of all of the above, by a specialist firm willing to learn an instruction set that exists only here.
- Continuous fuzzing of the interpreter and the AOT against adversarial inputs.
- Re-audits whenever the language or the VM evolves.
- The same audit work, repeated, every year, indefinitely.

A WebAssembly runtime means: wasmtime, which is **already vetted as production infrastructure** by Bytecode Alliance, deployed at scale by Microsoft, Fastly, Shopify, and others. The sandbox has been fuzzed continuously for years. The instruction set is a public standard with academic and industrial scrutiny. We inherit that work at zero engineering cost. Our remaining audit surface shrinks to the host-function ABI and the chain-side integration — a small fraction of what a custom-VM audit would cost.

That was not a marginal saving. That was a reframe of how much engineering capacity Pyde would have to put into proving its own execution layer was safe, on a recurring basis, every year going forward.

And then there was the moment that settled it: we ran the numbers honestly.

The argument for keeping a custom VM had always rested on a quiet assumption — that our custom AOT, hand-tuned for our opcodes, would outperform a general-purpose WASM runtime. The reasoning sounded plausible: bespoke beats generic, surely. We had built `pyde-aot` carefully. It used Cranelift, the best open-source code generator outside of LLVM. It produced real native machine code. We had spent months on it.

So we looked at wasmtime. And we found out something that changed the whole equation.

Wasmtime also uses Cranelift. The exact same backend. The same code-generation passes. The same register allocator. The same machine-code emitter. The difference between `pyde-aot` and wasmtime's AOT was not the optimizer — it was the front-end that fed instructions into Cranelift.

And the WASM front-end is the path Cranelift was _originally_ optimized for. WebAssembly is the workload Cranelift was built to serve well. Years of optimization passes, edge cases, calling-convention refinements — all targeted at WASM. Our Otigen front-end, by comparison, was new code touching the same backend. It had not been adversarially fuzzed. It had not benefited from a hundred outside contributors finding obscure miscompiles. It worked, but it was newer, less battle-tested, with smaller margins for the optimizer to extract performance from.

We then ran our own benchmarks instead of guessing. Real measurements on the existing PVM stack, on a developer workstation:

- **PVM interpreter, ALU dispatch:** ~279 million instructions per second.
- **PVM AOT, ALU dispatch:** ~2.9 billion instructions per second. A 10× speedup on tight compute loops.
- **PVM AOT, DEX swap (constant-product AMM):** ~100 million swaps per second, 3.7× faster than interpreted.
- **PVM AOT, token transfer (storage-bound):** ~243K transfers per second — essentially identical to the interpreter's ~231K. Storage IO dominates; the AOT compute advantage disappears.
- **AOT compilation cost:** under one millisecond for contracts under 256 instructions.

> These numbers are single-thread micro-benchmarks of the execution layer in isolation — one VM, one workload, no consensus, no network, no parallel scheduling. They measure raw VM throughput, not end-to-end TPS. Full-chain TPS is governed by consensus latency, signature verification, network bandwidth, parallel scheduling, and disk IO in addition to VM execution; the realistic v1 target of 10–30K plaintext TPS on commodity hardware reflects all of those layers combined. The numbers above are useful for the VM-vs-VM comparison; they are not the chain's TPS.
>
> **Hardware used:** Apple M4 Pro, 14 cores, 24 GB RAM, macOS 26.3.1.
>
> **Reproduce these numbers yourself:** see [pivot/03-running-benchmarks.md](../pivot/03-running-benchmarks.md) for the exact commands and the expected output shape.

Those are real numbers, not extrapolations. They tell us several things about where the VM actually matters.

The 10× speedup is on tight ALU loops. Real smart contracts are not tight ALU loops. They are storage reads, storage writes, signature checks, event emissions — workloads where the AOT-versus-interpreter gap collapses to roughly 1× because the bottleneck moves to RocksDB and to cryptographic verification, neither of which the VM can speed up. So the actual workload Pyde runs barely cares which VM compiles it.

When we mapped this against published wasmtime numbers — Cranelift-AOT WASM landing within 80-95% of native speed on compute, the interpreter at 10-30% of native — the comparison sat in the same range as our measurements. The two stacks are not in different leagues. They are in the same league, on the same backend, for the same reasons.

The interpreted comparison told the same story. A WASM interpreter (the fallback path when AOT cache is cold) achieves roughly the same throughput as our PVM interpreter — both sit in that 10-30 percent of native range, because both pay the dispatch cost. There was no meaningful interpreted-vs-interpreted advantage either.

So the speed argument for keeping Otigen quietly disappeared. The custom VM was not faster on the workloads that matter. It was just smaller-team-maintained, less-fuzzed, and lonelier.

What WASM offered was not just a comparable runtime. It was an _already-vetted_ one. Production-deployed at Fastly and Microsoft and Shopify. Continuously fuzzed by an open community. Maintained by an entity that exists to maintain it. And we would pay essentially zero engineering capacity to inherit all of that — no compiler to support, no language to teach, no security maintenance to schedule. We got the speed plus the platform plus the ecosystem, in exchange for retiring a custom stack we had built for reasons that no longer held.

There was the moment when we looked at the surface area a credible v1 requires — consensus correctness, threshold cryptography, state sync, slashing, validator lifecycle, network protocol, parachain framework, audit prep — and realized that an in-house language committed us to maintaining a parallel track of work that competed with all of those for attention. Not because the language was harder than the consensus or the crypto. Because the language was _optional in a way the others were not_. Every chain ships consensus and crypto and state. Few chains ship their own language. The ones that do (Move, Vyper, Otigen) carry that as a perpetual obligation, and it is rarely the thing that determines whether the chain ships well.

We decided that Pyde would compete on what is actually unique to Pyde — post-quantum consensus, threshold-decrypted mempool, the cryptography stack — and inherit the rest from established WebAssembly tooling.

Pyde's execution layer pivoted to WebAssembly via wasmtime. Authors write contracts in Rust, AssemblyScript, Go, or C — whatever they already know. The compilation target is well-defined, the runtime is battle-tested in production at Fastly and Microsoft and Shopify, the sandboxing is verified by years of fuzzing, the gas-metering is built in, and the ZK-readiness path has actual researchers working on it.

This was not a defeat. It was the right call. The work we did building Otigen taught us what mattered (sandboxing, determinism, gas semantics, tight integration with Pyde primitives) and what did not (a custom syntax we had to teach the world). Everything that mattered carried forward into how we expose Pyde's primitives as WebAssembly host functions. The work was not wasted. The language was retired, but its lessons live in the new architecture.

### The Otigen safety goodies are preserved

Worth being explicit about this because it is easy to assume a language-retirement loses the safety properties the language enforced. It does not.

Otigen's design defaults — **reentrancy blocked by default**, **checked arithmetic**, **typed storage**, **no `tx.origin`**, **compile-time access list inference**, **the `#[view]` / `#[payable]` / `#[reentrant]` / `#[sponsored]` / `#[constructor]` attribute set** — are all preserved unchanged in the WASM era. They are now expressed as language-native attributes (Rust `#[pyde::view]`, AssemblyScript `@pyde.view`, Go `//pyde:view`, C `PYDE_VIEW`) that the build tool extracts into the ABI; the runtime applies the same guards it would have applied under Otigen.

Reentrancy is still blocked by default. The reentrancy guard is enforced at the WASM execution layer for every function not marked `#[reentrant]`. The author who writes nothing is still protected — exactly as in the Otigen era. See [Chapter 5: Otigen Toolchain](../chapters/05-otigen-toolchain.md) §5.6 for the full attribute surface and per-language declaration syntax.

The mechanism changed (build-time metadata + runtime enforcement instead of language compiler). The author experience and the safety guarantees did not.

## What we got from the pivot

Worth naming explicitly, so the trade-offs are visible:

- **An already-vetted execution platform.** Wasmtime is production infrastructure at Microsoft, Fastly, Shopify, and many others. The sandbox boundary, the determinism guarantees, the fuel-metered gas, the validation pipeline — all of it has been fuzzed continuously and hardened in adversarial conditions for years. We did not have to build any of it.

- **A dramatically smaller audit surface.** A custom VM means auditing the interpreter, the AOT compiler, the sandbox, the gas accounting, the traps, and the language compiler — all from scratch, internally first and then externally, then re-audited as the system evolves. With wasmtime, our audit surface is the host-function ABI and the chain-side integration. Smaller scope, lower cost, faster turnaround, fewer specialists required.

- **Years of compounding maintenance work avoided.** No language to keep current. No compiler to keep current. No AOT to keep current. No standard library to maintain. No IDE plugins, no debuggers, no formatters, no linters to write from scratch. The maintenance burden of a custom-language stack is permanent; pivoting away from it returns that capacity to Pyde's actual differentiators.

- **A clean ZK readiness path.** zk-WASM is an active research area with multiple groups pushing it toward production. When mature, the provers slot in over our existing wasmtime execution — no re-tooling required on our end. zk-Otigen, by contrast, did not exist and would have been a multi-year side project for us alone.

- **Multi-language support out of the box.** Authors write Pyde contracts in Rust, AssemblyScript, Go (via TinyGo), or C/C++. The barrier to entry is "the language you already use," not "the language Pyde wants you to learn." Developer adoption stops being gated by syntax familiarity.

- **A larger ecosystem of tooling.** Block explorers, debuggers, profilers, fuzzers, formal verification tools — all exist for WebAssembly. We inherit them. Pyde-specific tooling can layer on top instead of starting from zero.

- **Time savings, measured honestly.** The engineering capacity we would have spent maintaining Otigen — language design, compiler bug fixes, AOT bug fixes, standard library work, security advisories, ecosystem support — flows directly into the work Pyde actually competes on: post-quantum consensus, threshold cryptography, state-layer performance, validator lifecycle, parachain framework.

The trade-off we accepted: a small overhead on tight compute loops (which the benchmarks show is negligible for blockchain workloads, where storage IO dominates) and the loss of "Pyde has its own VM" as a marketing line (which was never a real differentiator anyway). For that price we got everything above.

The Otigen name lives on too. The new developer toolchain — the binary that scaffolds projects, generates state bindings, builds WASM artifacts, and deploys them — is called `otigen`. The same name, repurposed for the role it serves best: making the ergonomics layer feel as opinionated and integrated as the language was meant to be. The original otigen-book is preserved as a historical artifact, a snapshot of an earlier design phase that taught us what we needed to learn.

This is the same posture Rust's `cargo` takes (named for shipping containers, not for a programming concept) or Foundry's `forge` and `cast` take (craft-naming for tools). The name describes the role in the workflow, not the underlying technology.

---

## Where we are now

The architecture that this book describes is the architecture after the pivots:

- **Consensus:** Mysticeti-style DAG, anchor-every-round, tail-latency-aware.
- **Execution:** WebAssembly via wasmtime, with Cranelift AOT for hot paths.
- **State:** Jellyfish Merkle Tree with dual hashing (Blake3 + Poseidon2), PIP-2 clustered slot keys for cache locality, dual roots so we can serve both standard light clients and future ZK light clients from the same tree.
- **Cryptography:** FALCON for signatures (post-quantum), threshold decryption as an opt-in mempool privacy path, Poseidon2 as our ZK-friendly hash, Blake3 for fast general hashing.
- **Developer experience:** the `otigen` binary owns the entire authoring lifecycle. Authors write only their contract logic and a `otigen.toml`. Everything else — language detection, build invocation, state binding generation, ABI emission, deploy-tx submission — is handled by the tool.
- **Parachains:** WASM runtime per parachain, equal-power governance, full upgrade history retention, ENS-style name registration.

Each of these is the result of trying something else first, hitting a wall, and learning what the wall was made of. The book chapters that follow describe each layer in detail. This preface is here so that when you read about Mysticeti instead of HotStuff, or WASM instead of Otigen-the-language, you know that those choices were the outcome of work, not first instincts.

The first instincts were wrong, mostly. The current architecture is what was left after the wrong ones were honestly retired.

---

## What this pivot does not change

It is worth being explicit about what stays the same, because the changes have been substantial and a casual reader could conclude that everything is in flux. It is not.

The core thesis is unchanged: post-quantum from day one, practical performance, decentralized validator set, light-client-verifiable state, opt-in transaction privacy via threshold decryption.

The consensus model is unchanged from the Mysticeti pivot onward: DAG-based, anchor-per-round, equal-power VRF-rotated committee.

The state layer is unchanged from the JMT decision onward: versioned Merkle tree, hash-friendly to both general hashing and ZK provers, PIP-2 clustering for locality.

The cryptography is unchanged: FALCON, Poseidon2, Blake3, threshold decryption via DKG.

The PIPs (Pyde Improvement Proposals) — PIP-2 clustered state keys, PIP-3 scheduler-level prefetch, PIP-4 application-level write-back cache, the dual-hash JMT — all carry forward unchanged. They are layer-agnostic. The execution VM does not affect them.

The pivot is localized. Most of Pyde's design carries through.

---

## What this book is, and is not

This book is the current architecture of Pyde, as honestly as we can describe it. It is updated as design decisions land. The chapters that follow assume the pivots described here have happened; they do not repeatedly say "after the WASM pivot" or "before the consensus change." Read those as historical facts that informed what is described here.

This book is not a marketing document. It does not promise speeds we have not measured. It does not list partnerships that do not exist. It does not paper over the parts of the design that are still hard. Where something is uncertain, we say so. Where we have changed our minds, we say that too.

If you came here looking for a clean, never-pivoted, always-knew-the-answer story — that is not what Pyde is, and not what this book is. Pyde is what happens when someone decides to build a post-quantum L1, runs into every wall the architecture has to offer, and writes down what remained after the dust settled.

For the deep technical material on the earlier iterations — the HotStuff consensus design that preceded Mysticeti, and the Otigen language design that preceded WebAssembly — see the [Pivot folder](../pivot/README.md), which includes the design records and a step-by-step guide to [running the pivot-era benchmarks](../pivot/03-running-benchmarks.md) on your own machine. The narrative is here; the design records are there.

The book starts now.
