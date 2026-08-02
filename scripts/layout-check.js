// scripts/layout-check.js
// Layout regression probe. Spawns the real server, forces the dashboard visible
// the way scripts/a11y-audit.js does, and asserts the layout invariants at every
// window size the app can actually be resized to (Electron's minWidth/minHeight
// are 900x600 — see main.js).
//
// WHY BOTH AXES: the first version of this probe only measured width, and three
// defects walked straight past it because they cost height instead — a 6-column
// grid holding 7 stat blocks, a hardcoded `height: calc(100vh - 52px)`, and
// panels that collapsed toward zero rather than scrolling. Clipping that costs
// height looks identical to the user. Every assertion below exists because
// something shipped broken without it.
//
// Usage: node scripts/layout-check.js
// Exit code is non-zero if any assertion fails.

const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Width x height pairs. 900x600 is the Electron minimum; 500x860 approximates a
// half-width or zoomed window (browser zoom shrinks the CSS viewport, which is
// how a 900px-minimum window still reported ~500 CSS px in the wild).
const VIEWPORTS = [
  [1400, 900],
  [1280, 720],
  [1100, 700],
  [960, 640],
  [900, 600],
  [500, 860],
];

const MIN_TERMINAL_HEIGHT = 150; // below this the terminal is a useless sliver

// ── harness ────────────────────────────────────────────────

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
    try {
      return await chromium.launch({ channel: 'msedge', headless: true });
    } catch {
      throw new Error('No usable browser: system Chrome or Edge required (or run `npx playwright-core install chromium`).');
    }
  }
}

// ── measurement (runs in the page) ─────────────────────────

function measure() {
  const de = document.documentElement;
  const round = (n) => Math.round(n);

  // Elements whose content is wider than their box AND which neither scroll nor
  // ellipsize it — i.e. content the user simply cannot see. `.sr-only` is
  // excluded: it is deliberately clipped to 1px for screen readers.
  const clipped = [];
  document.querySelectorAll('*').forEach((el) => {
    if (el.classList.contains('sr-only') || el.closest('.sr-only')) return;
    if (el.clientWidth <= 0) return;
    if (el.scrollWidth <= el.clientWidth + 1) return;
    const cs = getComputedStyle(el);
    if (cs.overflowX !== 'visible' && cs.overflowX !== 'hidden') return; // scrolls: reachable
    if (cs.textOverflow === 'ellipsis') return;                          // truncates visibly
    clipped.push({
      el: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).trim().split(/\s+/).join('.') : ''),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    });
  });

  // Stat blocks must fill every row they occupy. A fixed column count that does
  // not divide the block count leaves the tail of the last row as dead panel
  // background — that was a ~65px black band at every window size.
  const blocks = [...document.querySelectorAll('.stat-block')].filter((b) => b.offsetParent !== null);
  const rows = new Map();
  blocks.forEach((b) => {
    const top = round(b.getBoundingClientRect().top);
    if (!rows.has(top)) rows.set(top, []);
    rows.get(top).push(b);
  });
  const statsWidth = document.querySelector('.stats-row').clientWidth;
  const shortRows = [];
  for (const [top, items] of rows) {
    const used = items.reduce((sum, el) => sum + el.getBoundingClientRect().width, 0) + (items.length - 1); // +1px gaps
    if (statsWidth - used > 2) shortRows.push({ top, used: round(used), rowWidth: statsWidth, blocks: items.length });
  }

  const statusBar = document.querySelector('.status-bar').getBoundingClientRect();
  const terminal = document.querySelector('.terminal-container').getBoundingClientRect();

  return {
    hOverflow: de.scrollWidth - de.clientWidth,
    clipped,
    shortRows,
    statRowCount: rows.size,
    statusBarVisible: statusBar.top >= 0 && statusBar.bottom <= window.innerHeight + 1,
    terminalHeight: round(terminal.height),
    // Panels must not be clipped away: below its floor .dashboard scrolls instead.
    dashboardScrolls: (() => {
      const d = document.querySelector('.dashboard');
      return d.scrollHeight > d.clientHeight;
    })(),
    dashboardReachable: (() => {
      const d = document.querySelector('.dashboard');
      return d.scrollHeight <= d.clientHeight || getComputedStyle(d).overflowY === 'auto';
    })(),
  };
}

