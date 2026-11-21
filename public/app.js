const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  data: null,
  view: 'chat',
  projects: [],
  bugs: [],
  bugFilter: { projectId: '', status: '' },
  expandedBug: null,
  projectId: null,
  chat: {
    sessionId: null,
    messages: [],
    streaming: false,
    profileId: 'code',
    modelId: '',
    projectId: null,
    status: '',
    sessions: [],
  },
};

/* ---------------- utils ---------------- */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function md(src) {
  const parts = String(src ?? '').split('```');
  const out = [];
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf('\n');
      const code = nl === -1 ? part : part.slice(nl + 1);
      out.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
      return;
    }
    let t = esc(part);
    t = t.replace(/^#{1,4} (.+)$/gm, '<h3>$1</h3>');
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    t = t.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    t = t.replace(/^\s*[-*] (.+)$/gm, '<li>$1</li>');
    t = t.replace(/(?:<li>.*<\/li>\s*)+/g, (m) => `<ul>${m}</ul>`);
    t = t
      .split(/\n{2,}/)
      .map((p) => {
        const trimmed = p.trim();
        if (!trimmed) return '';
        if (trimmed.startsWith('<ul>') || trimmed.startsWith('<h3>') || trimmed.startsWith('<pre>')) return trimmed;
        return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
      })
      .join('');
    out.push(t);
  });
  return out.join('');
}

function fmtTokens(n) {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(Math.round(v));
}

