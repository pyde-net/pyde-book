#!/usr/bin/env node
/*
 * Build-time sitemap.xml generator for the Pyde Book.
 *
 * mdBook doesn't ship a sitemap generator (the upstream issue has been
 * open for years). This script walks `src/SUMMARY.md`, extracts every
 * `[title](path.md)` link, converts each to its built URL on
 * book.pyde.network, and writes the result to `src/sitemap.xml`.
 *
 * mdBook then copies `sitemap.xml` straight to the build output as a
 * static asset (non-`.md` files under src/ pass through unchanged), so
 * the final URL is `https://book.pyde.network/sitemap.xml`.
 *
 * URL convention: Amplify is configured with clean URLs at the hosting
 * layer (the mdBook output is `book/chapters/06-consensus.html`, and
 * Amplify serves it at `/chapters/06-consensus`). We emit the clean
 * version in the sitemap — that's what users click on, that's what
 * Google indexes.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SUMMARY = join(REPO_ROOT, "src", "SUMMARY.md");
const OUTPUT = join(REPO_ROOT, "src", "sitemap.xml");
const SITE_URL = "https://book.pyde.network";

if (!existsSync(SUMMARY)) {
  console.error(`[sitemap] SUMMARY.md not found at ${SUMMARY}`);
  process.exit(1);
}

const raw = readFileSync(SUMMARY, "utf8");

// Match `[Title](path.md)` or `[Title](path.md "tooltip")` — the standard
// SUMMARY.md link forms. The unbracketed "prefix" / "suffix" chapters
// (no [...](...) wrapper) are SUMMARY headings, not pages — skip.
const linkRe = /\[[^\]]+\]\(([^)#?]+\.md)(?:\s+"[^"]*")?\)/g;

const seen = new Set();
const urls = [];
let m;
while ((m = linkRe.exec(raw)) !== null) {
  const mdPath = m[1].trim();
  if (mdPath.startsWith("http")) continue; // external links — skip
  if (seen.has(mdPath)) continue;
  seen.add(mdPath);

  // chapters/06-consensus.md → chapters/06-consensus (clean URL)
  let url = mdPath.replace(/\.md$/, "");
  // README.md folders collapse: pivot/README.md → pivot
  url = url.replace(/\/README$/, "");
  urls.push(`${SITE_URL}/${url}`);
}

// Always include the root explicitly.
urls.unshift(`${SITE_URL}/`);

const today = new Date().toISOString().slice(0, 10);

const xml = [
  `<?xml version="1.0" encoding="UTF-8"?>`,
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
  ...urls.map(
    (u) =>
      `  <url>\n    <loc>${u}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>${u.endsWith("/") ? "1.0" : "0.7"}</priority>\n  </url>`,
  ),
  `</urlset>`,
  ``,
].join("\n");

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, xml);
console.log(`[sitemap] wrote ${urls.length} URLs to src/sitemap.xml`);
