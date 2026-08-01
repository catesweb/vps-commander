# VPS Commander — Global Development Guardrails

These rules apply to **every** change, by any agent or human. They exist to keep the
interface from decaying into AI slop: inconsistent tokens, magic numbers, `!important`
hacks, duplicated rules, misleading class names, and animation noise. A dedicated
`@slop-auditor` agent exists to check changes against this file — run it after any
UI/CSS/HTML work.

Read `knowledge.md` for architecture, REST API, and feature details.
Personal workflow rules (imported from `~/.claude/CLAUDE.md` — TODO.md capture,
a11y baseline, design-skill trio, self-contained packaging) live in `CLAUDE.md`
and apply alongside this file. This file is the codebase-specific part.

---

## 1. Design Tokens — no magic numbers

All colors, fonts, motion, and elevation come from `:root` in `public/css/styles.css`.
If a value already has a token, **use the token**. Never hardcode a hex color, font
stack, duration, or z-index that a token covers.

### Palette — strictly red / green / amber on neutral
- `--bg`, `--bg-panel`, `--bg-elevated`, `--fg`, `--fg-mid`, `--fg-dim`
- `--red`, `--red-bright`, `--red-dim`, `--green`, `--amber`
- `--border`, `--border-active`
- No rainbow. No new accent colors without a design decision. `rgba()` of an accent
  color must reference the token via `hexToRgba(cssVar('--x'), alpha)` in JS or the
  literal token value in CSS with a comment.

### Type
- `--font-mono` (JetBrains Mono) — data, code, terminals, labels
- `--font-sans` (Barlow) — UI body
- `--font-display` (Barlow Condensed) — headings, panel titles, stat values
- Numbers that shift (stats, clocks, tables, sizes) get `font-variant-numeric: tabular-nums`.

### Motion
- `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)` — entrances
- `--ease-inout: cubic-bezier(0.77, 0, 0.175, 1)` — movement
- `--dur-fast: 140ms`, `--dur: 200ms`
- **Never** `ease-in` for UI. Never `transition: all`. Specify exact properties.

### Elevation scale (z-index) — use the tokens
- `--z-overlay: 9990` — CRT display-effects family (sweep `+7`, noise `+8`, scanlines `+9`)
- `--z-modal: 10000` — modal backdrops and cards
- `--z-toast: 10100` — reserved for toasts (top of stack)
- Sticky table headers (`z-index: 1` on `.proc-table thead` / `.file-table thead`) are
  **contextual, off-scale** — leave them.
- No new magic z-index values. Ever.

---

## 2. Anti-Slop Rules

1. **No `!important` hacks.** If a rule loses a cascade fight, fix the specificity with
   a scoped selector (e.g. `.proc-table th.th-actions` beats `.proc-table th`), don't
   bolt on   `!important`. The only sanctioned `!important`s are the reduced-motion media
   query and two pre-existing utility rules (`.key-textarea` font-size, `.sound-path`).
2. **No duplicated rules.** Identical declarations belong in one comma-separated
   selector (`.proc-table th, .file-table th { … }`), not two copies. Duplicate
   definitions with the same specificity silently override each other by source order —
   a real bug class we've hit.
3. **No undefined classes.** Every class used in HTML/JS-generated markup must have a
   CSS rule (or be a documented JS hook). A class with zero CSS renders unstyled —
   check before shipping.
4. **No inline styles overriding tokens.** `style="padding:…; font-size:…; width:…;"`
   on elements that have a class is drift. Move one-off layout values into scoped
   classes (e.g. `.unlock-field { margin-top: 12px; }` instead of inline margin).
5. **No misleading class reuse.** Don't borrow another component's class for a
   different purpose (a docker count must not use `.ufw-status`). Either share a
   neutral base class or name a new one.
6. **No ambiguous names.** Class names one character apart from an existing one
   (`.th-action` vs `.th-actions`) are a footgun — disambiguate (`.th-ufw-action`).
7. **Structural integrity.** Every `<div>`/`<table>` pair balances. Tab panels must be
   siblings at the right depth — a panel nested inside the wrong parent renders
   invisible (the Docker-tab-inside-UFW bug). Verify with the balance check in §5.
8. **Consistent spacing.** Same-purpose control bars share gaps/padding
   (`.proc-controls`/`.ufw-controls` are both 8px). If a compact form legitimately
   differs, say so in a comment.

---

## 3. Motion Framework

From the animation decision framework — rare, delightful motion only:

