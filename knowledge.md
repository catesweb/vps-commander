# VPS Commander — Knowledge Base

**Tactical telemetry for remote server management.** A cross-platform Electron desktop application for monitoring and controlling cloud-hosted VPS servers through an industrial brutalist dashboard. Built for sysadmins who manage multiple Linux servers — provides real-time stats, a full terminal, service control, process management, firewall management, Docker control, file browsing, audit logging, and bulk command execution.

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
│  public/js/app.js — All UI logic (~2390 lines)   │
│  public/css/styles.css — Brutalist design system  │
│  xterm.js — Terminal emulation (vendored local)   │
└─────────────────────────────────────────────────┘
```

### Data Flow

1. **main.js** forks `server.js` as a child process on port 3141
2. Electron `BrowserWindow` loads `http://localhost:3141` 
3. Express serves `public/` as static files + REST API endpoints
4. Frontend fetches data via `fetch()` to REST API, receives real-time terminal data via WebSocket
5. REST API routes to `ssh-handler.js` which maintains a connection pool using `ssh2`
6. `ssh-handler.js` runs shell commands on remote servers via `client.exec()`
7. `settings.js` handles config persistence in `~/.vps-commander/`
8. `crypto-util.js` handles AES-256-GCM encryption for profile passwords/keys

### Key Files

| File | Role | Lines |
|------|------|-------|
| `main.js` | Electron entry point, window creation, app menu, auto-update | ~390 |
| `server.js` | Express REST API + WebSocket terminal + security middleware | ~880 |
| `ssh-handler.js` | SSH connection pool, exec/shell/sftp, all remote commands | ~470 |
| `settings.js` | JSON config persistence, profile storage, audit logging | ~180 |
| `crypto-util.js` | AES-256-GCM encryption with PBKDF2 key derivation | ~200 |
| `app-logger.js` | Rotating error log (5MB) in `~/.vps-commander/` | ~75 |
| `public/index.html` | Dashboard layout, modals, forms | ~685 |
| `public/js/app.js` | All frontend logic: state, DOM, polling, charts, panels | ~2390 |
| `public/css/styles.css` | Brutalist dark design system | ~650 |
| `package.json` | Dependencies, build config (electron-builder) | ~115 |

---

## Features

### Dashboard & Monitoring
- **Stat blocks**: CPU load, memory, disk, uptime, load average, process count, network throughput
- **Resource history**: Sparkline charts for CPU, memory, disk, network TX/RX (dual-line)
- **Alert thresholds**: User-configurable CPU/memory/disk limits with red pulsing flash + audit logging
- **Network throughput**: Dual-line TX/RX sparkline with bytes/sec delta computation from `/proc/net/dev`

### Services Panel (4 tabs)
- **SERVICES**: systemd unit list with start/stop/restart actions
- **PROCESSES**: Sortable process table (PID, user, CPU%, MEM%, command) with kill/renice actions
- **UFW**: Firewall rule management — enable/disable, add/delete rules, status display
- **DOCKER**: Container management — start/stop/restart, inline log viewer, per-container stats

### Terminal
- Full xterm.js shell via WebSocket
- 256-color support, scrollback, font resize
- ResizeObserver for automatic fit on window resize
- One terminal per server session (switches on tab click)

### File Browser (SFTP)
- Browse remote filesystem in a sortable table
- Breadcrumb navigation, upload/download, rename, delete, chmod, mkdir
- **Text file editor**: Double-click any text file to open inline editor with save (Ctrl+S)
- 10MB upload limit, 50MB download limit

### Bottom Panels
- **SYSTEM LOGS**: Tail multiple log files with configurable refresh and export
- **SYSTEM INFO**: Hostname, OS, kernel, network interface data
- **AUDIT LOG**: Full activity trail — connections, disconnects, service actions, file operations, alerts

### Multi-Server
- Connect to multiple servers simultaneously
- Server tabs in header bar to switch between sessions
- **BULK COMMAND**: Run same command across all connected servers with per-server output
- Session timeouts (1 hour default, configurable)

