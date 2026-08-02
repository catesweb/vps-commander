/* ═══════════════════════════════════════════════════════════
   VPS COMMANDER — MULTI-SERVER APPLICATION LOGIC
   Electron Desktop Edition
   ═══════════════════════════════════════════════════════════ */

const API = '';
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── STATE ─────────────────────────────────────────────────
const State = {
  sessions: {},
  activeSession: null,
  settings: {},
  profiles: [],
  polling: {},
  term: null,
  termSocket: null,
  authMethod: 'password',
  vaultLocked: false,
  processSort: 'cpu',
  processOrder: 'desc',
  processData: [],
  processFilter: '',
  filePath: '/',
  fileList: [],
  history: { cpu: [], mem: [], disk: [], netTx: [], netRx: [] },
  maxHistory: 60,
  alerts: { cpu: false, mem: false, disk: false, network: false },
  ufwActive: false,
  prevNetRx: null, prevNetTx: null,
  soundCache: {},       // decoded AudioBuffer cache: { cpu: AudioBuffer, ... }
  lastAlertSound: {},   // per-type debounce: { cpu: timestamp, ... }
};

// ── DOM REFS ──────────────────────────────────────────────
const dom = {
  connectPanel: $('#connect-panel'),
  dashboardView: $('#dashboard-view'),
  connectBtn: $('#connect-btn'),
  connectStatus: $('#connect-status'),
  serverTabs: $('#server-tabs'),
  headerUnit: $('#header-unit'),
  headerTime: $('#header-time'),

  profileSelect: $('#profile-select'),
  profileSave: $('#profile-save'),
  profileDelete: $('#profile-delete'),
  connLabel: $('#conn-label'),
  connHost: $('#conn-host'),
  connPort: $('#conn-port'),
  connUser: $('#conn-user'),
  connPass: $('#conn-pass'),
  connKey: $('#conn-key'),
  authPwBtn: $('#auth-pw-btn'),
  authKeyBtn: $('#auth-key-btn'),
  authPwGroup: $('#auth-pw-group'),
  authKeyGroup: $('#auth-key-group'),
  keyLoadFile: $('#key-load-file'),
  keyFileInput: $('#key-file-input'),
  keyStatus: $('#key-status'),

  statCpu: $('#stat-cpu'), statCpuBar: $('#stat-cpu-bar'),
  statMem: $('#stat-mem'), statMemBar: $('#stat-mem-bar'),
  statDisk: $('#stat-disk'), statDiskBar: $('#stat-disk-bar'),
  chartCpu: $('#chart-cpu'), chartMem: $('#chart-mem'), chartDisk: $('#chart-disk'), chartNet: $('#chart-net'),
  statNet: $('#stat-net'), netTxVal: $('#net-tx-val'), netRxVal: $('#net-rx-val'),
  statUptime: $('#stat-uptime'), statLoad: $('#stat-load'),
  statProcs: $('#stat-procs'),

  termHost: $('#term-host'),
  servicesList: $('#services-list'), svcCount: $('#svc-count'),
  logContainer: $('#log-container'),

  siHostname: $('#si-hostname'), siOs: $('#si-os'),
  siKernel: $('#si-kernel'), siNetwork: $('#si-network'),

  statusConn: $('#status-conn'), statusLatency: $('#status-latency'),
  statusLast: $('#status-last'), statusSessions: $('#status-sessions'),
  btnDisconnect: $('#btn-disconnect'),
  btnBulk: $('#btn-bulk'),

  settingsModal: $('#settings-modal'),
  unlockModal: $('#unlock-modal'),
  unlockPass: $('#unlock-pass'),
  unlockBtn: $('#unlock-btn'),
  unlockError: $('#unlock-error'),
  auditContainer: $('#audit-container'),
  auditCount: $('#audit-count'),
  auditRefresh: $('#audit-refresh'),
  auditClear: $('#audit-clear'),

  applogContainer: $('#applog-container'),
  applogCount: $('#applog-count'),
  applogRefresh: $('#applog-refresh'),

  procCount: $('#proc-count'),
  procRefresh: $('#proc-refresh'),
  procSearch: $('#proc-search'),
  procTbody: $('#proc-tbody'),
  procTable: $('#proc-table'),

  ufwCount: $('#ufw-count'),
  ufwRefresh: $('#ufw-refresh'),
  ufwStatus: $('#ufw-status'),
  ufwPolicy: $('#ufw-policy'),
  ufwTbody: $('#ufw-tbody'),
  ufwToggleBtn: $('#ufw-toggle-btn'),
  ufwAddBtn: $('#ufw-add-btn'),
  ufwAddForm: $('#ufw-add-form'),
  ufwRuleAction: $('#ufw-rule-action'),
  ufwRuleInput: $('#ufw-rule-input'),
  ufwRuleSubmit: $('#ufw-rule-submit'),
  ufwRuleCancel: $('#ufw-rule-cancel'),
  svcRefresh: $('#svc-refresh'),

  dockerCount: $('#docker-count'),
  dockerRefresh: $('#docker-refresh'),
  dockerTbody: $('#docker-tbody'),

  filePathBar: $('#file-path-bar'),
  filePathInfo: $('#file-path-info'),
  fileTbody: $('#file-tbody'),
  fileTable: $('#file-table'),
  fileHome: $('#file-home'),
  fileUp: $('#file-up'),
  fileRefresh: $('#file-refresh'),
  fileMkdir: $('#file-mkdir'),
  fileUploadBtn: $('#file-upload-btn'),
  fileUploadInput: $('#file-upload-input'),
  logActions: $('#log-actions'),
  fileActions: $('#file-actions'),

  editorModal: $('#editor-modal'),
  editorTextarea: $('#editor-textarea'),
  editorPath: $('#editor-path'),
  editorInfo: $('#editor-info'),
  editorStatus: $('#editor-status'),
  editorSave: $('#editor-save'),
  editorClose: $('#editor-close'),

  bulkModal: $('#bulk-modal'),
  bulkCommand: $('#bulk-command'),
  bulkExecute: $('#bulk-execute'),
  bulkOutput: $('#bulk-output'),
  bulkServerCount: $('#bulk-server-count'),
  bulkStatus: $('#bulk-status'),
  bulkClose: $('#bulk-close'),
};

// ── MODAL TRANSITIONS ───────────────────────────────────
// Asymmetric: 200ms ease-out scale(0.97)+fade in, 150ms fade out.
// Editor/bulk carry .modal-instant and toggle instantly (frequent work
// surfaces). Reduced-motion users get instant toggles, no timers.
const modalCloseTimers = new WeakMap();
const modalStack = [];             // open order → Escape closes topmost first
const modalReturnFocus = new WeakMap(); // trigger element per modal

function modalPrefersReduced() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function openModal(el, trigger) {
  if (modalCloseTimers.has(el)) {
    clearTimeout(modalCloseTimers.get(el));
    modalCloseTimers.delete(el);
  }
  el.classList.remove('closing');
  // Track open order (dedupe so a reopen mid-close doesn't double-push)
  if (!modalStack.includes(el)) modalStack.push(el);
  // Remember the element that had focus so we can return it on close
  const t = trigger || document.activeElement;
  if (t && t !== document.body && t !== document.documentElement) {
    modalReturnFocus.set(el, t);
  }
  el.style.display = 'flex';
  if (el.classList.contains('modal-instant') || modalPrefersReduced()) {
    el.classList.add('open');
  } else {
    void el.offsetWidth; // reflow so the entry transition actually fires
    el.classList.add('open');
  }
  // Move focus into the dialog: the header (title) is the programmatic
  // focus target so screen readers announce the dialog name.
  const header = el.querySelector('.modal-header');
  if (header) header.focus();
}

function closeModal(el) {
  if (el.style.display !== 'flex') return;
  // Cancel any pending close so a rapid double-close can't orphan a timer
  // that would later hide a freshly reopened modal.
  if (modalCloseTimers.has(el)) {
    clearTimeout(modalCloseTimers.get(el));
    modalCloseTimers.delete(el);
  }
  // Pop from the open-order stack
  const si = modalStack.indexOf(el);
  if (si !== -1) modalStack.splice(si, 1);
  el.classList.remove('open');
  const finish = () => {
    el.classList.remove('closing');
    el.style.display = 'none';
    // Return focus to the triggering button (keyboard dialog behavior)
    const target = modalReturnFocus.get(el);
    modalReturnFocus.delete(el);
    if (target && target.isConnected && typeof target.focus === 'function') {
      target.focus();
    }
  };
  if (el.classList.contains('modal-instant') || modalPrefersReduced()) {
    finish();
    return;
  }
  el.classList.add('closing');
  modalCloseTimers.set(el, setTimeout(() => {
    finish();
    modalCloseTimers.delete(el);
  }, 150));
}

// ── INIT ──────────────────────────────────────────────────
async function init() {
  await checkVaultStatus();
  if (State.vaultLocked) {
    openModal(dom.unlockModal);
    dom.unlockPass.focus();
    updateClock();
    setInterval(updateClock, 1000);
    bindEvents();
    typeInTitle();
    return;
  }
  await loadSettings();
  await loadProfiles();
  // Desktop notifications for log-watch alerts raised while the window is blurred.
  if (window.Notification && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
  updateClock();
  setInterval(updateClock, 1000);
  bindEvents();
  typeInTitle();
}

async function checkVaultStatus() {
  try {
    const res = await fetch(`${API}/api/auth/status`);
    const status = await res.json();
    State.vaultLocked = status.locked;
    State.vaultMethod = status.method;
  } catch {}
}

function updateClock() {
  dom.headerTime.textContent = new Date().toTimeString().split(' ')[0];
}

// ── THEME ────────────────────────────────────────────────
function applyTheme(theme) {
  const t = theme === 'swiss' ? 'swiss' : 'tactical';
  document.documentElement.dataset.theme = t;
  // Live-update an open terminal's palette without reconnecting
  if (State.term && State.term.options) {
    State.term.options.theme = getTermTheme(t);
  }
  drawCharts();
}

function getTermTheme(theme) {
  if (theme === 'swiss') {
    return {
      background: '#FFFFFF', foreground: '#141414', cursor: '#C81010',
      selectionBackground: '#C8101040',
      black: '#141414', red: '#C81010', green: '#15803D', yellow: '#8A6D00',
      blue: '#1A5FB4', magenta: '#A0208A', cyan: '#0E7490', white: '#141414',
      brightBlack: '#5A5A5A', brightRed: '#E61919', brightGreen: '#1FA84A', brightYellow: '#B45309',
      brightBlue: '#2E7BD9', brightMagenta: '#C73EB0', brightCyan: '#0FA3C4', brightWhite: '#0A0A0A',
    };
  }
  return {
    background: '#000000', foreground: '#EAEAEA', cursor: '#E61919',
    selectionBackground: '#E6191940',
    black: '#1A1A1A', red: '#E61919', green: '#4AF626', yellow: '#FFD700',
    blue: '#4169E1', magenta: '#FF69B4', cyan: '#00CED1', white: '#EAEAEA',
    brightBlack: '#444444', brightRed: '#FF4444', brightGreen: '#6BFF6B', brightYellow: '#FFFF44',
    brightBlue: '#6FA8FF', brightMagenta: '#FF8AE0', brightCyan: '#4DE0E5', brightWhite: '#FFFFFF',
  };
}

// ── CONNECT-SCREEN MOTION ────────────────────────────────
let titleTypeTimer = null;
let titleRun = 0;

function typeInTitle() {
  const run = ++titleRun;
  if (titleTypeTimer) { clearInterval(titleTypeTimer); titleTypeTimer = null; }
  const el = $('.connect-title');
  if (!el || !el.dataset.text) return;
  const full = el.dataset.text;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.classList.remove('typing');
    el.textContent = full;
    return;
  }
  el.classList.add('typing');
  // Pin the box to the exact width of the rendered text (via Range, since the
  // block h2's own rect spans its container), then center with auto margins so
  // the title never drifts while typing. Measure after fonts settle to avoid
  // pinning to fallback-font metrics.
  const start = () => {
    if (run !== titleRun) return; // superseded by a newer typeInTitle/finish
    el.textContent = full;
    const range = document.createRange();
    range.selectNodeContents(el);
    const w = range.getBoundingClientRect().width;
    range.detach();
    el.style.width = w + 'px';
    el.style.margin = '0 auto 20px';
    el.style.whiteSpace = 'nowrap';
    el.textContent = '';
    let i = 0;
    titleTypeTimer = setInterval(() => {
      i += 1;
      el.textContent = full.slice(0, i);
      if (i >= full.length) {
        clearInterval(titleTypeTimer);
        titleTypeTimer = null;
        el.classList.remove('typing');
      }
    }, 26);
  };
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(start);
  } else {
    start();
  }
}

