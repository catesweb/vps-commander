# VPS Commander

**Tactical telemetry for remote server management.**

A cross-platform Electron desktop application for monitoring and controlling cloud-hosted VPS servers through an industrial brutalist dashboard. Built for sysadmins who manage multiple Linux servers — real-time stats, a full terminal, service control, process management, firewall management, Docker control, file browsing, audit logging, and bulk command execution.

![Platform](https://img.shields.io/badge/platform-windows%20%7C%20macos%20%7C%20linux-informational) ![Electron](https://img.shields.io/badge/electron-43-blueviolet) ![License](https://img.shields.io/badge/license-MIT-green)

---

## Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Installation](#installation)
- [Build from Source](#build-from-source)
- [Usage](#usage)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Feature Deep-Dive](#feature-deep-dive)
- [Configuration](#configuration)
- [Profiles & Vault Security](#profiles-vault-security)
- [REST API](#rest-api)
- [WebSocket Protocol](#websocket-protocol)
- [Security Architecture](#security-architecture)
- [CI/CD](#cicd)
- [Project Structure](#project-structure)
- [Development](#development)
- [Contributing](#contributing)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Features

### Dashboard & Monitoring
- **Stat blocks**: CPU load, memory, disk, uptime, load average, process count, network throughput — all live
- **Resource history**: Sparkline charts for CPU, memory, disk, and network TX/RX (dual-line)
- **Alert thresholds**: User-configurable CPU/memory/disk limits with red pulsing flash + audit logging
- **Network throughput**: Dual-line TX/RX sparkline with bytes/sec delta computed from `/proc/net/dev`

### Services Panel (4 tabs)
- **SERVICES**: systemd unit list with start/stop/restart actions
- **PROCESSES**: Sortable process table (PID, user, CPU%, MEM%, command) with kill/renice actions
- **UFW**: Firewall rule management — enable/disable, add/delete rules, status display
- **DOCKER**: Container management — start/stop/restart, inline log viewer, stats

### Terminal
- Full xterm.js shell via WebSocket
- 256-color support, scrollback, font resize
- ResizeObserver for automatic fit on window resize
- One terminal per server session (switches on tab click)

### File Browser (SFTP)
- Browse the remote filesystem in a sortable table
- Breadcrumb navigation, upload/download, rename, delete, chmod, mkdir
- **Text file editor**: double-click any text file to open an inline editor with save (Ctrl+S)
- 10MB upload limit, 50MB download limit

### Bottom Panels
- **SYSTEM LOGS**: Tail multiple log files with configurable refresh and export
- **SYSTEM INFO**: Hostname, OS, kernel, network interface data
- **AUDIT LOG**: Full activity trail — connections, disconnects, service actions, file operations, alerts

### Multi-Server
- Connect to multiple servers simultaneously
- Server tabs in the header bar to switch between sessions
- **BULK COMMAND**: Run the same command across all connected servers with per-server output
- Session timeouts (1 hour default, configurable)

### Auto-Update
- **Self-updating** via GitHub Releases (electron-updater)
- Checks for updates 5 seconds after launch and via **Help → Check for Updates…**
- Native prompt to download + install; restarts the app automatically
- Windows (NSIS), macOS (DMG/ZIP), and Linux (AppImage) update feeds published by the release workflow
- Note: macOS auto-update requires a signed/notarized build (see [CI/CD](#cicd)); unsigned builds open the Releases page instead

### Security
- **Vault system**: AES-256-GCM encrypted profile storage
- **Master password** option: one password unlocks all saved profiles
- **Machine key** fallback: auto-derived from hostname/username
- Rate limiting on `/api/connect` (10 requests per 15 seconds)
- Input sanitization: regex validation on all user inputs (paths, service names, PIDs, Docker IDs, UFW rules)
- Security headers: X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Referrer-Policy, Permissions-Policy, CSP
- Passwords/keys cleared from DOM after connection
- `ssh2.exec()` runs without local shell — no shell injection

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Desktop Shell | Electron |
| Backend | Node.js + Express + WebSocket (`ws`) |
| SSH | `ssh2` library (connection pool) |
| Terminal | xterm.js |
| UI | Industrial Brutalist — Tactical Telemetry Dark Mode |
| Storage | JSON files in `~/.vps-commander/` (AES-256-GCM encrypted) |

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Electron Shell                  │
│  main.js — BrowserWindow, app lifecycle, menu   │
│  Loads http://localhost:3141 via Chromium        │
├─────────────────────────────────────────────────┤
│              Node.js Server (port 3141)           │
│  server.js — Express REST API + WebSocket server  │
│  settings.js — Config, profiles, audit logging    │
│  crypto-util.js — AES-256-GCM encryption          │
│  ssh-handler.js — SSH connection pool (ssh2)      │
├─────────────────────────────────────────────────┤
│              Frontend (SPA)                       │
│  public/index.html — Single-page dashboard        │
│  public/js/app.js — All UI logic                  │
│  public/css/styles.css — Brutalist design system  │
│  xterm.js — Terminal emulation (vendored)         │
└─────────────────────────────────────────────────┘
```

### Data Flow

1. **main.js** forks `server.js` as a child process on port 3141
2. Electron `BrowserWindow` loads `http://localhost:3141`
3. Express serves `public/` as static files + REST API endpoints
4. Frontend fetches data via `fetch()` to the REST API, receives real-time terminal data via WebSocket
5. REST API routes to `ssh-handler.js` which maintains a connection pool using `ssh2`
6. `ssh-handler.js` runs shell commands on remote servers via `client.exec()`
7. `settings.js` handles config persistence in `~/.vps-commander/`
8. `crypto-util.js` handles AES-256-GCM encryption for profile passwords/keys

---

## Installation

### Requirements

- **Runtime**: Windows, macOS, or Linux desktop
- **Target VPS**: Linux with SSH access (systemd for service management)
- **Build host**: Node.js 20+, npm 9+

### Download Pre-built Binary

Download the latest release for your platform from the [Releases](https://github.com/catesweb/vps-commander/releases) page:

| Platform | File |
|----------|------|
| Windows (x64) | `VPS Commander Setup *.exe` (NSIS installer) or `VPS Commander *.exe` (portable) |
| macOS (Apple Silicon) | `*-arm64.dmg` or `*-arm64-mac.zip` |
| macOS (Intel) | `*.dmg` or `*-mac.zip` — the builds *without* `arm64` in the name |
| Linux (x64) | `*.AppImage` or `*.deb` |

> Auto-update works with the **NSIS installer**, **DMG/ZIP**, and **AppImage** builds. The Windows *portable* `.exe` does not self-update (electron-updater limitation) — use the installer to receive updates.

> **Builds are currently unsigned.** Until code-signing secrets are configured (see [docs/SIGNING.md](docs/SIGNING.md)), your OS will warn on first launch:
>
> - **Windows** — SmartScreen shows "Windows protected your PC". Click **More info → Run anyway**.
> - **macOS** — Gatekeeper blocks the app outright. Right-click the app → **Open** → **Open**, or run `xattr -dr com.apple.quarantine "/Applications/VPS Commander.app"`.
> - **Linux** — no signature is expected; mark the AppImage executable with `chmod +x`.

---

## Build from Source

```bash
git clone https://github.com/catesweb/vps-commander.git
cd vps-commander
npm install
npm start          # Launch the Electron app
```

### Build Executables

```bash
npm run build:win    # Windows (.exe) — NSIS installer + portable, x64
npm run build:mac    # macOS (.dmg + .zip) — arm64 and x64
npm run build:linux  # Linux (.AppImage, .deb) — x64
```

Output appears in the `dist/` folder. The `prebuild` hook regenerates app icons automatically for builds; during development you can run `npm run icon` directly to regenerate them.

### Run Server Only (Browser Mode)

```bash
npm run server
# Open http://localhost:3141
```

Useful for development and for testing the frontend in a regular browser.

---

## Usage

1. Launch VPS Commander
2. Enter your VPS credentials (host, port, username, password)
3. Optionally save as a profile for future use
4. Click **CONNECT**
5. The dashboard appears with live stats, terminal, services, and logs
6. Connect additional servers — each gets its own tab

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+N` / `Cmd+N` | New connection |
| `Ctrl+,` / `Cmd+,` | Open settings |
| `Ctrl+Q` / `Cmd+Q` | Quit |
| `F12` | Toggle Developer Tools |
| `Ctrl+R` / `Cmd+R` | Reload window |
| `Ctrl+=` / `Cmd+=` | Zoom in |
| `Ctrl+-` / `Cmd+-` | Zoom out |
| `Ctrl+0` / `Cmd+0` | Reset zoom |
| `Ctrl+S` | Save file in the built-in text editor |

---

## Feature Deep-Dive

### Dashboard & Monitoring

The top row of stat blocks shows CPU load, memory, disk, uptime, load average, process count, and network throughput. Each metric refreshes on the configured polling interval, and sparkline charts track history for CPU, memory, disk, and network TX/RX.

**Alert thresholds** (default 90% for CPU/memory/disk) trigger a red pulsing flash on the affected stat block and write an entry to the audit log. Configure thresholds in Settings.

### Services, Processes, Firewall & Docker

The Services panel has four tabs:

| Tab | What it does |
|-----|--------------|
| **SERVICES** | Lists systemd units with `start` / `stop` / `restart` actions |
| **PROCESSES** | Sortable table (PID, user, CPU%, MEM%, command) with `kill` (TERM/KILL/HUP) and `renice` (-20 to 19) |
| **UFW** | Firewall status, enable/disable, add rules (allow/deny/reject/limit), delete rules by number |
| **DOCKER** | Container list with start/stop/restart, inline log viewer, per-container stats |

### Terminal

The terminal is a full xterm.js shell over a WebSocket connection. It supports 256 colors, configurable font size and scrollback, and auto-fits on window resize. Each server session has its own terminal instance that switches when you change tabs.

### File Browser (SFTP)

Browse the remote filesystem with breadcrumbs, upload/download files, and perform rename, delete, chmod, and mkdir operations. Double-click any text file to open an inline editor — save with **Ctrl+S**.

**Limits**: 10MB upload (base64 overhead accounted), 50MB download.

### Bottom Panels

- **SYSTEM LOGS**: Tail up to 6 configurable log files (defaults: syslog, auth, kern, nginx access/error, mysql error) with configurable refresh rate and export.
- **SYSTEM INFO**: Hostname, OS, kernel, network interface data.
- **AUDIT LOG**: Append-only activity trail — connections, disconnects, service actions, file operations, firewall changes, Docker actions, alerts.

### Bulk Command Execution

Run a command across all connected servers at once. Output is collected per-server with exit codes, and the action is written to the audit log. Great for rolling out config changes or checking versions fleet-wide.

---

## Configuration

Settings are stored in `~/.vps-commander/settings.json`. All values are configurable from the Settings panel in the app.

| Key | Default | Description |
|-----|---------|-------------|
| `theme` | `tactical` | UI theme |
| `statsInterval` | `3000` | Stats polling interval (ms) |
| `servicesInterval` | `10000` | Services polling interval (ms) |
| `logsInterval` | `30000` | Logs polling interval (ms) |
| `logLines` | `200` | Log lines to fetch |
| `terminalFontSize` | `13` | Terminal font size (px) |
| `terminalScrollback` | `5000` | Terminal scrollback lines |
| `sessionTimeout` | `3600000` | Session idle timeout (ms) |
| `auditLog` | `true` | Enable audit logging |
| `alertEnabled` | `true` | Enable alert thresholds |
| `alertSound` | `true` | Play alert sound |
| `alertSounds` | `{...}` | Per-alert-type toggles + optional custom audio files (cpu, memory, disk, network, connectOk, connectFail) |
| `alertCpu` | `90` | CPU alert threshold (%) |
| `alertMem` | `90` | Memory alert threshold (%) |
| `alertDisk` | `90` | Disk alert threshold (%) |
| `alertNetMbps` | `800` | Network throughput alert threshold (Mbps) |
| `logPresets` | `[...]` | Default log files to tail |

---

## Profiles & Vault Security

Profiles are stored in `~/.vps-commander/profiles.json`. Passwords and SSH keys are **never stored in plaintext** — they're encrypted with AES-256-GCM before touching disk.

### Encryption Pipeline

```
Password/Key → PBKDF2 (100K iterations, SHA-512) → AES-256-GCM → iv:tag:ciphertext
```

### Vault Modes

1. **Machine Key** (default): Key derived from `hostname + username + app_secret`, salted and stored on disk
2. **Master Password**: User sets a password, key derived via PBKDF2 with verification hash. The key lives only in memory (`memoryKey`) — never on disk

### Lock/Unlock Flow

```
App Start → readKeyFile() → machine mode (auto-unlock) OR master mode (show unlock modal)
Unlock → verify hash with timingSafeEqual → derive decryption key → load profiles
Lock → null memoryKey → profiles unreadable
```

Master password verification uses 120K PBKDF2 iterations and `crypto.timingSafeEqual` for comparison. When you switch between master and machine mode, all profiles are transparently re-encrypted with the new key.

---

## REST API

The Express server exposes a JSON REST API. Unless noted, routes require a `sessionId` (returned by `/api/connect`).

### Connection

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/connect` | Connect to VPS (rate limited: 10 req / 15s) |
| POST | `/api/disconnect` | Disconnect session |
| GET | `/api/sessions` | List active sessions |

### Stats & Logs

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/stats?sessionId=` | Server stats (CPU, mem, disk, network, etc.) |
| GET | `/api/logs?sessionId=&file=&lines=` | Tail log files (path must match `/var/log/...`) |
| GET | `/api/services?sessionId=` | List systemd services |
| POST | `/api/services/:name/:action` | Control service (start/stop/restart/status) |

### Processes

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/processes?sessionId=&sort=` | List processes |
| POST | `/api/processes/:pid/kill` | Kill process (TERM/KILL/HUP) |
| POST | `/api/processes/:pid/renice` | Renice process (-20 to 19) |

### SFTP File Browser

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/sftp/list?sessionId=&path=` | List directory |
| GET | `/api/sftp/stat?sessionId=&path=` | File/directory stat |
| GET | `/api/sftp/download?sessionId=&path=` | Download file (base64, 50MB limit) |
| POST | `/api/sftp/upload` | Upload file (10MB limit) |
| POST | `/api/sftp/save` | Save file (in-place edit) |
| POST | `/api/sftp/delete` | Delete file/directory |
| POST | `/api/sftp/rename` | Rename file/directory |
| POST | `/api/sftp/chmod` | Change permissions |
| POST | `/api/sftp/mkdir` | Create directory |

### UFW Firewall

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/ufw/status?sessionId=` | Get firewall status + rules |
| POST | `/api/ufw/enable` | Enable UFW |
| POST | `/api/ufw/disable` | Disable UFW |
| POST | `/api/ufw/rule` | Add rule (allow/deny/reject/limit) |
| DELETE | `/api/ufw/rule/:num` | Delete rule by number |

### Docker

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/docker/containers?sessionId=` | List containers |
| POST | `/api/docker/:id/:action` | Start/stop/restart container |
| GET | `/api/docker/:id/logs?lines=` | View container logs |
| GET | `/api/docker/:id/stats` | View container stats |

### Bulk Execution

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/bulk-exec` | Run command on all/multiple sessions |

### Auth & Settings

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/auth/status` | Vault lock status |
| POST | `/api/auth/unlock` | Unlock vault with master password |
| POST | `/api/auth/set-master` | Set master password |
| POST | `/api/auth/remove-master` | Remove master password |
| POST | `/api/auth/lock` | Lock vault |
| GET | `/api/settings` | Get settings |
| POST | `/api/settings` | Save settings |
| GET | `/api/profiles` | List profiles (safe — no passwords) |
| GET | `/api/profiles/:id/auth` | Get decrypted profile auth |
| POST | `/api/profiles` | Save profile (password encrypted server-side) |
| DELETE | `/api/profiles/:id` | Delete profile |
| GET | `/api/audit-log` | Read audit log |
| POST | `/api/audit-log/clear` | Clear audit log |
| POST | `/api/audit-log` | Write client-side audit entry (alerts) |
| GET | `/api/error-log` | Read app error log |
| POST | `/api/error-log` | Write client-side error entry |

---

## WebSocket Protocol

The WebSocket server (mounted on the same port) powers the interactive terminal:

| Message Type | Direction | Description |
|-------------|-----------|-------------|
| `terminal:init` | Client → Server | Initialize terminal shell for session |
| `terminal:input` | Client → Server | Keystroke data |
| `terminal:resize` | Client → Server | Terminal resize event |
| `terminal:data` | Server → Client | Shell output |
| `terminal:closed` | Server → Client | Shell session ended |

One terminal per server session; sessions switch with the UI tabs.

---

## Security Architecture

### Input Validation

- Log paths: `/^\/var\/log\/[a-zA-Z0-9_\/.\-]+$/`
- Service names: `/^[a-zA-Z0-9_@.\-]+$/`
- PIDs: `/^\d+$/`
- Nice values: `-20` to `19`
- Docker IDs: `/^[a-zA-Z0-9_\-.:]+$/`
- UFW rules: `/^[a-zA-Z0-9\s.,\/:\-]+$/`
- SFTP paths: sanitized with `path.posix.normalize()`, blocking `..` traversal
- File modes: parsed as octal, validated `0-07777`

### Defense Layers

1. **No shell injection**: `ssh2.exec()` runs commands without a local shell
2. **Rate limiting**: `/api/connect` capped at 10 requests per 15-second window per IP
3. **Security headers**: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, CSP
4. **Encrypted credentials**: AES-256-GCM with PBKDF2 key derivation; master key never on disk
5. **Session timeouts**: 1-hour idle timeout (configurable), auto-disconnect
6. **Credential hygiene**: passwords cleared from the DOM after connection; API never echoes credentials

### Audit Logging

All actions are appended to `~/.vps-commander/audit.log` in ISO 8601 pipe-separated format. Categories: `CONNECT`, `DISCONNECT`, `CONNECT_FAIL`, `SERVICE`, `PROCESS`, `FILE`, `FIREWALL`, `DOCKER`, `BULK`, `ALERT`, `CONFIG`, `AUTH`, `SESSION`, `PROFILE`.

---

## CI/CD

GitHub Actions workflows are included:

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `ci.yml` | Push to `main`, pull requests | Rejects commit messages with AI attribution footers, syntax-checks all source files, runs the server smoke test, verifies the app packages on Windows, macOS, and Linux, and checks docs TOC anchors + relative links |
| `links.yml` | Weekly schedule (Mon 06:00 UTC), manual dispatch | Probes every http/https link in the docs with a live HEAD request (GET fallback) so dead external URLs fail CI |
| `release.yml` | Push tag `v*` | Gates on docs freshness, builds all platform installers, verifies signatures (when signing secrets are configured), and publishes a GitHub Release with release notes + auto-update feeds |

To publish a release:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The release workflow builds `.exe` (Windows), `.dmg` + `.zip` (macOS), and `.AppImage`/`.deb` (Linux), attaches them to a **published** release (not a draft — drafts are invisible to `electron-updater`), and uploads the `latest*.yml` update feeds + `.blockmap` files that power auto-update. Release notes are generated from merged PRs. Existing installs will see the new version via **Help → Check for Updates…** or automatically on launch.

**Auto-update configuration** lives in `package.json` (`build.publish`): GitHub provider pointing at `catesweb/vps-commander`. No `GH_TOKEN` is needed because the repo is public.

**Code signing & notarization**: releases are unsigned until you configure signing secrets. See [docs/SIGNING.md](docs/SIGNING.md) for a step-by-step guide on setting up **Windows Authenticode** (`.pfx`), **macOS Developer ID** (`.p12`), and **Apple notarization** (App Store Connect API key) as GitHub secrets. Once the secrets exist, `release.yml` signs installers automatically — and notarizes macOS builds once you add the `notarize` block to `package.json` (per the guide). Signed macOS installs then get silent auto-updates instead of the Releases-page fallback.

---

## Project Structure

```
├── main.js                 # Electron entry: window, lifecycle, menu
├── server.js               # Express REST API + WebSocket terminal + security middleware
├── ssh-handler.js          # SSH connection pool, exec/shell/sftp, all remote commands
├── settings.js             # JSON config persistence, profile storage, audit logging
├── crypto-util.js          # AES-256-GCM encryption with PBKDF2 key derivation
├── app-logger.js           # Rotating error log (5MB) in ~/.vps-commander/
├── entitlements.mac.plist  # macOS hardened-runtime entitlements
├── knowledge.md            # Project knowledge base
├── AGENTS.md / CLAUDE.md   # Agent guardrails (design system, workflow rules)
├── CONTRIBUTING.md         # Contribution guide
├── CODEOWNERS              # Single-maintainer ownership
├── public/
│   ├── index.html          # Dashboard layout, modals, forms
│   ├── splash.html         # Startup splash screen
│   ├── js/app.js           # All frontend logic: state, DOM, polling, charts, panels
│   ├── css/styles.css      # Brutalist dark design system
│   ├── vendor/             # Vendored xterm.js + fonts (no CDN)
│   └── icon.png/ico        # Generated app icons
├── scripts/
│   ├── generate-icon.js    # Icon generator (PNG/ICO)
│   ├── a11y-audit.js       # Accessibility audit (npm run a11y)
│   └── smoke-test.js       # CI server boot test
├── docs/
│   └── SIGNING.md          # Code-signing & notarization guide
└── .github/
    ├── workflows/          # GitHub Actions CI + release pipelines
    └── ISSUE_TEMPLATE/     # Bug report + feature request forms
```

---

## Development

### Run in Dev Mode

```bash
npm install
npm start          # Electron app (forks server on port 3141)
# or
npm run server     # Server only → http://localhost:3141
```

### Adding a New Feature (Pattern)

1. **ssh-handler.js**: Add a method using the `this.exec(id, command)` pattern
2. **server.js**: Add a REST endpoint with input validation, `touchSession()`, and audit logging
3. **index.html**: Add UI elements (tab, button, panel, modal)
4. **styles.css**: Add CSS classes (follow the brutalist design system)
5. **app.js**: Add DOM refs, state, event bindings, refresh function, tab-switching integration
6. **Manual test**: connect to a VPS and verify the feature works

### Conventions

- Plain ES6+ JavaScript — no build step, no TypeScript
- Single quotes, semicolons, 2-space indentation, `async/await`
- Global `State` object for all mutable state; `dom` object for DOM refs
- Canvas-based sparklines: `drawSparkline()`, `drawDualSparkline()`
- All remote commands run through `this.exec(id, command)` returning `{stdout, stderr, code}`

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide: dev setup, project layout, code style, testing & validation, the PR workflow, the release process, and how to report issues and security vulnerabilities.

---

## Troubleshooting

### "Port 3141 is already in use"

Another VPS Commander instance (or a leftover server process) is holding the port. Close all instances and retry. The app attempts to kill stale listeners automatically.

### The app shows a black window / won't load

Check `~/.vps-commander/app-error.log` for the server error. Common causes: port conflict, missing `node_modules`.

### Profiles show "VAULT_LOCKED"

Master password mode is enabled and the vault is locked. Enter your master password via the unlock prompt. If you lost the password, profiles cannot be decrypted by design — this is intentional.

### Settings/profiles not persisting

Settings and profiles live in `~/.vps-commander/`. Deleting that folder resets the app to defaults (and destroys your encrypted profiles).

---

## License

Released under the [MIT License](LICENSE).

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
