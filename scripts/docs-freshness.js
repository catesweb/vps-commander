#!/usr/bin/env node
/**
 * docs-freshness.js — CI check for documentation drift.
 *
 * Verifies, for every tracked markdown file in the repo:
 *   1. Every `[text](#anchor)` link resolves to a real heading in the same file,
 *      using GitHub's heading-slug algorithm (lowercase, strip punctuation,
 *      collapse whitespace/hyphens).
 *   2. Every relative link (`file.md`, `file.md#anchor`, `../docs/x.md`) points
 *      at an existing file, and if it carries a fragment, that the fragment
 *      resolves to a heading in the target file.
 *   3. External URLs (mailto/tel/data) are passed over silently. http/https
 *      links are skipped by default (fast, offline push check) but are probed
 *      live when run with `--external` — a HEAD request per URL with a GET
 *      fallback for servers that reject HEAD. Intended for the scheduled
 *      `links` workflow, not the per-push `docs` job.
 *
 * Usage:
 *   node scripts/docs-freshness.js             # offline: anchors + relative links
 *   node scripts/docs-freshness.js --external  # + live HEAD/GET probe of http(s) links
 *
 * Fails (exit 1) on any drift so CI breaks instead of shipping stale docs.
 * No dependencies — plain Node (global fetch), runnable with node >= 18.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'reports', '.claude']);
const MD_EXT = '.md';

// ---------------------------------------------------------------------------
// GitHub heading slug — mirrors github-slugger used by GitHub itself
// ---------------------------------------------------------------------------
function githubSlug(headingText) {
  return headingText
    .toLowerCase()
    .replace(/[^\w\s-]/g, '') // strip punctuation, emoji, markup
    .trim()
    .replace(/[\s_-]+/g, '-'); // collapse spaces/underscores/hyphen runs
}

/** Returns a Map<slug, count> where duplicate headings get -1, -2, … suffixes. */
function headingSlugs(md) {
  const slugs = new Map();
  for (const match of md.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = githubSlug(match[1]);
    const n = (slugs.get(base) || 0) + 1;
    slugs.set(base, n);
    // GitHub suffixes duplicates: second occurrence of `foo` is `foo-1`, etc.
    if (n > 1) {
      slugs.set(`${base}-${n - 1}`, 1);
    }
  }
  return slugs;
}

/** Returns the plain text of every `##`-level heading (for TOC completeness). */
function h2Headings(md) {
  return [...md.matchAll(/^##\s+(.+?)\s*#*\s*$/gm)].map((m) => m[1]);
}

/** Extracts inline links `[text](url)` and `![alt](url)`. */
function inlineLinks(md) {
  const links = [];
  const re = /!?\[[^\]]*\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(md)) !== null) links.push(m[1]);
  return links;
}

/** Extracts reference-style definitions `[ref]: url` and their usages `[text][ref]`. */
function referenceLinks(md) {
  const defs = new Map();
  for (const m of md.matchAll(/^\[([^\]]+)\]:\s*(\S+)\s*$/gm)) {
    defs.set(m[1].toLowerCase(), m[2]);
  }
  const links = [];
  const re = /\[[^\]]*\]\[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    const url = defs.get(m[1].toLowerCase());
    if (url) links.push(url);
  }
  return links;
}

function collectLinks(md) {
  return [...new Set([...inlineLinks(md), ...referenceLinks(md)])];
}

function splitFragment(target) {
  const hash = target.indexOf('#');
  if (hash === -1) return { file: target, fragment: null };
  return { file: target.slice(0, hash), fragment: target.slice(hash + 1) };
}

function isExternal(url) {
  return /^(https?:|mailto:|tel:|data:|\/\/)/i.test(url);
}

// ---------------------------------------------------------------------------
// External link probing (--external)
// ---------------------------------------------------------------------------

const CHECK_EXTERNAL = process.argv.includes('--external');
const EXTERNAL_UA = 'docs-freshness-check (VPS Commander repo maintainer)';
const EXTERNAL_TIMEOUT_MS = 15000;
const EXTERNAL_CONCURRENCY = 8;

/** Collects unique http/https URLs referenced from any doc, mapped to the
 *  files that mention them. Fragments and non-http schemes are skipped. */
function collectExternalLinks(files) {
  const urlMap = new Map(); // url -> Set of files referencing it
  for (const abs of files) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    const md = fs.readFileSync(abs, 'utf8');
    for (const url of collectLinks(md)) {
      if (!/^https?:\/\//i.test(url)) continue;
      const clean = url.split('#')[0]; // fragments are client-side, not probed
      if (!urlMap.has(clean)) urlMap.set(clean, new Set());
      urlMap.get(clean).add(rel);
    }
  }
  return urlMap;
}

/** Probes one URL: HEAD first, GET fallback when HEAD is rejected or errors. */
async function probeUrl(url) {
  const attempt = async (method) => {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      headers: { 'User-Agent': EXTERNAL_UA },
      signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
    });
    if (res.body) await res.body.cancel(); // we only need the status line
    return res.status;
  };

  // HEAD is the polite first try. Some servers reject it with a status
  // (403/405/501) and some WAFs drop the connection outright — treat both as
  // "needs the GET fallback" rather than marking the link dead.
  let headStatus = null;
  try {
    headStatus = await attempt('HEAD');
  } catch {
    /* network error / timeout on HEAD — try GET before giving up */
  }
  if (headStatus !== null && headStatus < 400) {
    return { ok: true, status: headStatus };
  }

  try {
    const getStatus = await attempt('GET');
    if (getStatus < 400) return { ok: true, status: getStatus };
    if (getStatus === 429) return { ok: true, status: getStatus }; // throttled, not dead
    return { ok: false, status: getStatus };
  } catch (err) {
    return { ok: false, error: (err.cause && err.cause.code) || err.name || String(err) };
  }
}

