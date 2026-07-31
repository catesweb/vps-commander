// ═══════════════════════════════════════════════════════════
// VPS COMMANDER — CI Smoke Test
// Boots the Express server on a random port and verifies the
// core REST endpoints respond correctly. Exits non-zero on
// failure so GitHub Actions can gate on it.
// ═══════════════════════════════════════════════════════════
const { spawn } = require('child_process');
const http = require('http');

const READY_LINE = 'VPS COMMANDER'; // banner printed when server starts
const RESERVED_PORTS = new Set([3141]); // dev default — never collide with a running dev server
const MAX_PORT_ATTEMPTS = 5;

function pickPort() {
  let p;
  do {
    p = 3141 + Math.floor(Math.random() * 900);
  } while (RESERVED_PORTS.has(p));
  return p;
}

function request(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error(`timeout GET ${path}`)); });
  });
}

async function waitForServer(child, port) {
  const deadline = Date.now() + 15000;
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stderr += d.toString()));

  // Poll the sessions endpoint until it answers
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early (code ${child.exitCode}):\n${stdout}${stderr}`);
    }
    try {
      const res = await request(port, '/api/sessions');
      if (res.status === 200) {
        if (!stdout.includes(READY_LINE)) {
          throw new Error(`Server responded before startup banner (port ${port} may be in use by another process):\n${stdout}${stderr}`);
        }
        return;
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server did not become ready in time:\n${stdout}${stderr}`);
}

const CHECKS = [
  // [path, expectedStatus, bodyCheck?]
  ['/api/sessions', 200],
  ['/api/settings', 200],
  ['/api/auth/status', 200],
  // Unknown sessions degrade gracefully (stats -> 'N/A', logs -> error string),
  // they never 500 the API.
  ['/api/stats?sessionId=missing', 200, (body) => body.includes('N/A')],
  ['/api/logs?sessionId=missing', 200, (body) => body.includes('ERROR_READING_LOG')],
  ['/', 200], // static index
];

async function main() {
  console.log('\n  VPS Commander — smoke test\n');
  let child = null;
  let port = null;

  // Ports can collide with other processes; retry with a fresh port if
  // the server dies immediately (e.g. EADDRINUSE).
  for (let attempt = 1; attempt <= MAX_PORT_ATTEMPTS; attempt++) {
    port = pickPort();
    console.log(`  Attempt ${attempt}: booting server on port ${port}...`);
    child = spawn(process.execPath, ['server.js'], {
      env: { ...process.env, VPS_COMMANDER_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await waitForServer(child, port);
      break;
    } catch (err) {
      // server.js keeps the process alive on EADDRINUSE (its uncaughtException
      // handler logs and continues), so detect the collision from the child's
      // captured output rather than its exit code. The banner-check phrase is
      // included too: a 200 answered without our banner can only mean a foreign
      // server owns the port, and that path can fire before the child's stderr
      // carries the EADDRINUSE line.
      const portCollision = /EADDRINUSE|address already in use|may be in use by another process/i.test(err.message);
      child.kill('SIGKILL');
      child = null;
      if (portCollision && attempt < MAX_PORT_ATTEMPTS) {
        console.log(`  Port ${port} unavailable — retrying with a fresh port.`);
        continue;
      }
      console.error(`  SMOKE TEST FAILED: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }
  if (!child || port === null) {
    console.error('  SMOKE TEST FAILED: could not bind a free port');
    process.exitCode = 1;
    return;
  }

  try {
    for (const [path, expected, bodyCheck] of CHECKS) {
      const res = await request(port, path);
      const okStatus = res.status === expected;
      const okBody = bodyCheck ? bodyCheck(res.body) : true;
      const ok = okStatus && okBody;
      console.log(`  ${ok ? '✓' : '✗'} GET ${path} -> ${res.status} (expected ${expected}${bodyCheck ? ', body check' : ''})`);
      if (!ok) process.exitCode = 1;
    }
    console.log(process.exitCode === 1 ? '\n  SMOKE TEST FAILED\n' : '\n  SMOKE TEST PASSED\n');
  } catch (err) {
    console.error(`  SMOKE TEST FAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    child.kill('SIGKILL');
  }
}

main();
