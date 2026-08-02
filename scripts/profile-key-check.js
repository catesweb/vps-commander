#!/usr/bin/env node
// Verifies a saved SSH key survives the encrypt → disk → decrypt round trip and
// that getProfilesSafe reports hasPrivateKey (the flag the connect form gates on).
// Runs against a throwaway HOME so the real ~/.vps-commander is untouched.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vpsc-check-'));
process.env.USERPROFILE = sandbox; // win32
process.env.HOME = sandbox;        // posix

const settings = require('../settings');
assert.ok(settings.CONFIG_DIR.startsWith(sandbox), 'sandbox HOME not picked up — aborting to protect real profiles');

const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\n-----END OPENSSH PRIVATE KEY-----';
const saved = settings.saveProfile({ label: 'check', host: '10.0.0.1', port: 22, username: 'root', privateKey: KEY });

const safe = settings.getProfilesSafe().find(p => p.id === saved.id);
assert.strictEqual(safe.hasPrivateKey, true, 'hasPrivateKey must be true for a key-only profile');
assert.strictEqual(safe.hasPassword, false, 'key-only profile must not report a password');
assert.ok(!('privateKeyEncrypted' in safe), 'safe profile must not leak the ciphertext');

const full = settings.getProfiles().find(p => p.id === saved.id);
assert.strictEqual(full.privateKey, KEY, 'decrypted key must match what was saved');

const onDisk = fs.readFileSync(path.join(settings.CONFIG_DIR, 'profiles.json'), 'utf8');
assert.ok(!onDisk.includes('BEGIN OPENSSH'), 'key must never hit disk in plaintext');

fs.rmSync(sandbox, { recursive: true, force: true });
console.log('profile-key-check: OK');