// ── fixtures ───────────────────────────────────────────────
// Same shape as scripts/a11y-audit.js: drive the REAL render functions so the
// panels hold real rows. An empty panel cannot reproduce a content-driven
// min-width, which is the failure mode this probe exists to catch.
function showDashboardWithFixtures(page) {
  return page.evaluate(async () => {
    document.getElementById('dashboard-view').style.display = 'flex';
    document.getElementById('connect-panel').style.display = 'none';
    const bulk = document.getElementById('btn-bulk');
    if (bulk) bulk.style.display = '';

    const realFetch = window.fetch.bind(window);
    const fixtures = {
      '/api/services': { services: 'nginx.service loaded active running\nsshd.service loaded active running\nfail2ban.service loaded failed failed\ndocker.service loaded inactive dead' },
      '/api/processes': { processes: [
        { pid: 1234, user: 'www-data', cpu: 87.4, mem: 32.1, command: '/usr/bin/node server.js --env production --workers 4' },
        { pid: 1, user: 'root', cpu: 0.1, mem: 0.3, command: '/sbin/init' },
        { pid: 5678, user: 'ubuntu', cpu: 12.5, mem: 8.2, command: 'python3 /opt/worker.py --queue high' },
      ] },
      '/api/ufw/status': { active: true, defaultPolicy: 'deny', rules: [
        { number: 1, rule: 'OpenSSH', action: 'ALLOW', from: 'Anywhere' },
        { number: 2, rule: '8080/tcp', action: 'LIMIT', from: '10.0.0.0/8' },
      ] },
      '/api/docker/containers': { containers: [
        { name: 'web-nginx', image: 'nginx:latest', status: 'Up 3 hours', ports: '0.0.0.0:80->80/tcp' },
      ] },
      '/api/logs': { logs: 'Jul 31 12:00:01 host systemd[1]: Started VPS Commander' },
      '/api/audit-log': { entries: ['[2026-07-31T12:00:00.000Z] CONNECT | root@10.0.0.1'] },
      '/api/error-log': { log: '' },
    };
    window.fetch = (url, opts) => {
      const u = String(url);
      for (const [prefix, data] of Object.entries(fixtures)) {
        if (u.includes(prefix)) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
      }
      return realFetch(url, opts);
    };

    State.activeSession = 'fixture-session';
    State.sessions['fixture-session'] = { sessionId: 'fixture-session', host: '10.0.0.1', port: 22, username: 'root', label: 'FIXTURE' };
    await refreshServices('fixture-session');
    await refreshProcesses();
    await refreshUfw();
    await refreshDocker();
    await refreshLogs('fixture-session');
    await refreshAuditLog();

    // Long unbreakable system-info values are a classic min-width trap.
    const sysinfo = { hostname: 'vm1177', os: 'Ubuntu 26.04 LTS', kernel: '7.0.0-28-generic', network: 'ens3:|83811232|2196453' };
    Object.entries(sysinfo).forEach(([k, v]) => {
      const el = document.getElementById('si-' + k);
      if (el) el.textContent = v;
    });

    window.fetch = realFetch;
  });
}

// ── main ───────────────────────────────────────────────────

async function main() {
  const port = await getFreePort();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, VPS_COMMANDER_PORT: String(port) },
    stdio: 'ignore',
  });
  const failures = [];

  try {
    await waitForServer(port);
    const browser = await launchBrowser();

    for (const [width, height] of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
      await showDashboardWithFixtures(page);
      await page.waitForTimeout(350);

      const m = await page.evaluate(measure);
      const at = `${width}x${height}`;
      const fail = (msg) => failures.push(`${at}: ${msg}`);

      if (m.hOverflow > 1) fail(`horizontal overflow of ${m.hOverflow}px on the document`);
      for (const c of m.clipped) fail(`${c.el} clips content with no scroll or ellipsis (${c.scrollWidth}px in ${c.clientWidth}px)`);
      for (const r of m.shortRows) fail(`stat row at y=${r.top} leaves ${r.rowWidth - r.used}px of dead space (${r.blocks} block(s) of ${r.rowWidth}px)`);
      if (!m.statusBarVisible) fail('status bar is outside the viewport');
      if (m.terminalHeight < MIN_TERMINAL_HEIGHT) fail(`terminal collapsed to ${m.terminalHeight}px (floor ${MIN_TERMINAL_HEIGHT}px)`);
      if (!m.dashboardReachable) fail('dashboard content overflows but cannot be scrolled to');

      const status = failures.some((f) => f.startsWith(at)) ? 'FAIL' : 'ok';
      console.log(`[layout] ${at.padEnd(9)} ${status.padEnd(4)} stat rows ${m.statRowCount}, terminal ${m.terminalHeight}px${m.dashboardScrolls ? ', dashboard scrolls' : ''}`);

      await context.close();
    }

    await browser.close();
  } finally {
    try { server.kill(); } catch { /* noop */ }
  }

  if (failures.length) {
    console.error(`\n[layout] ${failures.length} failure(s):`);
    failures.forEach((f) => console.error('  - ' + f));
    process.exitCode = 1;
  } else {
    console.log(`\n[layout] all ${VIEWPORTS.length} viewports pass.`);
  }
}

main().catch((err) => {
  console.error('[layout] probe failed:', err.message);
  process.exit(1);
});
