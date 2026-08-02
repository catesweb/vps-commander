// public/js/layout.js
// Dashboard layout: swap panels, reorder/hide stat blocks, drag the splitters,
// and persist all of it to ~/.vps-commander/settings.json under `layout`.
//
// Loads after app.js and uses its globals (State, API, $, toast). Kept in its own
// file because none of it touches SSH, polling, or rendering — it only moves
// existing DOM around and writes three numbers and two arrays.
//
// ACCESSIBILITY: HTML5 drag-and-drop is pointer-only, so every move has a
// keyboard equivalent — arrow keys on a focused panel grip or stat block, and
// arrow keys on a focused splitter. A drag-only layout editor is not usable.

(function () {
  'use strict';

  const PANEL_KEYS = ['terminal', 'services', 'logs', 'sysinfo'];
  const STAT_KEYS = ['cpu', 'mem', 'disk', 'net', 'uptime', 'load', 'proc'];

  // Splitter definitions: CSS property, settings key, axis, bounds in px.
  const SPLITTERS = {
    'side-w':    { prop: '--side-w',    key: 'sideW',    axis: 'x', min: 220, max: 720, invert: true },
    'sysinfo-w': { prop: '--sysinfo-w', key: 'sysinfoW', axis: 'x', min: 180, max: 640, invert: true },
    'bottom-h':  { prop: '--bottom-h',  key: 'bottomH',  axis: 'y', min: 120, max: 600, invert: true },
  };

  const DEFAULTS = {
    panels: PANEL_KEYS.slice(),
    stats: STAT_KEYS.slice(),
    hiddenStats: [],
    sideW: 320,
    sysinfoW: 280,
    bottomH: 200,
    uiScale: 1,
  };

  const root = document.documentElement;
  const dashboard = document.querySelector('.dashboard-view');
  let layout = { ...DEFAULTS };
  let saveTimer = null;

  // ── persistence ──────────────────────────────────────────
  // Debounced: a splitter drag emits a move per frame and each save is a disk
  // write on the server side. The visual update is immediate regardless.

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      State.settings = { ...State.settings, layout: { ...layout } };
      fetch(`${API}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout }),
      }).catch(() => { /* layout is cosmetic — a failed save must never interrupt */ });
    }, 400);
  }

  // Drop unknown keys rather than trusting the file: a hand-edited settings.json
  // with a bad panel name would otherwise leave that panel unrendered forever.
  function sanitize(saved) {
    const s = saved && typeof saved === 'object' ? saved : {};
    const orderOf = (list, allowed) => {
      const clean = Array.isArray(list) ? list.filter((k) => allowed.includes(k)) : [];
      const seen = new Set(clean);
      return [...new Set(clean)].concat(allowed.filter((k) => !seen.has(k)));
    };
    const num = (v, d, lo, hi) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
    return {
      panels: orderOf(s.panels, PANEL_KEYS),
      stats: orderOf(s.stats, STAT_KEYS),
      // Never let every stat be hidden — an empty stats row reads as a broken app.
      hiddenStats: (Array.isArray(s.hiddenStats) ? s.hiddenStats.filter((k) => STAT_KEYS.includes(k)) : [])
        .slice(0, STAT_KEYS.length - 1),
      sideW: num(s.sideW, DEFAULTS.sideW, SPLITTERS['side-w'].min, SPLITTERS['side-w'].max),
      sysinfoW: num(s.sysinfoW, DEFAULTS.sysinfoW, SPLITTERS['sysinfo-w'].min, SPLITTERS['sysinfo-w'].max),
      bottomH: num(s.bottomH, DEFAULTS.bottomH, SPLITTERS['bottom-h'].min, SPLITTERS['bottom-h'].max),
      uiScale: num(s.uiScale, 1, 0.85, 2),
    };
  }

  // ── applying ─────────────────────────────────────────────

  function applySizes() {
    root.style.setProperty('--side-w', layout.sideW + 'px');
    root.style.setProperty('--sysinfo-w', layout.sysinfoW + 'px');
    root.style.setProperty('--bottom-h', layout.bottomH + 'px');
    root.style.setProperty('--ui-scale', String(layout.uiScale));
  }

  function panelEl(key) { return document.querySelector(`[data-panel="${key}"]`); }
  function statEl(key) { return document.querySelector(`[data-stat="${key}"]`); }

  // Panels live in fixed grid slots; reordering means putting the right panel in
  // each slot, not moving the slots. Read the slots first, then fill them.
  function applyPanelOrder() {
    const slots = [...document.querySelectorAll('[data-panel]')].map((el) => ({
      parent: el.parentNode,
      next: el.nextSibling === el ? null : el.nextSibling,
    }));
    const wanted = layout.panels.map(panelEl);
    if (wanted.some((el) => !el)) return;
    // Detach everything first so the placeholders below are stable.
    const marks = slots.map((slot) => {
      const mark = document.createComment('slot');
      slot.parent.insertBefore(mark, slot.next);
      return mark;
    });
    wanted.forEach((el) => el.remove());
    marks.forEach((mark, i) => {
      mark.parentNode.insertBefore(wanted[i], mark);
      mark.remove();
    });
  }

  function applyStatOrder() {
    const row = document.querySelector('.stats-row');
    layout.stats.forEach((key) => {
      const el = statEl(key);
      if (el) row.appendChild(el); // appendChild moves, so this reorders in place
    });
    STAT_KEYS.forEach((key) => {
      const el = statEl(key);
      if (el) el.hidden = layout.hiddenStats.includes(key);
    });
    if (typeof drawCharts === 'function') requestAnimationFrame(() => drawCharts());
  }

  function applyAll() {
    applySizes();
    applyPanelOrder();
    applyStatOrder();
    syncSettingsUI();
  }

  // ── splitter dragging ────────────────────────────────────

  function sizeFor(def, el, clientX, clientY) {
    // Every splitter sits before a trailing panel, so the panel's size is the
    // distance from the pointer to the container's far edge.
    const box = el.parentNode.getBoundingClientRect();
    const raw = def.axis === 'x' ? box.right - clientX : box.bottom - clientY;
    return Math.round(Math.min(def.max, Math.max(def.min, raw)));
  }

  function bindSplitter(el) {
    const def = SPLITTERS[el.dataset.resize];
    if (!def) return;

    el.setAttribute('aria-valuemin', String(def.min));
    el.setAttribute('aria-valuemax', String(def.max));
    const publish = () => el.setAttribute('aria-valuenow', String(layout[def.key]));
    publish();

    const commit = (value) => {
      layout[def.key] = value;
      root.style.setProperty(def.prop, value + 'px');
      publish();
      save();
    };

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      document.body.classList.add('is-resizing', def.axis === 'x' ? 'resizing-col' : 'resizing-row');

      const move = (ev) => commit(sizeFor(def, el, ev.clientX, ev.clientY));
      const up = (ev) => {
        el.releasePointerCapture(ev.pointerId);
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        document.body.classList.remove('is-resizing', 'resizing-col', 'resizing-row');
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });

    el.addEventListener('keydown', (e) => {
      const big = e.shiftKey ? 40 : 10;
      let delta = 0;
      if (def.axis === 'x' && e.key === 'ArrowLeft') delta = big;   // handle left = panel wider
      else if (def.axis === 'x' && e.key === 'ArrowRight') delta = -big;
      else if (def.axis === 'y' && e.key === 'ArrowUp') delta = big;
      else if (def.axis === 'y' && e.key === 'ArrowDown') delta = -big;
      else if (e.key === 'Home') delta = def.max;
      else if (e.key === 'End') delta = -def.max;
      else return;
      e.preventDefault();
      commit(Math.min(def.max, Math.max(def.min, layout[def.key] + delta)));
    });
  }

  // ── panel swapping ───────────────────────────────────────

  let draggingPanel = null;

  function swapPanels(a, b) {
    if (!a || !b || a === b) return;
    const i = layout.panels.indexOf(a);
    const j = layout.panels.indexOf(b);
    if (i < 0 || j < 0) return;
    [layout.panels[i], layout.panels[j]] = [layout.panels[j], layout.panels[i]];
    applyPanelOrder();
    save();
    announce(`${a} and ${b} panels swapped`);
    // xterm refits itself via its ResizeObserver; the canvases do not.
    if (typeof drawCharts === 'function') requestAnimationFrame(() => drawCharts());
  }

  function bindPanelDrag(panel) {
    const key = panel.dataset.panel;
    const grip = panel.querySelector('[data-grip]');
    if (!grip) return;

    // Only the grip starts a drag — dragging the whole panel would fight text
    // selection in the terminal and the log views.
    //
    // The release listener is on the document, not the grip: a drag ends with the
    // pointer wherever it was dropped, so a grip-scoped pointerup never fired and
    // the panel stayed draggable for the rest of the session. A draggable panel
    // swallows mousedown's default action, which is what focuses xterm and starts
    // a text selection — the terminal went keyboard-dead and unselectable.
    grip.addEventListener('pointerdown', () => { panel.draggable = true; });
    document.addEventListener('pointerup', () => { if (!draggingPanel) panel.draggable = false; });
    document.addEventListener('pointercancel', () => { if (!draggingPanel) panel.draggable = false; });

    panel.addEventListener('dragstart', (e) => {
      draggingPanel = key;
      panel.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', key); // Firefox needs a payload
    });
    panel.addEventListener('dragend', () => {
      draggingPanel = null;
      panel.draggable = false;
      panel.classList.remove('is-dragging');
      document.querySelectorAll('.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
    });
    panel.addEventListener('dragover', (e) => {
      if (!draggingPanel || draggingPanel === key) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      panel.classList.add('is-drop-target');
    });
    panel.addEventListener('dragleave', () => panel.classList.remove('is-drop-target'));
    panel.addEventListener('drop', (e) => {
      if (!draggingPanel || draggingPanel === key) return;
      e.preventDefault();
      panel.classList.remove('is-drop-target');
      swapPanels(draggingPanel, key);
    });

    // Keyboard: arrows swap with the neighbouring slot.
    grip.addEventListener('keydown', (e) => {
      const idx = layout.panels.indexOf(key);
      let target = -1;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') target = idx - 1;
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') target = idx + 1;
      else return;
      e.preventDefault();
      if (target < 0 || target >= layout.panels.length) return;
      swapPanels(key, layout.panels[target]);
      // The DOM moved under the focus; put it back on this panel's grip.
      requestAnimationFrame(() => {
        const el = panelEl(key);
        if (el) el.querySelector('[data-grip]').focus();
      });
    });
  }

  // ── stat reordering ──────────────────────────────────────

  let draggingStat = null;

  function moveStat(key, toIndex) {
    const from = layout.stats.indexOf(key);
    if (from < 0 || toIndex < 0 || toIndex >= layout.stats.length || from === toIndex) return;
    layout.stats.splice(from, 1);
    layout.stats.splice(toIndex, 0, key);
    applyStatOrder();
    save();
    announce(`${key} moved to position ${toIndex + 1} of ${layout.stats.length}`);
  }

  function bindStatDrag(block) {
    const key = block.dataset.stat;

    block.addEventListener('dragstart', (e) => {
      draggingStat = key;
      block.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', key);
    });
    block.addEventListener('dragend', () => {
      draggingStat = null;
      block.classList.remove('is-dragging');
      document.querySelectorAll('.stat-block.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
    });
    block.addEventListener('dragover', (e) => {
      if (!draggingStat || draggingStat === key) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      block.classList.add('is-drop-target');
    });
    block.addEventListener('dragleave', () => block.classList.remove('is-drop-target'));
    block.addEventListener('drop', (e) => {
      if (!draggingStat || draggingStat === key) return;
      e.preventDefault();
      block.classList.remove('is-drop-target');
      moveStat(draggingStat, layout.stats.indexOf(key));
      draggingStat = null;
    });

    block.addEventListener('keydown', (e) => {
      // Alt-modified so the arrow keys still scroll the dashboard normally.
      if (!e.altKey) return;
      const idx = layout.stats.indexOf(key);
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') moveStat(key, idx - 1);
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') moveStat(key, idx + 1);
      else return;
      e.preventDefault();
      requestAnimationFrame(() => { const el = statEl(key); if (el) el.focus(); });
    });
  }

  // ── settings panel wiring ────────────────────────────────

  function syncSettingsUI() {
    const scale = document.getElementById('setting-ui-scale');
    if (scale) scale.value = String(layout.uiScale);
    STAT_KEYS.forEach((key) => {
      const box = document.getElementById('stat-vis-' + key);
      if (box) box.checked = !layout.hiddenStats.includes(key);
    });
  }

  function bindSettings() {
    const scale = document.getElementById('setting-ui-scale');
    if (scale) {
      scale.addEventListener('change', () => {
        layout.uiScale = parseFloat(scale.value) || 1;
        applySizes();
        save();
        if (typeof drawCharts === 'function') requestAnimationFrame(() => drawCharts());
      });
    }

    STAT_KEYS.forEach((key) => {
      const box = document.getElementById('stat-vis-' + key);
      if (!box) return;
      box.addEventListener('change', () => {
        const hidden = new Set(layout.hiddenStats);
        if (box.checked) hidden.delete(key);
        else hidden.add(key);
        if (hidden.size >= STAT_KEYS.length) { // never hide the last one
          box.checked = true;
          return;
        }
        layout.hiddenStats = [...hidden];
        applyStatOrder();
        save();
      });
    });

    const reset = document.getElementById('setting-layout-reset');
    if (reset) {
      reset.addEventListener('click', () => {
        layout = { ...DEFAULTS, panels: PANEL_KEYS.slice(), stats: STAT_KEYS.slice(), hiddenStats: [] };
        applyAll();
        save();
        announce('Layout reset to defaults');
      });
    }
  }

  // ── live region ──────────────────────────────────────────
  // Drag-and-drop and arrow-key moves produce no native announcement, so every
  // committed move says what happened.

  let liveRegion = null;
  function announce(message) {
    if (!liveRegion) {
      liveRegion = document.createElement('div');
      liveRegion.className = 'sr-only';
      liveRegion.setAttribute('role', 'status');
      liveRegion.setAttribute('aria-live', 'polite');
      document.body.appendChild(liveRegion);
    }
    liveRegion.textContent = message;
  }

  // ── init ─────────────────────────────────────────────────

  function init() {
    layout = sanitize(State.settings && State.settings.layout);
    applyAll();
    document.querySelectorAll('.splitter').forEach(bindSplitter);
    document.querySelectorAll('[data-panel]').forEach(bindPanelDrag);
    document.querySelectorAll('[data-stat]').forEach(bindStatDrag);
    bindSettings();
  }

  // app.js loads settings asynchronously, so wait for them rather than racing to
  // a default layout that then visibly jumps when the real one lands.
  function waitForSettings(tries = 40) {
    if (typeof State !== 'undefined' && State.settings && Object.keys(State.settings).length) return init();
    if (tries <= 0) return init(); // vault locked or offline: defaults are correct
    setTimeout(() => waitForSettings(tries - 1), 100);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => waitForSettings());
  else waitForSettings();

  // Exposed for the layout probe and for app.js's reset paths.
  window.dashboardLayout = { get: () => ({ ...layout }), apply: applyAll, reset: () => {
    layout = { ...DEFAULTS, panels: PANEL_KEYS.slice(), stats: STAT_KEYS.slice(), hiddenStats: [] };
    applyAll(); save();
  } };
})();
