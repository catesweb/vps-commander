// scripts/a11y-audit.js
// Automated WCAG 2.1 AA audit via @axe-core/playwright (uses playwright-core —
// the axe peer dep — since we drive the system Chrome via channel, no browser
// download needed).
//
// Spawns the real Express server (server.js) on a free port, loads the app in a
// headless browser, and audits these views with axe-core:
//   1. connect screen            (real initial state)
//   2. dashboard skeleton        (forced visible via JS — no SSH session)
//   3. dashboard + fixtures      (stubbed fetch drives the REAL render
//                                 functions, so the dynamic rows — services,
//                                 processes, UFW, docker, files, logs, audit,
//                                 app log — are scanned with real markup)
//   4. modals                    (settings, unlock, bulk, editor — opened one
//                                 at a time so their content is visible to axe)
//   5. swiss connect / swiss dashboard (light-theme contrast pass)
//
// Note: the axe `region` rule (best-practice) is NOT in the WCAG tags below,
// so it never runs. The connect panel now lives inside <main> and the skip
// link works from the first screen, so the old landmark gap is resolved.
//
// Reports are saved to reports/a11y/ for regression tracking:
//   - latest-<view>.json                    (full axe results, overwritten)
//   - summary.md                            (readable violation tables)
//   - json/<view>-<ts>.json                 (timestamped snapshots, kept)
//
// Usage: node scripts/a11y-audit.js
// Exit code is non-zero if any view has a violation with impact serious/critical.

const { chromium } = require('playwright-core');
const AxeBuilder = require('@axe-core/playwright').default;
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPORT_DIR = path.join(ROOT, 'reports', 'a11y');
const JSON_DIR = path.join(REPORT_DIR, 'json');
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

// ── helpers ────────────────────────────────────────────────

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function waitForServer(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const ping = () => {
      http.get({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, (res) => {
        res.resume();
        resolve();
      }).on('error', () => {
        if (Date.now() > deadline) reject(new Error('server did not start in time'));
        else setTimeout(ping, 250);
      });
    };
    ping();
  });
}

async function launchBrowser() {
  try {
    return await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    // playwright-core does NOT auto-download browsers. This is a Windows-targeted
    // app, so Edge (Chromium-based) is a likely fallback before giving up.
    try {
      return await chromium.launch({ channel: 'msedge', headless: true });
    } catch {
      console.warn('No system Chrome/Edge found. Install one:  npx playwright-core install chromium');
      throw new Error('No usable browser: system Chrome or Edge required (or run `npx playwright-core install chromium`).');
    }
  }
}

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function summarize(label, results) {
  const byImpact = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const v of results.violations) byImpact[v.impact] = (byImpact[v.impact] || 0) + 1;
  const lines = [`## ${label}`, '', `- Violations: ${results.violations.length} (critical ${byImpact.critical} / serious ${byImpact.serious} / moderate ${byImpact.moderate} / minor ${byImpact.minor})`, '', '| Rule | Impact | Nodes | Help |', '| --- | --- | --- | --- |'];
  for (const v of results.violations) {
    lines.push(`| ${v.id} | ${v.impact} | ${v.nodes.length} | ${v.help} |`);
  }
  if (results.violations.length === 0) lines.push('| _none_ | — | — | — |');
  return lines.join('\n');
}

async function audit(page, label, views) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  views.push({ name: label, results });
  return results;
}

