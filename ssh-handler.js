const { Client } = require('ssh2');

class SSHHandler {
  constructor() {
    this.connections = new Map(); // id -> { client, meta }
  }

  connect(id, config) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      const timeout = setTimeout(() => {
        conn.end();
        reject(new Error('SSH connection timed out'));
      }, 15000);

      conn.on('ready', () => {
        clearTimeout(timeout);
        this.connections.set(id, { client: conn, meta: { host: config.host, username: config.username } });
        resolve({ success: true, id });
      });

      conn.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      conn.on('close', () => {
        this.connections.delete(id);
      });

      conn.connect({
        host: config.host,
        port: config.port || 22,
        username: config.username,
        password: config.password,
        privateKey: config.privateKey,
        readyTimeout: 10000,
        keepaliveInterval: 30000,
      });
    });
  }

  disconnect(id) {
    const entry = this.connections.get(id);
    if (entry) {
      entry.client.end();
      this.connections.delete(id);
      return true;
    }
    return false;
  }

  isConnected(id) {
    return this.connections.has(id);
  }

  listSessions() {
    const sessions = [];
    for (const [id, entry] of this.connections) {
      sessions.push({
        id,
        host: entry.meta?.host || 'unknown',
        username: entry.meta?.username || 'unknown',
        connected: true,
      });
    }
    return sessions;
  }

  exec(id, command) {
    return new Promise((resolve, reject) => {
      const entry = this.connections.get(id);
      if (!entry) return reject(new Error('Not connected'));

      entry.client.exec(command, (err, stream) => {
        if (err) return reject(err);

        let stdout = '';
        let stderr = '';

        stream.on('data', (data) => { stdout += data.toString(); });
        stream.stderr.on('data', (data) => { stderr += data.toString(); });
        stream.on('close', (code) => {
          resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
        });
      });
    });
  }

  shell(id) {
    return new Promise((resolve, reject) => {
      const entry = this.connections.get(id);
      if (!entry) return reject(new Error('Not connected'));

      entry.client.shell({ term: 'xterm-256color', cols: 120, rows: 40 }, (err, stream) => {
        if (err) return reject(err);
        resolve(stream);
      });
    });
  }

  async getStats(id) {
    const cmds = {
      cpu: "top -bn1 | grep 'Cpu(s)' | awk '{print $2 + $4}'",
      memory: "free -m | awk 'NR==2{printf \"%.1f|%.1f|%.1f\", $3, $2, $3*100/$2}'",
      disk: "df -h / | awk 'NR==2{printf \"%s|%s|%s\", $3, $2, $5}'",
      uptime: "uptime -p | sed 's/up //'",
      load: "cat /proc/loadavg | awk '{print $1, $2, $3}'",
      hostname: "hostname",
      os: "cat /etc/os-release | grep PRETTY_NAME | cut -d'\"' -f2",
      kernel: "uname -r",
      processes: "ps aux --no-headers | wc -l",
      network: "cat /proc/net/dev | grep -E 'eth0|ens|enp' | awk '{printf \"%s|%.0f|%.0f\", $1, $2, $10}' | head -1",
    };

    const results = {};
    for (const [key, cmd] of Object.entries(cmds)) {
      try {
        const { stdout } = await this.exec(id, cmd);
        results[key] = stdout;
      } catch {
        results[key] = 'N/A';
      }
    }
    return results;
  }

  async getLogs(id, logFile = '/var/log/syslog', lines = 100) {
    try {
      const { stdout } = await this.exec(id, `tail -n ${lines} ${logFile} 2>/dev/null || echo "LOG_NOT_FOUND"`);
      return stdout;
    } catch {
      return 'ERROR_READING_LOG';
    }
  }

  async getServices(id) {
    const cmd = "systemctl list-units --type=service --all --no-legend --no-pager 2>/dev/null | head -50 | awk '{print $1, $3, $4}'";
    try {
      const { stdout } = await this.exec(id, cmd);
      return stdout;
    } catch {
      return '';
    }
  }

  async controlService(id, serviceName, action) {
    try {
      const { stdout, stderr } = await this.exec(id, `sudo systemctl ${action} ${serviceName} 2>&1`);
      return { success: true, output: stdout || stderr };
    } catch (err) {
      return { success: false, output: err.message };
    }
  }

  async getProcesses(id, sortBy = 'cpu', order = 'desc') {
    const sortFlags = sortBy === 'cpu' ? '-nrk 3' : sortBy === 'mem' ? '-nrk 4' : sortBy === 'pid' ? '-nk 2' : '-nrk 3';
    const cmd = `ps aux --no-headers | sort ${sortFlags} | head -200`;
    try {
      const { stdout } = await this.exec(id, cmd);
      const lines = stdout.split('\n').filter(Boolean);
      return lines.map(line => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 11) return null;
        return {
          user: parts[0],
          pid: parseInt(parts[1]),
          cpu: parseFloat(parts[2]),
          mem: parseFloat(parts[3]),
          vsz: parts[4],
          rss: parts[5],
          stat: parts[7],
          start: parts[8],
          time: parts[9],
          command: parts.slice(10).join(' '),
        };
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  async killProcess(id, pid, signal = 'TERM') {
    const sig = signal === 'KILL' ? '-9' : '';
    try {
      const { stdout, stderr } = await this.exec(id, `kill ${sig} ${pid} 2>&1`);
      return { success: true, output: stdout || stderr || `Process ${pid} signaled with ${signal}` };
    } catch (err) {
      return { success: false, output: err.message };
    }
  }

  async reniceProcess(id, pid, nice) {
    try {
      const { stdout, stderr } = await this.exec(id, `renice ${nice} -p ${pid} 2>&1`);
      return { success: true, output: stdout || stderr || `Process ${pid} renice to ${nice}` };
    } catch (err) {
      return { success: false, output: err.message };
    }
  }

  // ── UFW Firewall ──────────────────────────────────────
  async getUfwStatus(id) {
    const { stdout } = await this.exec(id, 'ufw status verbose 2>&1');
    const status = {};
    const lines = stdout.split('\n');
    for (const line of lines) {
      if (line.startsWith('Status:')) status.active = line.includes('active');
      if (line.startsWith('Default:')) status.defaultPolicy = line.replace('Default:', '').trim();
      if (line.startsWith('Logging:')) status.logging = line.replace('Logging:', '').trim();
    }
    // Parse rules
    status.rules = [];
    const { stdout: numberedOut } = await this.exec(id, 'ufw status numbered 2>&1');
    const numLines = numberedOut.split('\n');
    for (const line of numLines) {
      if (line.startsWith('[') && line.includes(']')) {
        inRules = true;
        const match = line.match(/^\[(\d+)\]\s+(.+?)\s+(ALLOW|DENY|LIMIT|REJECT)\s+(.+)$/);
        if (match) {
          status.rules.push({ number: parseInt(match[1]), rule: match[2].trim(), action: match[3], from: match[4].trim() });
        }
      }
    }
    return status;
  }

  async enableUfw(id) {
    const { stdout } = await this.exec(id, 'echo y | ufw enable 2>&1');
    return { success: true, output: stdout };
  }

  async disableUfw(id) {
    const { stdout } = await this.exec(id, 'echo y | ufw disable 2>&1');
    return { success: true, output: stdout };
  }

  async addUfwRule(id, rule, action) {
    const cmd = `ufw ${action.toLowerCase()} ${rule} 2>&1`;
    const { stdout, stderr } = await this.exec(id, cmd);
    return { success: true, output: stdout || stderr };
  }

  async deleteUfwRule(id, ruleNum) {
    const { stdout, stderr } = await this.exec(id, `ufw --force delete ${ruleNum} 2>&1`);
    return { success: true, output: stdout || stderr };
  }

  // ── Docker Management ─────────────────────────────────
  async getDockerContainers(id) {
    const { stdout } = await this.exec(id, "docker ps -a --no-trunc --format '{{json .}}' 2>&1");
    const lines = stdout.split('\n').filter(Boolean);
    return lines.map(line => {
      try {
        const c = JSON.parse(line);
        return {
          id: c.ID ? c.ID.substring(0, 12) : '',
          name: c.Names || '',
          image: c.Image || '',
          status: c.Status || '',
          state: c.State || '',
          ports: c.Ports || '',
          created: c.CreatedAt || '',
        };
      } catch { return null; }
    }).filter(Boolean);
  }

  async dockerAction(id, containerId, action) {
    const cmd = `docker ${action} ${containerId} 2>&1`;
    const { stdout, stderr } = await this.exec(id, cmd);
    return { success: true, output: stdout || stderr };
  }

  async getDockerLogs(id, containerId, lines = 100) {
    const { stdout } = await this.exec(id, `docker logs --tail ${lines} ${containerId} 2>&1`);
    return stdout;
  }

  async getDockerStats(id, containerId) {
    const { stdout } = await this.exec(id, `docker stats --no-stream --format '{{json .}}' ${containerId} 2>&1`);
    try { return JSON.parse(stdout.trim()); } catch { return null; }
  }

  // ── SFTP Methods ──────────────────────────────────────
  sftp(id) {
    return new Promise((resolve, reject) => {
      const entry = this.connections.get(id);
      if (!entry) return reject(new Error('Not connected'));
      entry.client.sftp((err, sftp) => {
        if (err) return reject(err);
        resolve(sftp);
      });
    });
  }

  async listFiles(id, dirPath = '/') {
    const sftp = await this.sftp(id);
    try {
      return await new Promise((resolve, reject) => {
        sftp.readdir(dirPath, (err, list) => {
          if (err) return reject(err);
          const items = list.map(item => ({
            name: item.filename,
            longname: item.longname,
            isDirectory: item.attrs.isDirectory(),
            isFile: item.attrs.isFile(),
            isSymlink: item.attrs.isSymbolicLink(),
            size: item.attrs.size,
            mode: item.attrs.mode,
            uid: item.attrs.uid,
            gid: item.attrs.gid,
            mtime: item.attrs.mtime * 1000,
            atime: item.attrs.atime * 1000,
            permissions: modeToPermissions(item.attrs.mode, item.attrs.isDirectory()),
          }));
          items.sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          resolve(items);
        });
      });
    } finally {
      try { sftp.end(); } catch {}
    }
  }

  async statFile(id, filePath) {
    const sftp = await this.sftp(id);
    try {
      return await new Promise((resolve, reject) => {
        sftp.stat(filePath, (err, attrs) => {
          if (err) return reject(err);
          resolve({
            size: attrs.size, mode: attrs.mode, uid: attrs.uid, gid: attrs.gid,
            mtime: attrs.mtime * 1000, isDirectory: attrs.isDirectory(), isFile: attrs.isFile(),
            permissions: modeToPermissions(attrs.mode, attrs.isDirectory()),
          });
        });
      });
    } finally {
      try { sftp.end(); } catch {}
    }
  }

  async deleteFile(id, filePath) {
    const sftp = await this.sftp(id);
    try {
      return await new Promise((resolve, reject) => {
        sftp.unlink(filePath, (err) => { if (err) return reject(err); resolve({ success: true }); });
      });
    } finally {
      try { sftp.end(); } catch {}
    }
  }

  async deleteDir(id, dirPath) {
    const sftp = await this.sftp(id);
    try {
      return await new Promise((resolve, reject) => {
        sftp.rmdir(dirPath, (err) => { if (err) return reject(err); resolve({ success: true }); });
      });
    } finally {
      try { sftp.end(); } catch {}
    }
  }

  async renameFile(id, oldPath, newPath) {
    const sftp = await this.sftp(id);
    try {
      return await new Promise((resolve, reject) => {
        sftp.rename(oldPath, newPath, (err) => { if (err) return reject(err); resolve({ success: true }); });
      });
    } finally {
      try { sftp.end(); } catch {}
    }
  }

  async chmodFile(id, filePath, mode) {
    const sftp = await this.sftp(id);
    try {
      return await new Promise((resolve, reject) => {
        sftp.chmod(filePath, mode, (err) => { if (err) return reject(err); resolve({ success: true }); });
      });
    } finally {
      try { sftp.end(); } catch {}
    }
  }

  async mkdir(id, dirPath) {
    const sftp = await this.sftp(id);
    try {
      return await new Promise((resolve, reject) => {
        sftp.mkdir(dirPath, (err) => { if (err) return reject(err); resolve({ success: true }); });
      });
    } finally {
      try { sftp.end(); } catch {}
    }
  }

  async readFile(id, filePath) {
    const sftp = await this.sftp(id);
    try {
      return await new Promise((resolve, reject) => {
        sftp.open(filePath, 'r', (err, handle) => {
          if (err) return reject(err);
          const chunks = [];
          const bufsize = 64 * 1024;
          let pos = 0;
          function readNext() {
            const buf = Buffer.alloc(bufsize);
            sftp.read(handle, buf, 0, bufsize, pos, (err, bytesRead) => {
              if (err) { try { sftp.close(handle, () => {}); } catch {}; return reject(err); }
              if (bytesRead === 0) {
                sftp.close(handle, () => {});
                return resolve(Buffer.concat(chunks).toString('base64'));
              }
              chunks.push(buf.slice(0, bytesRead));
              pos += bytesRead;
              readNext();
            });
          }
          readNext();
        });
      });
    } finally {
      try { sftp.end(); } catch {}
    }
  }

  async writeFile(id, filePath, base64Data) {
    const sftp = await this.sftp(id);
    const data = Buffer.from(base64Data, 'base64');
    try {
      return await new Promise((resolve, reject) => {
        sftp.open(filePath, 'w', (err, handle) => {
          if (err) return reject(err);
          sftp.write(handle, 0, data.length, data, (err) => {
            if (err) { try { sftp.close(handle, () => {}); } catch {}; return reject(err); }
            sftp.close(handle, () => {});
            resolve({ success: true, size: data.length });
          });
        });
      });
    } finally {
      try { sftp.end(); } catch {}
    }
  }

  disconnectAll() {
    for (const [id, entry] of this.connections) {
      try { entry.client.end(); } catch { /* ignore */ }
    }
    this.connections.clear();
  }
}

module.exports = new SSHHandler();

// ── Helpers ───────────────────────────────────────────────
function modeToPermissions(mode, isDir) {
  const type = isDir ? 'd' : '-';
  const r = (m) => m & 4 ? 'r' : '-';
  const w = (m) => m & 2 ? 'w' : '-';
  const x = (m) => m & 1 ? 'x' : '-';
  const u = (mode >> 6) & 7;
  const g = (mode >> 3) & 7;
  const o = mode & 7;
  return type + r(u) + w(u) + x(u) + r(g) + w(g) + x(g) + r(o) + w(o) + x(o);
}
