const fs = require('fs');
let js = fs.readFileSync('public/js/app.js', 'utf8');

// ── 1. Add sound cache to State object
js = js.replace(
  '  prevNetRx: null, prevNetTx: null,',
  '  prevNetRx: null, prevNetTx: null,\n  soundCache: {},       // decoded AudioBuffer cache: { cpu: AudioBuffer, ... }\n  lastAlertSound: {},   // per-type debounce: { cpu: timestamp, ... }'
);

// ── 2. Replace the old playAlertBeep + getAlertAudio + lastAlertBeep sections
// Find and replace from the old playAlertBeep through to the end of the audio code

// First, find the getAlertAudio and lastAlertBeep declarations
const oldAudioState = `let alertCtx = null;
let lastAlertBeep = 0;`;
const newAudioState = `let alertCtx = null;`;

js = js.replace(oldAudioState, newAudioState);

// Replace getAlertAudio
const oldGetAlert = `function getAlertAudio() {
  if (alertCtx) return alertCtx;
  try {
    alertCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (alertCtx.state === 'suspended') alertCtx.resume();
    return alertCtx;
  } catch {
    return null;
  }
}`;
const newGetAlert = `function getAlertAudio() {
  if (alertCtx && alertCtx.state !== 'closed') return alertCtx;
  try {
    alertCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (alertCtx.state === 'suspended') alertCtx.resume();
    return alertCtx;
  } catch {
    return null;
  }
}`;
js = js.replace(oldGetAlert, newGetAlert);

// Replace the old playAlertBeep with new typed sound system
const oldPlayAlert = `function playAlertBeep() {
  if (State.settings.alertSound === false) return;
  const ctx = getAlertAudio();
  if (!ctx) return;
  // Coalesce multi-threshold breaches in the same poll into a single beep.
  // Use wall-clock time (Date.now) — ctx.currentTime freezes while the
  // AudioContext is suspended and starts at 0, which would suppress the first beep.
  const wallNow = Date.now();
  if (wallNow - lastAlertBeep < 1200) return;
  lastAlertBeep = wallNow;

  // Short tactical two-tone: 880 Hz → 1320 Hz square pulse.
  // Tone scheduling runs on the audio timeline (ctx.currentTime, seconds).
  const master = ctx.createGain();
  master.gain.value = 0.12;
  master.connect(ctx.destination);
  const t0 = ctx.currentTime;
  [880, 1320].forEach((freq, i) => {
    const toneAt = t0 + i * 0.16;
    const osc = ctx.createOscillator();
    osc.type = 'square';
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
}`;

const newPlayAlert = `// ── ALERT SOUND SYSTEM ───────────────────────────────────
// Per-type alert sounds with file-backed custom audio and
// synthesized fallback tones.

const ALERT_TONES = {
  cpu:       { freqs: [880, 1320],   type: 'square', label: 'CPU Alert' },
  memory:    { freqs: [660, 990],    type: 'square', label: 'Memory Alert' },
  disk:      { freqs: [440, 660],    type: 'square', label: 'Disk Alert' },
  network:   { freqs: [1100, 1650],  type: 'triangle', label: 'Network Alert' },
  connectOk: { freqs: [523, 659, 784], type: 'sine', label: 'Connect OK' },
  connectFail: { freqs: [200, 150],  type: 'sawtooth', label: 'Connect Fail' },
};

async function loadSoundFile(type, file) {
  if (!file) return null;
  try {
    const res = await fetch('file://' + file);
    const arrayBuf = await res.arrayBuffer();
    const ctx = getAlertAudio();
    if (!ctx) return null;
    const audioBuf = await ctx.decodeAudioData(arrayBuf);
    State.soundCache[type] = audioBuf;
    return audioBuf;
  } catch {
    return null;
  }
}

function playAlertSound(type) {
  const s = State.settings;
  if (s.alertSound === false) return;
  if (s.alertSounds && s.alertSounds[type] && s.alertSounds[type].enabled === false) return;

  const ctx = getAlertAudio();
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
function playAlertBeep() { playAlertSound('cpu'); }`;

js = js.replace(oldPlayAlert, newPlayAlert);

// ── 3. Update checkAlerts to pass alert type
js = js.replace(
  '        playAlertBeep();',
  '        playAlertSound(key);'
);

// ── 4. Update saveSettingsAndClose to save sound file paths
const oldSaveSounds = `    alertEnabled: $('#setting-alert-enabled').checked,
    alertSound: $('#setting-alert-sound').checked,`;