function finishTitleType() {
  titleRun++; // invalidate any pending fonts.ready start
  if (titleTypeTimer) { clearInterval(titleTypeTimer); titleTypeTimer = null; }
  const el = $('.connect-title');
  if (!el || !el.dataset.text) return;
  el.classList.remove('typing');
  el.textContent = el.dataset.text;
  el.style.width = '';
  el.style.margin = '';
  el.style.whiteSpace = '';
}

function scanSweep() {
  const el = $('#scanline-sweep');
  if (!el) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  // Restart the animation cleanly on every connect
  el.classList.remove('active');
  void el.offsetWidth;
  el.classList.add('active');
}

// ── SETTINGS ──────────────────────────────────────────────
async function loadSettings() {    try {
      const res = await fetch(`${API}/api/settings`);
      if (res.status === 423) { State.vaultLocked = true; return; }
      State.settings = await res.json();
      applySettings();
    } catch { /* defaults */ }
}

async function refreshMasterPasswordUI() {
  try {
    const res = await fetch(`${API}/api/auth/status`);
    const status = await res.json();
    const isMaster = status.method === 'master';
    $('#setting-master-status').textContent = isMaster ? 'ENABLED' : 'DISABLED (MACHINE KEY)';
    $('#setting-master-status').style.color = isMaster ? 'var(--green)' : 'var(--fg-dim)';
    $('#setting-master-set-btn').style.display = isMaster ? 'none' : 'inline-block';
    $('#setting-master-remove-btn').style.display = isMaster ? 'inline-block' : 'none';
    if (isMaster) { $('#setting-master-pw').value = ''; $('#setting-master-pw2').value = ''; }
  } catch {}
}

function applySettings() {
  const s = State.settings;
  refreshMasterPasswordUI();
  $('#setting-theme').value = s.theme || 'tactical';
  applyTheme(s.theme || 'tactical');
  $('#setting-fontsize').value = s.terminalFontSize || 13;
  $('#setting-stats').value = s.statsInterval || 3000;
  $('#setting-services').value = s.servicesInterval || 10000;
  $('#setting-logs').value = s.logsInterval || 30000;
  $('#setting-loglines').value = s.logLines || 200;
  $('#setting-configdir').textContent = s.configDir || '~/.vps-commander';
  $('#setting-alert-enabled').checked = s.alertEnabled !== false;
  $('#setting-alert-sound').checked = s.alertSound !== false;
  $('#setting-alert-cpu').value = s.alertCpu || 90;
  $('#setting-alert-mem').value = s.alertMem || 90;
  $('#setting-alert-disk').value = s.alertDisk || 90;
  $('#setting-alert-net').value = s.alertNetMbps || 800;
  $('#setting-log-watch').value = (s.logWatch || []).join(', ');
  // Sound selections — preload each so the first alert doesn't wait on a fetch
  if (s.alertSounds) {
    SOUND_TYPES.forEach(t => {
      const path = (s.alertSounds[t] && s.alertSounds[t].file) || '';
      setSoundValue(t, path);
      if (path) loadSoundFile(t, path).catch(() => {});
    });
  }
}

async function saveSettingsAndClose() {
  State.settings = {
    theme: $('#setting-theme').value,
    terminalFontSize: parseInt($('#setting-fontsize').value) || 13,
    statsInterval: parseInt($('#setting-stats').value) || 3000,
    servicesInterval: parseInt($('#setting-services').value) || 10000,
    logsInterval: parseInt($('#setting-logs').value) || 30000,
    logLines: parseInt($('#setting-loglines').value) || 200,
    alertEnabled: $('#setting-alert-enabled').checked,
    alertSound: $('#setting-alert-sound').checked,
    alertSounds: Object.fromEntries(SOUND_TYPES.map(t => [
      t, { enabled: true, file: ($('#sound-' + t) || {}).value || '' },
    ])),
    alertCpu: parseInt($('#setting-alert-cpu').value) || 90,
    alertMem: parseInt($('#setting-alert-mem').value) || 90,
    alertDisk: parseInt($('#setting-alert-disk').value) || 90,
    alertNetMbps: parseInt($('#setting-alert-net').value) || 800,
    logWatch: $('#setting-log-watch').value.split(',').map(p => p.trim()).filter(Boolean),
  };
  await fetch(`${API}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(State.settings),
  });
  applyTheme(State.settings.theme);
  closeModal(dom.settingsModal);
  // Restart polling for active session with new intervals
  if (State.activeSession) restartPolling();
}

// ── PROFILES ──────────────────────────────────────────────
async function loadProfiles() {
  try {
    const res = await fetch(`${API}/api/profiles`);
    if (res.status === 423) { State.vaultLocked = true; return; }
    const data = await res.json();
    State.profiles = data.profiles || [];
    renderProfileSelect();
    // Auto-load the last profile connected from this machine
    const last = localStorage.getItem('vpsc.lastProfile');
    if (last && State.profiles.some(p => p.id === last)) {
      dom.profileSelect.value = last;
      dom.profileSelect.dispatchEvent(new Event('change'));
    }
  } catch {}
}

function renderProfileSelect() {
  const sel = dom.profileSelect;
  sel.innerHTML = '<option value="">-- NEW CONNECTION --</option>';
  State.profiles.forEach(p => {
    sel.innerHTML += `<option value="${p.id}">${p.label || p.host}</option>`;
  });
}

dom.profileSelect.addEventListener('change', async () => {
  const id = dom.profileSelect.value;
  if (!id) {
    dom.connLabel.value = ''; dom.connHost.value = '';
    dom.connPort.value = '22'; dom.connUser.value = 'root';
    dom.connPass.value = '';
    dom.connKey.value = '';
    dom.keyStatus.textContent = '';
    dom.keyStatus.className = 'key-status';
    dom.profileDelete.style.display = 'none';
    setAuthMethod('password');
    return;
  }
  const profile = State.profiles.find(p => p.id === id);
  if (profile) {
    dom.connLabel.value = profile.label || '';
    dom.connHost.value = profile.host || '';
    dom.connPort.value = profile.port || 22;
    dom.connUser.value = profile.username || 'root';
    dom.connPass.value = '';
    dom.profileDelete.style.display = 'inline-block';

    // Fetch decrypted password/key for this profile
    if (profile.hasPassword || profile.hasPrivateKey) {
      dom.connPass.placeholder = '•••• (loading)...';
      try {
        const res = await fetch(`${API}/api/profiles/${id}/auth`);
        const data = await res.json();
        if (data.password) {
          dom.connPass.value = data.password;
          dom.connPass.placeholder = '••••••••';
        }
        if (data.privateKey) {
          dom.connKey.value = data.privateKey;
          dom.keyStatus.textContent = '[ KEY LOADED ]';
          dom.keyStatus.className = 'key-status loaded';
          // Switch to key auth if key is present
          setAuthMethod('key');
        }
      } catch {
        dom.connPass.placeholder = '•••• (enter password)';
      }
    }
  }
});

dom.profileSave.addEventListener('click', async () => {
  const profileData = {
    id: dom.profileSelect.value || undefined,
    label: dom.connLabel.value.trim() || dom.connHost.value.trim(),
    host: dom.connHost.value.trim(),
    port: parseInt(dom.connPort.value) || 22,
    username: dom.connUser.value.trim(),
  };
  // Include auth based on current method
  if (State.authMethod === 'key') {
    profileData.privateKey = dom.connKey.value.trim();
  } else {
    profileData.password = dom.connPass.value;
  }
  if (!profileData.host) return;
  try {
    await fetch(`${API}/api/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profileData),
    });
    await loadProfiles();
    dom.connectStatus.textContent = 'PROFILE SAVED';
    dom.connectStatus.style.color = 'var(--green)';
    setTimeout(() => {
      dom.connectStatus.textContent = 'AWAITING CREDENTIALS';
      dom.connectStatus.style.color = 'var(--fg-dim)';
    }, 2000);
  } catch (err) {
    dom.connectStatus.textContent = 'ERROR SAVING PROFILE';
    dom.connectStatus.style.color = 'var(--red)';
  }
});

dom.profileDelete.addEventListener('click', async () => {
  const id = dom.profileSelect.value;
  if (!id) return;
  await fetch(`${API}/api/profiles/${id}`, { method: 'DELETE' });
  await loadProfiles();
  dom.profileSelect.value = '';
  dom.profileDelete.style.display = 'none';
  dom.connLabel.value = ''; dom.connHost.value = '';
  dom.connPort.value = '22'; dom.connUser.value = 'root';
  dom.connPass.value = '';
});

// ── CONNECTION ────────────────────────────────────────────
dom.connectBtn.addEventListener('click', connectToServer);

async function connectToServer() {
  finishTitleType();
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
    dom.connectStatus.textContent = 'WARNING: Username has uppercase — Linux is case-sensitive. Try "' + username.toLowerCase() + '" instead of "' + username + '".';
    dom.connectStatus.style.color = '#FF8C00';
  }

  const connBody = { host, port, username };
  if (State.authMethod === 'key') {
    connBody.privateKey = dom.connKey.value.trim();
    if (!connBody.privateKey) {
      dom.connectStatus.textContent = 'ERROR: SSH KEY REQUIRED — paste a key or switch to PASSWORD';
      dom.connectStatus.style.color = 'var(--red)';
      return;
    }
  } else {
    connBody.password = dom.connPass.value;
    if (!connBody.password || connBody.password.length === 0) {
      dom.connectStatus.textContent = 'ERROR: PASSWORD EMPTY — enter credentials or switch to SSH KEY';
      dom.connectStatus.style.color = 'var(--red)';
      return;
    }
  }

  dom.connectStatus.textContent = 'CHECKING CONNECTION...';
  dom.connectStatus.style.color = 'var(--fg-mid)';
  dom.connectBtn.disabled = true;

  try {
    const res = await fetch(`${API}/api/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(connBody),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Connection failed');

    const { sessionId } = await res.json();

    if (dom.profileSelect.value) localStorage.setItem('vpsc.lastProfile', dom.profileSelect.value);

    State.prevNetRx = null; State.prevNetTx = null;
    State.sessions[sessionId] = { host, port, username, label, sessionId, statsInterval: null, servicesInterval: null, logsInterval: null };
    State.activeSession = sessionId;

    // Clear password and key fields from memory
    dom.connPass.value = '';
    dom.connKey.value = '';
    dom.keyStatus.textContent = '';
    dom.keyStatus.className = 'key-status';

    dom.connectPanel.style.display = 'none';
    dom.dashboardView.style.display = 'flex';
    scanSweep();
    dom.btnDisconnect.style.display = 'inline';
    dom.btnBulk.style.display = 'inline';
    dom.statusConn.textContent = `LINK: ${username}@${host}`;
    dom.termHost.textContent = `ssh://${username}@${host}`;
    updateTabs();
    updateSessionCount();

    playAlertSound('connectOk').catch(() => {});
    initTerminal(sessionId);
    startPolling(sessionId);
    refreshLogs(sessionId);
    refreshServices(sessionId);
    refreshProcesses();
  } catch (err) {
    dom.connectStatus.textContent = `ERROR: ${err.message}`;
    dom.connectStatus.style.color = 'var(--red)';
    dom.connectBtn.disabled = false;
    playAlertSound('connectFail').catch(() => {});
  }
}

