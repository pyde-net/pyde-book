#!/usr/bin/env node
/*
 * Post-build SEO meta-tag rewriter for The Pyde Book.
 *
 * mdBook ships a single `theme/head.hbs` that's concatenated into
 * every chapter's <head>. That means the og:title, og:description,
 * twitter:*, <meta name="description">, and JSON-LD blocks all
 * render with the SAME book-level description on every page —
 * which is bad SEO (Google + crawlers see "Pyde is a blockchain"
 * on the Otigen toolchain pages too).
 *
 * This script runs AFTER `mdbook build` and rewrites those meta
 * tags per-page based on `theme/seo.toml`. Crawlers see different
 * static HTML on each section.
 *
 * Inheritance: longest-prefix-wins per section. Each field
 * (title, description, image) falls back independently to the
 * next-shorter matching section, eventually to [default].
 *
 * Conventions match `scripts/build-sitemap.mjs`:
 *   - Node ESM (.mjs)
 *   - Zero deps (Amplify's standard image has Node; no install)
 *   - Read-only on `src/`, mutates `book/`
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const BOOK_DIR = join(REPO_ROOT, "book");
const SEO_MANIFEST = join(REPO_ROOT, "theme", "seo.toml");

// ── Minimal TOML parser ──────────────────────────────────────────
//
// Handles our specific use case: `[section]` + `[section."name"]`
// headers, and `key = "value"` string assignments. No arrays, no
// nesting beyond a single dot, no booleans/integers. Avoids a TOML
// dependency for parity with build-sitemap.mjs's zero-dep policy.

function parseToml(text) {
  const out = {};
  let cur = out;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const name = sectionMatch[1].trim();
      const parts = splitTomlPath(name);
      let target = out;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (i === parts.length - 1) {
          if (!target[p]) target[p] = {};
          cur = target[p];
        } else {
          if (!target[p]) target[p] = {};
          target = target[p];
        }
      }
      continue;
    }

    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
    if (kv && cur) {
      const k = kv[1];
      let v = kv[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      cur[k] = v;
    }
  }
  return out;
}

// Split a TOML section path on unquoted dots. Handles:
//   sections."otigen"           → ["sections", "otigen"]
//   sections."chapters/05-otigen-toolchain"
//     → ["sections", "chapters/05-otigen-toolchain"]
function splitTomlPath(name) {
  const out = [];
  let cur = "";
  let inQuote = false;
  for (const ch of name) {
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (ch === "." && !inQuote) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// ── Path → manifest fallback (section-level + default) ───────────
//
// The manifest provides FALLBACK values when per-page content
// extraction (below) yields nothing usable. Image always comes
// from the manifest (it's shared across pages by intent).

function resolveSectionFallback(relPath, manifest) {
  const noExt = relPath.replace(/\.html$/, "");
  const sections = manifest.sections || {};
  const matched = [];
  for (const [key, val] of Object.entries(sections)) {
    if (noExt === key || noExt.startsWith(key + "/")) {
      matched.push({ key, val });
    }
  }
  matched.sort((a, b) => b.key.length - a.key.length);
  const def = manifest.default || {};
  const resolve = (field) => {
    for (const m of matched) {
      if (m.val[field] != null) return m.val[field];
    }
    return def[field];
  };
  return {
    title: resolve("title"),
    description: resolve("description"),
    image: resolve("image"),
  };
}

// ── Per-page content extraction ──────────────────────────────────
//
// Title  = the page's H1 text (mdBook generates `<h1 class="...">...
// Description = first meaningful <p> after that H1, stripped of
// inline HTML, normalised whitespace, truncated to MAX_DESC_LEN
// chars at a word boundary with an ellipsis.

const MAX_DESC_LEN = 200;

function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&[a-zA-Z0-9#]+;/g, ""); // strip anything else
}

function stripInlineHtml(html) {
  // Replace block tags that should produce a space boundary,
  // then strip every remaining tag. Collapse whitespace.
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|li|h[1-6]|div|td|tr)>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateAtWord(s, max) {
  if (s.length <= max) return s;
  const sliced = s.slice(0, max - 1);
  const lastSpace = sliced.lastIndexOf(" ");
  const base = lastSpace > max - 40 ? sliced.slice(0, lastSpace) : sliced;
  return base.replace(/[\s,.;:!?—–-]+$/, "") + "…";
}

function extractPageMeta(html) {
  // Scope to mdBook's <main> element so we skip the nav/sidebar's
  // `<h1 class="menu-title">The Pyde Book` and only see the
  // actual page content. mdBook always emits `<main>` for the
  // chapter body.
  const mainMatch = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  const content = mainMatch ? mainMatch[1] : html;

  // First H1 inside <main>. mdBook adds `id="..."` for anchor
  // links + an inline `<a class="header" .../>` after the text.
  // Strip both the anchor + any other inline markup.
  const h1Match = content.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  let title = null;
  if (h1Match) {
    title = decodeHtmlEntities(stripInlineHtml(h1Match[1]));
    if (!title) title = null;
  }

  // First paragraph AFTER the H1 (still scoped to <main>). Skip
  // empty / very short paragraphs (typically figure captions or
  // stray markup).
  let description = null;
  if (h1Match) {
    const after = content.slice(h1Match.index + h1Match[0].length);
    const paragraphs = after.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi);
    for (const p of paragraphs) {
      const stripped = decodeHtmlEntities(stripInlineHtml(p[1]));
      if (stripped.length < 40) continue;
      description = truncateAtWord(stripped, MAX_DESC_LEN);
      break;
    }
  }

  return { title, description };
}

function resolveMetaForPath(relPath, manifest, html) {
  const fallback = resolveSectionFallback(relPath, manifest);
  const extracted = extractPageMeta(html);
  return {
    // Per-page title from H1; fall back to section/default.
    title: extracted.title || fallback.title,
    // Per-page description from first paragraph; fall back to
    // section/default.
    description: extracted.description || fallback.description,
    // Image is intentionally shared (section/default only).
    image: fallback.image,
  };
}

// ── HTML rewriter ────────────────────────────────────────────────

function escapeAttr(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Replace the `content="..."` attribute of a meta tag identified by
// either `property="..."` or `name="..."`. Anchored to a fresh
// attribute value each call so multiple rewrites compose cleanly.
function rewriteMetaContent(html, identifier, identifierValue, newContent) {
  // identifier is "property" or "name"
  const pattern = new RegExp(
    `<meta\\s+${identifier}="${escapeRegex(identifierValue)}"\\s+content="[^"]*"\\s*/?>`,
    "g",
  );
  return html.replace(
    pattern,
    `<meta ${identifier}="${identifierValue}" content="${escapeAttr(newContent)}">`,
  );
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rewriteHtml(html, meta) {
  let out = html;

  out = rewriteMetaContent(out, "name", "description", meta.description);

  out = rewriteMetaContent(out, "property", "og:title", `${meta.title}`);
  out = rewriteMetaContent(out, "property", "og:description", meta.description);
  out = rewriteMetaContent(out, "property", "og:image", meta.image);
  out = rewriteMetaContent(out, "property", "og:image:width", "1200");
  out = rewriteMetaContent(out, "property", "og:image:height", "630");

  out = rewriteMetaContent(out, "name", "twitter:title", meta.title);
  out = rewriteMetaContent(out, "name", "twitter:description", meta.description);
  out = rewriteMetaContent(out, "name", "twitter:image", meta.image);
  // Bump card type so the larger image renders on X / LinkedIn.
  out = rewriteMetaContent(out, "name", "twitter:card", "summary_large_image");

  // JSON-LD block: rewrite the `"headline"` and `"description"`
  // fields inside the application/ld+json script. The script body
  // is multi-line; match the first occurrence of each field with
  // a single-line regex (the source template uses one value per
  // line so this is robust enough).
  out = out.replace(
    /"headline":\s*"[^"]*"/,
    `"headline": "${escapeJsonString(meta.title)}"`,
  );
  out = out.replace(
    /"description":\s*"[^"]*"/,
    `"description": "${escapeJsonString(meta.description)}"`,
  );
  out = out.replace(
    /"image":\s*"[^"]*"/,
    `"image": "${escapeJsonString(meta.image)}"`,
  );

  return out;
}

function escapeJsonString(s) {
  if (s == null) return "";
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ── HTML directory walker ────────────────────────────────────────

function findAllHtml(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      out.push(...findAllHtml(p));
    } else if (name.endsWith(".html")) {
      out.push(p);
    }
  }
  return out;
}

// ── Main ─────────────────────────────────────────────────────────

const manifestText = readFileSync(SEO_MANIFEST, "utf8");
const manifest = parseToml(manifestText);
const sectionCount = Object.keys(manifest.sections || {}).length;
console.log(
  `[inject-seo] manifest loaded: ${sectionCount} section override(s) + default`,
);

const htmlFiles = findAllHtml(BOOK_DIR);
console.log(`[inject-seo] walking ${htmlFiles.length} HTML files...`);

let updated = 0;
let extractedTitleCount = 0;
let extractedDescCount = 0;
for (const file of htmlFiles) {
  const relPath = file.slice(BOOK_DIR.length + 1);
  const html = readFileSync(file, "utf8");
  const meta = resolveMetaForPath(relPath, manifest, html);
  // Telemetry: did extraction succeed for this page, or did we
  // fall back to the section default?
  const pageMeta = extractPageMeta(html);
  if (pageMeta.title) extractedTitleCount++;
  if (pageMeta.description) extractedDescCount++;
  const rewritten = rewriteHtml(html, meta);
  if (rewritten !== html) {
    writeFileSync(file, rewritten);
    updated++;
  }
}

console.log(`[inject-seo] rewrote SEO on ${updated}/${htmlFiles.length} pages.`);
console.log(`[inject-seo] per-page title  extracted from H1 on ${extractedTitleCount}/${htmlFiles.length} pages`);
console.log(`[inject-seo] per-page desc   extracted from <p> on ${extractedDescCount}/${htmlFiles.length} pages`);
console.log(`[inject-seo] (the rest fall back to section/default values from theme/seo.toml)`);
