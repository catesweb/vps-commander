const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const ssh = require('./ssh-handler');
const settings = require('./settings');
const cryptoUtil = require('./crypto-util');
const appLogger = require('./app-logger');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.VPS_COMMANDER_PORT || 3141;

// ── Input Sanitization ───────────────────────────────────
const SAFE_LOG_PATH = /^\/var\/log\/[a-zA-Z0-9_\/.\-]+$/;
const SAFE_SERVICE_NAME = /^[a-zA-Z0-9_@.\-]+$/;

// ── Rate Limiting ────────────────────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 15000; // 15 seconds
const RATE_LIMIT_MAX = 10;       // max requests per window per endpoint

function rateLimit(req, res, next) {
  const key = `connect:${req.ip || 'local'}`;
  const now = Date.now();
  const entry = rateLimitMap.get(key) || { count: 0, reset: now + RATE_LIMIT_WINDOW };

  if (now > entry.reset) {
    entry.count = 1;
    entry.reset = now + RATE_LIMIT_WINDOW;
  } else {
    entry.count++;
  }

  rateLimitMap.set(key, entry);

  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests — rate limit exceeded' });
  }
  next();
}

// Clean rate limit map periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.reset) rateLimitMap.delete(key);
  }
}, 60000);

// ── Security Headers ─────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Session Timeout Tracking ─────────────────────────────
const sessionActivity = new Map(); // sessionId -> lastActivity timestamp
const SESSION_TIMEOUT = 3600000;   // 1 hour default

function touchSession(sessionId) {
  sessionActivity.set(sessionId, Date.now());
}

function isSessionTimedOut(sessionId) {
  const last = sessionActivity.get(sessionId);
  if (!last) return false;
  const timeout = settings.getSettings().sessionTimeout || SESSION_TIMEOUT;
  return Date.now() - last > timeout;
}

// Auto-cleanup timed out sessions
setInterval(() => {
  for (const [sessionId] of sessionActivity) {
    if (isSessionTimedOut(sessionId)) {
      ssh.disconnect(sessionId);
      sessionActivity.delete(sessionId);
      settings.auditLog({ type: 'SESSION', message: `Session timed out: ${sessionId}` });
    }
  }
}, 60000);

// ── REST API ──────────────────────────────────────────────

// Connect to VPS (rate limited)
app.post('/api/connect', rateLimit, async (req, res) => {
  try {
    const { host, port, username, password, privateKey } = req.body;
    const hasPassword = password && password.length > 0;
    const hasKey = privateKey && privateKey.length > 0;

    // Quick TCP reachability check before attempting SSH
    const net = require('net');
    const tcpOk = await new Promise(resolve => {
      const sock = new net.Socket();
      sock.setTimeout(5000);
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => resolve(false));
      sock.on('timeout', () => { sock.destroy(); resolve(false); });
      sock.connect(port || 22, host);
    });

    if (!tcpOk) {
      return res.status(500).json({
        error: `Cannot reach ${host}:${port || 22} — server is unreachable or port is closed.`,
      });
    }

    const sessionId = `sess_${Date.now()}`;
    const result = await ssh.connect(sessionId, req.body);
    touchSession(sessionId);
    settings.auditLog({
      type: 'CONNECT',
      message: `Connected to ${host || 'unknown'} as ${username || 'unknown'} [${sessionId}]`,
    });
    res.json({ ...result, sessionId });
  } catch (err) {
    settings.auditLog({
      type: 'CONNECT_FAIL',
      message: `Failed to connect to ${req.body.host || 'unknown'}: ${err.message}`,
    });
    const hasPassword = req.body.password && req.body.password.length > 0;
    const hasKey = req.body.privateKey && req.body.privateKey.length > 0;
    appLogger.log({ source: 'SSH', level: 'ERROR', message: `Connect failed to ${req.body.host || 'unknown'}`, extra: { error: err.message, username: req.body.username, hasPassword, hasKey } });

    // More helpful error message
    let hint = '';
    if (!hasPassword && !hasKey) {
      hint = ' No password or SSH key was provided.';
    } else if (err.message.includes('authentication methods failed')) {
      hint = ' Check that your username is correct (Linux is case-sensitive: "root" ≠ "Root"). Also verify the server accepts password authentication (PasswordAuthentication yes in /etc/ssh/sshd_config).';
    } else if (err.message.includes('timed out')) {
      hint = ' Server did not respond in time. Check that the host and port are correct.';
    }
    res.status(500).json({ error: err.message + hint });
  }
});