async function disconnectSession(sessionId) {
  await fetch(`${API}/api/disconnect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });

  const session = State.sessions[sessionId];
  if (session) {
    clearInterval(session.statsInterval);
    clearInterval(session.servicesInterval);
    clearInterval(session.logsInterval);
    clearInterval(session.processesInterval);
  }

  delete State.sessions[sessionId];

  if (State.activeSession === sessionId) {
    if (State.termSocket) {
      State.termSocket.close();
      State.termSocket = null;
    }
    if (State.term) {
      State.term.dispose();
      State.term = null;
    }

    const remaining = Object.keys(State.sessions);
    if (remaining.length > 0) {
      State.activeSession = remaining[0];
      switchToSession(State.activeSession);
    } else {
      State.activeSession = null;
      State.history = { cpu: [], mem: [], disk: [], netTx: [], netRx: [] };
      State.prevNetRx = null; State.prevNetTx = null;
      dom.dashboardView.style.display = 'none';
      dom.connectPanel.style.display = 'flex';
      typeInTitle();
      dom.btnDisconnect.style.display = 'none';
      dom.btnBulk.style.display = 'none';
      dom.statusConn.textContent = 'LINK: DISCONNECTED';
      dom.connectBtn.disabled = false;
      dom.headerUnit.textContent = 'UNIT // DISCONNECTED';
      dom.connKey.value = '';
      dom.keyStatus.textContent = '';
      dom.keyStatus.className = 'key-status';
      setAuthMethod('password');
    }
  }

  updateTabs();
  updateSessionCount();
}

dom.btnDisconnect.addEventListener('click', () => {
  if (State.activeSession) disconnectSession(State.activeSession);
});

// ── SERVER TABS ───────────────────────────────────────────
function updateTabs() {
  const sessions = Object.values(State.sessions);
  if (sessions.length === 0) {
    dom.serverTabs.innerHTML = '<span class="header-unit" id="header-unit">UNIT // DISCONNECTED</span>';
    return;
  }

  dom.serverTabs.innerHTML = sessions.map(s => {
    const active = s.sessionId === State.activeSession;
    return `<button type="button" class="server-tab${active ? ' tab-active' : ''}" data-sid="${s.sessionId}" title="${s.username}@${s.host}" aria-current="${active ? 'true' : 'false'}">[ ${s.label} ]</button>`;
  }).join('');

  const serverTabs = Array.from(dom.serverTabs.querySelectorAll('.server-tab'));
  serverTabs.forEach((tab, i) => {
    tab.addEventListener('click', () => {
      const sid = tab.dataset.sid;
      if (sid !== State.activeSession) switchToSession(sid);
    });
    // Keyboard access: arrows move between server tabs (wrap), Enter/Space
    // activate via the native button click. Focus is restored after the
    // re-render so keyboard users don't lose their place.
    tab.addEventListener('keydown', (e) => {
      const dir = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
      if (dir === undefined) {
        if (e.key === 'Home') { e.preventDefault(); serverTabs[0].click(); }
        else if (e.key === 'End') { e.preventDefault(); serverTabs[serverTabs.length - 1].click(); }
        return;
      }
      e.preventDefault();
      const next = serverTabs[(i + dir + serverTabs.length) % serverTabs.length];
      next.focus();
      next.click();
      requestAnimationFrame(() => {
        const active = dom.serverTabs.querySelector('.server-tab.tab-active');
        if (active && document.activeElement !== active) active.focus();
      });
    });
  });

  const active = State.sessions[State.activeSession];
  if (active) dom.headerUnit.textContent = `UNIT // ${active.host}`;
}

function switchToSession(sessionId) {
  // Pause old polling
  const old = State.sessions[State.activeSession];
  if (old) {
    clearInterval(old.statsInterval);
    clearInterval(old.servicesInterval);
    clearInterval(old.logsInterval);
    clearInterval(old.processesInterval);
  }

  // Close old terminal
  if (State.termSocket) { State.termSocket.close(); State.termSocket = null; }
  if (State.term) { State.term.dispose(); State.term = null; }

  State.activeSession = sessionId;
  resetLogWatch();  // different host: the old anchor line means nothing here
  State.history = { cpu: [], mem: [], disk: [], netTx: [], netRx: [] };
  State.prevNetRx = null; State.prevNetTx = null;
  const session = State.sessions[sessionId];

  dom.termHost.textContent = `ssh://${session.username}@${session.host}`;
  dom.statusConn.textContent = `LINK: ${session.username}@${session.host}`;
  dom.headerUnit.textContent = `UNIT // ${session.host}`;

  updateTabs();
  initTerminal(sessionId);
  startPolling(sessionId);
  refreshLogs(sessionId);
  refreshServices(sessionId);
  refreshProcesses();
}

function updateSessionCount() {
  dom.statusSessions.textContent = `SESSIONS: ${Object.keys(State.sessions).length}`;
}

// ── STATS POLLING ────────────────────────────────────────
function startPolling(sessionId) {
  fetchStats(sessionId);
  const s = State.sessions[sessionId];
  s.statsInterval = setInterval(() => fetchStats(sessionId), State.settings.statsInterval || 3000);
  s.servicesInterval = setInterval(() => refreshServices(sessionId), State.settings.servicesInterval || 10000);
  s.logsInterval = setInterval(() => refreshLogs(sessionId), State.settings.logsInterval || 30000);
  s.processesInterval = setInterval(() => {
    const procTab = document.querySelector('.panel-services .panel-tab[data-tab="processes"].tab-active');
    if (procTab) refreshProcesses();
  }, 5000);
}

function restartPolling() {
  if (!State.activeSession) return;
  const session = State.sessions[State.activeSession];
  clearInterval(session.statsInterval);
  clearInterval(session.servicesInterval);
  clearInterval(session.logsInterval);
  startPolling(State.activeSession);
}

async function fetchStats(sessionId) {
  try {
    const start = Date.now();
    const res = await fetch(`${API}/api/stats?sessionId=${sessionId}`);
    const data = await res.json();
    dom.statusLatency.textContent = `LATENCY: ${Date.now() - start}ms`;
    dom.statusLast.textContent = `LAST: ${new Date().toLocaleTimeString()}`;

    if (data.cpu) {
      const cpu = parseFloat(data.cpu);
      dom.statCpu.textContent = `${cpu.toFixed(1)}%`;
      dom.statCpuBar.style.width = `${Math.min(cpu, 100)}%`;
      dom.statCpuBar.className = 'stat-bar-fill' + (cpu > 80 ? ' danger' : cpu > 60 ? ' warning' : '');
    }
    if (data.memory) {
      const [used, total, percent] = data.memory.split('|');
      dom.statMem.textContent = `${used} / ${total} MB`;
      dom.statMemBar.style.width = `${parseFloat(percent) || 0}%`;
      dom.statMemBar.className = 'stat-bar-fill' + (parseFloat(percent) > 80 ? ' danger' : parseFloat(percent) > 60 ? ' warning' : '');
    }
    if (data.disk) {
      const [used, total, percent] = data.disk.split('|');
      dom.statDisk.textContent = `${used} / ${total}`;
      dom.statDiskBar.style.width = `${parseInt(percent) || 0}%`;
      dom.statDiskBar.className = 'stat-bar-fill' + (parseInt(percent) > 85 ? ' danger' : parseInt(percent) > 70 ? ' warning' : '');
    }
    if (data.uptime) { dom.statUptime.textContent = data.uptime; dom.statUptime.title = data.uptime; }
    if (data.load) { dom.statLoad.textContent = data.load; dom.statLoad.title = data.load; }
    if (data.processes) dom.statProcs.textContent = data.processes;
    if (data.hostname) dom.siHostname.textContent = data.hostname;
    if (data.os) dom.siOs.textContent = data.os;
    if (data.kernel) dom.siKernel.textContent = data.kernel;
    if (data.network) {
      dom.siNetwork.textContent = data.network;
      // Compute network throughput from /proc/net/dev raw bytes
      const netParts = data.network.split('|');
      if (netParts.length >= 3) {
        const rx = parseInt(netParts[1]) || 0;
        const tx = parseInt(netParts[2]) || 0;
        if (State.prevNetRx !== null && State.prevNetTx !== null) {
          const interval = (State.settings.statsInterval || 3000) / 1000;
          const rxDelta = Math.max(0, (rx - State.prevNetRx) / interval);
          const txDelta = Math.max(0, (tx - State.prevNetTx) / interval);
          dom.statNet.textContent = formatBitrate(rxDelta + txDelta);
          dom.netRxVal.textContent = formatBitrate(rxDelta);
          dom.netTxVal.textContent = formatBitrate(txDelta);
          data._netRxDelta = rxDelta;
          data._netTxDelta = txDelta;
        }
        State.prevNetRx = rx;
        State.prevNetTx = tx;
      }
    }
    checkAlerts(data);
    pushHistory(data);
    drawCharts();
  } catch { /* silent */ }
}

// ── ALERT AUDIO ──────────────────────────────────────────
let alertAudioCtx = null;
let lastAlertBeep = 0;

async function getAlertAudio() {
  if (!alertAudioCtx) {
    try {
      alertAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch { return null; }
  }
  if (alertAudioCtx.state === 'suspended') {
    try { await alertAudioCtx.resume(); } catch { /* user gesture required */ }
  }
  return alertAudioCtx;
}

// ── ALERT SOUND SYSTEM ───────────────────────────────────
// Per-type alert sounds with file-backed custom audio and
// synthesized fallback tones.

const ALERT_TONES = {
  cpu:       { freqs: [880, 1320],   type: 'square', label: 'CPU Alert' },
  memory:    { freqs: [660, 990],    type: 'square', label: 'Memory Alert' },
  disk:      { freqs: [440, 660],    type: 'square', label: 'Disk Alert' },
  network:   { freqs: [1100, 1650],  type: 'triangle', label: 'Network Alert' },
  connectOk: { freqs: [523, 659, 784], type: 'sine', label: 'Connect OK' },
  connectFail: { freqs: [200, 150],  type: 'sawtooth', label: 'Connect Fail' },
  logWatch:  { freqs: [1400, 700, 1400], type: 'square', label: 'Log Watch' },
};

// A stored sound is either a bundled preset ("/sounds/foo.wav", served static)
// or an absolute path to a user file the server copied into ~/.vps-commander.
function isPresetSound(file) { return typeof file === 'string' && file.startsWith('/sounds/'); }

const SOUND_TYPES = ['cpu', 'memory', 'disk', 'network', 'logWatch', 'connectOk', 'connectFail'];

// "mixkit-classic-alarm-995.wav" → "CLASSIC ALARM"
function presetLabel(filename) {
  return filename
    .replace(/\.[^.]+$/, '')
    .replace(/^mixkit-/, '')
    .replace(/-\d+$/, '')
    .replace(/[-_]/g, ' ')
    .toUpperCase();
}

// Sets the stored value (hidden input) and makes the dropdown agree. A custom
// file has no preset option, so one is added on the fly and reused thereafter.
function setSoundValue(type, value, displayName) {
  const hidden = $('#sound-' + type);
  const select = document.querySelector('.sound-preset[data-type="' + type + '"]');
  if (!hidden || !select) return;
  hidden.value = value || '';
  if (!value) { select.value = ''; return; }
  let opt = Array.from(select.options).find(o => o.value === value);
  if (!opt) {
    opt = document.createElement('option');
    opt.value = value;
    select.appendChild(opt);
  }
  const name = value.split(/[\\/]/).pop();
  // A saved selection can be restored before populateSoundPresets() has run, so
  // label it here too — otherwise the restored option renders blank.
  opt.textContent = isPresetSound(value) ? presetLabel(name) : 'CUSTOM: ' + (displayName || name);
  select.value = value;
}

// Fills every dropdown from the bundled sounds in public/sounds/. Safe to run
// before or after settings load — existing selections are preserved.
async function populateSoundPresets() {
  let presets = [];
  try {
    const res = await fetch('/api/sounds');
    presets = (await res.json()).presets || [];
  } catch {
    return; // dropdowns still offer the default beep
  }
  document.querySelectorAll('.sound-preset').forEach(select => {
    const current = select.value;
    presets.forEach(name => {
      const value = '/sounds/' + name;
      if (Array.from(select.options).some(o => o.value === value)) return;
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = presetLabel(name);
      select.appendChild(opt);
    });
    select.value = current;
  });
}

async function loadSoundFile(type, file) {
  if (!file) return null;
  try {
    const url = isPresetSound(file) ? file : '/api/sound?path=' + encodeURIComponent(file);
    const res = await fetch(url);
    if (!res.ok) return null;
    const arrayBuf = await res.arrayBuffer();
    const ctx = await getAlertAudio();
    if (!ctx) return null;
    const audioBuf = await ctx.decodeAudioData(arrayBuf);
    State.soundCache[type] = audioBuf;
    return audioBuf;
  } catch {
    return null;
  }
}

async function playAlertSound(type) {
  const s = State.settings;
  if (s.alertSound === false) return;
  if (s.alertSounds && s.alertSounds[type] && s.alertSounds[type].enabled === false) return;

  const ctx = await getAlertAudio();
  if (!ctx) return;

  // Debounce per-type: don't play same alert twice within 2s
  const wallNow = Date.now();
  if (State.lastAlertSound[type] && wallNow - State.lastAlertSound[type] < 2000) return;
  State.lastAlertSound[type] = wallNow;

  const master = ctx.createGain();
  master.gain.value = 0.15;
  master.connect(ctx.destination);

  // Check if we have a loaded AudioBuffer for this type
  const buf = State.soundCache[type];
  if (buf) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(master);
    src.start(0);
    return;
  }

  // Fallback: synthesized tone
  const toneCfg = ALERT_TONES[type] || ALERT_TONES.cpu;
  const t0 = ctx.currentTime;
  toneCfg.freqs.forEach((freq, i) => {
    const toneAt = t0 + i * 0.16;
    const osc = ctx.createOscillator();
    osc.type = toneCfg.type;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, toneAt);
    g.gain.exponentialRampToValueAtTime(0.4, toneAt + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, toneAt + 0.13);
    osc.connect(g);
    g.connect(master);
    osc.start(toneAt);
    osc.stop(toneAt + 0.15);
  });
}

