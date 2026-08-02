// scripts/log-watch-check.js
// Log-watch scan check: proves matchLogWatch() only alerts on lines that are
// genuinely new since the previous poll.
//
// WHY THIS EXISTS: the scanner has no cursor from the server — it re-reads the
// same `tail -n 200` every 30s and works out what's new by finding the previous
// anchor line in the new buffer. Two ways that silently breaks: anchoring on a
// trailing empty line (lastIndexOf('') always returns the new trailing index,
// so every subsequent poll scans zero lines and no alert ever fires again), and
// alerting on the whole backlog the first time a file is opened. Neither shows
// up in the UI — the logs panel looks identical either way.
//
// app.js is a plain browser script with no module system, so the pure function
// is extracted from the source and evaluated here.
//
// Usage: node scripts/log-watch-check.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const APP_JS = path.join(__dirname, '..', 'public', 'js', 'app.js');
const src = fs.readFileSync(APP_JS, 'utf8');

const start = src.indexOf('function matchLogWatch(');
assert.ok(start !== -1, 'matchLogWatch not found in public/js/app.js');
const end = src.indexOf('\n}\n', start);
assert.ok(end !== -1, 'could not find the end of matchLogWatch');

// eslint-disable-next-line no-new-func
const matchLogWatch = new Function(`${src.slice(start, end + 3)}\nreturn matchLogWatch;`)();

const PATTERNS = ['error', 'denied'];
let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

console.log('log-watch scan check');

check('first poll never alerts on the existing backlog', () => {
  const r = matchLogWatch('old line\nfatal error here\nlast line', null, PATTERNS);
  assert.strictEqual(r.hit, null);
  assert.strictEqual(r.anchor, 'last line');
});

check('a new matching line after the anchor alerts', () => {
  const r = matchLogWatch('old line\nlast line\nssh: permission denied', 'last line', PATTERNS);
  assert.strictEqual(r.hit, 'denied');
  assert.strictEqual(r.line, 'ssh: permission denied');
  assert.strictEqual(r.anchor, 'ssh: permission denied');
});

check('lines at or before the anchor never re-alert', () => {
  const r = matchLogWatch('disk error\nlast line', 'last line', PATTERNS);
  assert.strictEqual(r.hit, null);
});

check('trailing newline does not stall the scan', () => {
  // tail output usually ends in \n, so lines[] ends with ''. Anchoring on that
  // empty string would make every later poll scan nothing.
  let r = matchLogWatch('line one\nline two\n', null, PATTERNS);
  assert.strictEqual(r.anchor, 'line two', 'anchor must skip the trailing empty line');
  r = matchLogWatch('line one\nline two\nauth error\n', r.anchor, PATTERNS);
  assert.strictEqual(r.hit, 'error');
});

check('matching is case-insensitive', () => {
  const r = matchLogWatch('anchor\nKernel PANIC: ERROR state', 'anchor', ['error']);
  assert.strictEqual(r.hit, 'error');
});

check('rotated log (anchor gone) scans the whole buffer once', () => {
  const r = matchLogWatch('fresh error after rotate\ntail', 'vanished anchor', PATTERNS);
  assert.strictEqual(r.hit, 'error');
});

check('empty pattern list yields no hit', () => {
  const r = matchLogWatch('anchor\nsome error', 'anchor', []);
  assert.strictEqual(r.hit, null);
});

check('empty log keeps the previous anchor', () => {
  const r = matchLogWatch('', 'anchor', PATTERNS);
  assert.strictEqual(r.hit, null);
  assert.strictEqual(r.anchor, 'anchor');
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
