# Pyde Brand Reference

**Version 0.1** · canonical brand guidance for the Pyde wordmark, glyph, and visual system.

This page is the source of truth for anyone (designers, contributors, integrators, ecosystem teams) using the Pyde name or mark. If you are about to make a logo lockup, a poster, a sticker, or a third-party landing page, read this first.

For the *story* behind the name and the mark, see [How Pyde Works → What's in a name](../preface/how-pyde-works.md#whats-in-a-name).

---

## 1. The name

**Pyde** — pronounced *pied* (rhymes with **tide**).

| Form | Use |
|---|---|
| `Pyde` | Default, sentence-case. Use this almost everywhere — headings, prose, marketing copy. |
| `pyde` | Lowercase in URLs, handles, file names, code identifiers (`pyde-net`, `pyde.network`). The X handle is `@pydenet` (the available short form). |
| `PYDE` | Uppercase **only** when referring to the token / unit of account (`100 PYDE`, `gas paid in PYDE`). |
| `PYDE NETWORK` (all caps) | Not used. Only in occasional design-led headings if it serves a layout, never in body copy. |

**Do not:**
- Write `pYde`, `PyDe`, `pydE`, or any other mixed-case treatment.
- Translate the name. It is `Pyde` in every language.
- Spell it out as an acronym (`Programmable Yield Decentralized Engine` and other backronyms). The name is **not** an acronym. Drop it from any third-party marketing that suggests it is.

**Sentence patterns:**

> ✓ Pyde is a sovereign L1.  
> ✓ Send 100 PYDE to alice.pyde.  
> ✓ pyde.network/docs  
> ✗ The PYDE Network announces…  
> ✗ pYde launches mainnet  

---

## 2. The mark (glyph)

The mark is based on **atomic structure** — a nucleus and its orbital. Not a trend, not network imagery, not decorative. It looks like a physical law.

<img src="../assets/logo.png" alt="The Pyde mark" style="display:block; margin: 24px auto; max-width: 180px;" />

**Anatomy:**

- **The vertical form is the core.** Dense, gravitational, everything pulls toward it. Pyde is monolithic — consensus and execution in one place. Wide at the poles, compressed at the center: finality under pressure. Stress-tested and held.
- **The circle to the right is in orbit.** Independent, in motion, but bound to the core by an invisible force. External chains, bridges, light clients, portable finality certificates — they orbit. They are *verified*, not *trusted*.
- **The two are separate on purpose.** Related but sovereign. The composition is asymmetric — the orbital sits to the upper-right. Do not mirror, balance, or duplicate it. The core is fixed; the orbital can be anywhere.

**Geometry:**

- The orbital's diameter is about `0.40×` the core's widest width.
- The orbital's centre sits about `0.55×` the core's height from the top, offset right by about `0.85×` the core's widest radius.

Guidance, not pixel rules. To recreate, eyeball against `assets/logo.png`.

---

## 3. Lockups

| Lockup | Use |
|---|---|
| **Mark alone** | Favicons, app icons, profile pictures, social avatars, watermarks, very small footprints. Default for any context under 32×32 px. |
| **Mark + wordmark, horizontal** | Website headers, presentation cover slides, partnership materials. Wordmark sits to the right of the mark, baseline-aligned to the mark's vertical centre. Space between mark and wordmark = `1.0×` the mark's widest radius. |
| **Mark + wordmark, vertical** | Posters, stickers, merchandise. Wordmark sits below the mark, centered. Vertical space = `0.6×` mark height. |

**Clear space:** the mark must always have clear space around it equal to `0.5×` the mark's widest radius. No other graphic element (text, image, border) intrudes into this clear space.

**Minimum size:** the mark must not be rendered below 16×16 px. At sizes under 32×32 px, do not pair it with the wordmark.

---

## 4. Colour

The Pyde palette is black and white, with shades. Nothing more.

Restrained, calm, subtle — the visual posture matches the technical posture. The brand is meant to feel like a physical law: present, quiet, not asking for attention. Color noise doesn't belong here. The protocol is the product, not the palette.

| Token | Hex | Role |
|---|---|---|
| `--pyde-ink` | `#0d1117` | Primary dark — backgrounds, dark-theme surfaces, default body text in light mode. |
| `--pyde-shadow` | `#2a2f36` | Dark elevated — elevated surfaces on dark backgrounds, code-block fills. |
| `--pyde-mist` | `#7a8590` | Mid-gray — muted labels, captions, dividers. |
| `--pyde-veil` | `#e1e4ea` | Light elevated — soft surfaces on light backgrounds, subtle dividers. |
| `--pyde-paper` | `#f7f8fa` | Primary light — backgrounds in light mode, default body text in dark mode. |

These five grayscale tokens carry the entire brand. No accent palette. Color is not part of the brand.

**Mark colouring rules:**
- The mark is grayscale. The canonical rendering is the gradient version in `assets/logo.png`.
- A solid-black or solid-white version of the mark is acceptable for monochrome contexts (engraving, single-colour print, dark-on-light printing).
- Never recolor the mark. Not for theming, not for events, not for partnerships, not for special occasions.

**Why grayscale only:**

- The brand should feel like a physical law: present, calm, derived not designed.
- The mark is grayscale (a nucleus and its orbital, see §2). The palette mirrors that posture.
- A restrained palette stands out in a sea of colorful chains. Discipline reads as confidence.
- Color is reserved for one purpose only: the existing factory illustration (see §6), which predates this discipline and serves as a didactic diagram, not as brand surface.

---

## 5. Typography

Pyde uses **system fonts**. No custom typeface ships with the brand.

| Context | Font stack |
|---|---|
| Body, UI, code | `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` |
| Monospace (code, hashes, addresses) | `ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace` |

**Why system fonts:**
- Zero load time, perfect cross-platform rendering.
- Accessibility-first: respects the user's font-size preferences.
- No licensing complications for downstream community use.
- Consistent with Pyde's minimalism — the protocol is the product, not the typography.

When the brand needs a "voice" beyond system fonts (a presentation cover, a marketing illustration), use **Inter** (Bold or Black weight) for the wordmark only. Body type stays system.

---

## 6. The factory illustration system

The factory metaphor (see [How Pyde Works](../preface/how-pyde-works.md)) is a teaching illustration, not a brand surface. The animated SVG at `src/assets/factory-loop.svg` predates the grayscale-only discipline (§4) and retains its original color cues — droplets for transactions, an amber flash for wave commit, a green pillar for state, a gold lock for threshold encryption — as didactic shortcuts that help readers visualize Pyde mechanics at a glance.

These colors live in the animation only. They are not brand tokens. New illustrations default to the §4 grayscale palette; if differentiation beyond gray is needed, prefer pattern, opacity, line weight, or texture over color.

When making a new illustration:
- Use the §4 grayscale tokens.
- Lines are `1.4px` for structural elements, `0.6px` for fine detail.
- Corners are slightly rounded (`rx="2"` is the default).
- Animations loop on a 3-second cycle (matching the factory loop's tempo).

Diagrams that explain Pyde mechanics may reuse the factory's visual vocabulary in grayscale: droplets for transactions, boxes for vertices, pillars for state, exhaust for eviction, a flash for wave commit.

---

## 7. Voice and tone

This is the brand's voice — apply it to any official copy or external comms.

| Quality | Means |
|---|---|
| **Direct** | Short sentences. Active voice. Avoid "we are excited to announce." Just announce. |
| **Honest** | Numbers are real numbers. "Throughput is whatever the multi-region harness measures on commodity hardware — published only once it's measured" is a Pyde-voice sentence; "Pyde achieves limitless throughput" is not. |
| **Specific** | "Mysticeti-style consensus with 128-validator committee, FALCON-512 signatures" beats "next-generation consensus." Name the thing. |
| **Unpretentious** | No "L1 of L1s," no "ushering in a new era." If a competitor would write it, don't. |
| **Curious** | When something is hard or undecided, say so. The audience is technical; treating them as adults builds trust. |

**Examples:**

> ✓ Pyde commits in waves through a 128-validator Mysticeti-style consensus. Encrypted transactions stay sealed until the wave commits.  
> ✓ v1 ships realistic numbers, not aspirational ones. The throughput target is published only once the multi-region harness measures it on commodity hardware.  
> ✗ Pyde is the world's first post-quantum, MEV-resistant, infinitely scalable Web3 platform of the future.  
> ✗ We are revolutionizing how the world thinks about blockchain.  

---

## 8. Asset inventory

The canonical brand asset directory is `pyde-book/src/assets/` (also mirrored at `pyde-book/assets/`).

| File | Purpose |
|---|---|
| `logo.png` | Canonical full-colour grayscale mark, 500×500 px. Default for digital use. |
| `factory-loop.svg` | Animated illustration of the Pyde transaction lifecycle. The brand's visual vocabulary defined in motion. |

Pending (post-launch designer handoff):

- `logo.svg` — vector source of the mark (currently only PNG exists).
- `wordmark.svg` — vector wordmark in Inter Bold.
- `mark-monochrome.svg` — single-colour version for engraving, single-colour print.
- `social-card-default.png` — Open Graph + Twitter Card default image.
- `presentation-template.pptx` / `.key` — slide deck template with the brand applied.

---

## 9. Third-party use

Community projects, ecosystem partners, and individuals are welcome to use the Pyde mark and name to refer to Pyde, subject to these rules:

**Allowed without permission:**
- Use the name "Pyde" to describe Pyde, in factual reference (news articles, tutorials, code documentation, third-party tooling that integrates with Pyde).
- Display the mark to indicate compatibility or integration ("works with Pyde," "deploys on Pyde").
- Reuse `assets/logo.png` and `assets/factory-loop.svg` at original aspect ratios.

**Not allowed without permission:**
- Use the name "Pyde" in your product name (`PydeWallet`, `PydeDeFi`) in a way that implies official endorsement.
- Modify the mark (recolour, distort, add elements, reshape).
- Use the mark on merchandise sold for profit at scale.
- Imply official affiliation with the Pyde Foundation when none exists.

For anything ambiguous, default to asking. There is no formal trademark registration at v1; the goodwill is community-held.

---

## 10. This document evolves

The brand is young. This document is a snapshot, not a contract. As Pyde matures and a dedicated designer joins, expect:

- A formal logo grid + construction guidance.
- A full type system (likely a custom display face for the wordmark).
- A motion-design spec beyond the factory loop.
- A photography / illustration direction for marketing.

When that work lands, this document gets revised and the version number bumps.

---

**Document version:** 0.1

**License:** See repository root
