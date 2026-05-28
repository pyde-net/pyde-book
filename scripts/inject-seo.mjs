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

// ── Path → metadata resolver ─────────────────────────────────────

function resolveMetaForPath(relPath, manifest) {
  // Strip .html suffix so the manifest can use path-style keys
  // (e.g., "otigen" matches "otigen/01-quickstart.html").
  const noExt = relPath.replace(/\.html$/, "");

  // Find every section whose key is a prefix of this path; pick
  // the longest. Field-level fallback handles independent inheritance.
  const sections = manifest.sections || {};
  const matched = [];
  for (const [key, val] of Object.entries(sections)) {
    if (noExt === key || noExt.startsWith(key + "/")) {
      matched.push({ key, val });
    }
  }
  // Sort by key length descending; longest match first.
  matched.sort((a, b) => b.key.length - a.key.length);

  const def = manifest.default || {};
  // Walk matched + default in order; first-defined wins per field.
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
const sectionStats = {};
for (const file of htmlFiles) {
  const relPath = file.slice(BOOK_DIR.length + 1);
  const meta = resolveMetaForPath(relPath, manifest);
  const html = readFileSync(file, "utf8");
  const rewritten = rewriteHtml(html, meta);
  if (rewritten !== html) {
    writeFileSync(file, rewritten);
    updated++;
    // Telemetry: which section did this page resolve into?
    const sectionKey = meta.title; // proxy for grouping
    sectionStats[sectionKey] = (sectionStats[sectionKey] || 0) + 1;
  }
}

console.log(`[inject-seo] rewrote SEO on ${updated}/${htmlFiles.length} pages.`);
console.log("[inject-seo] per-section page count:");
for (const [title, count] of Object.entries(sectionStats).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${count.toString().padStart(4)}  ${title}`);
}