// ── fixture injection ─────────────────────────────────────
// Stubs window.fetch for the data endpoints and drives the app's REAL render
// functions so the dynamic row markup (which received the manual aria-labels)
// is exercised. Returns when all renders have settled.
function injectFixtures(page) {
  return page.evaluate(async () => {
    const realFetch = window.fetch.bind(window);

    // Order-independence: the fixtures drive dashboard render functions, so make
    // sure the dashboard view is shown and the connect panel hidden even if the
    // prior view didn't leave them that way.
    const dashboardView = document.getElementById('dashboard-view');
    const connectPanel = document.getElementById('connect-panel');
    if (dashboardView) dashboardView.style.display = 'flex';
    if (connectPanel) connectPanel.style.display = 'none';

    // Fixture responses keyed by API path prefix.
    const fixtures = {
      '/api/services': { services: 'nginx.service loaded active running\nsshd.service loaded active running\nfail2ban.service loaded failed failed\ndocker.service loaded inactive dead' },
      '/api/processes': { processes: [
        { pid: 1234, user: 'www-data', cpu: 87.4, mem: 32.1, command: '/usr/bin/node server.js --env production --workers 4' },
        { pid: 1, user: 'root', cpu: 0.1, mem: 0.3, command: '/sbin/init' },
        { pid: 5678, user: 'ubuntu', cpu: 12.5, mem: 8.2, command: 'python3 /opt/worker.py --queue high' },
      ] },
      '/api/ufw/status': { active: true, defaultPolicy: 'deny', rules: [
        { number: 1, rule: 'OpenSSH', action: 'ALLOW', from: 'Anywhere' },
        { number: 2, rule: '80/tcp', action: 'DENY', from: 'Anywhere' },
        { number: 3, rule: '8080/tcp', action: 'LIMIT', from: '10.0.0.0/8' },
      ] },
      '/api/docker/containers': { containers: [
        { name: 'web-nginx', image: 'nginx:latest', status: 'Up 3 hours', ports: '0.0.0.0:80->80/tcp' },
        { name: 'db-postgres', image: 'postgres:16', status: 'Exited (0)', ports: '--' },
      ] },
      '/api/logs': { logs: 'Jul 31 12:00:01 host systemd[1]: Started VPS Commander\nJul 31 12:00:02 host sshd[999]: Accepted publickey for root from 10.0.0.5' },
      '/api/audit-log': { entries: [
        '[2026-07-31T12:00:00.000Z] CONNECT | root@10.0.0.1',
        '[2026-07-31T12:00:01.000Z] SERVICE | nginx restart',
        '[2026-07-31T12:00:02.000Z] ALERT | CPU: 95.2% (threshold: 90%)',
      ] },
      '/api/error-log': { log: '[2026-07-31T12:00:03.000Z] ERROR [server] Unhandled rejection | {"pid":1234}' },
    };

    window.fetch = (url, opts) => {
      const u = String(url);
      for (const [prefix, data] of Object.entries(fixtures)) {
        if (u.includes(prefix)) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(data))) });
        }
      }
      return realFetch(url, opts);
    };

    // Fake session so session-guarded refresh functions proceed.
    State.activeSession = 'fixture-session';
    State.sessions['fixture-session'] = { sessionId: 'fixture-session', host: '10.0.0.1', port: 22, username: 'root', label: 'FIXTURE', statsInterval: null, servicesInterval: null, logsInterval: null };

    // Drive the real render functions (each awaits the stubbed fetch).
    await refreshServices('fixture-session');
    await refreshProcesses();
    await refreshUfw();
    await refreshDocker();
    await refreshLogs('fixture-session');
    await refreshAuditLog();
    await refreshAppLog();

    // File table renders from State directly (no fetch).
    State.filePath = '/var/www';
    State.fileList = [
      { name: 'index.html', isDirectory: false, isSymlink: false, size: 2048, mtime: new Date().toISOString(), permissions: '-rw-r--r--' },
      { name: 'assets', isDirectory: true, isSymlink: false, size: 0, mtime: new Date().toISOString(), permissions: 'drwxr-xr-x' },
      { name: 'config.yml', isDirectory: false, isSymlink: false, size: 512, mtime: new Date().toISOString(), permissions: '-rw-r--r--' },
    ];
    renderBreadcrumb('/var/www');
    renderFileTable();

    // Force-show every tab body + the hidden ufw add form so all rows are visible to axe.
    document.querySelectorAll('.tab-content').forEach((el) => { el.style.display = 'block'; });
    const ufwForm = document.getElementById('ufw-add-form');
    if (ufwForm) ufwForm.style.display = 'flex';

    // Restore the real fetch so the modal/Swiss views audit against a live
    // network, not a permanently stubbed one.
    window.fetch = realFetch;
  });
}

