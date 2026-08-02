const { app, BrowserWindow, Menu, dialog, shell, screen } = require('electron');
const path = require('path');
const { fork, execSync, execFileSync } = require('child_process');
const appLogger = require('./app-logger');

// Windows decides the taskbar icon, window grouping, pin target and notification
// identity from the AppUserModelID — NOT from BrowserWindow's `icon:`, which only
// dresses the window itself. With no AUMID set, Windows falls back to the running
// executable, so the taskbar shows electron.exe's default icon and calls the app
// "Electron", and a pin re-resolves to Electron on the next launch.
// Must match `build.appId` in package.json, and must run before any window or
// notification is created. No-op off Windows.
app.setAppUserModelId('com.vpscommander.app');

// Auto-update via GitHub Releases (electron-updater).
// Guarded by app.isPackaged so dev mode (`npm start`) never self-updates.
let autoUpdater = null;
let updatePromptShown = false;
let restartDialogOpen = false;

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

// macOS only: self-update requires a valid Developer ID signature. Check the
// running binary's signature directly (future-proof if signing is added to CI).
let macSignedCache = null;
function isMacAppSigned() {
  if (macSignedCache !== null) return macSignedCache;
  if (process.platform !== 'darwin') return true;
  try {
    // execFileSync (no shell) so the app-bundle path can never be shell-interpreted.
    execFileSync('codesign', ['--verify', process.execPath], { timeout: 5000, stdio: 'ignore' });
    macSignedCache = true;
  } catch {
    macSignedCache = false;
  }
  return macSignedCache;
}

function setupAutoUpdater() {
  if (!app.isPackaged) {
    appLogger.log({ source: 'UPDATER', level: 'INFO', message: 'Auto-update disabled (dev mode)' });
    return;
  }

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    appLogger.log({ source: 'UPDATER', level: 'ERROR', message: 'Failed to load electron-updater: ' + err.message });
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (msg) => appLogger.log({ source: 'UPDATER', level: 'INFO', message: updaterLogMsg(msg) }),
    warn: (msg) => appLogger.log({ source: 'UPDATER', level: 'WARN', message: updaterLogMsg(msg) }),
    error: (msg) => appLogger.log({ source: 'UPDATER', level: 'ERROR', message: updaterLogMsg(msg) }),
  };

  autoUpdater.on('checking-for-update', () => {
    appLogger.log({ source: 'UPDATER', level: 'INFO', message: 'Checking for updates' });
  });

  autoUpdater.on('update-available', (info) => {
    const version = info?.version || '? ';
    appLogger.log({ source: 'UPDATER', level: 'INFO', message: `Update available: v${version}` });
    // macOS unsigned builds can't self-update; degrade to a release-link prompt.
    if (process.platform === 'darwin' && !isMacAppSigned()) {
      promptOpenRelease(version);
      return;
    }
    promptDownload(version);
  });

  autoUpdater.on('update-not-available', () => {
    appLogger.log({ source: 'UPDATER', level: 'INFO', message: 'No update available' });
  });

  let lastLoggedPct = -1;
  autoUpdater.on('download-progress', (progress) => {
    const pct = Math.round(progress?.percent || 0);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(progress?.percent ? progress.percent / 100 : -1);
    }
    // Throttle disk writes — progress fires many times per second.
    const bucket = Math.floor(pct / 10);
    if (bucket !== lastLoggedPct) {
      lastLoggedPct = bucket;
      appLogger.log({ source: 'UPDATER', level: 'INFO', message: `Downloading update: ${pct}%` });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    const version = info?.version || '? ';
    appLogger.log({ source: 'UPDATER', level: 'INFO', message: `Update downloaded: v${version}` });
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(-1);
    promptRestart(version);
  });

  autoUpdater.on('error', (err) => {
    appLogger.log({ source: 'UPDATER', level: 'ERROR', message: 'Update error: ' + err.message, extra: { code: err.code } });
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(-1);
  });

  // Check shortly after startup so the splash/main window aren't delayed.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      appLogger.log({ source: 'UPDATER', level: 'ERROR', message: 'Update check failed: ' + err.message });
    });
  }, 5000);
}