// Backward compat
function playAlertBeep() { playAlertSound('cpu').catch(() => {}); }

// ── LOG WATCH ────────────────────────────────────────────
// Scans each polled log tail for watch-list substrings and raises the same
// alert channels the metric thresholds use (sound + audit log + desktop
// notification). No new transport — it rides the existing logs poll.

// Pure so scripts/log-watch-check.js can eval it out of this file.
// `anchor` is the last non-empty line of the previous scan, or null on the
// first poll (which is skipped so a backlog of old errors doesn't alert).
// ponytail: anchor is matched by content, so a log with repeated identical
// lines can resync to the wrong one and skip a few. Switch to journalctl
// --cursor / a server-side tail if that matters.
function matchLogWatch(text, anchor, patterns) {
  const lines = String(text || '').split('\n');
  const nextAnchor = lines.slice().reverse().find(l => l.trim()) || anchor || null;
  let start = 0;
  if (anchor === null || anchor === undefined) {
    start = lines.length;               // first poll: establish the anchor only
  } else {
    const i = lines.lastIndexOf(anchor);
    if (i >= 0) start = i + 1;          // i < 0 => rotated/scrolled past, scan all
  }
  for (const line of lines.slice(start)) {
    if (!line.trim()) continue;
    const hit = (patterns || []).find(p => p && line.toLowerCase().includes(String(p).toLowerCase()));
    if (hit) return { hit, line: line.trim(), anchor: nextAnchor };
  }
  return { hit: null, line: null, anchor: nextAnchor };
}

let logWatchAnchor = null;

function resetLogWatch() { logWatchAnchor = null; }

function scanLogs(text) {
  const s = State.settings;
  if (!s.alertEnabled) return;
  const patterns = s.logWatch || [];
  if (!patterns.length) { logWatchAnchor = null; return; }

  const { hit, line, anchor } = matchLogWatch(text, logWatchAnchor, patterns);
  logWatchAnchor = anchor;
  if (!hit) return;

  // One alert per poll cycle, not one per matching line.
  playAlertSound('logWatch').catch(() => {});
  const file = $('#log-selector').value;
  if (!document.hasFocus() && window.Notification && Notification.permission === 'granted') {
    new Notification(`LOG ALERT // ${file}`, { body: line.slice(0, 200) });
  }
  fetch(`${API}/api/audit-log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'ALERT',
      message: `Log match "${hit}" in ${file}: ${line.slice(0, 200)} [${State.activeSession}]`,
    }),
  }).catch(() => {});
}

// ── ALERT THRESHOLDS ─────────────────────────────────────
function checkAlerts(data) {
  const s = State.settings;
  if (!s.alertEnabled) return;

  const check = (value, threshold, key, label) => {
    if (!value) return;
    const pct = key === 'cpu' ? parseFloat(value) : parseFloat(value.split('|')[2]);
    const thresh = threshold || 90;
    if (isNaN(pct)) return;

    const el = document.getElementById(key === 'cpu' ? 'stat-cpu' : key === 'mem' ? 'stat-mem' : 'stat-disk');
    const statBlock = el?.closest('.stat-block');
    if (pct > thresh) {
      if (!State.alerts[key]) {
        State.alerts[key] = true;
        if (statBlock) statBlock.classList.add('alert-flash');
        playAlertSound(key).catch(() => {});
        fetch(`${API}/api/audit-log`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'ALERT', message: `${label}: ${pct.toFixed(1)}% (threshold: ${thresh}%) [${State.activeSession}]` }),
        }).catch(() => {});
      }
    } else {
      if (State.alerts[key]) {
        State.alerts[key] = false;
        if (statBlock) statBlock.classList.remove('alert-flash');
      }
    }
  };

  check(data.cpu, s.alertCpu, 'cpu', 'CPU');
  check(data.memory, s.alertMem, 'mem', 'Memory');
  check(data.disk, s.alertDisk, 'disk', 'Disk');

  // Network throughput alert — fires if total throughput exceeds threshold in Mbps
  if (data._netRxDelta != null && data._netTxDelta != null) {
    const totalMbps = ((data._netRxDelta + data._netTxDelta) * 8) / 1_000_000;
    const netThresh = s.alertNetMbps || 800;
    const netBlock = $('#stat-net')?.closest('.stat-block');
    if (totalMbps > netThresh) {
      if (!State.alerts.network) {
        State.alerts.network = true;
        if (netBlock) netBlock.classList.add('alert-flash');
        playAlertSound('network').catch(() => {});
      }
    } else {
      if (State.alerts.network) {
        State.alerts.network = false;
        if (netBlock) netBlock.classList.remove('alert-flash');
      }
    }
  }
}

// ── RESOURCE HISTORY CHARTS ──────────────────────────────
function pushHistory(data) {
  const push = (arr, val, max) => { arr.push(val); if (arr.length > max) arr.shift(); };
  if (data.cpu != null && data.cpu !== '') push(State.history.cpu, parseFloat(data.cpu) || 0, State.maxHistory);
  if (data.memory != null && data.memory !== '') {
    const parts = data.memory.split('|');
    push(State.history.mem, parseFloat(parts[2]) || 0, State.maxHistory);
  }
  if (data.disk != null && data.disk !== '') {
    const parts = data.disk.split('|');
    push(State.history.disk, parseInt(parts[2]) || 0, State.maxHistory);
  }
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return 'rgba(255,176,32,' + alpha + ')';
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function drawCharts() {
  const green = cssVar('--green') || '#4AF626';
  drawSparkline(dom.chartCpu, State.history.cpu, { color: green, warn: 60, danger: 80 });
  drawSparkline(dom.chartMem, State.history.mem, { color: green, warn: 60, danger: 80 });
  drawSparkline(dom.chartDisk, State.history.disk, { color: green, warn: 70, danger: 85 });
}

function drawSparkline(canvas, data, opts) {
  if (!canvas || !data.length) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width * dpr;
  const h = rect.height * dpr;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  const pad = 2 * dpr;
  const plotW = w - pad * 2;
  const plotH = h - pad * 2;
  const stepX = data.length > 1 ? plotW / (data.length - 1) : plotW;
  const maxVal = Math.max(...data, 100);

  // Draw filled area
  ctx.beginPath();
  ctx.moveTo(pad, h - pad);
  data.forEach((v, i) => {
    const x = pad + i * stepX;
    const y = pad + plotH - (v / maxVal) * plotH;
    ctx.lineTo(x, y);
  });
  ctx.lineTo(pad + (data.length - 1) * stepX, h - pad);
  ctx.closePath();

  const grad = ctx.createLinearGradient(0, pad, 0, h - pad);
  grad.addColorStop(0, opts.color + '60');
  grad.addColorStop(1, opts.color + '08');
  ctx.fillStyle = grad;
  ctx.fill();

  // Draw line
  ctx.beginPath();
  data.forEach((v, i) => {
    const x = pad + i * stepX;
    const y = pad + plotH - (v / maxVal) * plotH;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = opts.color;
  ctx.lineWidth = 1.5 * dpr;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Danger zone shading
  if (opts.warn) {
    const warnY = pad + plotH - (opts.warn / maxVal) * plotH;
    ctx.fillStyle = hexToRgba(cssVar('--amber') || '#FFB020', 0.06);
    ctx.fillRect(pad, pad, plotW, warnY - pad);
  }
  if (opts.danger) {
    const dangerY = pad + plotH - (opts.danger / maxVal) * plotH;
    ctx.fillStyle = 'rgba(230,25,25,0.08)';
    ctx.fillRect(pad, pad, plotW, dangerY - pad);
  }
}


function drawDualSparkline(canvas, dataA, dataB, opts) {
  if (!canvas) return;
  const hasA = dataA && dataA.length > 1;
  const hasB = dataB && dataB.length > 1;
  if (!hasA && !hasB) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width * dpr;
  const h = rect.height * dpr;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  const pad = 2 * dpr;
  const plotW = w - pad * 2;
  const plotH = h - pad * 2;

  // Find global max across both datasets (capped at 1 so chart shows something)
  let maxVal = 1;
  if (hasA) maxVal = Math.max(maxVal, ...dataA);
  if (hasB) maxVal = Math.max(maxVal, ...dataB);
  if (maxVal <= 0) maxVal = 1;

  const drawLine = (data, color, lineWidth) => {
    if (!data || data.length < 2) return;
    ctx.beginPath();
    const stepX = data.length > 1 ? plotW / (data.length - 1) : plotW;
    data.forEach((v, i) => {
      const x = pad + i * stepX;
      const y = pad + plotH - (v / maxVal) * plotH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth * dpr;
    ctx.lineJoin = 'round';
    ctx.stroke();
  };

  drawLine(dataA, opts.colorA, 1.2);
  drawLine(dataB, opts.colorB, 1.2);
}

function formatBitrate(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0 || isNaN(bytesPerSec)) return '0 B/s';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytesPerSec) / Math.log(1024));
  const v = bytesPerSec / Math.pow(1024, Math.min(i, units.length - 1));
  return v.toFixed(v < 10 ? 1 : 0) + ' ' + units[Math.min(i, units.length - 1)];
}

// ── SERVICES ─────────────────────────────────────────────
async function refreshServices(sessionId) {
  try {
    const res = await fetch(`${API}/api/services?sessionId=${sessionId}`);
    const data = await res.json();
    if (!data.services) return;
    const lines = data.services.split('\n').filter(Boolean);
    let activeCount = 0;
    dom.servicesList.innerHTML = '';

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const name = parts[0] || '';
      const activeState = parts[2] || '';
      const isActive = activeState === 'active';
      if (isActive) activeCount++;

      const div = document.createElement('div');
      div.className = 'service-item';
      div.innerHTML = `
        <span class="service-name">${name.replace('.service', '')}</span>
        <span class="service-state ${isActive ? 'active' : activeState === 'failed' ? 'failed' : 'inactive'}">${activeState.toUpperCase()}</span>
        <span class="service-actions">
          <button class="svc-btn" data-svc="${name}" data-action="${isActive ? 'stop' : 'start'}">${isActive ? 'STOP' : 'START'}</button>
          <button class="svc-btn" data-svc="${name}" data-action="restart">RST</button>
        </span>`;

      div.querySelectorAll('.svc-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          btn.textContent = '...';
          try {
            await fetch(`${API}/api/services/${encodeURIComponent(btn.dataset.svc)}/${btn.dataset.action}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId: State.activeSession }),
            });
          } catch {}
          setTimeout(() => refreshServices(State.activeSession), 1000);
        });
      });
      dom.servicesList.appendChild(div);
    }
    dom.svcCount.textContent = `ACTIVE: ${activeCount}`;
  } catch {
    dom.servicesList.innerHTML = '<div class="empty-state">&gt;&gt; SERVICE MANIFEST UNAVAILABLE</div>';
  }
}