function fmtCost(n) {
  const v = Number(n || 0);
  if (!v) return '$0';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

function highlightSnippet(text) {
  return String(text || '')
    .split(/(<<|>>)/)
    .map((part) => {
      if (part === '<<') return '<mark>';
      if (part === '>>') return '</mark>';
      return esc(part);
    })
    .join('');
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function fmtUntil(iso) {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = j.error || msg;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  const type = res.headers.get('content-type') || '';
  return type.includes('json') ? res.json() : res.text();
}

/* ---------------- data ---------------- */

async function loadBootstrap() {
  state.data = await api('/api/bootstrap');
  state.projects = state.data.projects;
  if (!state.projectId && state.projects[0]) state.projectId = state.projects[0].id;
  if (!state.chat.projectId) state.chat.projectId = state.projectId;
  renderShell();
  return state.data;
}

async function refreshUsage() {
  try {
    const usage = await api('/api/usage');
    if (state.data) state.data.usage = usage;
    renderUsageMini(usage);
  } catch { /* ignore */ }
}

function renderUsageMini(usage) {
  const u = usage || state.data?.usage;
  if (!u) return;
  $('#mini-today').textContent = fmtTokens(u.today.tokens);
  $('#mini-week').textContent = fmtTokens(u.week.tokens);
  $('#mini-total').textContent = fmtTokens(u.total.tokens);
  $('#side-week').textContent = `${fmtTokens(u.week.tokens)} tok`;
  $('#side-cost').textContent = fmtCost(u.week.cost);
}

function renderShell() {
  renderUsageMini();
  $('#badge-projects').textContent = state.projects.length;
  $('#side-version').textContent = `v${state.data.version}`;
  $('#dot-status').className = 'dot';
  api('/api/bugs?status=aberto').then((bugs) => {
    $('#badge-bugs').textContent = bugs.length;
    state.bugs = bugs;
  }).catch(() => {});
}

/* ---------------- routing ---------------- */

const TITLES = {
  chat: 'Chat',
  usage: 'Uso',
  projects: 'Projetos',
  bugs: 'Bugs',
  models: 'Modelos',
  connections: 'Conexões',
};

function setView(view) {
  state.view = view;
  $('#view-title').textContent = TITLES[view] || view;
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  renderView();
}

function renderView() {
  if (state.view === 'chat') return mountChat();
  if (state.view === 'usage') return mountUsage();
  if (state.view === 'projects') return mountProjects();
  if (state.view === 'bugs') return mountBugs();
  if (state.view === 'models') return mountModels();
  if (state.view === 'connections') return mountConnections();
}

/* ---------------- chat ---------------- */

function profileOptions(selected) {
  return state.data.profiles
    .map((p) => `<option value="${esc(p.id)}" ${p.id === selected ? 'selected' : ''}>${esc(p.label)}</option>`)
    .join('');
}

function modelOptions(selected) {
  const rows = state.data.models
    .filter((m) => m.enabled)
    .map((m) => `<option value="${esc(m.id)}" ${m.id === selected ? 'selected' : ''}>${esc(m.label)}</option>`)
    .join('');
  return `<option value="" ${!selected ? 'selected' : ''}>Auto (pelo perfil)</option>${rows}`;
}

function projectOptions(selected) {
  const rows = state.projects
    .map((p) => `<option value="${esc(p.id)}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}</option>`)
    .join('');
  return `<option value="" ${!selected ? 'selected' : ''}>Sem projeto</option>${rows}`;
}

function mountChat() {
  $('#view').innerHTML = `
    <div class="chat-layout">
      <div class="sessions-rail">
        <div class="rail-head">
          <button class="btn primary sm grow" id="new-session">+ Nova</button>
          <button class="btn sm" id="reload-sessions" title="Recarregar">↻</button>
        </div>
        <div class="sessions-list" id="sessions-list"></div>
      </div>
      <div class="chat-main">
        <div class="chat-head">
          <select id="profile-select" title="Perfil de tarefa">${profileOptions(state.chat.profileId)}</select>
          <select id="model-select" title="Modelo (com fallback)">${modelOptions(state.chat.modelId)}</select>
          <select id="project-select" class="proj" title="Projeto no contexto">${projectOptions(state.chat.projectId)}</select>
          <span class="grow"></span>
          <span id="route-chip" class="chip">—</span>
        </div>
        <div class="messages" id="messages"></div>
        <div class="composer">
          <div class="composer-box">
            <textarea id="composer-input" rows="2" placeholder="Pergunte, cole um erro, peça código… (⌘/Ctrl + Enter envia)"></textarea>
            <div class="composer-row">
              <span class="hint" id="composer-hint">fila: —</span>
              <span class="grow"></span>
              <button class="btn sm" id="summarize">Resumir</button>
              <button class="btn primary sm" id="send">Enviar</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  $('#new-session').onclick = () => {
    state.chat.sessionId = null;
    state.chat.messages = [];
    renderMessages();
    loadSessions();
    $('#composer-input').focus();
  };
  $('#reload-sessions').onclick = loadSessions;
  $('#profile-select').onchange = (e) => {
    state.chat.profileId = e.target.value;
    updateRouteChip();
  };
  $('#model-select').onchange = (e) => {
    state.chat.modelId = e.target.value;
    updateRouteChip();
  };
  $('#project-select').onchange = (e) => {
    state.chat.projectId = e.target.value || null;
    loadSessions();
  };
  $('#send').onclick = sendMessage;
  $('#summarize').onclick = summarizeSession;

  $('#messages').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-approve],[data-deny]');
    if (!btn) return;
    const id = btn.dataset.approve || btn.dataset.deny;
    const approved = Boolean(btn.dataset.approve);
    btn.disabled = true;
    try {
      await api(`/api/approvals/${id}`, { method: 'POST', body: { approved } });
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
    }
  });

  const input = $('#composer-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendMessage();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  });

  loadSessions();
  renderMessages();
  updateRouteChip();
  input.focus();
}

function updateSendBtn() {
  const btn = $('#send');
  if (btn) btn.disabled = state.chat.streaming;
}

async function updateRouteChip() {
  const chip = $('#route-chip');
  if (!chip) return;
  try {
    const plan = await api(`/api/route?profileId=${encodeURIComponent(state.chat.profileId)}${state.chat.modelId ? `&modelId=${encodeURIComponent(state.chat.modelId)}` : ''}`);
    const ready = plan.filter((p) => p.status === 'ready');
    const first = ready[0];
    chip.className = `chip ${ready.length ? 'lime' : 'red'}`;
    chip.textContent = first ? `${ready.length} na fila · ${first.label}` : 'fila vazia';
    chip.title = plan.map((p) => `${p.order}. ${p.label} — ${p.status === 'ready' ? 'ok' : p.reason}`).join('\n');
    const hint = $('#composer-hint');
    if (hint) hint.textContent = first ? `próximo: ${first.label}` : 'nenhum modelo disponível';
  } catch { /* ignore */ }
}

async function loadSessions() {
  const list = $('#sessions-list');
  if (!list) return;
  try {
    const q = state.chat.projectId ? `?projectId=${encodeURIComponent(state.chat.projectId)}` : '';
    const sessions = await api(`/api/sessions${q}`);
    state.chat.sessions = sessions;
    list.innerHTML = sessions.length
      ? sessions.map((s) => `
        <div class="session-item ${s.id === state.chat.sessionId ? 'active' : ''}" data-session="${esc(s.id)}">
          <span class="t">${esc(s.title || 'Sem título')}</span>
          <span class="m">${s.message_count} msgs · ${fmtCost(s.cost)} · ${fmtDate(s.updated_at)}</span>
        </div>`).join('')
      : '<div class="empty" style="margin:8px">Nenhuma conversa ainda.</div>';

    $$('.session-item', list).forEach((el) => {
      el.onclick = () => openSession(el.dataset.session);
    });
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function openSession(id) {
  try {
    const { session, messages } = await api(`/api/sessions/${id}`);
    state.chat.sessionId = session.id;
    state.chat.projectId = session.project_id;
    state.chat.profileId = session.profile_id || 'code';
    state.chat.modelId = '';
    state.chat.messages = messages.map((m) => ({
      role: m.role,
      content: m.content,
      model: m.meta?.label || m.model_id || null,
      usage: m.input_tokens || m.output_tokens ? { inputTokens: m.input_tokens, outputTokens: m.output_tokens } : null,
      cost: m.cost,
      notes: [],
      tools: (m.meta?.tools || []).map((t) =>
        t.status === 'pending' ? { ...t, status: 'expired' }
        : t.status === 'running' ? { ...t, status: 'interrupted' }
        : t,
      ),
    }));
    $('#profile-select').value = state.chat.profileId;
    $('#model-select').value = '';
    $('#project-select').value = state.chat.projectId || '';
    renderMessages();
    loadSessions();
    updateRouteChip();
  } catch (err) {
    toast(err.message, 'err');
  }
}

function renderTool(tool) {
  const labels = {
    pending: 'aguardando você',
    approved: 'aprovado',
    denied: 'negado',
    running: 'executando…',
    ok: 'ok',
    error: 'erro',
    expired: 'expirado',
    interrupted: 'interrompido',
  };
  const tone = tool.status === 'error' || tool.status === 'denied' ? 'bad' : tool.status === 'pending' ? 'wait' : 'good';
  return `<div class="tool ${tone}">
    <div class="tool-head">
      <span class="tool-name">${esc(tool.name)}</span>
      <span class="chip">${labels[tool.status] || tool.status}</span>
    </div>
    <div class="tool-preview">${esc(tool.preview || '')}</div>
    ${tool.status === 'pending'
      ? `<div class="tool-actions">
           <button class="btn sm primary" data-approve="${esc(tool.id)}">Aprovar</button>
           <button class="btn sm" data-deny="${esc(tool.id)}">Negar</button>
         </div>`
      : ''}
    ${tool.output
      ? `<details class="tool-out"><summary>saída</summary><pre>${esc(tool.output)}</pre></details>`
      : ''}
  </div>`;
}

function renderMessages() {
  const box = $('#messages');
  if (!box) return;
  if (!state.chat.messages.length) {
    box.innerHTML = `
      <div class="empty" style="max-width:640px;margin:40px auto">
        <div style="font-size:26px;margin-bottom:10px">◆</div>
        <b>Conversa nova.</b><br>
        Escolha um projeto no topo pra puxar decisões, bugs e docs pro contexto.<br>
        Se o modelo escolhido falhar ou estourar cota, o próximo da fila assume sozinho.
      </div>`;
    return;
  }
  box.innerHTML = state.chat.messages.map((m) => {
    const isUser = m.role === 'user';
    const meta = [];
    if (m.model) meta.push(`<span class="chip lime">${esc(m.model)}</span>`);
    if (m.usage) meta.push(`<span class="chip">${fmtTokens((m.usage.inputTokens || 0) + (m.usage.outputTokens || 0))} tok</span>`);
    if (m.cost) meta.push(`<span class="chip">${fmtCost(m.cost)}</span>`);
    if (m.notes?.length) meta.push(...m.notes.map((n) => `<span class="chip amber">${esc(n)}</span>`));
    const tools = m.tools?.length ? `<div class="tool-list">${m.tools.map(renderTool).join('')}</div>` : '';
    return `
      <div class="msg ${isUser ? 'user' : 'assistant'}">
        <div class="avatar">${isUser ? 'VC' : 'IA'}</div>
        <div class="bubble">
          <div class="who">${isUser ? 'você' : esc(m.model || 'teko')} ${m.streaming ? '<span class="chip">gerando…</span>' : ''}</div>
          <div class="content ${m.streaming ? 'typing' : ''}">${m.error ? `<span style="color:var(--red)">${esc(m.error)}</span>` : md(m.content)}</div>
          ${tools}
          ${meta.length ? `<div class="meta">${meta.join('')}</div>` : ''}
        </div>
      </div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}

let msgTimer = null;
function scheduleMessages() {
  if (msgTimer) return;
  msgTimer = setTimeout(() => {
    msgTimer = null;
    renderMessages();
  }, 45);
}

async function streamChat(payload, onEvent) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = block.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()));
      } catch { /* ignore */ }
    }
  }
}

