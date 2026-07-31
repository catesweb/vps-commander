const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// List of all catch blocks to instrument with appLogger.log.
// Each entry: [unique context line, log message prefix]
const patches = [
  // Stats
  ['const stats = await ssh.getStats(sessionId);', 'Stats fetch failed'],
  // Logs
  ['const logs = await ssh.getLogs(sessionId, file, parseInt(lines));', 'Logs fetch failed'],
  // Services
  ['const services = await ssh.getServices(sessionId);', 'Services list failed'],
  ['const result = await ssh.controlService(sessionId, name, action);', 'Service control failed'],
  // Processes
  ['const processes = await ssh.getProcesses(sessionId, sort);', 'Process list failed'],
  ['const result = await ssh.killProcess(sessionId, parseInt(pid), signal);', 'Process kill failed'],
  ['const result = await ssh.reniceProcess(sessionId, parseInt(pid), parseInt(nice));', 'Process renice failed'],
  // SFTP
  ['const files = await ssh.listFiles(sessionId, safePath);', 'SFTP list failed'],
  ['const stat = await ssh.statFile(sessionId, safePath);', 'SFTP stat failed'],
  ['isDirectory ? await ssh.deleteDir(sessionId, safePath) : await ssh.deleteFile(sessionId, safePath);', 'SFTP delete failed'],
  ['const result = await ssh.renameFile(sessionId, safeOld, safeNew);', 'SFTP rename failed'],
  ['const result = await ssh.chmodFile(sessionId, safePath, safeMode);', 'SFTP chmod failed'],
  ['const result = await ssh.mkdir(sessionId, safePath);', 'SFTP mkdir failed'],
  ['const data = await ssh.readFile(sessionId, safePath);', 'SFTP download failed'],
  ['const result = await ssh.writeFile(sessionId, fullPath, data);', 'SFTP upload failed'],
  ['const result = await ssh.writeFile(sessionId, safePath, data);', 'SFTP save failed'],
  // UFW
  ['const status = await ssh.getUfwStatus(sessionId);', 'UFW status failed'],
  ['const result = await ssh.enableUfw(sessionId);', 'UFW enable failed'],
  ['const result = await ssh.disableUfw(sessionId);', 'UFW disable failed'],
  ['const result = await ssh.addUfwRule(sessionId, rule, action);', 'UFW rule add failed'],
  ['const result = await ssh.deleteUfwRule(sessionId, ruleNum);', 'UFW rule delete failed'],
  // Docker
  ['const containers = await ssh.getDockerContainers(sessionId);', 'Docker list failed'],
  ['const result = await ssh.dockerAction(sessionId, containerId, action);', 'Docker action failed'],
  ['const logs = await ssh.getDockerLogs(sessionId, containerId, parseInt(lines));', 'Docker logs failed'],
  ['const stats = await ssh.getDockerStats(sessionId, containerId);', 'Docker stats failed'],
  // Bulk exec — per-server failures
  ['const { stdout, stderr, code } = await ssh.exec(sid, command.trim());', 'Bulk exec per-server failed'],
];

let applied = 0;
for (const [contextLine, logMsg] of patches) {
  // Find the try block containing this context line, then find the catch(err) after it
  // and add appLogger.log before the res.status(500)
  const idx = code.indexOf(contextLine);
  if (idx === -1) continue;

  // Find the closing catch block after this line
  const afterTry = code.substring(idx);
  const catchMatch = afterTry.match(/\} catch \(err\) \{/);
  if (!catchMatch) continue;
  const catchIdx = idx + catchMatch.index;

  // Find the res.status(500) after the catch
  const afterCatch = code.substring(catchIdx);
  const statusMatch = afterCatch.match(/res\.status\(500\)\.json\(\{ error: err\.message \}\);?/);
  if (!statusMatch) continue;
  const statusIdx = catchIdx + statusMatch.index;

  // Build the log line with session context
  // Determine which session variable to use (sessionId or sid)
  const sessionVar = contextLine.includes('sid, command') ? 'sid' : 'sessionId';

  const logLine = `appLogger.log({ source: 'SSH', level: 'ERROR', message: '${logMsg}: ' + err.message, extra: { sessionId: ${sessionVar} } });\n      `;

  // Insert the log line before res.status(500)
  code = code.substring(0, statusIdx) + logLine + code.substring(statusIdx);
  applied++;
}

console.log(`Applied ${applied} session-aware log entries`);

// Also handle the bulk exec outer catch
code = code.replace(
  '  settings.auditLog({ type: \'BULK\', message: `Bulk exec on ${activeIds.length} servers: ${command.substring(0, 60)}` });\n  res.json({ results: Object.values(results) });',
  '  settings.auditLog({ type: \'BULK\', message: `Bulk exec on ${activeIds.length} servers: ${command.substring(0, 60)}` });\n  res.json({ results: Object.values(results) });\n  // Note: per-server errors are logged individually above'
);

fs.writeFileSync('server.js', code);
console.log('Done');
