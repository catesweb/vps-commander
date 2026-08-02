// scripts/terminal-focus-check.js
// Terminal INPUT-PATH check, in a real browser.
//
// scripts/terminal-check.js proves a keystroke that reaches the WebSocket makes
// it to the SSH shell. It cannot see the half of the problem that lives in the
// DOM: whether a click on the terminal actually lands focus on xterm's hidden
// textarea. If it does not, nothing is typed, no error is raised, and the
// transport check still passes — the terminal just sits there ignoring the
// keyboard.
//
// WHY THIS EXISTS: `.panel-grip` set `panel.draggable = true` on pointerdown and
// cleared it on the grip's own pointerup. Release the button anywhere else — the
// normal end of a drag — and the panel stayed draggable forever. A draggable
// ancestor makes Chromium swallow mousedown's default action, so clicking the
// terminal stopped focusing it and the whole panel went keyboard-dead.
//
// Usage: node scripts/terminal-focus-check.js

const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');

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

// Show the dashboard and mount a real xterm. The WebSocket will fail to open a
// shell (no SSH session behind the fixture id) — irrelevant here, the terminal
// still renders and still owns the keyboard.
function mountTerminal(page) {
  return page.evaluate(async () => {
    document.getElementById('dashboard-view').style.display = 'flex';
    document.getElementById('connect-panel').style.display = 'none';
    State.activeSession = 'fixture-session';
    State.sessions['fixture-session'] = { sessionId: 'fixture-session', host: '10.0.0.1', port: 22, username: 'root', label: 'FIXTURE' };
    initTerminal('fixture-session');
    await new Promise((r) => setTimeout(r, 400));
  });
}

const failures = [];
const check = (ok, label) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures.push(label);
};

// Focus lands on xterm's hidden textarea — the only element that turns a keypress
// into terminal input.
const focusIsTerminal = (page) => page.evaluate(() =>
  !!document.activeElement && document.activeElement.classList.contains('xterm-helper-textarea'));

async function main() {
  console.log('\n  VPS Commander — terminal focus check\n');
  const port = await getFreePort();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, VPS_COMMANDER_PORT: String(port) },
    stdio: 'ignore',
  });

  let browser = null;
  try {
    await waitForServer(port);
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    await mountTerminal(page);

    // 1. The baseline every other assertion depends on.
    await page.click('#terminal-container .xterm-screen');
    check(await focusIsTerminal(page), 'clicking the terminal focuses it');

    // 2. A real keypress arrives as terminal input rather than being eaten by a
    //    document-level shortcut handler.
    await page.evaluate(() => {
      window.__typed = '';
      State.term.onData((d) => { window.__typed += d; });
    });
    await page.keyboard.type('id');
    const typed = await page.evaluate(() => window.__typed);
    check(typed === 'id', `keystrokes reach the terminal (got ${JSON.stringify(typed)})`);

    // 3. The panel padding is part of the terminal as far as the user is
    //    concerned — a click there must not drop focus on the floor.
    await page.evaluate(() => document.activeElement.blur());
    const box = await page.locator('#terminal-container').boundingBox();
    await page.mouse.click(box.x + 2, box.y + box.height - 2); // inside padding, outside .xterm
    check(await focusIsTerminal(page), 'clicking the terminal padding focuses it');

    // 4. The regression itself: a grip press released anywhere else must not
    //    leave the panel draggable, because a draggable ancestor kills the click
    //    that focuses the terminal.
    await page.evaluate(() => {
      const grip = document.querySelector('[data-panel="terminal"] [data-grip]');
      grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }));
      document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, button: 0 }));
    });
    const stuck = await page.evaluate(() => document.querySelector('[data-panel="terminal"]').draggable);
    check(stuck === false, `grip press released off-grip leaves the panel non-draggable (draggable=${stuck})`);

    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.click('#terminal-container .xterm-screen');
    check(await focusIsTerminal(page), 'terminal still focuses after a grip press');

    // 5. A splitter drag that ends abnormally must not leave the whole UI behind
    //    `body.is-resizing * { pointer-events: none }`.
    await page.evaluate(() => {
      const sp = document.querySelector('.splitter[data-resize="side-w"]');
      sp.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2, button: 0 }));
      document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 2, button: 0 }));
    });
    const resizing = await page.evaluate(() => document.body.classList.contains('is-resizing'));
    check(resizing === false, `splitter release off-handle clears is-resizing (is-resizing=${resizing})`);

    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.click('#terminal-container .xterm-screen');
    check(await focusIsTerminal(page), 'terminal still focuses after a splitter drag');
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { server.kill(); } catch { /* noop */ }
  }

  if (failures.length) {
    console.error(`\n  TERMINAL FOCUS CHECK FAILED (${failures.length}):`);
    failures.forEach((f) => console.error('    - ' + f));
    process.exit(1);
  }
  console.log('\n  TERMINAL FOCUS CHECK PASSED\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('  TERMINAL FOCUS CHECK FAILED:', err.message);
  process.exit(1);
});