### Auto-Update
- **Self-updating** via GitHub Releases (electron-updater)
- Checks for updates 5 seconds after launch and via **Help → Check for Updates…**
- Native prompt to download + install; restarts the app automatically
- Windows (NSIS), macOS (DMG/ZIP), and Linux (AppImage) update feeds published by the release workflow
- Note: macOS auto-update requires a signed/notarized build; unsigned macOS builds degrade to a Releases-page prompt

### Security
- **Vault system**: AES-256-GCM encrypted profile storage
- **Master password** option: One password unlocks all saved profiles
- **Machine key** fallback: Auto-derived from hostname/username
- Rate limiting on `/api/connect` (10 requests per 15 seconds)
- Input sanitization: regex validation on all user inputs (paths, service names, PIDs, Docker IDs, UFW rules)
- Security headers: X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Referrer-Policy, Permissions-Policy (server middleware) + CSP (meta tag)
- Passwords/keys cleared from DOM after connection
- `ssh2.exec()` runs without local shell — no shell injection

### Audit Logging
- All actions logged to `~/.vps-commander/audit.log`
- Categories: CONNECT, DISCONNECT, CONNECT_FAIL, SERVICE, PROCESS, FILE, FIREWALL, DOCKER, BULK, ALERT, CONFIG, AUTH, SESSION, PROFILE
- Client-side alerts also write to audit log via `POST /api/audit-log`

---

## REST API

### Connection
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/connect` | Connect to VPS (rate limited) |
| POST | `/api/disconnect` | Disconnect session |
| GET | `/api/sessions` | List active sessions |

### Stats & Logs
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/stats?sessionId=` | Server stats (CPU, mem, disk, network, etc.) |
| GET | `/api/logs?sessionId=&file=&lines=` | Tail log files |
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
| GET | `/api/sftp/download?sessionId=&path=` | Download file (base64) |
| POST | `/api/sftp/upload` | Upload file |
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
| GET | `/api/docker/:id/logs` | View container logs |
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
| GET | `/api/profiles` | List profiles (safe, no passwords) |
| GET | `/api/profiles/:id/auth` | Get decrypted profile auth |
| POST | `/api/profiles` | Save profile |
| DELETE | `/api/profiles/:id` | Delete profile |
| GET | `/api/audit-log` | Read audit log |
| POST | `/api/audit-log/clear` | Clear audit log |
| POST | `/api/audit-log` | Write client-side audit entry (alerts) |
| GET | `/api/error-log?lines=` | Read app error log |
| POST | `/api/error-log` | Write client-side error entry |
| DELETE | `/api/error-log` | Clear app error log |
| GET | `/api/sound?path=` | Serve a custom alert sound file (wav/mp3/ogg/m4a/aac/flac/weba) |

### WebSocket
| Message Type | Direction | Description |
|-------------|-----------|-------------|
| `terminal:init` | Client → Server | Initialize terminal shell for session |
| `terminal:input` | Client → Server | Keystroke data |
| `terminal:resize` | Client → Server | Terminal resize event |
| `terminal:data` | Server → Client | Shell output |
| `terminal:closed` | Server → Client | Shell session ended |

---

## Code Conventions

### JavaScript Style
- **No build step** — plain ES6+ JavaScript, no TypeScript, no bundler
- **Semicolons**: Used
- **Quotes**: Single quotes for strings, template literals for HTML generation
- **Indentation**: 2 spaces
- **Arrow functions**: Used for callbacks, `function` declarations for top-level
- **Async**: `async/await` throughout for API calls and SSH operations

### Naming
- **State**: Global `State` object holds all mutable state (`State.sessions`, `State.history`, etc.)
- **DOM Refs**: Global `dom` object with camelCase references (`dom.statCpu`, `dom.connectBtn`)
- **Functions**: camelCase (`fetchStats`, `pushHistory`, `drawSparkline`)
- **CSS**: BEM-like with dashes (`stat-block`, `panel-header`, `proc-btn`)
- **CSS variables**: `--bg`, `--fg`, `--red`, `--green`, `--border`, etc.