// Disconnect
app.post('/api/disconnect', (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  ssh.disconnect(sessionId);
  sessionActivity.delete(sessionId);
  settings.auditLog({ type: 'DISCONNECT', message: `Disconnected: ${sessionId}` });
  res.json({ success: true });
});

// List active sessions
app.get('/api/sessions', (req, res) => {
  res.json({ sessions: ssh.listSessions() });
});

// Server stats
app.get('/api/stats', async (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  if (isSessionTimedOut(sessionId)) {
    ssh.disconnect(sessionId);
    sessionActivity.delete(sessionId);
    return res.status(401).json({ error: 'Session timed out' });
  }
  touchSession(sessionId);
  try {
    const stats = await ssh.getStats(sessionId);
    res.json(stats);
  } catch (err) {
    appLogger.log({ source: 'SSH', level: 'ERROR', message: 'Stats fetch failed: ' + err.message, extra: { sessionId: sessionId } });
    res.status(500).json({ error: err.message });
  }
});

// Logs
app.get('/api/logs', async (req, res) => {
  const { sessionId, file = '/var/log/syslog', lines = 100 } = req.query;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  if (isSessionTimedOut(sessionId)) {
    ssh.disconnect(sessionId);
    sessionActivity.delete(sessionId);
    return res.status(401).json({ error: 'Session timed out' });
  }
  touchSession(sessionId);
  if (!SAFE_LOG_PATH.test(file)) {
    return res.status(400).json({ error: 'Invalid log path' });
  }
  try {
    const logs = await ssh.getLogs(sessionId, file, parseInt(lines));
    res.json({ logs });
  } catch (err) {
    appLogger.log({ source: 'SSH', level: 'ERROR', message: 'Logs fetch failed: ' + err.message, extra: { sessionId: sessionId } });
    res.status(500).json({ error: err.message });
  }
});

// Services list
app.get('/api/services', async (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  touchSession(sessionId);
  try {
    const services = await ssh.getServices(sessionId);
    res.json({ services });
  } catch (err) {
    appLogger.log({ source: 'SSH', level: 'ERROR', message: 'Services list failed: ' + err.message, extra: { sessionId: sessionId } });
    res.status(500).json({ error: err.message });
  }
});

