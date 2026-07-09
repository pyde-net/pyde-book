# Pivot: Historical Design References

This directory preserves Pyde's earlier architectural iterations as first-class historical material. Pyde has gone through two clean pivots that materially changed the protocol design, and the work that preceded each pivot is documented here so it can be studied, learned from, and properly credited.

Read [the preface](../preface/pivot.md) first if you have not already — it is the narrative companion to this directory. The preface tells the story; this directory holds the design records.

## Contents

| Document | Era | Status |
|----------|-----|--------|
| [01. The HotStuff Consensus Era](./01-hotstuff-consensus-era.md) | Pre-Mysticeti consensus design | Retired |
| [02. The Otigen Language Era](./02-otigen-language-era.md) | Pre-WASM execution design (custom language + VM + AOT) | Retired |

Each document summarizes what was designed, what was built, what was learned, and where the deep technical material lives (which archived repos, which book, which design docs). The summaries are not re-derivations of the original work — they are pointers + context for reading the originals correctly.

## Why this exists

Three reasons:

1. **The work is real.** Building these systems taught us what mattered and what did not. The current architecture is informed throughout by lessons from these earlier iterations. Pretending the work never happened would be both dishonest and counterproductive — future architects (Pyde or otherwise) can learn from the trade-offs we explored.

2. **Honesty is the project's posture.** Pyde's design has changed in response to evidence. Documenting the changes openly is the same discipline that made the changes possible. A reader who lands here looking for "why did Pyde stop using X?" deserves a real answer with real material, not a 404.

3. **Some of these designs are independently interesting.** The Otigen language, the custom register-based VM, the pre-Mysticeti HotStuff integration, the early access-list scheduler — these are not generic patterns. They were thought through carefully. Someone designing a similar system elsewhere may find the trade-offs documented here useful.

## How to read what's here

Each document follows the same shape:

- **What we built**: the design, in summary form.
- **Why we built it that way**: the constraints and reasoning at the time.
- **What we learned**: what survived the pivot, intellectually.
- **Where the original material lives**: links to archived code, archived docs, and the otigen-book for language-specific content.

Read in the order presented (01 then 02). The two pivots happened in sequence; the second was informed by lessons from the first.

## Reading order for the whole pivot story

1. [Preface: The Pivot](../preface/pivot.md), the narrative.
2. This directory's [01. HotStuff Era](./01-hotstuff-consensus-era.md) and [02. Otigen Era](./02-otigen-language-era.md): the design records.
3. The main book chapters — the current architecture.