$('#svc-refresh').addEventListener('click', () => {
  if (State.activeSession) refreshServices(State.activeSession);
});

// ── ARIA TABS ─────────────────────────────────────────────
// Shared tablist behavior for the three panel tab groups and the
// auth toggle: roving tabindex, aria-selected sync, arrow-key +
// Home/End navigation. onActivate(tab, tabName) switches content.
function initTabGroup(scopeSel, onActivate) {
  const tablist = document.querySelector(scopeSel);
  if (!tablist) return;
  const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
  if (!tabs.length) return;

  const activate = (tab, focus = false) => {
    tabs.forEach((t) => {
      const active = t === tab;
      t.classList.toggle('tab-active', active);
      t.setAttribute('aria-selected', String(active));
      t.tabIndex = active ? 0 : -1;
    });
    if (focus) tab.focus();
    onActivate(tab, tab.dataset.tab);
  };

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', (e) => {
      const dir = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 }[e.key];
      if (dir !== undefined) {
        e.preventDefault();
        activate(tabs[(i + dir + tabs.length) % tabs.length], true);
      } else if (e.key === 'Home') {
        e.preventDefault();
        activate(tabs[0], true);
      } else if (e.key === 'End') {
        e.preventDefault();
        activate(tabs[tabs.length - 1], true);
      }
    });
  });
}

// ── PROCESS MANAGER ──────────────────────────────────────
function initProcessManager() {
  initTabGroup('.panel-services .panel-tabs', (tab, tabName) => {
    document.querySelectorAll('#tab-services, #tab-processes, #tab-ufw, #tab-docker').forEach(c => c.style.display = 'none');
    $(`#tab-${tabName}`).style.display = 'block';

    const isProc = tabName === 'processes';
    dom.svcCount.style.display = isProc ? 'none' : 'inline';
    dom.ufwCount.style.display = (tabName === 'ufw') ? 'inline' : 'none';
    dom.ufwRefresh.style.display = (tabName === 'ufw') ? 'inline-block' : 'none';
    if (isProc) refreshProcesses();
    if (tabName === 'ufw') refreshUfw();
    if (tabName === 'docker') refreshDocker();
  });

  dom.procRefresh.addEventListener('click', () => refreshProcesses());
  dom.ufwRefresh.addEventListener('click', () => refreshUfw());
  dom.ufwToggleBtn.addEventListener('click', toggleUfw);
  dom.ufwAddBtn.addEventListener('click', () => { dom.ufwAddForm.style.display = 'flex'; dom.ufwRuleInput.focus(); });
  dom.ufwRuleSubmit.addEventListener('click', addUfwRule);
  dom.ufwRuleCancel.addEventListener('click', () => { dom.ufwAddForm.style.display = 'none'; });
  dom.ufwRuleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addUfwRule(); });
  dom.dockerRefresh.addEventListener('click', () => refreshDocker());
  dom.procSearch.addEventListener('input', () => {
    State.processFilter = dom.procSearch.value.toLowerCase();
    renderProcessTable();
  });

  // Sortable columns
  dom.procTable.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const sort = th.dataset.sort;
      if (State.processSort === sort) {
        State.processOrder = State.processOrder === 'asc' ? 'desc' : 'asc';
      } else {
        State.processSort = sort;
        State.processOrder = sort === 'pid' ? 'asc' : 'desc';
      }
      dom.procTable.querySelectorAll('th.sortable').forEach(t => {
        t.classList.remove('active', 'asc', 'desc');
      });
      th.classList.add('active', State.processOrder);
      renderProcessTable();
    });
  });
}

async function refreshProcesses() {
  if (!State.activeSession) return;
  try {
    const res = await fetch(`${API}/api/processes?sessionId=${State.activeSession}&sort=${State.processSort}&order=${State.processOrder}`);
    const data = await res.json();
    State.processData = data.processes || [];
    dom.procCount.textContent = `PROCS: ${State.processData.length}`;
    renderProcessTable();
  } catch {
    dom.procTbody.innerHTML = '<tr><td colspan="6" class="empty-state">&gt;&gt; PROCESS TABLE UNAVAILABLE</td></tr>';
  }
}

function renderProcessTable() {
  let procs = State.processData;
  if (State.processFilter) {
    procs = procs.filter(p =>
      p.command?.toLowerCase().includes(State.processFilter) ||
      p.user?.toLowerCase().includes(State.processFilter) ||
      String(p.pid).includes(State.processFilter)
    );
  }

  if (!procs.length) {
    dom.procTbody.innerHTML = '<tr><td colspan="6" class="empty-state">&gt;&gt; NO MATCHING PROCESSES</td></tr>';
    return;
  }

  dom.procTbody.innerHTML = procs.map(p => {
    const cpuClass = p.cpu > 50 ? ' high' : '';
    const memClass = p.mem > 30 ? ' high' : '';
    const cmd = escapeHtml(p.command || '').substring(0, 80);
    return `<tr>
      <td>${p.pid}</td>
      <td>${escapeHtml(p.user || '')}</td>
      <td class="proc-cpu${cpuClass}">${p.cpu?.toFixed(1) || '0.0'}%</td>
      <td class="proc-mem${memClass}">${p.mem?.toFixed(1) || '0.0'}%</td>
      <td class="proc-command" title="${escapeHtml(p.command || '')}">${cmd}${(p.command || '').length > 80 ? '...' : ''}</td>
      <td class="proc-actions">
        <button class="proc-btn kill" data-pid="${p.pid}" data-action="kill">KILL</button>
        <button class="proc-btn kill9" data-pid="${p.pid}" data-action="kill9">-9</button>
        <button class="proc-btn nice-up" data-pid="${p.pid}" data-action="nice-up">+5</button>
        <button class="proc-btn nice-down" data-pid="${p.pid}" data-action="nice-down">-5</button>
      </td>
    </tr>`;
  }).join('');

  // Bind action buttons
  dom.procTbody.querySelectorAll('.proc-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const pid = parseInt(btn.dataset.pid);
      const action = btn.dataset.action;
      btn.disabled = true;
      btn.textContent = '...';
      try {
        if (action === 'kill') {
          await fetch(`${API}/api/processes/${pid}/kill`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: State.activeSession, signal: 'TERM' }),
          });
        } else if (action === 'kill9') {
          await fetch(`${API}/api/processes/${pid}/kill`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: State.activeSession, signal: 'KILL' }),
          });
        } else if (action === 'nice-up') {
          await fetch(`${API}/api/processes/${pid}/renice`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: State.activeSession, nice: 5 }),
          });
        } else if (action === 'nice-down') {
          await fetch(`${API}/api/processes/${pid}/renice`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: State.activeSession, nice: -5 }),
          });
        }
        setTimeout(() => refreshProcesses(), 800);
      } catch {
        btn.disabled = false;
        btn.textContent = action === 'kill' ? 'KILL' : action === 'kill9' ? '-9' : action === 'nice-up' ? '+5' : '-5';
      }
    });
  });
}

// ── FILE BROWSER ─────────────────────────────────────────
function initFileBrowser() {
  initTabGroup('.panel-logs .panel-tabs', (tab, tabName) => {
    document.querySelectorAll('#tab-logs, #tab-files').forEach(c => c.style.display = 'none');
    $(`#tab-${tabName}`).style.display = 'block';

    const isFiles = tabName === 'files';
    dom.logActions.style.display = isFiles ? 'none' : 'flex';
    dom.fileActions.style.display = isFiles ? 'flex' : 'none';
    dom.filePathInfo.style.display = isFiles ? 'inline' : 'none';
    if (isFiles) navigateTo(State.filePath);
  });

  dom.fileHome.addEventListener('click', () => navigateTo('/'));
  dom.fileUp.addEventListener('click', () => {
    const parent = State.filePath.split('/').filter(Boolean).slice(0, -1).join('/');
    navigateTo('/' + parent);
  });
  dom.fileRefresh.addEventListener('click', () => navigateTo(State.filePath));

  dom.fileMkdir.addEventListener('click', () => {
    const name = prompt('New directory name:');
    if (!name || !name.trim()) return;
    mkdir(name.trim());
  });

  dom.fileUploadBtn.addEventListener('click', () => dom.fileUploadInput.click());
  dom.fileUploadInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { alert('File too large (max 10MB)'); return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const base64 = ev.target.result.split(',')[1];
      uploadFile(file.name, base64);
    };
    reader.readAsDataURL(file);
  });
}

async function navigateTo(dirPath) {
  if (!State.activeSession) {
    dom.fileTbody.innerHTML = '<tr><td colspan="5" class="empty-state">&gt;&gt; SELECT A SERVER TO BROWSE FILES</td></tr>';
    return;
  }
  State.filePath = dirPath;
  dom.filePathInfo.textContent = dirPath;
  renderBreadcrumb(dirPath);
  dom.fileTbody.innerHTML = '<tr><td colspan="5" class="empty-state">&gt;&gt; LOADING...</td></tr>';

  try {
    const res = await fetch(`${API}/api/sftp/list?sessionId=${State.activeSession}&path=${encodeURIComponent(dirPath)}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    State.fileList = data.files || [];
    renderFileTable();
  } catch (err) {
    dom.fileTbody.innerHTML = `<tr><td colspan="5" class="empty-state">&gt;&gt; ERROR: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderBreadcrumb(dirPath) {
  const segs = dirPath.split('/').filter(Boolean);
  let html = '<span class="file-path-seg" data-path="/">/</span>';
  let accum = '';
  segs.forEach((seg, i) => {
    accum += '/' + seg;
    const isLast = i === segs.length - 1;
    html += `<span class="file-path-seg" data-path="${accum}">${isLast ? '' : '/'}${escapeHtml(seg)}${isLast ? '' : '/'}</span>`;
  });
  dom.filePathBar.innerHTML = html;

  dom.filePathBar.querySelectorAll('.file-path-seg').forEach(seg => {
    seg.addEventListener('click', () => navigateTo(seg.dataset.path));
  });
}

function renderFileTable() {
  if (!State.fileList.length) {
    dom.fileTbody.innerHTML = '<tr><td colspan="5" class="empty-state">&gt;&gt; DIRECTORY EMPTY</td></tr>';
    return;
  }

  dom.fileTbody.innerHTML = State.fileList.map(f => {
    const icon = f.isDirectory ? '▸' : f.isSymlink ? '→' : '·';
    const nameClass = f.isDirectory ? ' dir' : f.isSymlink ? ' symlink' : '';
    const sizeStr = f.isDirectory ? '--' : formatSize(f.size);
    const dateStr = f.mtime ? new Date(f.mtime).toISOString().replace('T', ' ').substring(0, 19) : '--';
    const perms = f.permissions || '----------';
    return `<tr>
      <td><span class="file-name${nameClass}" tabindex="-1" data-path="${State.filePath.replace(/\/$/, '')}/${escapeAttr(f.name)}" data-isdir="${f.isDirectory}"><span class="file-icon">${icon}</span>${escapeHtml(f.name)}</span></td>
      <td class="file-size">${sizeStr}</td>
      <td class="file-perms">${perms}</td>
      <td class="file-date">${dateStr}</td>
      <td class="proc-actions">
        ${f.isFile ? `<button class="file-btn dl" data-action="dl" data-path="${State.filePath.replace(/\/$/, '')}/${escapeAttr(f.name)}">DL</button>` : ''}
        <button class="file-btn edit" data-action="rename" data-path="${State.filePath.replace(/\/$/, '')}/${escapeAttr(f.name)}">RN</button>
        <button class="file-btn edit" data-action="chmod" data-path="${State.filePath.replace(/\/$/, '')}/${escapeAttr(f.name)}">CH</button>
        <button class="file-btn del" data-action="delete" data-path="${State.filePath.replace(/\/$/, '')}/${escapeAttr(f.name)}" data-isdir="${f.isDirectory}">DEL</button>
      </td>
    </tr>`;
  }).join('');

  // Click on directory name → navigate
  dom.fileTbody.querySelectorAll('.file-name.dir').forEach(el => {
    el.addEventListener('click', () => navigateTo(el.dataset.path));
    el.style.cursor = 'pointer';
  });
  dom.fileTbody.querySelectorAll('.file-name.symlink').forEach(el => {
    el.addEventListener('click', () => navigateTo(el.dataset.path));
    el.style.cursor = 'pointer';
  });
  // Double-click file names to open editor (row is the return-focus target)
  dom.fileTbody.querySelectorAll('.file-name:not(.dir):not(.symlink)').forEach(el => {
    el.addEventListener('dblclick', () => openEditor(el.dataset.path, el));
    el.style.cursor = 'pointer';
  });

  // Action buttons
  dom.fileTbody.querySelectorAll('.file-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const fpath = btn.dataset.path;
      const isDir = btn.dataset.isdir === 'true';
      btn.disabled = true;
      btn.textContent = '...';
      try {
        if (action === 'dl') await downloadFile(fpath);
        else if (action === 'rename') await renameFile(fpath);
        else if (action === 'chmod') await chmodFile(fpath);
        else if (action === 'delete') await deleteFile(fpath, isDir);
        btn.disabled = false;
      } catch (err) {
        btn.disabled = false;
        btn.textContent = action === 'dl' ? 'DL' : action === 'rename' ? 'RN' : action === 'chmod' ? 'CH' : 'DEL';
      }
    });
  });
}

