const fs = require('fs');
const path = require('path');
const os = require('os');
const { encrypt, decrypt } = require('./crypto-util');

const CONFIG_DIR = path.join(os.homedir(), '.vps-commander');
const SETTINGS_PATH = path.join(CONFIG_DIR, 'settings.json');
const PROFILES_PATH = path.join(CONFIG_DIR, 'profiles.json');
const AUDIT_LOG_PATH = path.join(CONFIG_DIR, 'audit.log');

const DEFAULT_SETTINGS = {
  theme: 'tactical',
  statsInterval: 3000,
  servicesInterval: 10000,
  logsInterval: 30000,
  logLines: 200,
  terminalFontSize: 13,
  terminalScrollback: 5000,
  sessionTimeout: 3600000,  // 1 hour idle timeout
  auditLog: true,
  alertEnabled: true,
  alertSound: true,
  alertSounds: {
    cpu:       { enabled: true, file: '' },
    memory:    { enabled: true, file: '' },
    disk:      { enabled: true, file: '' },
    network:   { enabled: true, file: '' },
    connectOk: { enabled: true, file: '' },
    connectFail: { enabled: true, file: '' },
  },
  alertCpu: 90,
  alertMem: 90,
  alertDisk: 90,
  alertNetMbps: 800,
  logPresets: [
    '/var/log/syslog',
    '/var/log/auth.log',
    '/var/log/kern.log',
    '/var/log/nginx/access.log',
    '/var/log/nginx/error.log',
    '/var/log/mysql/error.log',
  ],
};

function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function readJSON(filePath, defaults) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) {
    console.error(`[vps-commander] Could not read ${filePath}:`, err.message);
  }
  return defaults;
}

function writeJSON(filePath, data) {
  ensureDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ── Audit Logging ─────────────────────────────────────────
function auditLog(entry) {
  try {
    ensureDir();
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${entry.type || 'INFO'} | ${entry.message}\n`;
    fs.appendFileSync(AUDIT_LOG_PATH, line);
  } catch {}
}

// ── Settings ──────────────────────────────────────────────
function getSettings() {
  return { ...DEFAULT_SETTINGS, ...readJSON(SETTINGS_PATH, {}) };
}

function saveSettings(newSettings) {
  const current = getSettings();
  const merged = { ...current, ...newSettings };
  writeJSON(SETTINGS_PATH, merged);
  auditLog({ type: 'CONFIG', message: 'Settings updated' });
  return merged;
}

// ── Profiles (with encrypted passwords) ───────────────────
function getProfiles() {
  const raw = readJSON(PROFILES_PATH, []);
  return raw.map(p => ({
    ...p,
    password: decrypt(p.passwordEncrypted || ''),
    privateKey: decrypt(p.privateKeyEncrypted || ''),
  }));
}

// Return profiles WITHOUT passwords/keys for API responses
function getProfilesSafe() {
  const raw = readJSON(PROFILES_PATH, []);
  return raw.map(p => {
    const { passwordEncrypted, privateKeyEncrypted, ...safe } = p;
    return { ...safe, hasPassword: !!passwordEncrypted, hasPrivateKey: !!privateKeyEncrypted };
  });
}

function saveProfile(profile) {
  const profiles = readJSON(PROFILES_PATH, []);
  const profileData = { ...profile };

  // Encrypt password before storage
  if (profileData.password) {
    profileData.passwordEncrypted = encrypt(profileData.password);
  }
  delete profileData.password;

  // Encrypt private key before storage
  if (profileData.privateKey) {
    profileData.privateKeyEncrypted = encrypt(profileData.privateKey);
  }
  delete profileData.privateKey;

  const idx = profiles.findIndex(p => p.id === profileData.id);
  if (idx >= 0) {
    // Merge with existing, preserving encrypted values if not changed
    if (!profileData.passwordEncrypted && profiles[idx].passwordEncrypted) {
      profileData.passwordEncrypted = profiles[idx].passwordEncrypted;
    }
    if (!profileData.privateKeyEncrypted && profiles[idx].privateKeyEncrypted) {
      profileData.privateKeyEncrypted = profiles[idx].privateKeyEncrypted;
    }
    profiles[idx] = { ...profiles[idx], ...profileData, updatedAt: new Date().toISOString() };
  } else {
    profileData.id = `prf_${Date.now()}`;
    profileData.createdAt = new Date().toISOString();
    profileData.updatedAt = profileData.createdAt;
    profiles.push(profileData);
  }

  writeJSON(PROFILES_PATH, profiles);
  auditLog({ type: 'PROFILE', message: `Profile saved: ${profileData.label || profileData.host || profileData.id}` });

  // Return profile with decrypted password and key
  return {
    ...profileData,
    password: decrypt(profileData.passwordEncrypted || ''),
    privateKey: decrypt(profileData.privateKeyEncrypted || ''),
  };
}

function deleteProfile(id) {
  let profiles = readJSON(PROFILES_PATH, []);
  const profile = profiles.find(p => p.id === id);
  profiles = profiles.filter(p => p.id !== id);
  writeJSON(PROFILES_PATH, profiles);
  if (profile) {
    auditLog({ type: 'PROFILE', message: `Profile deleted: ${profile.label || profile.host || id}` });
  }
  return { success: true };
}

// ── Re-encrypt all profiles with new key (for master password switch) ──
function reencryptProfiles() {
  const raw = readJSON(PROFILES_PATH, []);
  // Re-save each profile — saveProfile will encrypt with the current key
  for (const profile of raw) {
    const full = { ...profile, password: decrypt(profile.passwordEncrypted || ''), privateKey: decrypt(profile.privateKeyEncrypted || '') };
    // Force re-encryption with the current key
    if (full.password) profile.passwordEncrypted = encrypt(full.password);
    if (full.privateKey) profile.privateKeyEncrypted = encrypt(full.privateKey);
    delete full.password;
    delete full.privateKey;
    Object.assign(profile, full);
  }
  writeJSON(PROFILES_PATH, raw);
}

module.exports = {
  getSettings, saveSettings,
  getProfiles, getProfilesSafe, saveProfile, deleteProfile,
  auditLog, reencryptProfiles, CONFIG_DIR,
};
