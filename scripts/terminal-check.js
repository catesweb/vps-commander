// scripts/terminal-check.js
// Terminal transport check: prove that a keystroke sent over the WebSocket
// actually reaches the SSH shell stream.
//
// WHY THIS EXISTS: terminal input was silently dead. `terminal:init` declared
// `const sid` inside its own `if` block, so the `terminal:input` and
// `terminal:resize` branches referenced an identifier that did not exist in
// their scope. Every keystroke threw ReferenceError one line before
// shellStream.write(), and the handler's bare `catch {}` swallowed it. The
// terminal rendered, took focus, echoed the local keypress into xterm — and
// sent nothing. Nothing in the UI, the logs, or the existing smoke test noticed.
//
// The SSH layer is stubbed through require.cache so this runs in CI with no
// server to connect to. It asserts the transport, not ssh2.
//
// Usage: node scripts/terminal-check.js

const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PORT = 3990 + Math.floor(Math.random() * 500);

// ── stub the SSH handler before server.js requires it ──────

const received = { input: [], window: null, shellRequests: [] };

function fakeShellStream() {
  const handlers = {};
  return {
    on(event, fn) { handlers[event] = fn; return this; },
    stderr: { on() { /* unused */ } },
    write(data) { received.input.push(data); },
    setWindow(rows, cols) { received.window = { rows, cols }; },
    close() { if (handlers.close) handlers.close(); },
  };
}

const sshStub = new Proxy({
  shell(id) { received.shellRequests.push(id); return Promise.resolve(fakeShellStream()); },
  listSessions() { return []; },
  getSession() { return null; },
}, {
  // Any other method the REST layer reaches for resolves to an inert value
  // rather than crashing the boot.
  get(target, prop) {
    if (prop in target) return target[prop];
    return () => Promise.resolve(null);
  },
});

const sshPath = require.resolve(path.join(ROOT, 'ssh-handler.js'));
require.cache[sshPath] = { id: sshPath, filename: sshPath, loaded: true, exports: sshStub };

// ── boot the real server in-process ────────────────────────

process.env.VPS_COMMANDER_PORT = String(PORT);
require(path.join(ROOT, 'server.js'));

// ── drive the socket ───────────────────────────────────────

const WebSocket = require('ws');

const failures = [];
const check = (ok, label) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures.push(label);
};

function waitForServer(deadline = Date.now() + 10000) {
  return new Promise((resolve, reject) => {
    const ping = () => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/api/sessions', timeout: 1000 }, (res) => {
        res.resume(); resolve();
      }).on('error', () => {
        if (Date.now() > deadline) reject(new Error('server did not start'));
        else setTimeout(ping, 200);
      });
    };
    ping();
  });
}

async function main() {
  console.log('\n  VPS Commander — terminal transport check\n');
  await waitForServer();

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  const send = (obj) => new Promise((r) => { ws.send(JSON.stringify(obj)); setTimeout(r, 120); });

  await send({ type: 'terminal:init', sessionId: 'check-session' });
  check(received.shellRequests.includes('check-session'), 'terminal:init opens a shell for the session');

  await send({ type: 'terminal:input', data: 'whoami\r' });
  check(received.input.join('') === 'whoami\r',
    `terminal:input reaches the shell stream (got ${JSON.stringify(received.input.join(''))})`);

  await send({ type: 'terminal:resize', rows: 44, cols: 132 });
  check(received.window && received.window.rows === 44 && received.window.cols === 132,
    `terminal:resize reaches the shell stream (got ${JSON.stringify(received.window)})`);

  // A second keystroke must still land — the original bug threw on every input
  // frame, not just the first, and a handler that dies once tends to stay dead.
  await send({ type: 'terminal:input', data: 'ls -la\r' });
  check(received.input.join('') === 'whoami\rls -la\r', 'a subsequent keystroke still reaches the shell');

  ws.close();

  if (failures.length) {
    console.error(`\n  TERMINAL CHECK FAILED (${failures.length}):`);
    failures.forEach((f) => console.error('    - ' + f));
    process.exit(1);
  }
  console.log('\n  TERMINAL CHECK PASSED\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('  TERMINAL CHECK FAILED:', err.message);
  process.exit(1);
});
