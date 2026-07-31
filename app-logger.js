const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_DIR = path.join(os.homedir(), '.vps-commander');
const LOG_FILE = path.join(LOG_DIR, 'app-error.log');
const MAX_SIZE = 5 * 1024 * 1024;        // 5MB max log size
const MAX_MSG_LEN = 5000;                 // Truncate long messages
const MAX_STACK_LEN = 10000;              // Truncate long stacks

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function ensureFile() {
  ensureDir();
  if (fs.existsSync(LOG_FILE)) {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_SIZE) {
      const backup = LOG_FILE + '.' + Date.now();
      fs.renameSync(LOG_FILE, backup);
    }
  }
}

function log(entry) {
  try {
    ensureFile();
    const timestamp = new Date().toISOString();
    const source = entry.source || 'SERVER';
    const level = entry.level || 'ERROR';
    const message = (entry.message || '').substring(0, MAX_MSG_LEN);
    const stack = (entry.stack || '').substring(0, MAX_STACK_LEN);
    const extra = entry.extra ? ' | ' + JSON.stringify(entry.extra) : '';

    const line = `[${timestamp}] ${level} [${source}] ${message}${extra}\n`;
    fs.appendFileSync(LOG_FILE, line, 'utf8');

    if (stack) {
      const stackLine = `  STACK: ${stack.replace(/\n/g, '\n  ')}\n`;
      fs.appendFileSync(LOG_FILE, stackLine, 'utf8');
    }
  } catch {
    // If logging itself fails, write to stderr as last resort
    console.error('[app-logger] Failed to write to log file:', entry.message);
  }
}

function readLog(lines = 200) {
  try {
    if (!fs.existsSync(LOG_FILE)) return '(no errors logged)';
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const allLines = content.trim().split('\n');
    const tail = allLines.slice(-lines);
    return tail.join('\n') || '(empty log)';
  } catch {
    return '(error reading log)';
  }
}

function clear() {
  try {
    if (fs.existsSync(LOG_FILE)) fs.unlinkSync(LOG_FILE);
    return true;
  } catch {
    return false;
  }
}

function getPath() {
  return LOG_FILE;
}

module.exports = { log, readLog, clear, getPath };