### Frontend Architecture
- **Single global State object**: All application state in one place
- **$ helper**: `const $ = (sel) => document.querySelector(sel)` — used everywhere
- **Polling**: `startPolling(sessionId)` sets up `setInterval` loops for stats/services/logs/processes
- **Charting**: Canvas-based sparklines drawn with `drawSparkline()` and `drawDualSparkline()`
- **Escape helpers**: `escapeHtml()`, `escapeAttr()` for safe HTML injection
- **Session lifecycle**: All three reset paths (connect, switch, disconnect) clear history/prev values

### Backend Architecture
- **Connection pool**: `ssh-handler.js` maintains a `Map<string, {client, meta}>` 
- **Exec pattern**: All remote commands use `this.exec(id, command)` returning `{stdout, stderr, code}`
- **Validation**: Regex-based input sanitization for all user-supplied values
- **Audit**: `settings.auditLog({type, message})` on every mutation
- **Error handling**: Try/catch with structured error responses

### Design Patterns
- **Industrial Brutalist UI**: Dark background (`#0A0A0A`), red accents (`#E61919`), green highlights (`#4AF626`), monospace throughout (`JetBrains Mono`)
- **CRT overlay**: Subtle scanline and noise effects via CSS overlays
- **Gap-based layout**: `var(--gap)` = 1px borders between panels (like window borders)
- **Sticky table headers**: Process/file tables use `position: sticky; top: 0` on thead (contextual, off the z-index scale)
- **Tab switching**: Class-based tab activation with `data-tab` attributes

### CSS Variables
```css
--bg: #0A0A0A          /* Main background */
--bg-panel: #0E0E0E    /* Panel background */
--bg-elevated: #141414 /* Header/modal background */
--fg: #EAEAEA          /* Primary text */
--fg-mid: #999999      /* Medium text */
--fg-dim: #858585      /* Dimmed text */
--red: #E61919         /* Accent red */
--red-bright: #FF2A2A  /* Bright red */
--red-dim: #8B0000     /* Dim red */
--green: #4AF626       /* Accent green */
--amber: #FFB020       /* Warning amber */
--border: #1F1F1F      /* Panel borders */
--border-active: #333  /* Active borders */
--font-mono: 'JetBrains Mono', monospace
--font-sans: 'Barlow', sans-serif
--font-display: 'Barlow Condensed', sans-serif
--ease-out: cubic-bezier(0.23, 1, 0.32, 1)
--ease-inout: cubic-bezier(0.77, 0, 0.175, 1)
--dur-fast: 140ms / --dur: 200ms
--z-overlay: 9990 / --z-modal: 10000 / --z-toast: 10100
--gap: 1px
```

---

## Configuration

### Settings (`~/.vps-commander/settings.json`)
| Key | Default | Description |
|-----|---------|-------------|
| `theme` | `tactical` | UI theme |
| `statsInterval` | 3000 | Stats polling interval (ms) |
| `servicesInterval` | 10000 | Services polling interval (ms) |
| `logsInterval` | 30000 | Logs polling interval (ms) |
| `logLines` | 200 | Log lines to fetch |
| `terminalFontSize` | 13 | Terminal font size (px) |
| `terminalScrollback` | 5000 | Terminal scrollback lines |
| `sessionTimeout` | 3600000 | Session idle timeout (ms) |
| `auditLog` | true | Enable audit logging |
| `alertEnabled` | true | Enable alert thresholds |
| `alertSound` | true | Play alert sound |
| `alertSounds` | `{...}` | Per-alert-type toggles + optional custom audio files (cpu, memory, disk, network, connectOk, connectFail) |
| `alertCpu` | 90 | CPU alert threshold (%) |
| `alertMem` | 90 | Memory alert threshold (%) |
| `alertDisk` | 90 | Disk alert threshold (%) |
| `alertNetMbps` | 800 | Network throughput alert threshold (Mbps) |
| `logPresets` | `[...]` | Default log files to tail |

