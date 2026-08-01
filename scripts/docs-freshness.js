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
 *   3. External URLs (http/https/mailto/data) are passed over silently — they
 *      need the network, not a lint.
 *
 * Fails (exit 1) on any drift so CI breaks instead of shipping stale docs.
 * No dependencies — plain Node, runnable with `node scripts/docs-freshness.js`.
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
function main() {
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

  console.log(`docs-freshness: ${stats.files} markdown files, ${stats.links} links checked`);
  console.log(`  files resolved: ${stats.filesChecked} | anchors resolved: ${stats.anchorsChecked}`);

  if (failures.length) {
    console.error(`\n${failures.length} documentation drift issue(s):`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }

  console.log('OK — all TOC anchors and relative links resolve.');
}

main();
