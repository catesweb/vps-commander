# VPS Commander — Imported Global Rules

Imported from `~/.claude/CLAUDE.md`. Markers: **[verbatim]** = unchanged from the
global file; **[adapted]** = scoped to this repo; **[N/A]** = does not apply here.
This file is the project-side copy so the rules travel with the repo; the global
file remains the source of truth — if they diverge, the global file wins.

This app also has project guardrails in `AGENTS.md` (design tokens, anti-slop,
motion framework, modal dialog behavior, validation workflow). Both files apply;
`AGENTS.md` is more specific to this codebase, this file is personal workflow.

Imported agent suite (in `.claude/agents/`, adapted from `~/.claude/agents/`):
`slop-auditor` (AGENTS.md enforcement), `web-compliance-officer` (a11y baseline),
`settings-schema-officer`, `panel-builder`, `component-library`,
`command-specialist`, `copy-manager`. Use them per their descriptions — e.g.
`@slop-auditor` after UI/CSS/HTML work (AGENTS.md §5).

---

## Workflow

- **Capture off-task recommendations in an internal `TODO.md`.** Whenever you offer
  a recommendation or suggestion that is NOT pertinent to the task at hand, add it
  to a git-ignored `TODO.md` at the repo root (internal use only — never commit it;
  it is in `.gitignore`). Organize entries by priority of necessity under
  🔴 Urgent / 🟡 Medium / 🟢 Low headings. Recommendations that directly serve the
  active task stay in the conversation, not the file. **[verbatim]**

- **Summarize and prompt for context reset when switching tasks entirely.** When the
  user moves to a new, unrelated task (not a continuation of the current one), first
  write a concise summary of the previous task's state — what was done, what remains,
  and where to resume — to a durable location (the project `TODO.md`, a memory file,
  or a relevant doc), since clearing will wipe the conversation. Then recommend the
  user run `/clear` to drop the stale context. Use `/compact` instead only when
  continuing the *same* task with less context. (Note: `/clear` and `/compact` are
  user-run harness commands; you cannot execute them yourself — surface the
  recommendation, don't claim to have run them.) **[verbatim]**

- **Accessibility baseline.** Every web surface must ship ADA + WCAG 2.1 AA
  accessible by default — it is not an optional pass. Baseline: one `<h1>` and
  logical heading order; a `<main id="main-content">` plus skip-to-content link;
  semantic landmarks with `aria-label` on each `<nav>`; descriptive accessible names
  on every icon button/link (never bare "Toggle theme" or ambiguous labels); never
  put `aria-hidden` on visible text; visible `:focus-visible` styles;
  `scroll-padding-top` so fixed headers don't cover focused targets; alt text on
  meaningful images; labels tied to every form field; AA color contrast; honor
  `prefers-reduced-motion`. Match the host project's stack and design system rather
  than bolting on an a11y widget/overlay (overlays like accessiBe don't create real
  compliance). **[adapted]** — this is an Electron desktop tool, not a public site;
  the a11y baseline applies (focus rings and reduced-motion are enforced in
  `AGENTS.md` §3–4, but aria labels and semantic landmarks are **not** yet covered
  there — enforce them per this rule). The **legal** baseline (Privacy Policy, ToS,
  Cookie notice, Client Services Agreement) is **[N/A]** — no data collection or
  cookies are involved. If this ever ships a public web service, revisit.

- **Never hand-roll web UI design — drive it with the design skills.** For any
  frontend design work (new components, de-slopping, redesigns), the core trio is
  mandatory and used together: `frontend-design` (aesthetic direction) + `impeccable`
  (anti-pattern detection/polish) + `ui-ux-pro-max` (layout/system decisions). For
  this repo, that composes with `AGENTS.md`'s token/anti-slop rules — skills set the
  direction, `AGENTS.md` enforces the palette and motion budget. Style direction for
  this app is `industrial-brutalist-ui` (the shipped design system) — use the others
  for new sites, not here. **[adapted]**

- **Use a motion skill for any animation or motion work without being asked.**
  Whenever the task involves animation or motion of any kind — CSS transitions/
  keyframes, scroll reveals, micro-interactions — invoke `remotion-best-practices`
  before writing code, applied within `AGENTS.md` §3's decision framework
  (frequency gates motion, custom easings, `prefers-reduced-motion`, delight
  budget). The app already spends its motion budget on title type-in, CRT sweep,
  alert flash, and modal transitions — new motion must earn its place. **[adapted]**

- **Heroes open with the subject's real artifact, not a generic template.** Avoid
  the default AI hero: centered text over a dark/gradient glow, an eyebrow pill, a
  serif headline with an italic accent word, and a row of chips. When the product
  has a quick interactive element, make that the hero and show it working. **[N/A]**
  for this dashboard — but the principle's closest analog here is the connect screen
  ('ESTABLISH SECURE LINK' type-in as the app's first impression): keep it the
  artifact, not a decorative splash.

## Repositories

- **Keep "superpowers" tooling and branding out of committed repos.** Never commit
  the `.superpowers/` directory, `docs/superpowers/` folders, or "superpowers:"
  -prefixed skill callouts inside docs. Keep `.superpowers/` in `.gitignore`, place
  design docs under neutral paths like `docs/specs/` and `docs/plans/`, and strip
  agentic-worker/sub-skill callouts from plan and spec docs before committing.
  **[verbatim]** — no `.superpowers/` exists here; `.gitignore` guard added.

- **Never add contributors.** Do not add `Co-Authored-By:` trailers, "Generated with
  …" lines, or any AI/tool attribution to commits, PRs, or other repo content. Only
  the repository owner is ever listed as a contributor. **[verbatim]**

- **Always keep READMEs updated and fresh.** Every change that affects user-visible
  behavior, configuration, commands, endpoints, file layout, or build/release workflow
  must be reflected in the README (and any related user-facing docs) before the change
  is considered complete — never leave stale info. Update the README in the same commit
  as the code change when practical, and re-verify it at the end of every task.
  **[verbatim]**

## Packaging

- **Always embed required assets so distributable executables are fully
  self-contained.** When producing a runnable build, embed fonts and other runtime
  resources into the binary and register them at startup rather than shipping loose
  files beside the exe. The deliverable should be a single executable with no
  companion folders.  **[adapted]** — **status: fixed.** xterm.js 5.3.0 + xterm-addon-fit and the
  latin-subset woff2 files for Barlow, Barlow Condensed, and JetBrains Mono are
  vendored under `public/vendor/` (`vendor/xterm/`, `vendor/fonts/`) and
  `index.html` now references them locally with a CSP that allows only `'self'`.
  Re-run `node scripts/vendor-fonts.js` when the font set/weights change. Keep
  `public/vendor/` in `electron-builder`'s `files` glob (`public/**/*` covers it).
