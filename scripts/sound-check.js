// scripts/sound-check.js
// Custom alert sound round-trip check: proves a picked audio file survives
// upload → disk → replay.
//
// WHY THIS EXISTS: the renderer can't read a picked file's absolute path
// (Electron dropped File.path in v32), so the only way a custom sound outlives
// the session is POST /api/sound/:type writing a server-side copy whose path
// gets stored in settings and re-fetched by GET /api/sound. Both halves fail
// silently in the UI — a broken upload just falls back to the synthesized beep,
// which sounds like a working default rather than a bug.
//
// Also asserts the renderer awaits the async getAlertAudio() before decoding.
// Calling decodeAudioData on the un-awaited Promise throws into a catch and
// leaves the sound cache empty — again, indistinguishable from "no custom
// sound set" in the UI.
//
// Usage: node scripts/sound-check.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3149;
const BASE = `http://localhost:${PORT}`;
const SOUND_DIR = path.join(os.homedir(), '.vps-commander', 'sounds');

// A 44-byte silent WAV header — enough to prove byte-exact round trip.
const WAV = Buffer.concat([
  Buffer.from('RIFF'), Buffer.from([36, 0, 0, 0]), Buffer.from('WAVEfmt '),
  Buffer.from([16, 0, 0, 0, 1, 0, 1, 0, 0x44, 0xac, 0, 0, 0x88, 0x58, 1, 0, 2, 0, 16, 0]),
  Buffer.from('data'), Buffer.from([0, 0, 0, 0]),
]);

// ── 1. Renderer: the file-picker handler must await getAlertAudio() ─────
const appJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const handler = appJs.slice(appJs.indexOf(".sound-file-input').forEach"));
const decodeCall = handler.slice(0, handler.indexOf('.decodeAudioData('));
assert.ok(
  /await getAlertAudio\(\)/.test(decodeCall),
  'sound-file-input handler must await getAlertAudio() before decodeAudioData'
);
assert.ok(
  !/file\.path/.test(handler.slice(0, 2000)),
  'sound-file-input handler must not read file.path (undefined in Electron 32+)'
);
console.log('PASS: renderer awaits the AudioContext and does not rely on file.path');

// ── 2. Server: upload → disk → download round trip ─────────────────────
const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  env: { ...process.env, VPS_COMMANDER_PORT: String(PORT) },
  cwd: ROOT,
  stdio: 'ignore',
});

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/api/sound`);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  throw new Error(`server did not come up on ${PORT}`);
}

(async () => {
  const preexisting = fs.existsSync(SOUND_DIR) ? fs.readdirSync(SOUND_DIR) : [];
  const usedType = 'soundcheck';
  assert.ok(
    !preexisting.some(f => f.startsWith(usedType + '.')),
    `refusing to clobber an existing ${usedType} sound`
  );

  await waitForServer();

  const up = await fetch(`${BASE}/api/sound/${usedType}?ext=wav`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: WAV,
  });
  const upBody = await up.json();
  assert.strictEqual(up.status, 200, `upload failed: ${JSON.stringify(upBody)}`);
  assert.ok(upBody.path, 'upload response must carry the saved path');
  assert.ok(fs.existsSync(upBody.path), `saved file missing at ${upBody.path}`);
  console.log('PASS: upload wrote', upBody.path);

  const down = await fetch(`${BASE}/api/sound?path=${encodeURIComponent(upBody.path)}`);
  assert.strictEqual(down.status, 200, 'replay fetch failed');
  const got = Buffer.from(await down.arrayBuffer());
  assert.ok(got.equals(WAV), 'replayed bytes differ from what was uploaded');
  console.log('PASS: replay returned the exact uploaded bytes');

  // Bad extension must be rejected — the GET side only serves audio extensions,
  // so anything else written here would be dead weight on disk.
  const bad = await fetch(`${BASE}/api/sound/${usedType}?ext=exe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: WAV,
  });
  assert.strictEqual(bad.status, 400, 'non-audio extension must be rejected');
  console.log('PASS: non-audio upload rejected');

  // ── 3. Bundled presets are listed and actually fetchable ─────────────
  const list = await fetch(`${BASE}/api/sounds`);
  assert.strictEqual(list.status, 200, '/api/sounds must answer');
  const { presets } = await list.json();
  assert.ok(Array.isArray(presets), '/api/sounds must return a presets array');

  const onDisk = fs.readdirSync(path.join(ROOT, 'public', 'sounds'))
    .filter(f => /\.(wav|mp3|ogg|m4a|aac|flac|weba)$/i.test(f)).sort();
  assert.deepStrictEqual(presets, onDisk, '/api/sounds must list every bundled audio file');
  assert.ok(presets.length > 0, 'expected at least one bundled preset in public/sounds/');

  // The renderer stores presets as "/sounds/<name>" and fetches that URL
  // directly rather than through /api/sound — prove the static route serves it.
  for (const name of presets) {
    const r = await fetch(`${BASE}/sounds/${encodeURIComponent(name)}`);
    assert.strictEqual(r.status, 200, `preset /sounds/${name} not served`);
    const bytes = Number(r.headers.get('content-length'));
    assert.ok(bytes > 0, `preset /sounds/${name} served empty`);
  }
  console.log(`PASS: ${presets.length} bundled preset(s) listed and served`);

  // ── 4. Renderer preset plumbing ──────────────────────────────────────
  assert.ok(
    /isPresetSound\(file\)\s*\?\s*file\s*:/.test(appJs),
    'loadSoundFile must fetch a "/sounds/..." preset directly, not via /api/sound?path='
  );
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const types = appJs.match(/const SOUND_TYPES = \[([^\]]+)\]/)[1]
    .split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
  for (const t of types) {
    assert.ok(
      html.includes(`class="settings-select sound-preset" data-type="${t}"`),
      `missing preset dropdown for alert type "${t}"`
    );
    assert.ok(html.includes(`id="sound-${t}"`), `missing stored-value input for "${t}"`);
  }
  console.log(`PASS: all ${types.length} alert types have a preset dropdown`);

  fs.unlinkSync(upBody.path);
  console.log('\nALL SOUND CHECKS PASSED');
})()
  .catch(err => {
    console.error('\nFAIL:', err.message);
    process.exitCode = 1;
  })
  .finally(() => server.kill());