// Service control
app.post('/api/services/:name/:action', async (req, res) => {
  const { name, action } = req.params;
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  touchSession(sessionId);
  if (!['start', 'stop', 'restart', 'status'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }
  if (!SAFE_SERVICE_NAME.test(name)) {
    return res.status(400).json({ error: 'Invalid service name' });
  }
  try {
    const result = await ssh.controlService(sessionId, name, action);
    settings.auditLog({ type: 'SERVICE', message: `Service ${action}: ${name} [${sessionId}]` });
    res.json(result);
  } catch (err) {
    appLogger.log({ source: 'SSH', level: 'ERROR', message: 'Service control failed: ' + err.message, extra: { sessionId: sessionId } });
    res.status(500).json({ error: err.message });
  }
});

// ── Process Manager ───────────────────────────────────────
const SAFE_PID = /^\d+$/;
const SAFE_NICE = /^-?\d{1,2}$/;

app.get('/api/processes', async (req, res) => {
  const { sessionId, sort = 'cpu' } = req.query;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  touchSession(sessionId);
  try {
    const processes = await ssh.getProcesses(sessionId, sort);
    res.json({ processes });
  } catch (err) {
    appLogger.log({ source: 'SSH', level: 'ERROR', message: 'Process list failed: ' + err.message, extra: { sessionId: sessionId } });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/processes/:pid/kill', async (req, res) => {
  const { pid } = req.params;
  const { sessionId, signal = 'TERM' } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  if (!SAFE_PID.test(pid)) return res.status(400).json({ error: 'Invalid PID' });
  if (!['TERM', 'KILL', 'HUP'].includes(signal)) return res.status(400).json({ error: 'Invalid signal' });
  touchSession(sessionId);
  try {
    const result = await ssh.killProcess(sessionId, parseInt(pid), signal);
    settings.auditLog({ type: 'PROCESS', message: `Kill ${signal} PID ${pid} [${sessionId}]` });
    res.json(result);
  } catch (err) {
    appLogger.log({ source: 'SSH', level: 'ERROR', message: 'Process kill failed: ' + err.message, extra: { sessionId: sessionId } });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/processes/:pid/renice', async (req, res) => {
  const { pid } = req.params;
  const { sessionId, nice = 0 } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  if (!SAFE_PID.test(pid)) return res.status(400).json({ error: 'Invalid PID' });
  if (!SAFE_NICE.test(String(nice))) return res.status(400).json({ error: 'Invalid nice value' });
  if (parseInt(nice) < -20 || parseInt(nice) > 19) return res.status(400).json({ error: 'Nice value must be -20 to 19' });
  touchSession(sessionId);
  try {
    const result = await ssh.reniceProcess(sessionId, parseInt(pid), parseInt(nice));
    settings.auditLog({ type: 'PROCESS', message: `Renice PID ${pid} to ${nice} [${sessionId}]` });
    res.json(result);
  } catch (err) {
    appLogger.log({ source: 'SSH', level: 'ERROR', message: 'Process renice failed: ' + err.message, extra: { sessionId: sessionId } });
    res.status(500).json({ error: err.message });
  }
});

// ── SFTP File Browser ─────────────────────────────────────
const UPLOAD_LIMIT = 10 * 1024 * 1024; // 10MB
const DOWNLOAD_LIMIT = 50 * 1024 * 1024; // 50MB

function sanitizePath(p) {
  const raw = (p || '/').replace(/\0/g, '');
  if (raw.includes('..')) throw new Error('Path traversal blocked');
  const normalized = path.posix.normalize(raw);
  if (!normalized.startsWith('/')) throw new Error('Invalid path');
  return normalized || '/';
}

function validateMode(mode) {
  const m = parseInt(mode, 8);
  if (isNaN(m) || m < 0 || m > 0o7777) throw new Error('Invalid mode');
  return m;
}

app.get('/api/sftp/list', async (req, res) => {
  const { sessionId, path: dirPath = '/' } = req.query;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  touchSession(sessionId);
  try {
    const safePath = sanitizePath(dirPath);
    const files = await ssh.listFiles(sessionId, safePath);
    res.json({ path: safePath, files });
  } catch (err) {
    appLogger.log({ source: 'SSH', level: 'ERROR', message: 'SFTP list failed: ' + err.message, extra: { sessionId: sessionId } });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sftp/stat', async (req, res) => {
  const { sessionId, path: filePath } = req.query;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  touchSession(sessionId);
  try {
    const safePath = sanitizePath(filePath);
    const stat = await ssh.statFile(sessionId, safePath);
    res.json(stat);
  } catch (err) {
    appLogger.log({ source: 'SSH', level: 'ERROR', message: 'SFTP stat failed: ' + err.message, extra: { sessionId: sessionId } });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sftp/delete', async (req, res) => {
  const { sessionId, path: filePath, isDirectory } = req.body;
  if (!sessionId || !filePath) return res.status(400).json({ error: 'sessionId and path required' });
  touchSession(sessionId);
  try {
    const safePath = sanitizePath(filePath);
    const result = isDirectory ? await ssh.deleteDir(sessionId, safePath) : await ssh.deleteFile(sessionId, safePath);
    settings.auditLog({ type: 'FILE', message: `Deleted ${isDirectory ? 'dir' : 'file'}: ${safePath} [${sessionId}]` });
    res.json(result);
  } catch (err) {
    appLogger.log({ source: 'SSH', level: 'ERROR', message: 'SFTP delete failed: ' + err.message, extra: { sessionId: sessionId } });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sftp/rename', async (req, res) => {
  const { sessionId, oldPath, newPath } = req.body;
  if (!sessionId || !oldPath || !newPath) return res.status(400).json({ error: 'sessionId, oldPath, and newPath required' });
  touchSession(sessionId);
  try {
    const safeOld = sanitizePath(oldPath);
    const safeNew = sanitizePath(newPath);
    const result = await ssh.renameFile(sessionId, safeOld, safeNew);
    settings.auditLog({ type: 'FILE', message: `Renamed ${safeOld} → ${safeNew} [${sessionId}]` });
    res.json(result);
  } catch (err) {
    appLogger.log({ source: 'SSH', level: 'ERROR', message: 'SFTP rename failed: ' + err.message, extra: { sessionId: sessionId } });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sftp/chmod', async (req, res) => {
  const { sessionId, path: filePath, mode } = req.body;
  if (!sessionId || !filePath || !mode) return res.status(400).json({ error: 'sessionId, path, and mode required' });
  touchSession(sessionId);
  try {
    const safePath = sanitizePath(filePath);
    const safeMode = validateMode(mode);
    const result = await ssh.chmodFile(sessionId, safePath, safeMode);
    settings.auditLog({ type: 'FILE', message: `Chmod ${mode} on ${safePath} [${sessionId}]` });
    res.json(result);
  } catch (err) {
    appLogger.log({ source: 'SSH', level: 'ERROR', message: 'SFTP chmod failed: ' + err.message, extra: { sessionId: sessionId } });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sftp/mkdir', async (req, res) => {
  const { sessionId, path: dirPath } = req.body;
  if (!sessionId || !dirPath) return res.status(400).json({ error: 'sessionId and path required' });
  touchSession(sessionId);
  try {
    const safePath = sanitizePath(dirPath);
    const result = await ssh.mkdir(sessionId, safePath);
    settings.auditLog({ type: 'FILE', message: `Created dir: ${safePath} [${sessionId}]` });
    res.json(result);
  } catch (err) {
    appLogger.log({ source: 'SSH', level: 'ERROR', message: 'SFTP mkdir failed: ' + err.message, extra: { sessionId: sessionId } });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sftp/download', async (req, res) => {
  const { sessionId, path: filePath } = req.query;
  if (!sessionId || !filePath) return res.status(400).json({ error: 'sessionId and path required' });
  touchSession(sessionId);
  try {
    const safePath = sanitizePath(filePath);
    // Check file size before downloading
    try {
      const stat = await ssh.statFile(sessionId, safePath);
      if (stat.size > DOWNLOAD_LIMIT) return res.status(413).json({ error: `File too large (max ${Math.round(DOWNLOAD_LIMIT/1024/1024)}MB)` });
    } catch { /* stat can fail on some systems */ }
    const data = await ssh.readFile(sessionId, safePath);
    const name = path.posix.basename(safePath);
    res.json({ name, data });
  } catch (err) {
    appLogger.log({ source: 'SSH', level: 'ERROR', message: 'SFTP download failed: ' + err.message, extra: { sessionId: sessionId } });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sftp/upload', async (req, res) => {
  const { sessionId, path: dirPath, name, data } = req.body;
  if (!sessionId || !name || !data) return res.status(400).json({ error: 'sessionId, name, and data required' });
  if (data.length > UPLOAD_LIMIT * 1.4) return res.status(413).json({ error: 'File too large (max 10MB)' });
  touchSession(sessionId);
  try {
    const safeDir = sanitizePath(dirPath || '/');
    const safeName = path.posix.basename(name);
    const fullPath = path.posix.join(safeDir, safeName);
    const result = await ssh.writeFile(sessionId, fullPath, data);
    settings.auditLog({ type: 'FILE', message: `Uploaded: ${fullPath} (${result.size} bytes) [${sessionId}]` });
    res.json(result);
  } catch (err) {
    appLogger.log({ source: 'SSH', level: 'ERROR', message: 'SFTP upload failed: ' + err.message, extra: { sessionId: sessionId } });
    res.status(500).json({ error: err.message });
  }
});

// Save (in-place write) — for text editor
app.post('/api/sftp/save', async (req, res) => {
  const { sessionId, path: filePath, data } = req.body;
  if (!sessionId || !filePath || data === undefined) return res.status(400).json({ error: 'sessionId, path, and data required' });
  if (data.length > UPLOAD_LIMIT * 1.4) return res.status(413).json({ error: 'File too large (max 10MB)' });
  touchSession(sessionId);
  try {
    const safePath = sanitizePath(filePath);
    const result = await ssh.writeFile(sessionId, safePath, data);
    settings.auditLog({ type: 'FILE', message: `Saved: ${safePath} (${result.size} bytes) [${sessionId}]` });
    res.json(result);
  } catch (err) {
    appLogger.log({ source: 'SSH', level: 'ERROR', message: 'SFTP save failed: ' + err.message, extra: { sessionId: sessionId } });
    res.status(500).json({ error: err.message });
  }
});

// ── UFW Firewall ─────────────────────────────────────────
app.get('/api/ufw/status', async (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  touchSession(sessionId);
  try {
    const status = await ssh.getUfwStatus(sessionId);
    res.json(status);
  } catch (err) {
    appLogger.log({ source: 'SSH', level: 'ERROR', message: 'UFW status failed: ' + err.message, extra: { sessionId: sessionId } });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ufw/enable', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  touchSession(sessionId);
  try {
    const result = await ssh.enableUfw(sessionId);
    settings.auditLog({ type: 'FIREWALL', message: `UFW enabled [${sessionId}]` });
    res.json(result);
  } catch (err) {
    appLogger.log({ source: 'SSH', level: 'ERROR', message: 'UFW enable failed: ' + err.message, extra: { sessionId: sessionId } });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ufw/disable', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  touchSession(sessionId);
  try {
    const result = await ssh.disableUfw(sessionId);
    settings.auditLog({ type: 'FIREWALL', message: `UFW disabled [${sessionId}]` });
    res.json(result);
  } catch (err) {
    appLogger.log({ source: 'SSH', level: 'ERROR', message: 'UFW disable failed: ' + err.message, extra: { sessionId: sessionId } });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ufw/rule', async (req, res) => {
  const { sessionId, rule, action = 'allow' } = req.body;
  if (!sessionId || !rule) return res.status(400).json({ error: 'sessionId and rule required' });
  if (!/^[a-zA-Z0-9\s.,/:\-]+$/.test(rule)) return res.status(400).json({ error: 'Invalid rule format' });
  if (!['allow', 'deny', 'reject', 'limit'].includes(action.toLowerCase())) return res.status(400).json({ error: 'Invalid action' });
  touchSession(sessionId);
  try {
    const result = await ssh.addUfwRule(sessionId, rule, action);
    settings.auditLog({ type: 'FIREWALL', message: `UFW rule added: ${action} ${rule} [${sessionId}]` });
    res.json(result);
  } catch (err) {
    appLogger.log({ source: 'SSH', level: 'ERROR', message: 'UFW rule add failed: ' + err.message, extra: { sessionId: sessionId } });
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/ufw/rule/:num', async (req, res) => {
  const { sessionId } = req.body;
  const ruleNum = parseInt(req.params.num);
  if (!sessionId || isNaN(ruleNum)) return res.status(400).json({ error: 'sessionId and valid rule number required' });
  touchSession(sessionId);
  try {
    const result = await ssh.deleteUfwRule(sessionId, ruleNum);
    settings.auditLog({ type: 'FIREWALL', message: `UFW rule ${ruleNum} deleted [${sessionId}]` });
    res.json(result);
  } catch (err) {
    appLogger.log({ source: 'SSH', level: 'ERROR', message: 'UFW rule delete failed: ' + err.message, extra: { sessionId: sessionId } });
    res.status(500).json({ error: err.message });
  }
});

// ── Docker Management ────────────────────────────────────
const SAFE_DOCKER_ID = /^[a-zA-Z0-9_\-.:]+$/;

app.get('/api/docker/containers', async (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  touchSession(sessionId);
  try {
    const containers = await ssh.getDockerContainers(sessionId);
    res.json({ containers });
  } catch (err) {
    appLogger.log({ source: 'SSH', level: 'ERROR', message: 'Docker list failed: ' + err.message, extra: { sessionId: sessionId } });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/docker/:containerId/:action', async (req, res) => {
  const { containerId, action } = req.params;
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  if (!SAFE_DOCKER_ID.test(containerId)) return res.status(400).json({ error: 'Invalid container ID' });
  if (!['start', 'stop', 'restart'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  touchSession(sessionId);
  try {
    const result = await ssh.dockerAction(sessionId, containerId, action);
    settings.auditLog({ type: 'DOCKER', message: `Container ${action}: ${containerId} [${sessionId}]` });
    res.json(result);
  } catch (err) {
    appLogger.log({ source: 'SSH', level: 'ERROR', message: 'Docker action failed: ' + err.message, extra: { sessionId: sessionId } });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/docker/:containerId/logs', async (req, res) => {
  const { sessionId, lines = 100 } = req.query;
  const { containerId } = req.params;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  if (!SAFE_DOCKER_ID.test(containerId)) return res.status(400).json({ error: 'Invalid container ID' });
  touchSession(sessionId);
  try {
    const logs = await ssh.getDockerLogs(sessionId, containerId, parseInt(lines));
    res.json({ logs });
  } catch (err) {
    appLogger.log({ source: 'SSH', level: 'ERROR', message: 'Docker logs failed: ' + err.message, extra: { sessionId: sessionId } });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/docker/:containerId/stats', async (req, res) => {
  const { sessionId } = req.query;
  const { containerId } = req.params;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  if (!SAFE_DOCKER_ID.test(containerId)) return res.status(400).json({ error: 'Invalid container ID' });
  touchSession(sessionId);
  try {
    const stats = await ssh.getDockerStats(sessionId, containerId);
    res.json(stats || {});
  } catch (err) {
    appLogger.log({ source: 'SSH', level: 'ERROR', message: 'Docker stats failed: ' + err.message, extra: { sessionId: sessionId } });
    res.status(500).json({ error: err.message });
  }
});

// ── Bulk Command Execution ───────────────────────────────
app.post('/api/bulk-exec', async (req, res) => {
  const { command, sessionIds } = req.body;
  if (!command || !command.trim()) return res.status(400).json({ error: 'Command required' });
  const allSessions = ssh.listSessions();
  const activeIds = sessionIds && sessionIds.length ? sessionIds : allSessions.map(s => s.id);
  if (!activeIds.length) return res.status(400).json({ error: 'No active sessions' });
  const results = {};
  for (const sid of activeIds) {
    const session = allSessions.find(s => s.id === sid);
    const label = session ? (session.host + '@' + session.username) : sid;
    try {
      const { stdout, stderr, code } = await ssh.exec(sid, command.trim());
      results[sid] = { id: sid, label, output: stdout || stderr || '(no output)', code, success: true };
    } catch (err) {
      results[sid] = { id: sid, label, output: err.message, code: -1, success: false };
    }
  }
  settings.auditLog({ type: 'BULK', message: `Bulk exec on ${activeIds.length} servers: ${command.substring(0, 60)}` });
  res.json({ results: Object.values(results) });
  // Note: per-server errors are logged individually above
});

// ── Auth / Vault API ─────────────────────────────────────

app.get('/api/auth/status', (req, res) => {
  res.json(cryptoUtil.getStatus());
});

app.post('/api/auth/unlock', (req, res) => {
  try {
    const result = cryptoUtil.unlock(req.body.password || '');
    settings.auditLog({ type: 'AUTH', message: 'Vault unlocked' });
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post('/api/auth/set-master', (req, res) => {
  try {
    const password = req.body.password || '';
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    cryptoUtil.setMasterPassword(password);
    settings.reencryptProfiles();
    settings.auditLog({ type: 'AUTH', message: 'Master password enabled' });
    res.json({ success: true, method: 'master' });
  } catch (err) {
    appLogger.log({ source: 'SSH', level: 'ERROR', message: 'Bulk exec per-server failed: ' + err.message, extra: { sessionId: sid } });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/remove-master', (req, res) => {
  try {
    // Verify password before removing
    cryptoUtil.unlock(req.body.password || '');
    cryptoUtil.removeMasterPassword();
    settings.reencryptProfiles();
    settings.auditLog({ type: 'AUTH', message: 'Master password removed — reverted to machine key' });
    res.json({ success: true, method: 'machine' });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post('/api/auth/lock', (req, res) => {
  cryptoUtil.lock();
  res.json({ success: true });
});

// ── Vault Lock Middleware ─────────────────────────────────
function requireUnlocked(req, res, next) {
  if (cryptoUtil.isLocked()) {
    return res.status(423).json({ error: 'VAULT_LOCKED', message: 'Profiles vault is locked. Enter your master password to unlock.' });
  }
  next();
}

// ── Settings API ──────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  res.json(settings.getSettings());
});

app.post('/api/settings', (req, res) => {
  const updated = settings.saveSettings(req.body);
  res.json(updated);
});

// ── Audit Log ────────────────────────────────────────────
app.get('/api/audit-log', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const logPath = path.join(os.homedir(), '.vps-commander', 'audit.log');
  try {
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, 'utf8');
      const lines = content.trim().split('\n').slice(-200);
      res.json({ entries: lines });
    } else {
      res.json({ entries: [] });
    }
  } catch {
    res.json({ entries: [] });
  }
});

// Clear audit log
app.post('/api/audit-log/clear', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const dir = path.join(os.homedir(), '.vps-commander');
  const logPath = path.join(dir, 'audit.log');
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(logPath, '', 'utf8');
    settings.auditLog({ type: 'CONFIG', message: 'Audit log cleared' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Client-side audit log entry (for alerts, etc.)
app.post('/api/audit-log', (req, res) => {
  const { type, message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  settings.auditLog({ type: type || 'ALERT', message });
  res.json({ success: true });
});

// ── Profiles API (passwords encrypted) ────────────────────
app.get('/api/profiles', requireUnlocked, (req, res) => {
  res.json({ profiles: settings.getProfilesSafe() });
});

// Get full profile with decrypted password (for loading into connection form)
app.get('/api/profiles/:id/auth', (req, res) => {
  const profiles = settings.getProfiles();
  const profile = profiles.find(p => p.id === req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  res.json({
    password: profile.password || '',
    privateKey: profile.privateKey || '',
  });
});

app.post('/api/profiles', requireUnlocked, (req, res) => {
  const profile = settings.saveProfile(req.body);
  // Strip password from response — never echo credentials back
  const { password, passwordEncrypted, ...safe } = profile;
  res.json({ ...safe, hasPassword: !!passwordEncrypted });
});

app.delete('/api/profiles/:id', requireUnlocked, (req, res) => {
  const result = settings.deleteProfile(req.params.id);
  res.json(result);
});

// ── Sound API ────────────────────────────────────────────
app.get('/api/sound', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  // Only allow audio files from common paths
  if (!/\.(wav|mp3|ogg|m4a|aac|flac|weba)$/i.test(filePath)) {
    return res.status(400).json({ error: 'Invalid audio file type' });
  }
  if (filePath.includes('..')) return res.status(400).json({ error: 'Path traversal blocked' });
  try {
    const fs = require('fs');
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    const ext = filePath.split('.').pop().toLowerCase();
    const mimeMap = { wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', weba: 'audio/webm' };
    const contentType = mimeMap[ext] || 'audio/mpeg';
    const data = fs.readFileSync(filePath);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', data.length);
    res.send(data);
  } catch {
    res.status(500).json({ error: 'Failed to read audio file' });
  }
});

// ── Error Log API ────────────────────────────────────────
app.get('/api/error-log', (req, res) => {
  const lines = parseInt(req.query.lines) || 200;
  res.json({ log: appLogger.readLog(lines), path: appLogger.getPath() });
});

app.post('/api/error-log', (req, res) => {
  const { message, stack, source } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  appLogger.log({ source: source || 'FRONTEND', level: 'ERROR', message, stack, extra: req.body.extra });
  res.json({ success: true });
});

app.delete('/api/error-log', (req, res) => {
  const ok = appLogger.clear();
  res.json({ success: ok });
});

// ── Global Error Handler ──────────────────────────────────
app.use((err, req, res, next) => {
  appLogger.log({ source: 'EXPRESS', level: 'FATAL', message: err.message, stack: err.stack, extra: { url: req.url, method: req.method } });
  res.status(500).json({ error: 'Internal server error' });
});

// Intentionally not calling process.exit() here — this is a desktop app
// and the user would rather see a degraded-but-running app than a hard crash.
process.on('uncaughtException', (err) => {
  appLogger.log({ source: 'PROCESS', level: 'FATAL', message: err.message, stack: err.stack });
  console.error('[FATAL] Uncaught exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  appLogger.log({ source: 'PROCESS', level: 'FATAL', message: reason?.message || String(reason), stack: reason?.stack });
  console.error('[FATAL] Unhandled rejection:', reason?.message || reason);
});

// ── WebSocket (Terminal per session) ──────────────────────
wss.on('connection', (ws) => {
  let shellStream = null;

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.type === 'terminal:init') {
        const sid = data.sessionId;
        if (!sid) { ws.send(JSON.stringify({ type: 'error', data: 'No sessionId' })); return; }
        touchSession(sid);
        try {
          shellStream = await ssh.shell(sid);
          shellStream.on('data', (chunk) => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'terminal:data', data: chunk.toString() }));
          });
          shellStream.on('close', () => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'terminal:closed' }));
          });
          shellStream.stderr.on('data', (chunk) => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'terminal:data', data: chunk.toString() }));
          });
        } catch (err) {
          appLogger.log({ source: 'SSH', level: 'ERROR', message: 'Terminal shell init failed: ' + err.message, extra: { sessionId: sid } });
          ws.send(JSON.stringify({ type: 'error', data: err.message }));
        }
      }

      if (data.type === 'terminal:input' && shellStream) {
        touchSession(sid);
        shellStream.write(data.data);
      }

      if (data.type === 'terminal:resize' && shellStream) {
        touchSession(sid);
        shellStream.setWindow(data.rows, data.cols, 0, 0);
      }
    } catch {
      // skip malformed messages
    }
  });

  ws.on('close', () => {
    if (shellStream) {
      try { shellStream.close(); } catch { /* already closed */ }
    }
  });
});

// ── Start ─────────────────────────────────────────────────
server.listen(PORT, () => {
  appLogger.log({ source: 'SERVER', level: 'INFO', message: `Server started on port ${PORT}` });
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║   VPS COMMANDER // SECURE MODE     ║`);
  console.log(`  ║   PORT: ${PORT}                       ║`);
  console.log(`  ║   http://localhost:${PORT}              ║`);
  console.log(`  ║   ERROR LOG: ${appLogger.getPath()}    ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  appLogger.log({ source: 'SERVER', level: 'INFO', message: 'Server shutting down (SIGINT)' });
  ssh.disconnectAll();
  server.close();
  process.exit();
});
