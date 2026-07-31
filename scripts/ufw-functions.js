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
        '<td><button class="file-btn del" data-ufw-del="' + r.number + '">&#128465;</button></td>' +
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
        } catch { btn.disabled = false; btn.textContent = '🗑'; }
      });
    });
  } catch {
    dom.ufwTbody.innerHTML = '<tr><td colspan="5" class="empty-state">&gt;&gt; FIREWALL UNAVAILABLE</td></tr>';
  }
}

async function toggleUfw() {
  const isActive = dom.ufwStatus.textContent === 'ACTIVE';
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
