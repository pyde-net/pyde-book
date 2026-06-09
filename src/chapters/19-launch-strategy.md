# Chapter 19: Launch Strategy

This chapter is the road from "code in a repo" to "live mainnet." The full sequenced plan lives in [the Roadmap](../roadmap.md); this chapter covers the principles and the shape, not the calendar.

There are no specific launch dates in this document. Phasing is honest; calendar commitments are not made.

---

## 19.1 Launch Philosophy

Three principles that shape every phase:

1. **Audit before stake.** Every line of consensus, cryptography, execution, and state-layer code goes through external audit before any user has serious skin in the game. The audit is not a formality.

2. **Testnet exposure before mainnet.** A multi-month incentivized testnet with reference contracts and external developers must run cleanly before any genesis ceremony. Real network conditions catch issues no simulation does.

3. **Voluntary launch.** No one is forced onto Pyde mainnet. The genesis validator set is recruited and validated; users opt in by deploying contracts and bridging value.

The plan is conservative on purpose. A delayed launch is recoverable; a botched launch is not. Bridge exploits and broken consensus hard-forks have ended chains.

---

## 19.2 The Shape of the Path

The roadmap groups work into sequenced phases. They are not strictly linear — many items run in parallel within a phase — but each phase has a bar that gates the next.

Summary, in order:

| Phase | Bar |
|-------|-----|
| Pivot foundations | Documentation, repo cleanup, foundational design specs |
| Engine cleanup | Pre-pivot crates removed from active workspace; archived for reference |
| WASM execution hardening | Single-language end-to-end (contracts deploy, execute, modify state, state verifiable) |
| Multi-language + parachain framework | All supported languages working; parachain governance + lifecycle complete |
| Public testnet | Multi-region committee, external developers building real contracts |
| Audit + stress + bug bounty | External audit complete; all critical findings resolved; stress testing passed |
| Mainnet candidate | Final build; validator set committed; genesis configuration locked |

The deliverables and exit criteria for each phase are in [the Roadmap](../roadmap.md), enumerated to the smallest actionable unit. This chapter does not duplicate them.

---

## 19.3 What ships at mainnet vs after

Pyde mainnet ships with:

- Post-quantum cryptography: FALCON signatures, Kyber threshold encryption, Poseidon2 + Blake3 hashing.
- Mysticeti-style consensus with sub-second median commit and 85-of-128 FALCON quorum certificates.
- WASM execution via wasmtime + Cranelift AOT, with the host-function ABI v1.0.
- JMT state with dual-hash (Blake3 + Poseidon2) per node, PIP-2 clustered keys, PIP-3 prefetch, PIP-4 write-back cache.
- libp2p + QUIC + Gossipsub networking with bootstrap-based peer discovery (no DHT).
- Native multisig accounts; ENS-style name registration for contracts and parachains.
- The `otigen` developer toolchain with Rust, AssemblyScript, Go (TinyGo), and C/C++ support.
- The Rust and TypeScript SDKs.

Mainnet does **not** ship with:

- Programmable accounts (post-mainnet — `Programmable` enum variant reserved at v1 so contracts written today survive).
- Native session keys (post-mainnet, paired with programmable accounts).
- Live parachain operator network (designed for v1, implementation in a later phase; the interfaces ship at v1 so the design forward-commits).
- ZK-aggregated FALCON signatures (the path to substantially higher signature-verification throughput; v2/v3 work).
- zk-WASM proven execution (research-stage; integrated when the upstream provers reach production quality).
- Cross-chain bridges to other L1s (post-mainnet, only with proven security models).

This split is intentional. v1 ships the properties that justify Pyde's existence — post-quantum security, MEV resistance, sub-second finality, commodity-hardware decentralization, multi-language WASM contracts. Everything else is sequenced honestly and shipped when ready.

---

## 19.4 The Publishing Discipline

A discipline carried forward from the consensus pivot:

> No external TPS claim is published until the performance harness exists, has been run on production-realistic conditions, and the methodology is reproducible by third parties. Publish only what the harness measures under sustained, production-realistic conditions — never burst, never microbenchmark, never single-machine if multi-region is the relevant scope.

The earlier consensus implementation hit roughly 4K TPS in lab tests despite a higher claimed design target. The discipline above prevents that gap from recurring. The v1 honest throughput target (to be established by the multi-region performance harness) on commodity validator hardware comes from this discipline.

See the [Performance Harness](../companion/PERFORMANCE_HARNESS.md) companion document for the testing methodology.

---

## 19.5 What carries forward from the pivots

For context (see [The Pivot](../preface/pivot.md) for the full story):

- **HotStuff-era consensus work** — properties, lessons, and invariants carry forward; the code is archived and the consensus layer is being rebuilt around Mysticeti.
- **Otigen-era execution work** — the safety properties (reentrancy guards, checked arithmetic, typed storage, no `tx.origin`, compile-time access-list inference) carry forward as patterns in the WASM host-function ABI and the binding generators; the language and custom VM are retired.

Both pivots reset the critical path for the affected layer but did not invalidate the work on adjacent layers (state, accounts, transactions, tokenomics, vesting, multisig, all preserved across both pivots).

---

## 19.6 Reading on

- [Roadmap](../roadmap.md) — the canonical sequenced plan with all phase deliverables.
- [Preface: The Pivot](../preface/pivot.md) — context on both architectural pivots.
- [Performance Harness](../companion/PERFORMANCE_HARNESS.md) — testing methodology.
- [Chapter 16: Security](./16-security.md) — threat model and audit scope.
- [Chapter 6: Consensus](./06-consensus.md) — the consensus design that ships at mainnet.
