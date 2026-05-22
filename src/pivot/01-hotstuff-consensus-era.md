# 01 — The HotStuff Consensus Era

The first consensus protocol Pyde adopted was an in-house variant of **HotStuff**. This document summarizes that design, why we chose it, what it taught us, and where the original material lives.

## What we built

A linear, pipelined HotStuff variant tuned for Pyde's committee model:

- **Three-phase commit pipeline** — prepare, pre-commit, commit, decide, with each phase carrying a quorum certificate (QC) from the prior phase.
- **Leader-driven block production** — one leader per view, leaders rotate per view via deterministic rotation.
- **128-validator committee** — the same committee size we still use today (preserved across the pivot).
- **400ms slot timing** — target round duration of 400ms, with adaptive timeouts on view changes.
- **FALCON-512 quorum certificates** — 85-of-128 signatures aggregated into a QC, with the FALCON signature scheme preserved across the pivot.
- **Pipelined view changes** — to avoid the canonical HotStuff round-trip stall, view changes were pipelined into the steady-state flow.

The architecture lived in a `consensus` crate inside the engine workspace, alongside the (then-) PVM execution layer and the state crate.

## Why we built it that way

HotStuff was the orthodoxy of modern BFT at the time. Used by Diem (Meta's version that did not ship), adopted by Aptos, validated in academic literature, with reference implementations available. The properties looked right for Pyde:

- Linear message complexity (vs PBFT's quadratic).
- Optimistic responsiveness (commits at the speed of the network, not at fixed timeouts).
- Simple safety + liveness proofs.
- Established ecosystem of HotStuff variants to learn from (LibraBFT, AptosBFT, HotStuff-2).

The constraint set Pyde faced — equal-power validators, sub-second commits, geographic-distribution-tolerant — looked like a clean HotStuff fit on paper.

So we built it.

## What went wrong

Under load, in adversarial conditions — partial network partitions, slow validators, particular orderings of messages — HotStuff's commit latency tail ballooned. Median commits stayed under 100ms; tail commits ran out to 400ms and beyond. The chain "wedged" intermittently: not formally halted, just unable to deliver low-latency commits when conditions degraded.

We engineered against the tail for weeks. Tuning timeouts, re-ordering message handlers, experimenting with different leader-rotation schedules, adjusting the view-change protocol. Some of these helped at the margin. None of them got the tail under control structurally.

The honest read became: HotStuff's latency tail is not a tuning problem. It is a structural property of leader-based BFT under adversarial conditions. Different parameters give different tail shapes; none of them give a flat tail. We could keep grinding for another year and still ship a chain that wedged.

## What we learned

Three lessons survived the pivot intact:

1. **Tail latency is the UX killer, not median latency.** A chain that commits in 100ms on average but stalls for 400ms in the tail will feel broken to users. The current Mysticeti-based design is specifically chosen for its better tail-latency profile under adversarial conditions, not for its median performance.

2. **DAG consensus is structurally different from leader-based BFT, in ways that matter.** The single-leader bottleneck in HotStuff is what produces the tail; removing the bottleneck (per-round, every validator can produce a vertex) removes the structural source of the tail.

3. **Build to learn, but be willing to throw it away.** The HotStuff integration was real engineering work. We did not regret building it — we regretted not pivoting away from it sooner. The retrospective lesson: when the data says "this won't get there," act on it. Do not engineer-around the structural problem.

## What survived

Several pieces of the HotStuff-era architecture carried forward into the current Mysticeti-based design without change:

- The **128-validator committee size** with **85-quorum** threshold.
- The **FALCON-512 signature scheme** for quorum certificates.
- The **equal-power, VRF-rotated** committee selection model.
- The general **wave** abstraction (a periodic commit unit with an associated state root).
- Much of the supporting infrastructure: state layer, mempool admission, transaction types, validator lifecycle.

The pivot was localized to the consensus core. Everything that touched consensus from above or below stayed.

## Where the original material lives

- **Source code** — `archive/crates/consensus/` (in the umbrella repo). The HotStuff implementation, including the QC types, view-change protocol, and leader-rotation logic.
- **Design notes** — `archive/crates/consensus/CONSENSUS_INVARIANTS.md` documents the consensus invariants the HotStuff implementation upheld.
- **Original whitepaper** — `archive/WHITEPAPER.md` describes the early-architecture vision including HotStuff as the consensus choice.
- **Pre-pivot engine crates** — `archive/crates/` more broadly contains the consensus-adjacent crates from this era (mempool integration, transaction processing under HotStuff semantics).

The archive directory is preserved with git history intact. Anyone wanting to study the HotStuff-era implementation can browse it directly or check out the git revision before the consensus pivot.

## Reading on

- [02 — The Otigen Language Era](./02-otigen-language-era.md) — the second pivot, on the execution layer.
- [Chapter 6: Consensus (Mysticeti DAG)](../chapters/06-consensus.md) — the current consensus design.
- [Preface: The Pivot](../preface/pivot.md) — the narrative version of both pivots.