async function sendMessage() {
  const input = $('#composer-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text || state.chat.streaming) return;

  input.value = '';
  input.style.height = 'auto';
  state.chat.messages.push({ role: 'user', content: text });
  const assistant = { role: 'assistant', content: '', streaming: true, notes: [], model: null, usage: null, cost: 0, tools: [] };
  state.chat.messages.push(assistant);
  state.chat.streaming = true;
  updateSendBtn();
  renderMessages();

  try {
    await streamChat(
      {
        text,
        sessionId: state.chat.sessionId,
        projectId: state.chat.projectId,
        profileId: state.chat.profileId,
        modelId: state.chat.modelId || null,
      },
      (ev) => {
        if (ev.type === 'meta' && ev.sessionId) {
          state.chat.sessionId = ev.sessionId;
        }
        if (ev.type === 'attempt') {
          assistant.model = ev.label;
          assistant.notes.push(`→ ${ev.label}`);
        }
        if (ev.type === 'delta') {
          assistant.content += ev.text;
          scheduleMessages();
        }
        if (ev.type === 'fallback') {
          if (typeof ev.truncate === 'number') assistant.content = assistant.content.slice(0, ev.truncate);
          assistant.notes.push(`↯ ${ev.fromLabel}: ${ev.reason}`);
          scheduleMessages();
        }
        if (ev.type === 'done') {
          assistant.model = ev.label;
          assistant.usage = ev.usage;
          assistant.cost = ev.cost;
          if (typeof ev.text === 'string') assistant.content = ev.text;
          if (Array.isArray(ev.tools)) assistant.tools = ev.tools;
          assistant.notes = assistant.notes.filter((n) => !n.startsWith('→'));
          scheduleMessages();
        }
        if (ev.type === 'tool_call') {
          assistant.tools.push({
            id: ev.id,
            name: ev.name,
            preview: ev.preview,
            requiresApproval: ev.requiresApproval,
            status: ev.requiresApproval ? 'pending' : 'running',
            output: '',
          });
          scheduleMessages();
        }
        if (ev.type === 'tool_decision') {
          const tool = assistant.tools.find((t) => t.id === ev.id);
          if (tool) tool.status = ev.approved ? 'approved' : 'denied';
          scheduleMessages();
        }
        if (ev.type === 'tool_running') {
          const tool = assistant.tools.find((t) => t.id === ev.id);
          if (tool) tool.status = 'running';
          scheduleMessages();
        }
        if (ev.type === 'tool_result') {
          const tool = assistant.tools.find((t) => t.id === ev.id);
          if (tool) {
            tool.status = ev.ok ? 'ok' : 'error';
            tool.output = ev.output || '';
          }
          scheduleMessages();
        }
        if (ev.type === 'error') assistant.error = ev.message;
        if (ev.type === 'end') assistant.streaming = false;
      },
    );
  } catch (err) {
    assistant.error = err.message;
  }

  assistant.streaming = false;
  state.chat.streaming = false;
  updateSendBtn();
  renderMessages();
  loadSessions();
  refreshUsage();
  updateRouteChip();
}

async function summarizeSession() {
  if (!state.chat.sessionId) return toast('Abra uma conversa primeiro', 'err');
  try {
    const out = await api(`/api/sessions/${state.chat.sessionId}/summarize`, { method: 'POST', body: {} });
    toast(`Resumo salvo (${out.model})`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ---------------- usage ---------------- */

function mountUsage() {
  const u = state.data.usage;
  const maxDay = Math.max(1, ...u.series.map((d) => d.tokens));
  const week = u.byModelWeek;

  $('#view').innerHTML = `
    <div class="view-pad">
      <div class="stat-grid">
        ${statCard('Sessão', u.session, 'conversa aberta')}
        ${statCard('Hoje', u.today, 'desde 00:00')}
        ${statCard('Semana', u.week, 'desde segunda')}
        ${statCard('Mês', u.month, 'desde o dia 1')}
        ${statCard('Total', u.total, 'histórico local')}
      </div>

      <div class="grid" style="grid-template-columns:1.4fr 1fr;margin-top:16px">
        <div class="card">
          <div class="card-head"><h2>Últimos 14 dias</h2><span class="grow"></span><span class="chip">${fmtTokens(u.series.reduce((n, d) => n + d.tokens, 0))} tok</span></div>
          <div class="card-body">
            <div class="chart">
              ${u.series.map((d) => `
                <div class="bar" style="height:${Math.max(2, (d.tokens / maxDay) * 100)}%" title="${d.date}: ${fmtTokens(d.tokens)} tok · ${fmtCost(d.cost)}">
                  <span>${d.date.slice(8)}</span>
                </div>`).join('')}
            </div>
            <div style="height:18px"></div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>Por provider (semana)</h2></div>
          <div class="card-body" style="padding:6px 16px">
            <table>
              <tbody>
                ${u.byProviderWeek.length ? u.byProviderWeek.map((p) => `
                  <tr><td>${esc(p.provider_id)}</td><td class="num">${fmtTokens(p.tokens)}</td><td class="num">${fmtCost(p.cost)}</td></tr>
                `).join('') : '<tr><td class="dim">Sem uso ainda.</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-head"><h2>Por modelo (semana)</h2><span class="grow"></span><span class="chip">${u.week.requests} requisições</span></div>
        <div class="card-body" style="padding:6px 16px">
          <table>
            <thead><tr><th>Modelo</th><th>Provider</th><th class="num">Entrada</th><th class="num">Saída</th><th class="num">Custo</th><th class="num">Req.</th><th>Orçamento</th></tr></thead>
            <tbody>
              ${week.length ? week.map((r) => {
                const model = state.data.models.find((m) => m.id === r.model_id);
                const budget = model?.budget;
                return `<tr>
                  <td class="mono">${esc(model?.label || r.model_id)}</td>
                  <td class="dim">${esc(r.provider_id || '—')}</td>
                  <td class="num">${fmtTokens(r.input)}</td>
                  <td class="num">${fmtTokens(r.output)}</td>
                  <td class="num">${fmtCost(r.cost)}</td>
                  <td class="num">${r.requests}</td>
                  <td>${budget ? `<span class="chip ${budget.window === 'week' ? 'amber' : 'red'}">${budget.label} ${Math.round((budget.used / budget.cap) * 100)}%</span>` : '<span class="dim">—</span>'}</td>
                </tr>`;
              }).join('') : '<tr><td colspan="7" class="dim">Nenhum uso registrado nesta semana.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function statCard(label, totals, sub) {
  return `<div class="stat ${label === 'Semana' ? 'accent' : ''}">
    <div class="k">${label}</div>
    <div class="v">${fmtTokens(totals.tokens)}</div>
    <div class="s">${fmtCost(totals.cost)} · ${totals.requests} req · ${sub}</div>
  </div>`;
}

/* ---------------- projects ---------------- */

function mountProjects() {
  if (!state.projectId && state.projects[0]) state.projectId = state.projects[0].id;
  const selected = state.projects.find((p) => p.id === state.projectId) || null;

  $('#view').innerHTML = `
    <div class="view-pad">
      <div class="proj-layout">
        <div>
          <div class="proj-list" id="proj-list"></div>
          <button class="btn" style="width:100%;margin-top:10px" id="new-project">+ Novo projeto</button>
        </div>
        <div id="proj-detail"></div>
      </div>
    </div>`;

  renderProjectList();
  renderProjectDetail(selected);

  $('#new-project').onclick = async () => {
    const name = prompt('Nome do projeto:');
    if (!name) return;
    const projectPath = prompt('Caminho local (opcional, ex: /caminho/para/seus-projetos/meu-projeto):') || '';
    try {
      const p = await api('/api/projects', { method: 'POST', body: { name, path: projectPath } });
      await loadBootstrap();
      state.projectId = p.id;
      mountProjects();
      toast('Projeto criado', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };
}

function renderProjectList() {
  const list = $('#proj-list');
  if (!list) return;
  list.innerHTML = state.projects.map((p) => `
    <div class="proj-card ${p.id === state.projectId ? 'active' : ''}" data-id="${esc(p.id)}">
      <div class="n">${esc(p.name)}</div>
      <div class="d">${esc(p.description || 'Sem descrição')}</div>
      <div class="m">
        <span class="chip">${p.decision_count} decisões</span>
        ${p.open_bugs ? `<span class="chip red">${p.open_bugs} bugs</span>` : '<span class="chip">0 bugs</span>'}
      </div>
    </div>`).join('');
  $$('.proj-card', list).forEach((el) => {
    el.onclick = () => {
      state.projectId = el.dataset.id;
      renderProjectList();
      renderProjectDetail(state.projects.find((p) => p.id === state.projectId));
    };
  });
}

async function renderProjectDetail(project) {
  const box = $('#proj-detail');
  if (!box) return;
  if (!project) {
    box.innerHTML = '<div class="empty">Nenhum projeto. Crie um pra guardar contexto, decisões e bugs.</div>';
    return;
  }
  const [decisions, memory, index] = await Promise.all([
    api(`/api/decisions?projectId=${encodeURIComponent(project.id)}`),
    api(`/api/memory?projectId=${encodeURIComponent(project.id)}`),
    api(`/api/search/status?projectId=${encodeURIComponent(project.id)}`).catch(() => null),
  ]);

  box.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>${esc(project.name)}</h2>
        <span class="grow"></span>
        <button class="btn sm" id="chat-project">Abrir no chat</button>
        <button class="btn sm danger" id="del-project">Excluir</button>
      </div>
      <div class="card-body">
        <div class="grid" style="grid-template-columns:1fr 1fr">
          <label class="field"><span>Nome</span><input id="p-name" value="${esc(project.name)}"></label>
          <label class="field"><span>Caminho local (pra ler o repo)</span><input id="p-path" value="${esc(project.path || '')}" placeholder="/Users/..."></label>
        </div>
        <label class="field" style="margin-top:10px"><span>Descrição</span><textarea id="p-desc" rows="2">${esc(project.description || '')}</textarea></label>
        <label class="field" style="margin-top:10px"><span>Stack (separada por vírgula)</span><input id="p-stack" value="${esc((project.stack || []).join(', '))}"></label>
        <div class="row" style="margin-top:12px">
          <button class="btn primary sm" id="save-project">Salvar</button>
          <span class="dim small">O caminho do repo entra no contexto via <code>git ls-files</code>.</span>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="card-head">
        <h2>Busca no projeto</h2><span class="grow"></span>
        <span class="chip ${index?.indexed ? 'lime' : ''}" id="index-chip">
          ${index?.indexed ? `${index.chunks} trechos` : 'não indexado'}
        </span>
        <button class="btn sm" id="reindex">Reindexar</button>
      </div>
      <div class="card-body">
        <div class="row">
          <input id="p-search" placeholder="Onde fica…? (código, decisões, bugs, docs)" style="flex:1">
          <button class="btn primary sm" id="do-search">Buscar</button>
        </div>
        <div class="dim small" style="margin-top:6px" id="search-meta">
          ${index?.indexed
            ? `${index.files} arquivos · ${index.chunks} trechos · atualizado ${fmtDate(index.indexed_at)}`
            : 'Indexe o repositório pra buscar por relevância e alimentar o chat automaticamente.'}
        </div>
        <div id="search-results" style="margin-top:10px"></div>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="card-head"><h2>Decisões</h2><span class="grow"></span><span class="chip">${decisions.length}</span></div>
      <div class="card-body">
        <div class="grid" style="grid-template-columns:1fr 1fr">
          <label class="field"><span>Título</span><input id="d-title" placeholder="Ex: usar SQLite em vez de Postgres"></label>
          <label class="field"><span>Status</span>
            <select id="d-status"><option>aceita</option><option>proposta</option><option>descartada</option></select>
          </label>
        </div>
        <label class="field" style="margin-top:8px"><span>Decisão</span><textarea id="d-decision" rows="2" placeholder="O que foi decidido e por quê"></textarea></label>
        <label class="field" style="margin-top:8px"><span>Consequências</span><input id="d-cons" placeholder="Trade-offs, custos, o que fica de fora"></label>
        <button class="btn primary sm" style="margin-top:10px" id="add-decision">+ Registrar decisão</button>

        <hr class="sep">
        <div id="decision-list">
          ${decisions.length ? decisions.map((d) => `
            <div class="decision">
              <div class="row"><div class="dt grow">${esc(d.title)}</div><span class="chip">${esc(d.status)}</span>
                <button class="btn sm danger" data-del-decision="${esc(d.id)}">×</button></div>
              <div class="dc">${esc(d.decision || '')}</div>
              ${d.consequences ? `<div class="dc dim">↳ ${esc(d.consequences)}</div>` : ''}
            </div>`).join('') : '<div class="dim small">Nenhuma decisão registrada.</div>'}
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="card-head"><h2>Memória / documentos</h2><span class="grow"></span><span class="chip">${memory.length}</span></div>
      <div class="card-body">
        <div class="row">
          <input id="m-title" placeholder="Título (ex: contrato da API)" style="flex:1">
          <button class="btn sm" id="import-drive">Importar do Drive</button>
          <button class="btn sm" id="import-figma">Figma</button>
        </div>
        <textarea id="m-content" rows="3" placeholder="Cole um trecho, resumo, spec…" style="margin-top:8px"></textarea>
        <button class="btn primary sm" style="margin-top:8px" id="add-memory">+ Salvar nota</button>
        <hr class="sep">
        ${memory.length ? memory.map((m) => `
          <div class="decision">
            <div class="row"><div class="dt grow">${esc(m.title || m.kind)}</div>
              <span class="chip">${esc(m.source || m.kind)}</span>
              <button class="btn sm danger" data-del-memory="${esc(m.id)}">×</button></div>
            <div class="dc dim">${esc(String(m.content).slice(0, 220))}${String(m.content).length > 220 ? '…' : ''}</div>
          </div>`).join('') : '<div class="dim small">Nenhum documento importado.</div>'}
      </div>
    </div>`;

  $('#save-project').onclick = async () => {
    try {
      await api(`/api/projects/${project.id}`, {
        method: 'PATCH',
        body: {
          name: $('#p-name').value,
          path: $('#p-path').value,
          description: $('#p-desc').value,
          stack: $('#p-stack').value.split(',').map((s) => s.trim()).filter(Boolean),
        },
      });
      await loadBootstrap();
      mountProjects();
      toast('Projeto salvo', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  $('#del-project').onclick = async () => {
    if (!confirm(`Excluir "${project.name}"? Decisões e memória vão junto.`)) return;
    await api(`/api/projects/${project.id}`, { method: 'DELETE' });
    state.projectId = null;
    await loadBootstrap();
    mountProjects();
  };

  $('#chat-project').onclick = () => {
    state.chat.projectId = project.id;
    setView('chat');
    $('#project-select').value = project.id;
    loadSessions();
  };

  $('#add-decision').onclick = async () => {
    const title = $('#d-title').value.trim();
    if (!title) return toast('Título obrigatório', 'err');
    await api('/api/decisions', {
      method: 'POST',
      body: {
        projectId: project.id,
        title,
        status: $('#d-status').value,
        decision: $('#d-decision').value,
        consequences: $('#d-cons').value,
      },
    });
    await loadBootstrap();
    renderProjectDetail(state.projects.find((p) => p.id === project.id));
  };

  $('#add-memory').onclick = async () => {
    const content = $('#m-content').value.trim();
    if (!content) return toast('Conteúdo obrigatório', 'err');
    await api('/api/memory', {
      method: 'POST',
      body: { projectId: project.id, title: $('#m-title').value, content, kind: 'nota' },
    });
    await loadBootstrap();
    renderProjectDetail(state.projects.find((p) => p.id === project.id));
  };

  const doSearch = async () => {
    const q = $('#p-search').value.trim();
    if (!q) return;
    const box = $('#search-results');
    box.innerHTML = '<div class="dim small">buscando…</div>';
    try {
      const out = await api(`/api/search?q=${encodeURIComponent(q)}&projectId=${encodeURIComponent(project.id)}&limit=12`);
      box.innerHTML = out.results.length
        ? out.results.map((hit) => `
            <div class="hit">
              <div class="hit-head">
                <span class="chip">${esc(hit.kind)}</span>
                <span class="hit-loc">${esc(hit.path || hit.title || '')}${hit.startLine ? `:${hit.startLine}-${hit.endLine}` : ''}</span>
              </div>
              <div class="hit-body">${highlightSnippet(hit.snippet)}</div>
            </div>`).join('')
        : '<div class="dim small">Nada encontrado.</div>';
    } catch (err) {
      box.innerHTML = `<div class="dim small">${esc(err.message)}</div>`;
    }
  };
  $('#do-search').onclick = doSearch;
  $('#p-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
  });
  $('#reindex').onclick = async () => {
    const btn = $('#reindex');
    btn.disabled = true;
    btn.textContent = 'Indexando…';
    try {
      const out = await api('/api/search/index', { method: 'POST', body: { projectId: project.id } });
      $('#index-chip').className = 'chip lime';
      $('#index-chip').textContent = `${out.chunks} trechos`;
      $('#search-meta').textContent = `${out.files} arquivos · ${out.chunks} trechos · ${out.ms} ms`;
      toast('Índice atualizado', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Reindexar';
    }
  };

  $('#import-drive').onclick = () => importFromDrive(project.id);
  $('#import-figma').onclick = () => importFromFigma(project.id);

  $$('[data-del-decision]').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/decisions/${b.dataset.delDecision}`, { method: 'DELETE' });
      renderProjectDetail(state.projects.find((p) => p.id === project.id));
    };
  });
  $$('[data-del-memory]').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/memory/${b.dataset.delMemory}`, { method: 'DELETE' });
      renderProjectDetail(state.projects.find((p) => p.id === project.id));
    };
  });
}

async function importFromDrive(projectId) {
  try {
    const status = await api('/api/google/status');
    if (!status.connected) return toast('Conecte o Google Drive na aba Conexões', 'err');
    const q = prompt('Buscar no Drive por nome:');
    if (q === null) return;
    const files = await api(`/api/google/search?q=${encodeURIComponent(q)}`);
    if (!files.length) return toast('Nada encontrado', 'err');
    const list = files.slice(0, 10).map((f, i) => `${i + 1}. ${f.name}`).join('\n');
    const pick = Number(prompt(`Escolha o número:\n\n${list}`));
    const file = files[pick - 1];
    if (!file) return;
    const out = await api('/api/google/import', { method: 'POST', body: { fileId: file.id, projectId } });
    toast(`Importado: ${out.title} (${out.chars} chars)`, 'ok');
    renderProjectDetail(state.projects.find((p) => p.id === projectId));
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function importFromFigma(projectId) {
  try {
    const status = await api('/api/figma/status');
    if (!status.connected) return toast('Conecte o Figma na aba Conexões', 'err');
    const figmaUrl = prompt('URL do arquivo no Figma:');
    if (!figmaUrl) return;
    const out = await api('/api/figma/import', { method: 'POST', body: { url: figmaUrl, projectId } });
    toast(`Importado: ${out.name} (${out.chars} chars)`, 'ok');
    renderProjectDetail(state.projects.find((p) => p.id === projectId));
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ---------------- bugs ---------------- */

async function mountBugs() {
  $('#view').innerHTML = `
    <div class="view-pad">
      <div class="row wrap" style="margin-bottom:14px">
        <select id="bug-project" style="width:auto;min-width:180px">
          <option value="">Todos os projetos</option>
          ${state.projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}
        </select>
        <select id="bug-status" style="width:auto">
          <option value="">Todos os status</option>
          <option value="aberto">Aberto</option>
          <option value="investigando">Investigando</option>
          <option value="resolvido">Resolvido</option>
        </select>
        <span class="grow"></span>
        <a class="btn sm" href="/api/bugs/export?format=json" download>Exportar JSON</a>
        <a class="btn sm" href="/api/bugs/export?format=md" download>Exportar MD</a>
        <button class="btn primary sm" id="new-bug">+ Novo bug</button>
      </div>

      <div class="card hidden" id="bug-form-card">
        <div class="card-head"><h2>Registrar bug</h2></div>
        <div class="card-body">
          <div class="grid" style="grid-template-columns:2fr 1fr 1fr">
            <label class="field"><span>Título</span><input id="b-title" placeholder="Sintoma em uma linha"></label>
            <label class="field"><span>Severidade</span><select id="b-sev"><option value="critica">crítica</option><option value="alta">alta</option><option value="media" selected>média</option><option value="baixa">baixa</option></select></label>
            <label class="field"><span>Projeto</span><select id="b-project"><option value="">—</option>${state.projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>
          </div>
          <div class="grid" style="grid-template-columns:1fr 1fr 1fr;margin-top:10px">
            <label class="field"><span>Área</span><input id="b-area" placeholder="auth, sync, build…"></label>
            <label class="field"><span>Status</span><select id="b-status"><option>aberto</option><option>investigando</option><option>resolvido</option></select></label>
            <label class="field"><span>Tags</span><input id="b-tags" placeholder="ios, offline"></label>
          </div>
          <label class="field" style="margin-top:10px"><span>Como reproduzir</span><textarea id="b-repro" rows="2"></textarea></label>
          <div class="grid" style="grid-template-columns:1fr 1fr;margin-top:10px">
            <label class="field"><span>Esperado</span><textarea id="b-expected" rows="2"></textarea></label>
            <label class="field"><span>Atual</span><textarea id="b-actual" rows="2"></textarea></label>
          </div>
          <label class="field" style="margin-top:10px"><span>Logs / stack trace</span><textarea id="b-logs" rows="4" class="mono"></textarea></label>
          <button class="btn primary sm" style="margin-top:12px" id="save-bug">Salvar bug</button>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-body" style="padding:6px 10px" id="bug-table"></div>
      </div>
    </div>`;

  $('#bug-project').onchange = (e) => {
    state.bugFilter.projectId = e.target.value;
    renderBugTable();
  };
  $('#bug-status').onchange = (e) => {
    state.bugFilter.status = e.target.value;
    renderBugTable();
  };
  $('#new-bug').onclick = () => $('#bug-form-card').classList.toggle('hidden');
  $('#save-bug').onclick = async () => {
    const title = $('#b-title').value.trim();
    if (!title) return toast('Título obrigatório', 'err');
    try {
      await api('/api/bugs', {
        method: 'POST',
        body: {
          title,
          severity: $('#b-sev').value,
          projectId: $('#b-project').value || null,
          area: $('#b-area').value,
          status: $('#b-status').value,
          repro: $('#b-repro').value,
          expected: $('#b-expected').value,
          actual: $('#b-actual').value,
          logs: $('#b-logs').value,
          tags: $('#b-tags').value.split(',').map((s) => s.trim()).filter(Boolean),
        },
      });
      $('#bug-form-card').classList.add('hidden');
      ['b-title', 'b-area', 'b-repro', 'b-expected', 'b-actual', 'b-logs', 'b-tags'].forEach((id) => { $(`#${id}`).value = ''; });
      await loadBootstrap();
      renderBugTable();
      toast('Bug registrado', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  renderBugTable();
}

async function renderBugTable() {
  const box = $('#bug-table');
  if (!box) return;
  const params = new URLSearchParams();
  if (state.bugFilter.projectId) params.set('projectId', state.bugFilter.projectId);
  if (state.bugFilter.status) params.set('status', state.bugFilter.status);
  const bugs = await api(`/api/bugs?${params}`);
  state.bugs = bugs;

  if (!bugs.length) {
    box.innerHTML = '<div class="empty">Nenhum bug com esses filtros.</div>';
    return;
  }

  box.innerHTML = `
    <table>
      <thead><tr><th>Sev.</th><th>Bug</th><th>Projeto</th><th>Status</th><th>Criado</th><th></th></tr></thead>
      <tbody>
        ${bugs.map((b) => `
          <tr class="bug-row" data-bug="${esc(b.id)}">
            <td><span class="sev ${esc(b.severity)}">${esc(b.severity)}</span></td>
            <td><b>${esc(b.title)}</b>${b.area ? ` <span class="dim small">· ${esc(b.area)}</span>` : ''}</td>
            <td class="dim">${esc(b.project_name || '—')}</td>
            <td>${esc(b.status)}</td>
            <td class="mono dim">${fmtDate(b.created_at)}</td>
            <td class="num"><button class="btn sm danger" data-del-bug="${esc(b.id)}">×</button></td>
          </tr>
          ${state.expandedBug === b.id ? `
          <tr class="bug-detail"><td colspan="6">
            <div class="box">
              <div class="grid" style="grid-template-columns:1fr 1fr">
                <div><h4>Reproduzir</h4><div class="small">${esc(b.repro || '—')}</div></div>
                <div><h4>Esperado / atual</h4><div class="small">${esc(b.expected || '—')} → ${esc(b.actual || '—')}</div></div>
              </div>
              ${b.logs ? `<div><h4>Logs</h4><pre>${esc(b.logs)}</pre></div>` : ''}
              <div class="row">
                <select data-bug-status="${esc(b.id)}" style="width:auto">
                  ${['aberto', 'investigando', 'resolvido'].map((s) => `<option ${s === b.status ? 'selected' : ''}>${s}</option>`).join('')}
                </select>
                <select data-bug-sev="${esc(b.id)}" style="width:auto">
                  ${['critica', 'alta', 'media', 'baixa'].map((s) => `<option ${s === b.severity ? 'selected' : ''}>${s}</option>`).join('')}
                </select>
                <span class="dim small mono">${esc(b.id)}</span>
              </div>
            </div>
          </td></tr>` : ''}
        `).join('')}
      </tbody>
    </table>`;

  $$('.bug-row').forEach((row) => {
    row.onclick = (e) => {
      if (e.target.closest('[data-del-bug]')) return;
      state.expandedBug = state.expandedBug === row.dataset.bug ? null : row.dataset.bug;
      renderBugTable();
    };
  });
  $$('[data-del-bug]').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      await api(`/api/bugs/${b.dataset.delBug}`, { method: 'DELETE' });
      renderBugTable();
      loadBootstrap();
    };
  });
  $$('[data-bug-status]').forEach((sel) => {
    sel.onchange = async () => {
      await api(`/api/bugs/${sel.dataset.bugStatus}`, { method: 'PATCH', body: { status: sel.value } });
      renderBugTable();
      loadBootstrap();
    };
  });
  $$('[data-bug-sev]').forEach((sel) => {
    sel.onchange = async () => {
      await api(`/api/bugs/${sel.dataset.bugSev}`, { method: 'PATCH', body: { severity: sel.value } });
      renderBugTable();
    };
  });
}

/* ---------------- models ---------------- */

function mountModels() {
  const models = state.data.models;
  $('#view').innerHTML = `
    <div class="view-pad">
      <div class="row" style="margin-bottom:14px">
        <span class="muted small">Preços em USD por 1M tokens. Orçamento em tokens por janela.</span>
        <span class="grow"></span>
        <button class="btn sm" id="reset-cooldowns">Limpar cooldowns</button>
        <button class="btn primary sm" id="sync-models">Sincronizar modelos</button>
      </div>

      <div class="card">
        <div class="card-body" style="padding:6px 12px;overflow:auto">
          <table class="model-table">
            <thead><tr><th>On</th><th>Modelo</th><th>Provider</th><th class="num">$ in</th><th class="num">$ out</th><th class="num">Ctx</th><th class="num">Orç. semana</th><th>Estado</th><th></th></tr></thead>
            <tbody>
              ${models.map((m) => `
                <tr>
                  <td><label class="switch"><input type="checkbox" data-toggle="${esc(m.id)}" ${m.enabled ? 'checked' : ''}><i></i></label></td>
                  <td><div class="mono" style="font-size:11.5px">${esc(m.label)}</div><div class="dim" style="font-size:10px">${esc(m.id)}</div></td>
                  <td class="dim">${esc(m.provider_id)}</td>
                  <td class="num"><input type="number" step="0.01" value="${m.price_in}" data-price-in="${esc(m.id)}"></td>
                  <td class="num"><input type="number" step="0.01" value="${m.price_out}" data-price-out="${esc(m.id)}"></td>
                  <td class="num dim">${fmtTokens(m.ctx)}</td>
                  <td class="num"><input type="number" step="1000" value="${state.data.settings.budgets?.[m.id]?.week || 0}" data-budget="${esc(m.id)}" title="0 = sem limite"></td>
                  <td>
                    ${m.health?.cooldownUntil
                      ? `<span class="chip red" title="${esc(m.health.lastError || '')}">${esc(m.health.reason || 'cooldown')} · ${fmtUntil(m.health.cooldownUntil)}</span>`
                      : !m.providerHasKey
                        ? '<span class="chip amber">sem chave</span>'
                        : m.enabled ? '<span class="chip lime">pronto</span>' : '<span class="chip">off</span>'}
                  </td>
                  <td class="num">${m.health?.cooldownUntil ? `<button class="btn sm" data-reset="${esc(m.id)}">reset</button>` : ''}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <div class="dim small" style="margin-top:10px">Modelos novos entram desativados depois de sincronizar — revise preço e ative.</div>
    </div>`;

  $$('[data-toggle]').forEach((el) => {
    el.onchange = async () => {
      await api(`/api/models?id=${encodeURIComponent(el.dataset.toggle)}`, { method: 'PATCH', body: { enabled: el.checked ? 1 : 0 } });
      await loadBootstrap();
      toast(`${el.checked ? 'Ativado' : 'Desativado'}`, 'ok');
    };
  });
  $$('[data-price-in]').forEach((el) => {
    el.onchange = () => api(`/api/models?id=${encodeURIComponent(el.dataset.priceIn)}`, { method: 'PATCH', body: { price_in: Number(el.value) } }).then(() => loadBootstrap());
  });
  $$('[data-price-out]').forEach((el) => {
    el.onchange = () => api(`/api/models?id=${encodeURIComponent(el.dataset.priceOut)}`, { method: 'PATCH', body: { price_out: Number(el.value) } }).then(() => loadBootstrap());
  });
  $$('[data-budget]').forEach((el) => {
    el.onchange = () => api(`/api/models?id=${encodeURIComponent(el.dataset.budget)}`, { method: 'PATCH', body: { budgetWeek: Number(el.value) } }).then(() => loadBootstrap());
  });
  $$('[data-reset]').forEach((el) => {
    el.onclick = async () => {
      await api('/api/health/reset', { method: 'POST', body: { modelId: el.dataset.reset } });
      await loadBootstrap();
      mountModels();
    };
  });
  $('#reset-cooldowns').onclick = async () => {
    await api('/api/health/reset', { method: 'POST', body: {} });
    await loadBootstrap();
    mountModels();
  };
  $('#sync-models').onclick = async () => {
    const btn = $('#sync-models');
    btn.disabled = true;
    btn.textContent = 'Sincronizando…';
    try {
      const out = await api('/api/models/sync', { method: 'POST', body: {} });
      const added = out.report.reduce((n, r) => n + (r.added || 0), 0);
      toast(`Sincronizado: ${added} modelos novos`, 'ok');
      await loadBootstrap();
      mountModels();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sincronizar modelos';
    }
  };
}

/* ---------------- connections ---------------- */

function mountConnections() {
  const { providers, google, figma, settings } = state.data;
  $('#view').innerHTML = `
    <div class="view-pad">
      <div class="grid" style="grid-template-columns:1.3fr 1fr;align-items:start">
        <div class="card">
          <div class="card-head"><h2>Chaves dos providers</h2><span class="grow"></span><span class="chip">${providers.filter((p) => p.hasKey).length}/${providers.length}</span></div>
          <div class="card-body" style="padding:6px 16px">
            ${providers.map((p) => `
              <div class="provider-row">
                <div class="pname">
                  <div style="font-size:12.5px">${esc(p.label)}</div>
                  <div class="dim mono" style="font-size:10px">${esc(p.keyEnv || 'sem chave (local)')}</div>
                </div>
                <input type="password" ${p.id === 'ollama' ? 'disabled placeholder="sem chave (local)"' : `placeholder="${p.keyHint ? `salva: ${esc(p.keyHint)}` : 'cole a API key'}"`} data-key="${esc(p.id)}">
                <button class="btn sm" data-save-key="${esc(p.id)}">Salvar</button>
                ${p.hasKey && p.keyHint ? `<button class="btn sm danger" data-clear-key="${esc(p.id)}">×</button>` : ''}
              </div>`).join('')}
          </div>
        </div>

        <div>
          <div class="card">
            <div class="card-head"><h2>Google Drive / Docs</h2><span class="grow"></span>
              <span class="chip ${google.connected ? 'lime' : google.configured ? 'amber' : ''}">${google.connected ? 'conectado' : google.configured ? 'configurado' : 'sem credenciais'}</span>
            </div>
            <div class="card-body">
              <p class="small muted" style="margin:0 0 10px">Leitura de Docs/Sheets e importação como memória do projeto.</p>
              <div class="row">
                <button class="btn primary sm" id="google-connect" ${google.configured ? '' : 'disabled'}>Conectar</button>
                <button class="btn sm" id="google-test">Testar busca</button>
              </div>
              <div class="dim small" style="margin-top:10px">
                Redirect URI: <code>${esc(google.redirectUri)}</code><br>
                ${google.configured ? 'Credenciais detectadas.' : 'Defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no .env (OAuth client tipo "Desktop app").'}
              </div>
            </div>
          </div>

          <div class="card" style="margin-top:14px">
            <div class="card-head"><h2>Figma</h2><span class="grow"></span>
              <span class="chip ${figma.connected ? 'lime' : ''}">${figma.connected ? 'conectado' : 'sem token'}</span>
            </div>
            <div class="card-body">
              <p class="small muted" style="margin:0 0 10px">Lê páginas, frames e textos do arquivo e salva como memória do projeto.</p>
              <div class="row">
                <input type="password" id="figma-token" placeholder="figd_... (Personal Access Token)">
                <button class="btn sm" id="figma-save">Salvar</button>
                ${figma.connected ? '<button class="btn sm danger" id="figma-clear">×</button>' : ''}
              </div>
              <hr class="sep">
              <input id="figma-url" placeholder="https://www.figma.com/design/...">
              <div class="row" style="margin-top:8px">
                <select id="figma-project" style="flex:1">
                  <option value="">Sem projeto</option>
                  ${state.projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}
                </select>
                <button class="btn primary sm" id="figma-import">Importar</button>
              </div>
              <div class="dim small" style="margin-top:8px">Token em figma.com → Settings → Security → Personal access tokens (escopo de leitura de arquivo).</div>
            </div>
          </div>

          <div class="card" style="margin-top:14px">
            <div class="card-head"><h2>Preferências permanentes</h2></div>
            <div class="card-body">
              <textarea id="global-notes" rows="5" placeholder="Ex: sempre TypeScript estrito; não usar ORM; responder curto.">${esc(settings.globalNotes || '')}</textarea>
              <button class="btn primary sm" style="margin-top:10px" id="save-notes">Salvar</button>
            </div>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-head"><h2>Usar no OpenCode</h2></div>
        <div class="card-body">
          <p class="small muted" style="margin-top:0">O teko expõe uma API local. Pra usar o mesmo contexto e roteamento dentro do OpenCode, aponte um MCP/proxy pra <code>http://127.0.0.1:4780/api/chat</code> ou copie a configuração abaixo como referência.</p>
          <pre class="mono" style="background:#05070a;border:1px solid var(--line);padding:12px;border-radius:10px;overflow:auto;font-size:11.5px">${esc(`// ~/.config/opencode/config.json (exemplo)
{
  "mcp": {
    "google-drive": {
      "type": "local",
      "command": ["<comando-do-servidor-mcp-de-drive>"],
      "environment": {
        "GOOGLE_APPLICATION_CREDENTIALS": "/caminho/credenciais.json"
      }
    }
  }
}`)}</pre>
        </div>
      </div>
    </div>`;

  $$('[data-save-key]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.saveKey;
      const input = $(`[data-key="${id}"]`);
      if (!input.value.trim()) return toast('Cole a chave primeiro', 'err');
      await api('/api/keys', { method: 'POST', body: { providerId: id, apiKey: input.value.trim() } });
      input.value = '';
      await loadBootstrap();
      mountConnections();
      toast('Chave salva', 'ok');
    };
  });
  $$('[data-clear-key]').forEach((btn) => {
    btn.onclick = async () => {
      await api(`/api/keys?providerId=${encodeURIComponent(btn.dataset.clearKey)}`, { method: 'DELETE' });
      await loadBootstrap();
      mountConnections();
    };
  });

  $('#google-connect').onclick = async () => {
    try {
      const { url } = await api('/api/google/auth');
      window.open(url, '_blank', 'width=520,height=680');
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  $('#google-test').onclick = async () => {
    try {
      const files = await api('/api/google/search?q=');
      toast(`${files.length} arquivos encontrados`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  $('#figma-save').onclick = async () => {
    const token = $('#figma-token').value.trim();
    if (!token) return toast('Cole o token do Figma', 'err');
    await api('/api/figma/token', { method: 'POST', body: { token } });
    await loadBootstrap();
    mountConnections();
    toast('Figma conectado', 'ok');
  };
  if ($('#figma-clear')) {
    $('#figma-clear').onclick = async () => {
      await api('/api/figma/token', { method: 'POST', body: { token: '' } });
      await loadBootstrap();
      mountConnections();
    };
  }
  $('#figma-import').onclick = async () => {
    const figmaUrl = $('#figma-url').value.trim();
    if (!figmaUrl) return toast('Cole a URL do arquivo', 'err');
    const btn = $('#figma-import');
    btn.disabled = true;
    btn.textContent = 'Importando…';
    try {
      const out = await api('/api/figma/import', {
        method: 'POST',
        body: { url: figmaUrl, projectId: $('#figma-project').value || null },
      });
      toast(`Importado: ${out.name} (${out.chars} chars)`, 'ok');
      $('#figma-url').value = '';
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Importar';
    }
  };

  $('#save-notes').onclick = async () => {
    await api('/api/settings', { method: 'PUT', body: { globalNotes: $('#global-notes').value } });
    await loadBootstrap();
    toast('Preferências salvas', 'ok');
  };
}

/* ---------------- boot ---------------- */

$('#nav').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (btn) setView(btn.dataset.view);
});

(async function boot() {
  try {
    await loadBootstrap();
    const initial = location.hash.replace('#', '');
    if (initial && TITLES[initial]) setView(initial);
    else renderView();
    setInterval(() => {
      if (!state.chat.streaming) refreshUsage();
    }, 60_000);
  } catch (err) {
    $('#view').innerHTML = `<div class="view-pad"><div class="banner">Falha ao carregar: ${esc(err.message)}</div></div>`;
  }
})();