async function downloadFile(filePath) {
  const res = await fetch(`${API}/api/sftp/download?sessionId=${State.activeSession}&path=${encodeURIComponent(filePath)}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  const byteChars = atob(data.data);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  const blob = new Blob([bytes]);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = data.name;
  a.click();
}

async function uploadFile(name, base64) {
  try {
    const res = await fetch(`${API}/api/sftp/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: State.activeSession, path: State.filePath, name, data: base64 }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    navigateTo(State.filePath);
  } catch (err) {
    alert('Upload failed: ' + err.message);
  }
}

async function renameFile(oldPath) {
  const oldName = oldPath.split('/').pop();
  const newName = prompt('Rename to:', oldName);
  if (!newName || !newName.trim() || newName === oldName) return;
  const parts = oldPath.split('/');
  parts[parts.length - 1] = newName.trim();
  const newPath = parts.join('/');
  await fetch(`${API}/api/sftp/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: State.activeSession, oldPath, newPath }),
  });
  navigateTo(State.filePath);
}

async function deleteFile(filePath, isDir) {
  if (!confirm(`Delete ${isDir ? 'directory' : 'file'}?\n${filePath}`)) return;
  await fetch(`${API}/api/sftp/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: State.activeSession, path: filePath, isDirectory: isDir }),
  });
  navigateTo(State.filePath);
}

async function chmodFile(filePath) {
  const newMode = prompt('New permissions (octal, e.g. 755):', '644');
  if (!newMode || !/^[0-7]{3,4}$/.test(newMode)) return;
  await fetch(`${API}/api/sftp/chmod`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: State.activeSession, path: filePath, mode: newMode }),
  });
  navigateTo(State.filePath);
}

async function mkdir(name) {
  const fullPath = State.filePath.replace(/\/$/, '') + '/' + name;
  await fetch(`${API}/api/sftp/mkdir`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: State.activeSession, path: fullPath }),
  });
  navigateTo(State.filePath);
}

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