function updaterLogMsg(msg) {
  if (typeof msg === 'string') return msg;
  try { return JSON.stringify(msg); } catch { return String(msg); }
}

function promptDownload(version) {
  if (updatePromptShown) return;
  updatePromptShown = true;
  dialog.showMessageBox(mainWindow || undefined, {
    type: 'info',
    title: 'Update Available',
    message: `VPS Commander v${version} is available`,
    detail: 'A new version is ready to download. Install it now?',
    buttons: ['Download & Install', 'Later'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) {
      autoUpdater.downloadUpdate().catch((err) => {
        appLogger.log({ source: 'UPDATER', level: 'ERROR', message: 'Update download failed: ' + err.message });
        dialog.showErrorBox('Update Failed', 'Could not download the update.\n\n' + err.message);
      });
    }
  }).catch(() => {});
}

function promptRestart(version) {
  if (restartDialogOpen) return;
  restartDialogOpen = true;
  dialog.showMessageBox(mainWindow || undefined, {
    type: 'info',
    title: 'Update Ready',
    message: `VPS Commander v${version} has been downloaded`,
    detail: 'Restart now to finish installing the update?',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    restartDialogOpen = false;
    if (response === 0) {
      autoUpdater.quitAndInstall();
    }
  }).catch(() => { restartDialogOpen = false; });
}

function promptOpenRelease(version) {
  if (updatePromptShown) return;
  updatePromptShown = true;
  dialog.showMessageBox(mainWindow || undefined, {
    type: 'info',
    title: 'Update Available',
    message: `VPS Commander v${version} is available`,
    detail: 'Auto-update is not supported on this build (unsigned macOS app).\n\nOpen the GitHub Releases page to download it manually?',
    buttons: ['Open Releases', 'Later'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) shell.openExternal('https://github.com/catesweb/vps-commander/releases');
  }).catch(() => {});
}

function createWindow() {
  // Clamp the default size to the display's work area. A hardcoded 1400x900 opens
  // LARGER than the desktop on a 1366x768 laptop, so the right and bottom edges sit
  // off-screen and the UI looks clipped even though the layout is fine. workAreaSize
  // already excludes the taskbar. The floor matches minWidth/minHeight below so a
  // very small display still gets a usable window rather than a degenerate one.
  const { width: availW, height: availH } = screen.getPrimaryDisplay().workAreaSize;
  const winWidth = Math.max(900, Math.min(1400, availW));
  const winHeight = Math.max(600, Math.min(900, availH));

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    minWidth: Math.min(900, availW),
    minHeight: Math.min(600, availH),
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
      { label: 'About VPS Commander', click: () => dialog.showMessageBox(mainWindow, { title: 'VPS Commander', message: `VPS Commander v${app.getVersion()}\n\nTactical telemetry for remote server management.\n\nBuilt with Electron + Node.js + xterm.js`, type: 'info' }) },
      { label: 'Check for Updates…', click: () => {
        if (!autoUpdater) {
          dialog.showMessageBox(mainWindow, { type: 'info', message: 'Auto-update is only available in packaged builds.', detail: 'Run `npm run build:win` (or mac/linux) and install the build to receive updates.' });
          return;
        }
        updatePromptShown = false;
        autoUpdater.checkForUpdates().catch((err) => {
          appLogger.log({ source: 'UPDATER', level: 'ERROR', message: 'Manual update check failed: ' + err.message });
          dialog.showErrorBox('Update Check Failed', err.message || 'Could not check for updates.');
        });
      } },
      { label: 'Documentation', click: () => shell.openExternal('https://github.com/catesweb/vps-commander') },
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
  setupAutoUpdater();

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
