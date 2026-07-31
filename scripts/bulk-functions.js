// ── BULK COMMAND EXECUTION ───────────────────────────────
function openBulkExec() {
  const sessions = Object.values(State.sessions);
  dom.bulkServerCount.textContent = sessions.length + ' SERVERS';
  dom.bulkStatus.textContent = 'READY';
  dom.bulkStatus.style.color = 'var(--fg-dim)';
  dom.bulkOutput.innerHTML = '<div class="empty-state">&gt;&gt; ENTER A COMMAND AND CLICK RUN</div>';
  dom.bulkModal.style.display = 'flex';
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
  dom.bulkExecute.innerHTML = '<span class="btn-icon">&#9654;</span> RUN';
}