function escapeAttr(str) {
  return (str || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── TEXT FILE EDITOR ─────────────────────────────────────
let editorFilePath = null;

async function openEditor(filePath, triggerEl) {
  if (!State.activeSession) return;
  editorFilePath = filePath;
  dom.editorPath.textContent = filePath;
  dom.editorStatus.textContent = 'LOADING...';
  openModal(dom.editorModal, triggerEl);
  dom.editorTextarea.value = '';
  dom.editorTextarea.disabled = true;

  try {
    const res = await fetch(`${API}/api/sftp/download?sessionId=${State.activeSession}&path=${encodeURIComponent(filePath)}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    // Decode base64 → UTF-8
    const bytes = Uint8Array.from(atob(data.data), c => c.charCodeAt(0));
    dom.editorTextarea.value = new TextDecoder().decode(bytes);
    dom.editorStatus.textContent = `LOADED: ${formatSize(bytes.length)}`;
  } catch (err) {
    dom.editorTextarea.value = `// Error loading file: ${err.message}`;
    dom.editorStatus.textContent = 'ERROR';
  }
  dom.editorTextarea.disabled = false;
  dom.editorTextarea.focus();
  updateEditorCursor();
}

function closeEditor() {
  closeModal(dom.editorModal);
  editorFilePath = null;
  dom.editorTextarea.value = '';
}

async function saveEditorFile() {
  if (!editorFilePath || !State.activeSession) return;
  dom.editorStatus.textContent = 'SAVING...';
  dom.editorSave.disabled = true;
  try {
    const text = dom.editorTextarea.value;
    const encoded = new TextEncoder().encode(text);
    // Chunked conversion to avoid call stack overflow on large files
    let binary = '';
    for (let i = 0; i < encoded.length; i += 8192) {
      binary += String.fromCharCode.apply(null, encoded.subarray(i, Math.min(i + 8192, encoded.length)));
    }
    const base64 = btoa(binary);
    const res = await fetch(`${API}/api/sftp/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: State.activeSession, path: editorFilePath, data: base64 }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    dom.editorStatus.textContent = `SAVED (${formatSize(data.size)})`;
    dom.editorStatus.style.color = 'var(--green)';
    setTimeout(() => { dom.editorStatus.style.color = 'var(--fg-dim)'; dom.editorStatus.textContent = 'READY'; }, 2500);
  } catch (err) {
    dom.editorStatus.textContent = `ERROR: ${err.message}`;
    dom.editorStatus.style.color = 'var(--red)';
  }
  dom.editorSave.disabled = false;
}

function updateEditorCursor() {
  const ta = dom.editorTextarea;
  const text = ta.value.substring(0, ta.selectionStart);
  const lines = text.split('\n');
  const line = lines.length;
  const col = lines[lines.length - 1].length + 1;
  dom.editorInfo.textContent = `Ln ${line}, Col ${col}`;
}

// ── UFW FIREWALL ─────────────────────────────────────────
async function refreshUfw() {
  if (!State.activeSession) return;
  try {
    const res = await fetch(`${API}/api/ufw/status?sessionId=${State.activeSession}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    dom.ufwStatus.textContent = data.active ? 'ACTIVE' : 'INACTIVE';
    dom.ufwStatus.className = 'ufw-status ' + (data.active ? 'active' : 'inactive');
    dom.ufwPolicy.textContent = data.defaultPolicy || '';
    dom.ufwToggleBtn.textContent = data.active ? 'DISABLE' : 'ENABLE';
    State.ufwActive = data.active || false;
    dom.ufwCount.textContent = 'RULES: ' + (data.rules ? data.rules.length : 0);

    if (!data.rules || !data.rules.length) {
      dom.ufwTbody.innerHTML = '<tr><td colspan="5" class="empty-state">&gt;&gt; NO RULES DEFINED</td></tr>';
      return;
    }
    dom.ufwTbody.innerHTML = data.rules.map(r => {
      const actionClass = r.action.toLowerCase();
      return '<tr class="ufw-rule-row ' + actionClass + '">' +
        '<td>' + r.number + '</td>' +
        '<td>' + escapeHtml(r.rule) + '</td>' +
        '<td class="ufw-action">' + r.action + '</td>' +
        '<td>' + escapeHtml(r.from) + '</td>' +
        '<td><button class="file-btn del" data-ufw-del="' + r.number + '" aria-label="Delete rule ' + r.number + '">X</button></td>' +
      '</tr>';
    }).join('');

    dom.ufwTbody.querySelectorAll('[data-ufw-del]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const num = parseInt(btn.dataset.ufwDel);
        btn.disabled = true; btn.textContent = '...';
        try {
          await fetch(`${API}/api/ufw/rule/${num}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: State.activeSession }),
          });
          refreshUfw();
        } catch { btn.disabled = false; btn.textContent = 'X'; }
      });
    });
  } catch {
    dom.ufwTbody.innerHTML = '<tr><td colspan="5" class="empty-state">&gt;&gt; FIREWALL UNAVAILABLE</td></tr>';
  }
}

async function toggleUfw() {
  const isActive = State.ufwActive || false;
  const endpoint = isActive ? '/api/ufw/disable' : '/api/ufw/enable';
  dom.ufwToggleBtn.disabled = true;
  dom.ufwToggleBtn.textContent = '...';
  try {
    await fetch(`${API}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: State.activeSession }),
    });
    setTimeout(() => refreshUfw(), 1000);
  } catch { dom.ufwToggleBtn.disabled = false; }
}

async function addUfwRule() {
  const rule = dom.ufwRuleInput.value.trim();
  const action = dom.ufwRuleAction.value;
  if (!rule) return;
  dom.ufwRuleSubmit.disabled = true;
  dom.ufwRuleSubmit.textContent = '...';
  try {
    await fetch(`${API}/api/ufw/rule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: State.activeSession, rule, action }),
    });
    dom.ufwRuleInput.value = '';
    dom.ufwAddForm.style.display = 'none';
    refreshUfw();
  } catch { dom.ufwRuleSubmit.disabled = false; dom.ufwRuleSubmit.textContent = 'ADD'; }
}


// ── DOCKER MANAGEMENT ─────────────────────────────────────
async function refreshDocker() {
  if (!State.activeSession) return;
  try {
    const res = await fetch();
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const containers = data.containers || [];
    dom.dockerCount.textContent = 'CONTAINERS: ' + containers.length;
    if (!containers.length) {
      dom.dockerTbody.innerHTML = '<tr><td colspan="5" class="empty-state">&gt;&gt; NO CONTAINERS FOUND</td></tr>';
      return;
    }
    dom.dockerTbody.innerHTML = containers.map(c => {
      const stateClass = c.status.toLowerCase().includes('up') ? 'running' : c.status.toLowerCase().includes('pause') ? 'paused' : 'exited';
      return '<tr>' +
        '<td>' + escapeHtml(c.name) + '</td>' +
        '<td style="font-size:9px;color:var(--fg-dim);">' + escapeHtml(c.image) + '</td>' +
        '<td><span class="docker-status ' + stateClass + '">' + escapeHtml(c.status) + '</span></td>' +
        '<td style="font-size:9px;color:var(--fg-dim);">' + escapeHtml(c.ports || '--') + '</td>' +
        '<td class="proc-actions">' +
          '<button class="proc-btn nice-up" data-docker-start="' + escapeAttr(c.name) + '">START</button>' +
          '<button class="proc-btn kill" data-docker-stop="' + escapeAttr(c.name) + '">STOP</button>' +
          '<button class="proc-btn nice-down" data-docker-restart="' + escapeAttr(c.name) + '">RST</button>' +
          '<button class="proc-btn" data-docker-logs="' + escapeAttr(c.name) + '">LOG</button>' +
        '</td>' +
      '</tr>';
    }).join('');

    // Docker action buttons
    dom.dockerTbody.querySelectorAll('[data-docker-start]').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); dockerAction(btn.dataset.dockerStart, 'start'); });
    });
    dom.dockerTbody.querySelectorAll('[data-docker-stop]').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); dockerAction(btn.dataset.dockerStop, 'stop'); });
    });
    dom.dockerTbody.querySelectorAll('[data-docker-restart]').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); dockerAction(btn.dataset.dockerRestart, 'restart'); });
    });
    dom.dockerTbody.querySelectorAll('[data-docker-logs]').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); showDockerLogs(btn.dataset.dockerLogs, btn.closest('tr')); });
    });
  } catch {
    dom.dockerTbody.innerHTML = '<tr><td colspan="5" class="empty-state">&gt;&gt; DOCKER UNAVAILABLE</td></tr>';
  }
}

async function dockerAction(name, action) {
  try {
    await fetch(API + '/api/docker/' + encodeURIComponent(name) + '/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: State.activeSession }),
    });
    setTimeout(() => refreshDocker(), 1000);
  } catch {}
}

async function showDockerLogs(name, row) {
  if (!row) return;
  const existing = row.querySelector('.docker-log-viewer');
  if (existing) { existing.remove(); return; }
  const logDiv = document.createElement('div');
  logDiv.className = 'docker-log-viewer';
  logDiv.textContent = 'Loading...';
  row.after(logDiv);
  try {
    const res = await fetch(API + '/api/docker/' + encodeURIComponent(name) + '/logs?sessionId=' + State.activeSession + '&lines=50');
    const data = await res.json();
    logDiv.textContent = data.logs || '(empty)';
  } catch {
    logDiv.textContent = 'Error loading logs';
  }
}

// ── BULK COMMAND EXECUTION ───────────────────────────────
function openBulkExec() {
  const sessions = Object.values(State.sessions);
  dom.bulkServerCount.textContent = sessions.length + ' SERVERS';
  dom.bulkStatus.textContent = 'READY';
  dom.bulkStatus.style.color = 'var(--fg-dim)';
  dom.bulkOutput.innerHTML = '<div class="empty-state">&gt;&gt; ENTER A COMMAND AND CLICK RUN</div>';
  openModal(dom.bulkModal, dom.btnBulk);
  dom.bulkCommand.focus();
}

async function executeBulkCommand() {
  const command = dom.bulkCommand.value.trim();
  if (!command) return;
  const sessions = Object.values(State.sessions);
  if (!sessions.length) return;

  dom.bulkExecute.disabled = true;
  dom.bulkExecute.textContent = '...';
  dom.bulkStatus.textContent = 'EXECUTING...';
  dom.bulkStatus.style.color = 'var(--fg-mid)';
  dom.bulkOutput.innerHTML = '<div class="empty-state">&gt;&gt; RUNNING: ' + escapeHtml(command.substring(0, 50)) + '...</div>';

  try {
    const res = await fetch(API + '/api/bulk-exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const results = data.results || [];
    if (!results.length) {
      dom.bulkOutput.innerHTML = '<div class="empty-state">&gt;&gt; NO RESULTS</div>';
    } else {
      dom.bulkOutput.innerHTML = results.map(r => {
        const labelClass = r.success ? 'success' : '';
        const codeInfo = r.code !== undefined ? ' [exit ' + r.code + ']' : '';
        return '<div class="bulk-server-result">' +
          '<div class="bulk-server-label ' + labelClass + '">[ ' + escapeHtml(r.label) + ' ]' + codeInfo + '</div>' +
          '<div class="bulk-server-output">' + escapeHtml(r.output || '') + '</div>' +
        '</div>';
      }).join('');
    }
    dom.bulkStatus.textContent = 'DONE (' + results.length + ' servers)';
    dom.bulkStatus.style.color = 'var(--green)';
  } catch (err) {
    dom.bulkOutput.innerHTML = '<div class="empty-state" style="color:var(--red);">&gt;&gt; ERROR: ' + escapeHtml(err.message) + '</div>';
    dom.bulkStatus.textContent = 'ERROR';
    dom.bulkStatus.style.color = 'var(--red)';
  }
  dom.bulkExecute.disabled = false;
  dom.bulkExecute.innerHTML = '<span class="btn-icon"><svg class="icon" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M3 1.8v8.4L10.2 6z"/></svg></span> RUN';
}

// ── LOGS ─────────────────────────────────────────────────
async function refreshLogs(sessionId) {
  try {
    const file = $('#log-selector').value;
    const res = await fetch(`${API}/api/logs?sessionId=${sessionId}&file=${encodeURIComponent(file)}&lines=${State.settings.logLines || 200}`);
    const data = await res.json();
    dom.logContainer.textContent = data.logs || 'NO DATA';
    dom.logContainer.scrollTop = dom.logContainer.scrollHeight;
    scanLogs(data.logs || '');
  } catch {
    dom.logContainer.textContent = 'ERROR READING LOGS';
  }
}

$('#log-selector').addEventListener('change', () => {
  resetLogWatch();  // different file: the old anchor line means nothing here
  if (State.activeSession) refreshLogs(State.activeSession);
});
$('#log-refresh').addEventListener('click', () => {
  if (State.activeSession) refreshLogs(State.activeSession);
});
$('#log-export').addEventListener('click', () => {
  const blob = new Blob([dom.logContainer.textContent], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `vps-log-${Date.now()}.txt`;
  a.click();
});

// ── TERMINAL ─────────────────────────────────────────────
function initTerminal(sessionId) {
  // Clear old terminal container
  const container = $('#terminal-container');
  container.innerHTML = '';

  const fitAddon = new FitAddon.FitAddon();
  State.term = new Terminal({
    cursorBlink: true,
    cursorStyle: 'block',
    fontSize: State.settings.terminalFontSize || 13,
    fontFamily: "'JetBrains Mono', 'Courier New', monospace",
    theme: getTermTheme(State.settings.theme),
    scrollback: State.settings.terminalScrollback || 5000,
  });

  State.term.loadAddon(fitAddon);
  State.term.open(container);

  let resizeTimer = null;
  const observer = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { try { fitAddon.fit(); } catch {} }, 100);
  });
  observer.observe(container);
  setTimeout(() => { try { fitAddon.fit(); } catch {} State.term.focus(); }, 200);

  // xterm only claims clicks that land on its own screen. The container padding
  // and the dead band below the last row belong to us, and they are a wide
  // target — clicking there used to leave focus wherever it was, so the terminal
  // rendered fine and silently ignored the keyboard.
  // preventDefault matters as much as the focus() call: mousedown on a
  // non-focusable element blurs whatever had focus as its default action, so
  // focusing first and letting the default run just blurs it again a tick later.
  container.addEventListener('mousedown', (e) => {
    if (!State.term || e.target.closest('.xterm-screen')) return;
    e.preventDefault();
    State.term.focus();
  });

  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  State.termSocket = new WebSocket(`${wsProto}//${location.host}`);

  State.termSocket.onopen = () => {
    State.termSocket.send(JSON.stringify({ type: 'terminal:init', sessionId }));
  };

  State.termSocket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'terminal:data') State.term.write(msg.data);
    if (msg.type === 'terminal:closed') State.term.write('\r\n\x1b[31m[ CONNECTION CLOSED ]\x1b[0m\r\n');
  };

  State.termSocket.onclose = () => {
    State.term.write('\r\n\x1b[31m[ WEBSOCKET DISCONNECTED ]\x1b[0m\r\n');
  };

  State.term.onData((data) => {
    if (State.termSocket && State.termSocket.readyState === WebSocket.OPEN) {
      State.termSocket.send(JSON.stringify({ type: 'terminal:input', data }));
    }
  });

  State.term.onResize(({ cols, rows }) => {
    if (State.termSocket && State.termSocket.readyState === WebSocket.OPEN) {
      State.termSocket.send(JSON.stringify({ type: 'terminal:resize', cols, rows }));
    }
  });

}

// Bound once, not per initTerminal — switching sessions re-inits the terminal and
// would otherwise stack a new listener on the same button every time.
$('#term-clear').addEventListener('click', () => {
  if (State.term) { State.term.clear(); State.term.focus(); }
});

// ── AUDIT LOG ────────────────────────────────────────────
function initAuditLog() {
  // Tab switching - scoped to sysinfo panel only
  initTabGroup('.panel-sysinfo .panel-tabs', (tab, tabName) => {
    document.querySelectorAll('#tab-sysinfo, #tab-audit, #tab-applog').forEach(c => c.style.display = 'none');
    $(`#tab-${tabName}`).style.display = 'block';
    // Show/hide audit controls
    const isAudit = tabName === 'audit';
    const isApplog = tabName === 'applog';
    dom.auditCount.style.display = isAudit ? 'inline' : 'none';
    dom.auditRefresh.style.display = isAudit ? 'inline-block' : 'none';
    dom.auditClear.style.display = isAudit ? 'inline-block' : 'none';
    dom.applogCount.style.display = isApplog ? 'inline' : 'none';
    dom.applogRefresh.style.display = isApplog ? 'inline-block' : 'none';
    if (isAudit) refreshAuditLog();
    if (isApplog) refreshAppLog();
  });

  dom.auditRefresh.addEventListener('click', refreshAuditLog);
  dom.auditClear.addEventListener('click', async () => {
    await fetch(`${API}/api/audit-log/clear`, { method: 'POST' });
    refreshAuditLog();
  });
  dom.applogRefresh.addEventListener('click', refreshAppLog);

  // Auto-refresh when connected
  setInterval(() => {
    const auditTab = document.querySelector('.panel-tab[data-tab="audit"].tab-active');
    if (auditTab) refreshAuditLog();
    const applogTab = document.querySelector('.panel-tab[data-tab="applog"].tab-active');
    if (applogTab) refreshAppLog();
  }, 15000);
}

async function refreshAuditLog() {
  try {
    const res = await fetch(`${API}/api/audit-log`);
    const data = await res.json();
    const entries = data.entries || [];
    dom.auditCount.textContent = `ENTRIES: ${entries.length}`;
    if (entries.length === 0) {
      dom.auditContainer.innerHTML = '<div class="empty-state">&gt;&gt; NO AUDIT ENTRIES...</div>';
      return;
    }
    dom.auditContainer.innerHTML = [...entries].reverse().map(line => {
      // Parse: [2024-01-01T00:00:00.000Z] TYPE | message
      const match = line.match(/^\[([^\]]+)\]\s+(\w+)\s*\|\s*(.+)$/);
      if (!match) return `<div class="audit-entry"><span class="ae-msg">${escapeHtml(line)}</span></div>`;
      const [, time, type, msg] = match;
      const timeShort = time.split('T')[1]?.split('.')[0] || time;
      const typeClass = type === 'CONNECT' ? 'ae-connect' : type === 'DISCONNECT' ? 'ae-disconnect' :
        type.includes('FAIL') ? 'ae-fail' : type === 'CONFIG' || type === 'PROFILE' || type === 'SESSION' || type === 'SERVICE' ? 'ae-config' : '';
      return `<div class="audit-entry"><span class="ae-time">${timeShort}</span><span class="ae-type ${typeClass}">${type}</span><span class="ae-msg">${escapeHtml(msg)}</span></div>`;
    }).join('');
    dom.auditContainer.scrollTop = dom.auditContainer.scrollHeight;
  } catch {
    dom.auditContainer.innerHTML = '<div class="empty-state">&gt;&gt; AUDIT LOG UNAVAILABLE</div>';
  }
}

async function refreshAppLog() {
  try {
    const res = await fetch(`${API}/api/error-log?lines=200`);
    const data = await res.json();
    const log = data.log || '(empty)';
    if (log === '(no errors logged)' || log === '(empty log)') {
      dom.applogContainer.innerHTML = '<div class="empty-state">&gt;&gt; NO APP ERRORS...</div>';
      dom.applogCount.textContent = 'ERRORS: 0';
      return;
    }
    const lines = log.trim().split('\n').filter(Boolean);
    dom.applogCount.textContent = 'ERRORS: ' + lines.length;
    dom.applogContainer.innerHTML = lines.reverse().map(line => {
      if (line.startsWith('  STACK:')) {
        return `<div class="applog-stack">${escapeHtml(line)}</div>`;
      }
      // Parse: [timestamp] LEVEL [source] message | {...}
      const match = line.match(/^\[([^\]]+)\]\s+(\w+)\s+\[([^\]]+)\]\s+(.+)$/);
      if (!match) return `<div class="audit-entry">${escapeHtml(line)}</div>`;
      const [, time, level, source, rest] = match;
      const timeShort = time.split('T')[1]?.split('.')[0] || time;
      const levelClass = level === 'FATAL' ? 'ae-fail' : level === 'ERROR' ? 'ae-fail' : level === 'WARN' ? 'ae-disconnect' : 'ae-config';
      // Separate message from extra JSON if present
      const extraIdx = rest.lastIndexOf(' | {"');
      const msg = extraIdx > -1 ? rest.substring(0, extraIdx) : rest;
      return `<div class="audit-entry"><span class="ae-time">${timeShort}</span><span class="ae-type ${levelClass}">${level}</span><span class="ae-type" style="color:var(--fg-mid);">[${source}]</span><span class="ae-msg">${escapeHtml(msg)}</span></div>`;
    }).join('');
    dom.applogContainer.scrollTop = dom.applogContainer.scrollHeight;
  } catch {
    dom.applogContainer.innerHTML = '<div class="empty-state">&gt;&gt; APP LOG UNAVAILABLE</div>';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── AUTH TOGGLE ──────────────────────────────────────────
function setAuthMethod(method) {
  State.authMethod = method;
  dom.authPwBtn.classList.toggle('active', method === 'password');
  dom.authKeyBtn.classList.toggle('active', method === 'key');
  dom.authPwBtn.setAttribute('aria-selected', String(method === 'password'));
  dom.authKeyBtn.setAttribute('aria-selected', String(method === 'key'));
  dom.authPwBtn.tabIndex = method === 'password' ? 0 : -1;
  dom.authKeyBtn.tabIndex = method === 'key' ? 0 : -1;
  dom.authPwGroup.style.display = method === 'password' ? 'block' : 'none';
  dom.authKeyGroup.style.display = method === 'key' ? 'block' : 'none';
}

// ── SETTINGS MODAL ───────────────────────────────────────
function bindEvents() {
  initAuditLog();
  initProcessManager();
  initFileBrowser();

  // Unlock vault
  dom.unlockBtn.addEventListener('click', async () => {
    const pw = dom.unlockPass.value;
    dom.unlockError.style.display = 'none';
    dom.unlockBtn.disabled = true;
    dom.unlockBtn.textContent = '...';
    try {
      const res = await fetch(`${API}/api/auth/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      State.vaultLocked = false;
      closeModal(dom.unlockModal);
      dom.unlockPass.value = '';
      await loadSettings();
      await loadProfiles();
      // Land keyboard focus on the connect form (profile picker first)
      if (dom.profileSelect.options.length > 1) dom.profileSelect.focus();
      else dom.connHost.focus();
    } catch (err) {
      dom.unlockError.textContent = err.message || 'INCORRECT PASSWORD';
      dom.unlockError.style.display = 'block';
      dom.unlockBtn.disabled = false;
      dom.unlockBtn.innerHTML = '<span class="btn-icon"><svg class="icon" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="square" aria-hidden="true"><rect x="2" y="5.2" width="8" height="5.3"/><path d="M4 5.2V3.6a2 2 0 0 1 4 0v1.6"/></svg></span> UNLOCK';
    }
  });

  dom.unlockPass.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') dom.unlockBtn.click();
  });

  // Auth method toggle (role=tablist with arrow-key nav + roving tabindex)
  initTabGroup('.auth-toggle', (tab, tabName) => {
    setAuthMethod(tabName === 'key' ? 'key' : 'password');
  });

  // Key file upload
  dom.keyLoadFile.addEventListener('click', () => dom.keyFileInput.click());
  dom.keyFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    dom.keyStatus.textContent = '[ LOADING... ]';
    dom.keyStatus.className = 'key-status';
    const reader = new FileReader();
    reader.onload = (ev) => {
      dom.connKey.value = ev.target.result;
      dom.keyStatus.textContent = `[ LOADED: ${file.name} ]`;
      dom.keyStatus.className = 'key-status loaded';
    };
    reader.onerror = () => {
      dom.keyStatus.textContent = '[ ERROR READING FILE ]';
      dom.keyStatus.className = 'key-status';
    };
    reader.readAsText(file);
  });

  $('#btn-settings').addEventListener('click', () => {
    openModal(dom.settingsModal, $('#btn-settings'));
    applySettings();
  });

  $('#btn-bulk').addEventListener('click', openBulkExec);

  $('#settings-close').addEventListener('click', () => {
    closeModal(dom.settingsModal);
  });

  $('#settings-save').addEventListener('click', saveSettingsAndClose);

  // Live theme preview while the settings modal is open
  $('#setting-theme').addEventListener('change', (e) => applyTheme(e.target.value));

  // Alert sound test button (user gesture unlocks the AudioContext)
  $('#alert-sound-test').addEventListener('click', () => {
    State.settings.alertSound = $('#setting-alert-sound').checked;
    playAlertSound('cpu');
  });

  // Per-type sound file pickers
  document.querySelectorAll('.sound-load').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type;
      const input = document.querySelector('.sound-file-input[data-type="' + type + '"]');
      if (input) input.click();
    });
  });

  populateSoundPresets();

  // Picking a bundled preset — decode it now so ▶ plays it without a round trip
  document.querySelectorAll('.sound-preset').forEach(select => {
    select.addEventListener('change', async () => {
      const type = select.dataset.type;
      const value = select.value;
      setSoundValue(type, value);
      delete State.soundCache[type];
      if (value && !(await loadSoundFile(type, value))) {
        setSoundValue(type, '');
        select.setAttribute('aria-invalid', 'true');
        return;
      }
      select.removeAttribute('aria-invalid');
    });
  });

  document.querySelectorAll('.sound-file-input').forEach(input => {
    input.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      const type = input.dataset.type;
      if (!file) return;
      const bytes = await file.arrayBuffer();
      // decodeAudioData detaches the buffer it's given — decode a copy so the
      // original bytes survive for the upload below.
      try {
        const ctx = await getAlertAudio();
        if (ctx) State.soundCache[type] = await ctx.decodeAudioData(bytes.slice(0));
      } catch {
        setSoundValue(type, '');
        delete State.soundCache[type];
        return;
      }
      // Electron hides the picked file's real path, so hand the bytes to the
      // server and persist the copy it keeps.
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      try {
        const res = await fetch(`/api/sound/${type}?ext=${encodeURIComponent(ext)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: bytes,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        setSoundValue(type, data.path, file.name);
      } catch {
        // Decoded but not persisted — usable now, gone on restart.
        setSoundValue(type, '');
      }
      input.value = '';
    });
  });

  document.querySelectorAll('.sound-clear').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type;
      setSoundValue(type, '');
      delete State.soundCache[type];
    });
  });

  document.querySelectorAll('.sound-test').forEach(btn => {
    btn.addEventListener('click', () => {
      State.settings.alertSound = true;
      playAlertSound(btn.dataset.type);
    });
  });

  // Master password settings
  $('#setting-master-set-btn').addEventListener('click', async () => {
    const pw = $('#setting-master-pw').value;
    const pw2 = $('#setting-master-pw2').value;
    const errEl = $('#setting-master-error');
    if (pw.length < 6) { errEl.textContent = 'PASSWORD MUST BE AT LEAST 6 CHARACTERS'; errEl.style.display = 'block'; return; }
    if (pw !== pw2) { errEl.textContent = 'PASSWORDS DO NOT MATCH'; errEl.style.display = 'block'; return; }
    errEl.style.display = 'none';
    try {
      const res = await fetch(`${API}/api/auth/set-master`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      $('#setting-master-pw').value = '';
      $('#setting-master-pw2').value = '';
      $('#setting-master-status').textContent = 'ENABLED';
      $('#setting-master-status').style.color = 'var(--green)';
      $('#setting-master-set-btn').style.display = 'none';
      $('#setting-master-remove-btn').style.display = 'inline-block';
      State.vaultMethod = 'master';
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
    }
  });

  $('#setting-master-remove-btn').addEventListener('click', async () => {
    const pw = prompt('Enter your master password to remove it:');
    if (!pw) return;
    try {
      const res = await fetch(`${API}/api/auth/remove-master`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      $('#setting-master-status').textContent = 'DISABLED (MACHINE KEY)';
      $('#setting-master-status').style.color = 'var(--fg-dim)';
      $('#setting-master-set-btn').style.display = 'inline-block';
      $('#setting-master-remove-btn').style.display = 'none';
      State.vaultMethod = 'machine';
      $('#setting-master-error').style.display = 'none';
    } catch (err) {
      $('#setting-master-error').textContent = err.message;
      $('#setting-master-error').style.display = 'block';
    }
  });

  $('#setting-reset').addEventListener('click', () => {
    $('#setting-theme').value = 'tactical';
    applyTheme('tactical');
    $('#setting-fontsize').value = '13';
    $('#setting-stats').value = '3000';
    $('#setting-services').value = '10000';
    $('#setting-logs').value = '30000';
    $('#setting-loglines').value = '200';
  });

  dom.settingsModal.addEventListener('click', (e) => {
    if (e.target === dom.settingsModal) closeModal(dom.settingsModal);
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Escape-first-close: topmost modal in open order closes first.
      // The unlock gate is a boot screen — never dismissible via Escape.
      const top = modalStack[modalStack.length - 1];
      if (!top || top === dom.unlockModal) return;
      if (top === dom.editorModal) { closeEditor(); return; }
      closeModal(top);
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      if (dom.editorModal.style.display === 'flex') { e.preventDefault(); saveEditorFile(); }
    }
  });

  // Editor bindings
  dom.editorSave.addEventListener('click', saveEditorFile);
  dom.editorClose.addEventListener('click', closeEditor);
  dom.editorTextarea.addEventListener('input', updateEditorCursor);
  dom.editorTextarea.addEventListener('click', updateEditorCursor);
  dom.editorTextarea.addEventListener('keyup', updateEditorCursor);
  dom.editorModal.addEventListener('click', (e) => {
    if (e.target === dom.editorModal) closeEditor();
  });

  // Bulk command bindings (close button + overlay click)
  dom.bulkClose.addEventListener('click', () => closeModal(dom.bulkModal));
  dom.bulkModal.addEventListener('click', (e) => {
    if (e.target === dom.bulkModal) closeModal(dom.bulkModal);
  });

  // Enter on password field
  dom.connPass.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') dom.connectBtn.click();
  });

  // Electron menu events
  if (typeof require !== 'undefined') {
    try {
      const { ipcRenderer } = require('electron');
      ipcRenderer.on('menu:settings', () => {
        openModal(dom.settingsModal);
        applySettings();
      });
      ipcRenderer.on('menu:new-connection', () => {
        if (State.activeSession) disconnectSession(State.activeSession);
        dom.dashboardView.style.display = 'none';
        dom.connectPanel.style.display = 'flex';
        typeInTitle();
      });
    } catch {}
  }
}

// ── FRONTEND ERROR REPORTING ────────────────────────────
window.addEventListener('error', (e) => {
  const msg = e.message || e.error?.message || 'Unknown JS error';
  const stack = e.error?.stack || '';
  const file = e.filename || '';
  const line = e.lineno || 0;
  const col = e.colno || 0;
  fetch(`${API}/api/error-log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: msg,
      stack: stack,
      source: 'FRONTEND',
      extra: { file, line, col },
    }),
  }).catch(() => {});
});

window.addEventListener('unhandledrejection', (e) => {
  fetch(`${API}/api/error-log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: e.reason?.message || String(e.reason),
      stack: e.reason?.stack || '',
      source: 'FRONTEND',
      extra: { type: 'unhandledrejection' },
    }),
  }).catch(() => {});
});

// ── BOOT ──────────────────────────────────────────────────
window.addEventListener('resize', () => drawCharts());
init();
