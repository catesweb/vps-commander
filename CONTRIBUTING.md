# Contributing to VPS Commander

Thanks for taking an interest in VPS Commander — a cross-platform Electron desktop app for monitoring and controlling cloud-hosted VPS servers. This guide covers everything you need to build, test, and submit changes.

> **Before you start:** this project is **single-maintainer and single-author**. All commits are authored by the repository owner — do **not** add `Co-Authored-By:` trailers, "Generated with …" lines, or any AI/tool attribution to commits or PRs. Only the repository owner is ever listed as a contributor.

- [Development Setup](#development-setup)
- [Project Layout](#project-layout)
- [Code Style](#code-style)
- [Design System Guardrails](#design-system-guardrails)
- [Testing & Validation](#testing-validation)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Release Process](#release-process)
- [Reporting Issues](#reporting-issues)
- [Security](#security)

---

## Development Setup

### Requirements

- **Node.js 20+** and npm 9+
- **Git** with your identity configured (`user.name`, `user.email`)
- A Linux VPS with SSH access is handy for manually testing real connections (the app works without one for most UI/dev work)

### Clone & install

```bash
git clone https://github.com/catesweb/vps-commander.git
cd vps-commander
npm install
git config core.hooksPath .githooks   # enable the commit-msg + pre-push hooks
```

The last line is required once per clone. Git does not enable repo-tracked
hooks automatically, and without it the `commit-msg` hook that rejects
AI/tool attribution footers never runs locally — CI still catches them, but
only after the commit is pushed, by which point a `Co-Authored-By` trailer
has already registered that account as a contributor on GitHub.

The same `core.hooksPath` setting also enables the `pre-push` hook, which parses
`.github/workflows/*.yml` locally before anything is pushed -- GitHub runs an
invalid workflow file with zero jobs and no error, so a broken release path
would otherwise look like "nothing happened".

### Run the app

```bash
npm start          # Electron app — forks the server on port 3141
npm run server     # Server only (browser mode) → http://localhost:3141
npm run icon       # Rebuild app icons from assets/icon-source.png → public/icon.png, icon.ico, favicons
```

`npm run server` is the fastest dev loop for frontend changes — open the dashboard in a regular browser and hit refresh.

### Build installers

```bash
npm run build:win    # Windows (.exe) — NSIS installer + portable
npm run build:mac    # macOS (.dmg + .zip)
npm run build:linux  # Linux (.AppImage, .deb)
```

The `prebuild` hook rebuilds app icons automatically (output in `dist/`). Source artwork lives at `assets/icon-source.png` (1024×1024) — replace that file and run `npm run icon` to change the app icon. Note: macOS requires the icon to be **at least 512×512**, so the source must stay 1024×1024 and square.

---

## Project Layout

```
main.js            # Electron entry: window, lifecycle, menu, auto-updater
server.js          # Express REST API + WebSocket terminal + security middleware
ssh-handler.js     # SSH connection pool, exec/shell/sftp, all remote commands
settings.js        # JSON config persistence, profile storage, audit logging
crypto-util.js     # AES-256-GCM encryption with PBKDF2 key derivation
app-logger.js      # Rotating error log (5MB) in ~/.vps-commander/
public/
  index.html       # Dashboard layout, modals, forms
  splash.html      # Startup splash screen
  js/app.js        # All frontend logic: state, DOM, polling, charts, panels
  css/styles.css   # Brutalist design system (design tokens in :root)
scripts/
  generate-icon.js # Icon builder: assets/icon-source.png → PNG/ICO/favicons
  smoke-test.js    # CI server boot test
.github/workflows/ # CI + release pipelines
```

Read [knowledge.md](knowledge.md) for architecture, REST API, WebSocket protocol, and feature details.

---

## Code Style

Plain **ES6+ JavaScript** — no build step, no TypeScript, no bundler.

| Rule | Convention |
|------|-----------|
| Semicolons | Always |
| Quotes | Single quotes; template literals for HTML generation |
| Indentation | 2 spaces |
| Functions | `async/await` throughout; `function` declarations at top level, arrow functions for callbacks |
| Frontend state | Global `State` object for all mutable state |
| DOM refs | Global `dom` object with camelCase refs (`dom.statCpu`) |
| Naming | camelCase functions (`fetchStats`, `drawSparkline`); BEM-like CSS classes |
| HTML safety | `escapeHtml()` / `escapeAttr()` for **every** interpolated value in generated HTML |
| Auditing | Every backend mutation calls `settings.auditLog({ type, message })` |
| Backend exec | All remote commands via `this.exec(id, command)` returning `{stdout, stderr, code}` |

### Backend additions (the pattern)

1. **ssh-handler.js** — add a method using the `this.exec(id, command)` pattern
2. **server.js** — add a REST endpoint with input validation, `touchSession()`, and audit logging
3. **index.html / styles.css / app.js** — add UI + wiring
4. **Validate** (see below) and test against a real VPS

### Input validation

All user-supplied input must be validated server-side before reaching an SSH command:

- Log paths: `/^\/var\/log\/[a-zA-Z0-9_\/.\-]+$/`
- Service names: `/^[a-zA-Z0-9_@.\-]+$/`
- PIDs: `/^\d+$/`, nice values: `-20` to `19`
- Docker IDs: `/^[a-zA-Z0-9_\-.:]+$/`
- UFW rules: `/^[a-zA-Z0-9\s.,\/:\-]+$/`
- SFTP paths: sanitized with `path.posix.normalize()`, blocking `..` traversal
- File modes: parsed as octal, validated `0-07777`

**Never** pass raw user input into an `ssh2.exec()` command string — validate first.

---

## Design System Guardrails

The UI follows a strict **industrial brutalist** design system. [AGENTS.md](AGENTS.md) is the authoritative guardrail file — read it before touching any UI/CSS/HTML. Highlights:

- **Design tokens only.** All colors, fonts, motion, and elevation come from `:root` in `public/css/styles.css`. Never hardcode a hex color, font stack, duration, or z-index that a token covers.
- **Palette:** strictly red / green / amber on neutral. No new accent colors without a design decision.
- **Motion budget:** no `ease-in`, no `transition: all`, no animation from `scale(0)`. Every animation must honor `prefers-reduced-motion`. The app already spends its budget on title type-in, CRT sweep, alert flash, and modal transitions.
- **No `!important` hacks.** Fix specificity with scoped selectors; the only sanctioned `!important`s are the reduced-motion query and two pre-existing utility rules.
- **Accessibility baseline:** visible `:focus-visible` styles, semantic landmarks, accessible names on every icon button, AA contrast, `tabular-nums` for shifting numbers, no layout shift.

---

## Testing & Validation

There is no automated test suite — validation is scripted checks plus manual testing. **Run all of these before opening a PR:**

```bash
# 1. Syntax-check every JS file (mirrors CI's check job — keep this list in sync
#    with the `for f in ...` loop in .github/workflows/ci.yml)
node --check main.js server.js ssh-handler.js settings.js crypto-util.js app-logger.js scripts/smoke-test.js public/js/app.js

# 2. CI server smoke test (boots server on a random port, checks 6 endpoints)
node scripts/smoke-test.js

# 3. After HTML changes — verify div/table balance
node -e "const h=require('fs').readFileSync('public/index.html','utf8');
const o=(h.match(/<div[\s>]/g)||[]).length,c=(h.match(/<\/div>/g)||[]).length;
const to=(h.match(/<table[\s>]/g)||[]).length,tc=(h.match(/<\/table>/g)||[]).length;
console.log('divs',o,c,o===c?'OK':'FAIL','tables',to,tc,to===tc?'OK':'FAIL')"
```

**CI** (`.github/workflows/ci.yml`) runs on every push/PR and enforces: syntax checks on all source files, the server smoke test, and a package build check on Windows, macOS, and Linux. A PR must be green across all three before merging.

**Manual test:** connect to a real VPS and exercise the feature — dashboard stats, terminal, services, processes, firewall, Docker, and file browser paths as relevant.

---

## Submitting a Pull Request

1. **Fork** the repo and create a branch: `git checkout -b feat/your-change`
2. Make focused changes — one logical change per PR, small enough to review
3. Follow the [code style](#code-style) and [design guardrails](#design-system-guardrails)
4. Run all [validation](#testing-validation) locally
5. Commit with a **clear, imperative, conventional-style message** — no attribution trailers:

   ```
   Add network alert threshold to settings

   Introduce a configurable network throughput threshold with the same
   pulsing-flash behavior as the existing CPU/memory/disk alerts.
   ```

6. Push and open a PR against `main`. The description should state what changed, why, and how you validated it.

By submitting a pull request you agree to license your contribution under the [MIT License](LICENSE).

**Review expectations:** the maintainer reviews every PR. Expect requests to tighten input validation, honor design tokens, avoid motion/slop regressions, and keep audit logging consistent. Unaddressed review feedback means the PR stays open.

**Author policy reminder:** do not add `Co-Authored-By:` or any tool/team attribution to commits or PR content.

---

## Release Process

Releases are tag-driven. CI packages and the release workflow is configured in `.github/workflows/release.yml` (installs are published, not drafts — drafts are invisible to the auto-updater).

```bash
git tag v1.0.1
git push origin v1.0.1
```

The workflow builds `.exe` (Windows), `.dmg` + `.zip` (macOS), and `.AppImage`/`.deb` (Linux), attaches them to a GitHub Release with auto-generated release notes, and uploads the `latest*.yml` update feeds that power in-app auto-updates.

Installed builds self-update via **Help → Check for Updates…** (see [docs/SIGNING.md](docs/SIGNING.md) for enabling signed, notarized macOS releases).

---

## Reporting Issues

Found a bug or have a feature idea? Open a [GitHub issue](https://github.com/catesweb/vps-commander/issues) — the repo has issue templates (🐛 bug report, ✨ feature request) that prompt for the right details. Include the version you're on (Help → About), what you did, what you expected, and what happened. Screenshots and `~/.vps-commander/app-error.log` excerpts help a lot.

For **security vulnerabilities**, do **not** open a public issue. Use GitHub's private vulnerability reporting: **repo → Security → Report a vulnerability**. Please include a reproduction and, if possible, a suggested fix.

---

## Security

VPS Commander manages remote servers and stores encrypted credentials — treat security as part of every change:

- **Never commit secrets** — passwords, SSH keys, `.pfx`/`.p12`/`.p8` certs, or API keys. Certificate material goes into GitHub secrets, never the repo.
- **Validate all input** on the server before it reaches SSH (see [Input validation](#input-validation)).
- **Never echo credentials** — passwords/keys are cleared from the DOM after connection and never returned by the API.
- **Sanitize file paths** against `..` traversal in all SFTP routes.
- Report vulnerabilities privately (see [Reporting Issues](#reporting-issues)).
