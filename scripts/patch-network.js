const fs = require('fs');
let js = fs.readFileSync('public/js/app.js', 'utf8');

// 1. Update fetchStats to handle network data
js = js.replace(
  '    if (data.network) dom.siNetwork.textContent = data.network;\n    checkAlerts(data);\n    pushHistory(data);\n    drawCharts();',
  `    if (data.network) {
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
    drawCharts();`
);

// 2. Update pushHistory to push net deltas
js = js.replace(
  '  if (data.disk != null && data.disk !== "") {\n    const parts = data.disk.split("|");\n    push(State.history.disk, parseInt(parts[2]) || 0, State.maxHistory);\n  }\n}',
  `  if (data.disk != null && data.disk !== "") {
    const parts = data.disk.split("|");
    push(State.history.disk, parseInt(parts[2]) || 0, State.maxHistory);
  }
  if (data._netTxDelta != null) push(State.history.netTx, data._netTxDelta, State.maxHistory);
  if (data._netRxDelta != null) push(State.history.netRx, data._netRxDelta, State.maxHistory);
}`
);

// 3. Update drawCharts to include network dual sparkline
js = js.replace(
  '  drawSparkline(dom.chartCpu, State.history.cpu, { color: "#4AF626", warn: 60, danger: 80 });\n  drawSparkline(dom.chartMem, State.history.mem, { color: "#4AF626", warn: 60, danger: 80 });\n  drawSparkline(dom.chartDisk, State.history.disk, { color: "#4AF626", warn: 70, danger: 85 });\n}',
  `  drawSparkline(dom.chartCpu, State.history.cpu, { color: "#4AF626", warn: 60, danger: 80 });
  drawSparkline(dom.chartMem, State.history.mem, { color: "#4AF626", warn: 60, danger: 80 });
  drawSparkline(dom.chartDisk, State.history.disk, { color: "#4AF626", warn: 70, danger: 85 });
  drawDualSparkline(dom.chartNet, State.history.netTx, State.history.netRx, {
    colorA: "#FF8C00", colorB: "#00CED1"
  });
}`
);

// 4. Add drawDualSparkline and formatBitrate after drawSparkline, before SERVICES
const dualSparklineCode = `
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
`;

js = js.replace(
  '// ── SERVICES ─────────────────────────────────────────────',
  dualSparklineCode + '\n// ── SERVICES ─────────────────────────────────────────────'
);

// 5. Update switchToSession to clear network history
js = js.replace(
  '  State.activeSession = sessionId;\n  State.history = { cpu: [], mem: [], disk: [] };',
  '  State.activeSession = sessionId;\n  State.history = { cpu: [], mem: [], disk: [], netTx: [], netRx: [] };\n  State.prevNetRx = null; State.prevNetTx = null;'
);

// 6. Update disconnectSession full disconnect to clear network history
js = js.replace(
  '      State.history = { cpu: [], mem: [], disk: [] };',
  '      State.history = { cpu: [], mem: [], disk: [], netTx: [], netRx: [] };\n      State.prevNetRx = null; State.prevNetTx = null;'
);

// 7. Update the connectToServer to reset prevNet values too
js = js.replace(
  '    State.sessions[sessionId] = { host, port, username, label, sessionId, statsInterval: null, servicesInterval: null, logsInterval: null };\n    State.activeSession = sessionId;',
  '    State.prevNetRx = null; State.prevNetTx = null;\n    State.sessions[sessionId] = { host, port, username, label, sessionId, statsInterval: null, servicesInterval: null, logsInterval: null };\n    State.activeSession = sessionId;'
);

fs.writeFileSync('public/js/app.js', js);
console.log('OK: app.js updated');