// ── main ───────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(JSON_DIR, { recursive: true });
  const port = await getFreePort();
  const stamp = ts();

  console.log(`[a11y] starting server on port ${port} ...`);
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, VPS_COMMANDER_PORT: String(port) },
    stdio: 'ignore',
  });
  const cleanup = () => { try { server.kill(); } catch { /* noop */ } };

  try {
    await waitForServer(port);
    const browser = await launchBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });

    const views = [];

    // ── View 1: connect screen (tactical) ──
    await audit(page, 'connect', views);

    // ── View 2: dashboard skeleton (forced visible) ──
    await page.evaluate(() => {
      const view = document.getElementById('dashboard-view');
      const panel = document.getElementById('connect-panel');
      if (view) view.style.display = 'flex';
      if (panel) panel.style.display = 'none';
    });
    await page.waitForTimeout(300);
    await audit(page, 'dashboard', views);

    // ── View 3: dashboard + fixtures (dynamic rows) ──
    await injectFixtures(page);
    await page.waitForTimeout(300);
    await audit(page, 'dashboard-fixtures', views);

    // ── Views 4-7: modals, one at a time ──
    const modals = ['settings-modal', 'unlock-modal', 'bulk-modal', 'editor-modal'];
    for (const id of modals) {
      await page.evaluate((modalId) => {
        const el = document.getElementById(modalId);
        if (el && window.openModal) openModal(el);
      }, id);
      await page.waitForTimeout(250); // entry transition settles
      await audit(page, 'modal-' + id.replace('-modal', ''), views);
      await page.evaluate((modalId) => {
        const el = document.getElementById(modalId);
        if (el && window.closeModal) closeModal(el);
      }, id);
      await page.waitForTimeout(250);
    }

    // ── Views 8-9: Swiss light theme (contrast pass) ──
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'swiss';
      const view = document.getElementById('dashboard-view');
      const panel = document.getElementById('connect-panel');
      if (view) view.style.display = 'none';
      if (panel) panel.style.display = 'flex';
    });
    await page.waitForTimeout(300);
    await audit(page, 'swiss-connect', views);

    await page.evaluate(() => {
      const view = document.getElementById('dashboard-view');
      const panel = document.getElementById('connect-panel');
      if (view) view.style.display = 'flex';
      if (panel) panel.style.display = 'none';
    });
    await page.waitForTimeout(300);
    await audit(page, 'swiss-dashboard', views);

    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'tactical';
    });

    // ── save reports ──
    for (const { name, results } of views) {
      fs.writeFileSync(path.join(REPORT_DIR, `latest-${name}.json`), JSON.stringify(results, null, 2));
      fs.writeFileSync(path.join(JSON_DIR, `${name}-${stamp}.json`), JSON.stringify(results, null, 2));
    }

    const summary = [
      '# VPS Commander — axe-core WCAG 2.1 AA Audit',
      '',
      `Generated: ${new Date().toISOString()}`,
      '',
      ...views.flatMap(({ name, results }) => [summarize(name, results), '']),
      'Full JSON: `reports/a11y/latest-<view>.json`',
      'Historical: `reports/a11y/json/`',
    ].join('\n');
    fs.writeFileSync(path.join(REPORT_DIR, 'summary.md'), summary);

    console.log(summary);
    await context.close();
    await browser.close();

    const critical = views.flatMap(({ results }) => results.violations)
      .filter((v) => v.impact === 'critical' || v.impact === 'serious').length;
    const total = views.reduce((n, v) => n + v.results.violations.length, 0);
    console.log(`\n[a11y] done. ${views.length} views, ${total} total violations (${critical} serious/critical).`);
    if (critical > 0) process.exitCode = 1;
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error('[a11y] audit failed:', err.message);
  process.exit(1);
});