/** Runs async work with a fixed-size worker pool (politeness to hosts). */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Probes every external URL; returns failures and a summary. */
async function checkExternalLinks(urlMap) {
  const entries = [...urlMap];
  const outcomes = await mapLimit(entries, EXTERNAL_CONCURRENCY, ([url]) => probeUrl(url));
  const failures = [];
  let ok = 0;
  entries.forEach(([url, files], i) => {
    const r = outcomes[i];
    if (r.ok) {
      ok++;
      return;
    }
    const why = r.status ? `HTTP ${r.status}` : r.error;
    failures.push(`${[...files].join(', ')}: dead external link "${url}" (${why})`);
  });
  return { failures, ok, total: entries.length };
}

function listMarkdownFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdownFiles(full));
    else if (entry.name.endsWith(MD_EXT)) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function main() {
  const files = listMarkdownFiles(ROOT);
  const failures = [];
  const stats = { files: 0, links: 0, filesChecked: 0, anchorsChecked: 0 };

  for (const abs of files) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    const md = fs.readFileSync(abs, 'utf8');
    const slugs = headingSlugs(md);
    const cache = new Map(); // abs path -> heading slug map for cross-file anchors
    stats.files++;

    // Every link must resolve (link direction).
    for (const url of collectLinks(md)) {
      stats.links++;
      if (isExternal(url)) continue;
      const { file, fragment } = splitFragment(url);
      const here = file === '' || file === '#';

      if (here) {
        // Same-file anchor link
        stats.anchorsChecked++;
        if (!fragment || slugs.has(fragment)) continue;
        failures.push(`${rel}: broken anchor "#${fragment}" (no matching heading)`);
        continue;
      }

      // Relative file link — resolve against the doc's directory
      const targetAbs = path.resolve(path.dirname(abs), file);
      if (!fs.existsSync(targetAbs)) {
        failures.push(`${rel}: missing target "${file}"`);
        continue;
      }
      stats.filesChecked++;

      if (!fragment) continue;
      stats.anchorsChecked++;
      if (!cache.has(targetAbs)) {
        cache.set(targetAbs, headingSlugs(fs.readFileSync(targetAbs, 'utf8')));
      }
      const targetSlugs = cache.get(targetAbs);
      if (targetSlugs && targetSlugs.has(fragment)) continue;
      failures.push(`${rel}: broken anchor "#${fragment}" in "${file}" (no matching heading)`);
    }

    // Completeness direction: every `##` section must have a TOC entry. This
    // only applies to files whose preamble (before the first `##` heading)
    // contains a bulleted list of same-file anchor links — the TOC. Reference
    // docs like knowledge.md, AGENTS.md, CLAUDE.md have no such preamble list
    // and are exempt. A body list item after the first section never triggers it.
    // Note: fresh regexes per use — a shared /g regex would carry lastIndex
    // state between .test() and .matchAll() and silently skip entries.
    const firstH2 = md.search(/^##\s/m);
    const preamble = firstH2 === -1 ? md : md.slice(0, firstH2);
    const TOC_LINE = /^- \[[^\]]+\]\(#([^)]+)\)/gm;
    const tocFragments = new Set([...preamble.matchAll(TOC_LINE)].map((m) => m[1]));
    if (tocFragments.size > 0) {
      for (const heading of h2Headings(md)) {
        if (/^contents$/i.test(heading.trim())) continue; // the TOC heading itself
        const slug = githubSlug(heading);
        // Match the base slug or a GitHub duplicate suffix (foo, foo-1, foo-2, …).
        const covered = [...tocFragments].some((f) => new RegExp(`^${slug}(-[0-9]+)?$`).test(f));
        if (!covered) {
          failures.push(`${rel}: "## ${heading}" has no table-of-contents entry`);
        }
      }
    }
  }

  // External link probing — opt-in via --external (scheduled workflow only,
  // so per-push CI stays fast and offline).
  let externalStats = null;
  if (CHECK_EXTERNAL) {
    externalStats = await checkExternalLinks(collectExternalLinks(files));
    failures.push(...externalStats.failures);
  }

  console.log(`docs-freshness: ${stats.files} markdown files, ${stats.links} links checked`);
  console.log(`  files resolved: ${stats.filesChecked} | anchors resolved: ${stats.anchorsChecked}`);
  if (externalStats) {
    console.log(`  external links: ${externalStats.ok}/${externalStats.total} reachable`);
  }

  if (failures.length) {
    console.error(`\n${failures.length} documentation drift issue(s):`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }

  const mode = CHECK_EXTERNAL ? 'anchors, relative links, and external links' : 'TOC anchors and relative links';
  console.log(`OK — all ${mode} resolve.`);
}

main().catch((err) => {
  console.error(`docs-freshness: unexpected error: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