const newSaveSounds = `    alertEnabled: $('#setting-alert-enabled').checked,
    alertSound: $('#setting-alert-sound').checked,
    alertSounds: {
      cpu:       { enabled: true, file: $('#sound-cpu').value || '' },
      memory:    { enabled: true, file: $('#sound-memory').value || '' },
      disk:      { enabled: true, file: $('#sound-disk').value || '' },
      network:   { enabled: true, file: $('#sound-network').value || '' },
      connectOk: { enabled: true, file: $('#sound-connectOk').value || '' },
      connectFail: { enabled: true, file: $('#sound-connectFail').value || '' },
    },`;
js = js.replace(oldSaveSounds, newSaveSounds);

// ── 5. Update applySettings to load sound file paths
js = js.replace(
  "  $('#setting-alert-disk').value = s.alertDisk || 90;",
  "  $('#setting-alert-disk').value = s.alertDisk || 90;\n  // Sound file paths\n  if (s.alertSounds) {\n    const types = ['cpu', 'memory', 'disk', 'network', 'connectOk', 'connectFail'];\n    types.forEach(t => {\n      const el = $('#sound-' + t);\n      if (el) {\n        const path = (s.alertSounds[t] && s.alertSounds[t].file) || '';\n        el.value = path;\n        el.placeholder = path ? path.split(/[\\\\/]/).pop() : '(default beep)';\n        // Preload the file if it exists\n        if (path) loadSoundFile(t, path).catch(() => {});\n      }\n    });\n  }"
);

// ── 6. Add sound file picker event bindings
// Find the sound test button binding and expand it
const oldSoundBind = `  // Alert sound test button (user gesture unlocks the AudioContext)\n  $('#alert-sound-test').addEventListener('click', () => {\n    State.settings.alertSound = $('#setting-alert-sound').checked;\n    playAlertBeep();\n  });`;
const newSoundBind = `  // Alert sound test button (user gesture unlocks the AudioContext)\n  $('#alert-sound-test').addEventListener('click', () => {\n    State.settings.alertSound = $('#setting-alert-sound').checked;\n    playAlertSound('cpu');\n  });\n\n  // Per-type sound file pickers\n  document.querySelectorAll('.sound-load').forEach(btn => {\n    btn.addEventListener('click', () => {\n      const type = btn.dataset.type;\n      const input = document.querySelector('.sound-file-input[data-type=\"' + type + '\"]');\n      if (input) input.click();\n    });\n  });\n\n  document.querySelectorAll('.sound-file-input').forEach(input => {\n    input.addEventListener('change', (e) => {\n      const file = e.target.files[0];\n      const type = input.dataset.type;\n      const pathEl = $('#sound-' + type);\n      if (!file || !pathEl) return;\n      pathEl.value = file.path;\n      pathEl.placeholder = file.name;\n      // Load into cache\n      const reader = new FileReader();\n      reader.onload = async (ev) => {\n        try {\n          const ctx = getAlertAudio();\n          if (!ctx) return;\n          const audioBuf = await ctx.decodeAudioData(ev.target.result);\n          State.soundCache[type] = audioBuf;\n        } catch {}\n      };\n      reader.readAsArrayBuffer(file);\n    });\n  });\n\n  document.querySelectorAll('.sound-clear').forEach(btn => {\n    btn.addEventListener('click', () => {\n      const type = btn.dataset.type;\n      const pathEl = $('#sound-' + type);\n      if (pathEl) { pathEl.value = ''; pathEl.placeholder = '(default beep)'; }\n      delete State.soundCache[type];\n    });\n  });\n\n  document.querySelectorAll('.sound-test').forEach(btn => {\n    btn.addEventListener('click', () => {\n      State.settings.alertSound = true;\n      playAlertSound(btn.dataset.type);\n    });\n  });`;

js = js.replace(oldSoundBind, newSoundBind);

// ── 7. Add connect/disconnect sound triggers
// After successful connect
js = js.replace(
  "    initTerminal(sessionId);\n    startPolling(sessionId);",
  "    playAlertSound('connectOk');\n    initTerminal(sessionId);\n    startPolling(sessionId);"
);

// On connect failure
js = js.replace(
  "    dom.connectBtn.disabled = false;\n  }\n}\n\nasync function disconnectSession",
  "    dom.connectBtn.disabled = false;\n    playAlertSound('connectFail');\n  }\n}\n\nasync function disconnectSession"
);

fs.writeFileSync('public/js/app.js', js);
console.log('OK: Sound system rewritten');
