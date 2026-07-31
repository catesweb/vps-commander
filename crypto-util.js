const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(os.homedir(), '.vps-commander');
const KEY_FILE = path.join(CONFIG_DIR, '.vps-key');
const APP_SECRET = 'vps-commander-local-secret-v2';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = 100000;
const VERIFY_ITERATIONS = 120000;

let memoryKey = null; // In-memory key for master password mode (never on disk)
let currentMethod = 'machine';

// ── Key File Management ───────────────────────────────────
function readKeyFile() {
  try {
    if (fs.existsSync(KEY_FILE)) {
      const raw = fs.readFileSync(KEY_FILE, 'utf8');
      // Support legacy hex-only format (pre-v2)
      if (raw.startsWith('{')) return JSON.parse(raw);
      if (raw.length === (SALT_LENGTH + KEY_LENGTH) * 2) {
        const buf = Buffer.from(raw, 'hex');
        const salt = buf.slice(0, SALT_LENGTH).toString('hex');
        const keyData = buf.slice(SALT_LENGTH).toString('hex');
        return { method: 'machine', salt, keyData };
      }
    }
  } catch {}
  return null;
}

function writeKeyFile(data) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(KEY_FILE, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
}

function getMachineFingerprint() {
  try { return `${os.hostname()}:${os.userInfo().username}`; } catch { return os.hostname(); }
}

function deriveMachineKey() {
  const fingerprint = getMachineFingerprint();
  const salt = crypto.randomBytes(SALT_LENGTH).toString('hex');
  const saltBuf = Buffer.from(salt, 'hex');
  const key = crypto.pbkdf2Sync(APP_SECRET + fingerprint, saltBuf, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
  return { salt, key };
}

// ── Initialization ────────────────────────────────────────
function init() {
  if (memoryKey) return; // Already initialized

  const keyData = readKeyFile();
  if (keyData) {
    currentMethod = keyData.method || 'machine';
    if (currentMethod === 'machine' && keyData.keyData && keyData.salt) {
      memoryKey = Buffer.from(keyData.keyData, 'hex');
    }
    // For master method, key stays null until unlock() is called
  } else {
    // First run — create machine key
    const { salt, key } = deriveMachineKey();
    currentMethod = 'machine';
    memoryKey = key;
    writeKeyFile({ method: 'machine', salt, keyData: key.toString('hex') });
  }
}

// ── Key Resolution ────────────────────────────────────────
function getKey() {
  init();
  if (!memoryKey) throw new Error('VAULT_LOCKED');
  return memoryKey;
}

// ── Encryption / Decryption ───────────────────────────────
function encrypt(plaintext) {
  if (!plaintext) return '';
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

function decrypt(encryptedText) {
  if (!encryptedText) return '';
  try {
    const key = getKey();
    const [ivHex, tagHex, cipherHex] = encryptedText.split(':');
    if (!ivHex || !tagHex || !cipherHex) return '';
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    if (e.message === 'VAULT_LOCKED') throw e;
    return '';
  }
}

// ── Auth Methods ──────────────────────────────────────────
function isLocked() {
  init();
  return currentMethod === 'master' && memoryKey === null;
}

function getStatus() {
  init();
  return {
    method: currentMethod,
    locked: isLocked(),
    hasMasterPassword: (readKeyFile()?.method === 'master') || false,
  };
}

// Set master password — re-encrypts nothing (caller handles profile re-encryption)
function setMasterPassword(password) {
  init();
  const keyFile = readKeyFile() || {};

  const salt = crypto.randomBytes(SALT_LENGTH).toString('hex');
  const verifySalt = crypto.randomBytes(SALT_LENGTH).toString('hex');

  const key = crypto.pbkdf2Sync(password, Buffer.from(salt, 'hex'), PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
  const verifyHash = crypto.pbkdf2Sync(password, Buffer.from(verifySalt, 'hex'), VERIFY_ITERATIONS, KEY_LENGTH, 'sha512').toString('hex');

  // Use new key immediately
  memoryKey = key;
  currentMethod = 'master';

  writeKeyFile({
    method: 'master',
    salt,
    verificationSalt: verifySalt,
    verificationHash: verifyHash,
  });

  return { success: true };
}

// Unlock with password — returns true if correct
function unlock(password) {
  init();
  const keyFile = readKeyFile();
  if (!keyFile || keyFile.method !== 'master') {
    throw new Error('No master password set');
  }

  const testHash = crypto.pbkdf2Sync(
    password,
    Buffer.from(keyFile.verificationSalt, 'hex'),
    VERIFY_ITERATIONS,
    KEY_LENGTH,
    'sha512'
  ).toString('hex');

  if (!crypto.timingSafeEqual(Buffer.from(testHash, 'hex'), Buffer.from(keyFile.verificationHash, 'hex'))) {
    throw new Error('Incorrect master password');
  }

  // Derive actual encryption key
  memoryKey = crypto.pbkdf2Sync(
    password,
    Buffer.from(keyFile.salt, 'hex'),
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    'sha512'
  );

  return { success: true };
}

// Lock — clears in-memory key
function lock() {
  memoryKey = null;
  return { success: true };
}

// Remove master password — re-encrypts nothing (caller handles profile re-encryption)
function removeMasterPassword() {
  const { salt, key } = deriveMachineKey();
  memoryKey = key;
  currentMethod = 'machine';
  writeKeyFile({ method: 'machine', salt, keyData: key.toString('hex') });
  return { success: true };
}

module.exports = { encrypt, decrypt, isLocked, getStatus, setMasterPassword, unlock, lock, removeMasterPassword };