### Profiles (`~/.vps-commander/profiles.json`)
- Passwords and SSH keys encrypted with AES-256-GCM
- Each profile: `{id, label, host, port, username, passwordEncrypted, privateKeyEncrypted, createdAt, updatedAt}`

### Crypto (`~/.vps-commander/.vps-key`)
- Machine mode: PBKDF2-derived key from hostname + username + app secret
- Master mode: User-provided password with verification hash, key never stored on disk

### Audit Log (`~/.vps-commander/audit.log`)
- ISO 8601 timestamps, pipe-separated format

---

## Build & Release

### Dependencies
- **Runtime**: express, ssh2, ws, electron-updater
- **Dev**: electron, electron-builder, @axe-core/playwright + playwright-core (a11y audit)

### Build Commands
```bash
npm start          # Launch Electron app (dev)
npm run server     # Run Express server only (browser mode on port 3141)
npm run build:win  # Build Windows NSIS installer + portable
npm run build:mac  # Build macOS DMG + ZIP
npm run build:linux # Build Linux AppImage + deb
```

### Build Output (`dist/`)
- Windows: NSIS installer + portable `.exe`
- macOS: `.dmg` + `.zip` with hardened runtime and entitlements
- Linux: `.AppImage` + `.deb`
- Icon: `public/icon.png` (PNG) / `public/icon.ico` (Windows)

### electron-builder Config
- `appId`: `com.vpscommander.app`
- `productName`: `VPS Commander`
- Files included: `main.js`, `server.js`, `ssh-handler.js`, `settings.js`, `crypto-util.js`, `app-logger.js`, `public/**`, `node_modules/**`, `package.json`
- Windows installer: non-oneClick, allows install directory choice, desktop + start menu shortcuts
- macOS: hardened runtime enabled, DMG + ZIP targets, `entitlements.mac.plist` (JIT + file-access entitlements)

---

## Stats Collection Commands

The `ssh-handler.getStats()` method runs these commands on the remote server:

| Key | Command | Output Format |
|-----|---------|---------------|
| `cpu` | `top -bn1 \| grep 'Cpu(s)' \| awk '{print $2 + $4}'` | Float (e.g., `42.5`) |
| `memory` | `free -m \| awk 'NR==2{printf "%.1f\|%.1f\|%.1f", $3, $2, $3*100/$2}'` | `used\|total\|percent` |
| `disk` | `df -h / \| awk 'NR==2{printf "%s\|%s\|%s", $3, $2, $5}'` | `used\|total\|percent` |
| `uptime` | `uptime -p \| sed 's/up //'` | String (e.g., `45 days, 2 hours`) |
| `load` | `cat /proc/loadavg \| awk '{print $1, $2, $3}'` | `0.08 0.12 0.09` |
| `hostname` | `hostname` | String |
| `os` | `cat /etc/os-release \| grep PRETTY_NAME \| cut -d'"' -f2` | String |
| `kernel` | `uname -r` | String |
| `processes` | `ps aux --no-headers \| wc -l` | Integer |
| `network` | `cat /proc/net/dev \| grep -E 'eth0\|ens\|enp' \| awk '{printf "%s\|%.0f\|%.0f", $1, $2, $10}' \| head -1` | `iface:\|rxbytes\|txbytes` |

---

## Security Architecture

### Encryption Pipeline
```
Password/Key → PBKDF2 (100K iterations, SHA-512) → AES-256-GCM → iv:tag:ciphertext
```

### Vault Modes
1. **Machine Key** (default): Key derived from `hostname + username + app_secret`, salted and stored on disk
2. **Master Password**: User sets a password, key derived via PBKDF2 with verification hash. Key lives only in memory (`memoryKey`)

### Lock/Unlock Flow
```
App Start → readKeyFile() → machine mode (auto-unlock) OR master mode (show unlock modal)
Unlock → verify hash with timingSafeEqual → derive decryption key → clear modal → load profiles
Lock → null memoryKey → profiles unreadable
```

