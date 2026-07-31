const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('path');
const { fork, execSync } = require('child_process');
const appLogger = require('./app-logger');

let mainWindow = null;
let splashWindow = null;
let serverProcess = null;
const PORT = 3141;

function killExistingServer() {
  try {
    // Windows: kill process on our port
    if (process.platform === 'win32') {
      const cmd = `for /f "tokens=5" %%a in ('netstat -ano ^| findstr :${PORT} ^| findstr LISTENING') do taskkill //F //PID %%a 2>nul`;
      execSync(cmd, { stdio: 'ignore', timeout: 3000 });
    } else {
      execSync(`lsof -ti:${PORT} | xargs kill -9 2>/dev/null`, { stdio: 'ignore', timeout: 3000 });
    }
    // Give the OS a moment to release the port
    return new Promise(resolve => setTimeout(resolve, 800));
  } catch {
    return Promise.resolve();
  }
}

function startServer(retries = 1) {
  return new Promise((resolve, reject) => {
    let started = false;
    let stderrBuffer = '';

    function attemptStart() {
      serverProcess = fork(path.join(__dirname, 'server.js'), [], {
        env: { ...process.env, VPS_COMMANDER_PORT: String(PORT) },
        silent: true,
      });

      serverProcess.stdout.on('data', (data) => {
        const msg = data.toString();
        if (msg.includes('PORT:')) {
          started = true;
          resolve();
        }
      });

      serverProcess.stderr.on('data', (data) => {
        stderrBuffer += data.toString();
      });

      serverProcess.on('error', (err) => {
        appLogger.log({ source: 'ELECTRON', level: 'FATAL', message: 'Server process error', extra: { error: err.message } });
        if (!started) reject(err);
      });

      serverProcess.on('exit', (code) => {
        if (!started) {
          if (stderrBuffer.includes('EADDRINUSE') && retries > 0) {
            appLogger.log({ source: 'ELECTRON', level: 'WARN', message: `Port ${PORT} in use, killing existing and retrying...` });
            killExistingServer().then(() => {
              stderrBuffer = '';
              retries--;
              attemptStart();
            });
          } else {
            const msg = stderrBuffer.includes('EADDRINUSE')
              ? `Port ${PORT} is already in use. Close any other instances of VPS Commander and try again.`
              : `Server failed to start. Check app-error.log for details.\n\n${stderrBuffer.substring(0, 200)}`;
            reject(new Error(msg));
          }
        }
      });

      // Fallback: if server hasn't started or errored within 5s, assume it's running
      setTimeout(() => {
        if (!started && !serverProcess.killed) {
          appLogger.log({ source: 'ELECTRON', level: 'WARN', message: 'Server startup timeout — assuming running' });
          resolve();
        }
      }, 5000);
    }

    attemptStart();
  });
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 400,
    height: 380,
    frame: false,
    transparent: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    center: true,
    backgroundColor: '#0A0A0A',
    icon: path.join(__dirname, 'public', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
  });

  splashWindow.setMenuBarVisibility(false);
  splashWindow.loadFile(path.join(__dirname, 'public', 'splash.html'));

  splashWindow.on('closed', () => {
    splashWindow = null;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: '[ VPS COMMANDER ] :: TACTICAL TELEMETRY',
    backgroundColor: '#0A0A0A',
    icon: path.join(__dirname, 'public', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL(`http://localhost:${PORT}`);

  mainWindow.once('ready-to-show', () => {
    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
      }
      mainWindow.show();
      mainWindow.focus();
    }, 800);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('crashed', (event, killed) => {
    appLogger.log({ source: 'ELECTRON', level: 'FATAL', message: 'Renderer process crashed', extra: { killed } });
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    appLogger.log({ source: 'ELECTRON', level: 'ERROR', message: `Page load failed: ${errorDescription}`, extra: { errorCode, url: validatedURL } });
  });
}

// ── Menu ──────────────────────────────────────────────────
const menuTemplate = [
  {
    label: 'File',
    submenu: [
      { label: 'New Connection', accelerator: 'CmdOrCtrl+N', click: () => mainWindow?.webContents.send('menu:new-connection') },
      { type: 'separator' },
      { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => mainWindow?.webContents.send('menu:settings') },
      { type: 'separator' },
      { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
    ],
  },
  {
    label: 'View',
    submenu: [
      { label: 'Toggle DevTools', accelerator: 'F12', click: () => mainWindow?.webContents.toggleDevTools() },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.webContents.reload() },
      { type: 'separator' },
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => mainWindow?.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() + 0.2) },
      { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => mainWindow?.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() - 0.2) },
      { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: () => mainWindow?.webContents.setZoomLevel(0) },
    ],
  },
  {
    label: 'Help',
    submenu: [
      { label: 'About VPS Commander', click: () => dialog.showMessageBox(mainWindow, { title: 'VPS Commander', message: 'VPS Commander v1.0.0\n\nTactical telemetry for remote server management.\n\nBuilt with Electron + Node.js + xterm.js', type: 'info' }) },
      { label: 'Documentation', click: () => shell.openExternal('https://github.com/vps-commander') },
    ],
  },
];

// ── App Lifecycle ─────────────────────────────────────────

app.whenReady().then(async () => {
  appLogger.log({ source: 'ELECTRON', level: 'INFO', message: 'App starting' });
  createSplashWindow();

  try {
    await startServer();
  } catch (err) {
    appLogger.log({ source: 'ELECTRON', level: 'FATAL', message: 'Server failed to start', extra: { error: err.message } });
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    dialog.showErrorBox('Startup Error', err.message || 'Server failed to start.');
    app.quit();
    return;
  }

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  if (serverProcess) serverProcess.kill('SIGKILL');
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  appLogger.log({ source: 'ELECTRON', level: 'INFO', message: 'App quitting' });
  if (serverProcess) {
    try { serverProcess.kill('SIGKILL'); } catch {}
  }
});