- **Frequency gates animation.** Actions used 100+ times a day don't animate
  (tab switches, editor/bulk toggles). Rare moments can delight (connect title type-in,
  CRT sweep, modal open/close).
- **Open/close**: enter with `scale(0.97)` + fade, 200ms ease-out; exit faster (150ms
  fade). Never animate from `scale(0)`. Popovers scale from their trigger; modals stay
  centered.
- **Reduced motion**: every animation must be gated by
  `prefers-reduced-motion` (CSS media query or `modalPrefersReduced()`/`matchMedia` in
  JS). No animation is allowed to skip this.
- **Interruptible**: prefer CSS transitions over keyframes for anything the user can
  retrigger. Guard rapid reopen-during-close with timers (see `modalCloseTimers`).
- **Delight budget**: the app already has title type-in, scanline sweep, alert flash,
  modal transitions. New motion must earn its place.

---

## 4. UI/UX Rules

- **Modal dialog behavior** (all four modals: settings, editor, bulk, unlock):
  - Headers have `tabindex="-1"` + `.modal-header:focus-visible` ring.
  - `openModal()` moves focus to the header; callers may then focus a primary control.
  - Escape closes the **topmost** modal first (`modalStack`); the unlock gate is never
    Escape-dismissible.
  - `closeModal()` returns focus to the triggering element (`modalReturnFocus`).
  - Open/close go through `openModal()`/`closeModal()` only — never raw `display`
    toggles.
- **Focus-visible**: every interactive element gets a visible focus ring. Green is the
  global focus color; modal headers use red to match their accent.
- **Touch/pointer**: `:active` states scale elements `0.92–0.97`; hover is an
  enhancement, never the only affordance.
- **No layout shift**: use `tabular-nums`, fixed dimensions for changing content,
  `transform`/`opacity` for animation (never `height`/`width`).

---

## 5. Validation Workflow — do this before calling a change done

1. `node --check public/js/app.js` after any JS change.
2. After HTML changes, verify div/table balance:
   ```bash
   node -e "const h=require('fs').readFileSync('public/index.html','utf8');
   const o=(h.match(/<div[\s>]/g)||[]).length,c=(h.match(/<\/div>/g)||[]).length;
   const to=(h.match(/<table[\s>]/g)||[]).length,tc=(h.match(/<\/table>/g)||[]).length;
   console.log('divs',o,c,o===c?'OK':'FAIL','tables',to,tc,to===tc?'OK':'FAIL')"
   ```
3. After CSS changes, sweep for drift:
   - `grep -n "!important" public/css/styles.css` — every hit must be sanctioned.
   - `grep -n "z-index" public/css/styles.css` — every hit must be a token or the
     off-scale sticky headers.
   - Check no `th.*`/class used in HTML lacks a CSS rule.
4. Cross-check every new class in HTML ↔ CSS before shipping.
5. Spawn `@slop-auditor` after UI/CSS/HTML work, and `code-reviewer-deepseek-flash`
   after any significant change set.
6. After UI/HTML changes, run `npm run a11y` (axe-core/Playwright, WCAG 2.1 AA)
   against the connect screen + dashboard — it exits non-zero on serious/critical
   violations and writes the regression report to `reports/a11y/`.

---

## 6. Code Conventions (summary)

- Plain ES6+, no build step. 2-space indent, single quotes, semicolons.
- Global `State` object for mutable state; `dom` object for DOM refs; `$` helper.
- All modal visibility through `openModal()`/`closeModal()` (§4).
- `escapeHtml()` / `escapeAttr()` for every interpolated value in generated HTML.
- Audit-log every mutation via `settings.auditLog()` on the backend.
- The Swiss light theme is a token override on `[data-theme="swiss"]` — never a
  separate stylesheet. New components must work in both themes via tokens.

---

## 7. Documentation Freshness — keep the README current

- **Always keep the README updated and fresh.** Every change that affects
  user-visible behavior, configuration, commands, endpoints, file layout, or
  build/release workflow must be reflected in the README (and any related
  user-facing docs — `docs/SIGNING.md`, `CONTRIBUTING.md`, `knowledge.md`)
  before the change is considered complete — never leave stale info.
- Update the README in the same commit as the code change when practical, and
  re-verify it at the end of every task.

---

## 8. Repo Policy

- **Never add contributors.** Do not add `Co-Authored-By:` trailers, "Generated
  with …" lines, or any AI/tool attribution to commits, PRs, or other repo
  content. Only the repository owner is ever listed as a contributor.