Master password verification uses 120K PBKDF2 iterations and `crypto.timingSafeEqual`; switching between master and machine mode re-encrypts all profiles via `reencryptProfiles()`.


### Input Validation
- Log paths: `SAFE_LOG_PATH = /^\/var\/log\/[a-zA-Z0-9_\/.\-]+$/`
- Service names: `SAFE_SERVICE_NAME = /^[a-zA-Z0-9_@.\-]+$/`
- PIDs: `SAFE_PID = /^\d+$/`
- Nice values: `SAFE_NICE = /^-?\d{1,2}$/` with -20 to 19 range check
- Docker IDs: `SAFE_DOCKER_ID = /^[a-zA-Z0-9_\-.:]+$/`
- UFW rules: `/^[a-zA-Z0-9\s.,\/:\-]+$/`
- SFTP paths: Sanitized with `path.posix.normalize()`, blocking `..` traversal
- File modes: Parsed as octal, validated 0-07777
- Upload limit: 10MB (base64 overhead accounted)
- Download limit: 50MB

### Rate Limiting
- `/api/connect`: 10 requests per 15-second window per IP
- Auto-cleanup of expired rate limit entries every 60 seconds

### Session Management
- 1-hour idle timeout (configurable via settings)
- Auto-disconnect of timed-out sessions every 60 seconds
- `touchSession()` on every API call that uses a session

---

## Scalability Notes

- **Connection pool**: In-memory `Map`, scales linearly with session count
- **Polling**: Each session has independent `setInterval` timers
- **Memory**: No caching layer, all data fetched on-demand
- **SSH**: ssh2 library handles concurrency natively
- **Electron**: Single renderer process, no service workers
- **Limitations**: Designed for 1-10 simultaneous connections (personal tool scale)
- **Releasable**: Self-contained Electron app with NSIS/DMG/AppImage packaging

---

## Development Workflow

1. **Run server only**: `npm run server` → `http://localhost:3141`
2. **Run full app**: `npm start` (Electron)
3. **Make frontend changes**: Edit `public/js/app.js`, `public/css/styles.css`, `public/index.html`
4. **Make backend changes**: Edit `server.js`, `ssh-handler.js`, `settings.js`, `crypto-util.js`
5. **Test**: No unit test suite — run `node --check` after JS edits and `npm run a11y` (axe-core/Playwright, WCAG 2.1 AA) after UI/HTML changes, then test manually in browser or Electron
6. **Build**: `npm run build:win` (or `mac`/`linux`)

### Adding a New Feature (Pattern)

1. **ssh-handler.js**: Add method using `this.exec(id, command)` pattern
2. **server.js**: Add REST endpoint with input validation, `touchSession()`, audit logging
3. **index.html**: Add UI elements (tab, button, panel, modal)
4. **styles.css**: Add CSS classes (follow brutalist design system)
5. **app.js**: Add DOM refs, state, event bindings, refresh function, tab-switching integration
6. **Manual test**: Connect to a VPS and verify the feature works

### Common Pitfalls
- **Escape in template literals**: When generating HTML in JS strings, use `escapeHtml()` and `escapeAttr()`
- **Session switching**: Always clear history/prev values in all three reset locations (connect, switch, disconnect)
- **Node.js script escaping**: When applying complex JS changes via Node script, use backtick template strings in source file to avoid quote escaping issues
- **str_replace precision**: Old strings must match exactly including whitespace and line endings
- **Terminal switching**: Always close old WebSocket and dispose old Terminal instance before creating new one

---

## Glossary

| Term | Meaning |
|------|---------|
| Session | An active SSH connection to one VPS server |
| Stat Block | One of the metric cards in the top stats row |
| Sparkline | Canvas-based line chart showing live resource history |
| Panel | A container with header + body (terminal, services, logs, etc.) |
| Vault | Encrypted storage for SSH credentials |
| Master Password | User-set password that derives the vault encryption key |
| Machine Key | Automatically-derived key from hostname + username |
| Audit Log | Append-only activity trail in `~/.vps-commander/audit.log` |
| TAB | Server tab in the header bar for switching between connected servers |
