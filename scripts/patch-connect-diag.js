const fs = require('fs');
let js = fs.readFileSync('public/js/app.js', 'utf8');

// Replace the connectToServer function with enhanced version
const oldFunc = `async function connectToServer() {
  const host = dom.connHost.value.trim();
  const port = parseInt(dom.connPort.value) || 22;
  const username = dom.connUser.value.trim();
  const label = dom.connLabel.value.trim() || host;

  if (!host || !username) {
    dom.connectStatus.textContent = 'ERROR: HOST/USER REQUIRED';
    dom.connectStatus.style.color = 'var(--red)';
    return;
  }

  const connBody = { host, port, username };
  if (State.authMethod === 'key') {
    connBody.privateKey = dom.connKey.value.trim();
    if (!connBody.privateKey) {
      dom.connectStatus.textContent = 'ERROR: SSH KEY REQUIRED';
      dom.connectStatus.style.color = 'var(--red)';
      return;
    }
  } else {
    connBody.password = dom.connPass.value;
  }

  dom.connectStatus.textContent = 'ESTABLISHING LINK...';
  dom.connectStatus.style.color = 'var(--fg-mid)';
  dom.connectBtn.disabled = true;`;

const newFunc = `async function connectToServer() {
  const host = dom.connHost.value.trim();
  const port = parseInt(dom.connPort.value) || 22;
  const username = dom.connUser.value.trim();
  const label = dom.connLabel.value.trim() || host;

  if (!host || !username) {
    dom.connectStatus.textContent = 'ERROR: HOST/USER REQUIRED';
    dom.connectStatus.style.color = 'var(--red)';
    return;
  }

  // Warn about uppercase usernames (Linux is case-sensitive)
  if (username !== username.toLowerCase()) {
    dom.connectStatus.textContent = 'WARNING: Username has uppercase chars. Linux is case-sensitive — "' + username + '" may not match "' + username.toLowerCase() + '".';
    dom.connectStatus.style.color = '#FF8C00';
    // Don't block — just warn
  }

  const connBody = { host, port, username };
  if (State.authMethod === 'key') {
    connBody.privateKey = dom.connKey.value.trim();
    if (!connBody.privateKey) {
      dom.connectStatus.textContent = 'ERROR: SSH KEY REQUIRED — paste a key or switch to PASSWORD mode';
      dom.connectStatus.style.color = 'var(--red)';
      return;
    }
  } else {
    connBody.password = dom.connPass.value;
    if (!connBody.password || connBody.password.length === 0) {
      dom.connectStatus.textContent = 'ERROR: PASSWORD IS EMPTY — check credentials or switch to SSH KEY mode';
      dom.connectStatus.style.color = 'var(--red)';
      return;
    }
  }

  dom.connectStatus.textContent = 'CHECKING CONNECTION...';
  dom.connectStatus.style.color = 'var(--fg-mid)';
  dom.connectBtn.disabled = true;`;

if (!js.includes(oldFunc)) {
  console.error('OLD FUNCTION NOT FOUND');
  process.exit(1);
}

js = js.replace(oldFunc, newFunc);

// Also improve the error catch block
const oldCatch = `  } catch (err) {
    dom.connectStatus.textContent = \`ERROR: \${err.message}\`;
    dom.connectStatus.style.color = 'var(--red)';
    dom.connectBtn.disabled = false;
  }`;

const newCatch = `  } catch (err) {
    const msg = err.message || 'Connection failed';
    dom.connectStatus.textContent = 'ERROR: ' + msg;
    dom.connectStatus.style.color = 'var(--red)';
    dom.connectBtn.disabled = false;
    // Log to app error log
    fetch(API + '/api/error-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Frontend connect error: ' + msg, source: 'FRONTEND' }),
    }).catch(() => {});
  }`;

js = js.replace(oldCatch, newCatch);
console.log('Replaced:', oldCatch !== newCatch);

fs.writeFileSync('public/js/app.js', js);
console.log('OK');
