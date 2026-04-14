// @ts-check
const vscode = acquireVsCodeApi();

const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const btnSend = document.getElementById('btn-send');
const btnStop = document.getElementById('btn-stop');
const btnNew = document.getElementById('btn-new');
const btnSessions = document.getElementById('btn-sessions');
const btnSettings = document.getElementById('btn-settings');
const sessionsPanelEl = document.getElementById('sessions-panel');
const settingsPanelEl = document.getElementById('settings-panel');
const statusEl = document.getElementById('status');

let configOptions = [];
let currentMode = 'manual';

let currentAssistantEl = null;
let currentToolGroupEl = null;
let isStreaming = false;

// ── Render helpers ────────────────────────────────────────────────────────────

function appendMessage(role, text) {
  const div = document.createElement('div');
  div.className = `message ${role}`;

  const roleEl = document.createElement('div');
  roleEl.className = 'message-role';
  roleEl.textContent = role === 'user' ? 'You' : role === 'assistant' ? 'Codeep' : '';
  if (role !== 'system') div.appendChild(roleEl);

  const contentEl = document.createElement('div');
  contentEl.className = 'message-content';
  contentEl.innerHTML = renderMarkdown(text);
  div.appendChild(contentEl);

  messagesEl.appendChild(div);
  scrollToBottom();
  return contentEl;
}

function appendToolCall(text) {
  if (!currentToolGroupEl) {
    currentToolGroupEl = document.createElement('div');
    currentToolGroupEl.className = 'tool-group';
    currentToolGroupEl.innerHTML = '<span class="tool-group-label">▸ Working...</span><div class="tool-group-items"></div>';
    messagesEl.appendChild(currentToolGroupEl);
  }
  const item = document.createElement('div');
  item.className = 'tool-item';
  item.textContent = text;
  currentToolGroupEl.querySelector('.tool-group-items').appendChild(item);
  scrollToBottom();
}

function appendThinking() {
  const div = document.createElement('div');
  div.className = 'thinking';
  div.id = 'thinking';
  div.innerHTML = 'Thinking <span class="thinking-dots"><span></span><span></span><span></span></span>';
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

function removeThinking() {
  document.getElementById('thinking')?.remove();
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Markdown renderer — handles code blocks first (extracted as placeholders),
// then processes inline/block markdown on remaining text, then restores blocks.
function renderMarkdown(text) {
  const blocks = [];

  // 1. Extract fenced code blocks into placeholders
  let s = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = escapeHtml(code.trimEnd());
    const label = lang || 'code';
    const block = `<div class="code-block"><div class="code-header">${label}<button class="copy-btn" onclick="copyCode(this)">Copy</button></div><pre><code>${escaped}</code></pre></div>`;
    blocks.push(block);
    return `\x00BLOCK${blocks.length - 1}\x00`;
  });

  // 2. Escape HTML in remaining text
  s = escapeHtml(s);

  // 3. Block-level: headings, lists, hr — process line by line
  const lines = s.split('\n');
  const out = [];
  let inUl = false, inOl = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Headings
    if (/^### /.test(line))      { closeLists(); out.push(`<h3>${line.slice(4)}</h3>`); continue; }
    if (/^## /.test(line))       { closeLists(); out.push(`<h2>${line.slice(3)}</h2>`); continue; }
    if (/^# /.test(line))        { closeLists(); out.push(`<h1>${line.slice(2)}</h1>`); continue; }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) { closeLists(); out.push('<hr>'); continue; }

    // Unordered list
    const ulMatch = line.match(/^[-*] (.+)/);
    if (ulMatch) {
      if (!inUl) { if (inOl) { out.push('</ol>'); inOl = false; } out.push('<ul>'); inUl = true; }
      out.push(`<li>${inline(ulMatch[1])}</li>`);
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^\d+\. (.+)/);
    if (olMatch) {
      if (!inOl) { if (inUl) { out.push('</ul>'); inUl = false; } out.push('<ol>'); inOl = true; }
      out.push(`<li>${inline(olMatch[1])}</li>`);
      continue;
    }

    closeLists();

    // Empty line → paragraph break
    if (line.trim() === '') { out.push('<br>'); continue; }

    out.push(inline(line) + '<br>');
  }

  closeLists();

  function closeLists() {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  }

  s = out.join('');

  // 4. Restore code blocks
  s = s.replace(/\x00BLOCK(\d+)\x00/g, (_, i) => blocks[+i]);

  return s;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

function copyCode(btn) {
  const code = btn.closest('.code-block').querySelector('code').textContent;
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
  });
}

// ── Send ──────────────────────────────────────────────────────────────────────

function send() {
  const text = inputEl.value.trim();
  if (!text || isStreaming) return;
  inputEl.value = '';
  inputEl.style.height = 'auto';
  vscode.postMessage({ type: 'send', text });
}

btnSend.addEventListener('click', send);

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

// Auto-resize textarea
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
});

btnStop.addEventListener('click', () => {
  vscode.postMessage({ type: 'cancel' });
});

btnNew.addEventListener('click', () => {
  sessionsPanelEl.style.display = 'none';
  vscode.postMessage({ type: 'newSession' });
});

btnSettings.addEventListener('click', () => {
  if (settingsPanelEl.style.display !== 'none') {
    settingsPanelEl.style.display = 'none';
    return;
  }
  sessionsPanelEl.style.display = 'none';
  renderSettingsPanel();
  settingsPanelEl.style.display = 'block';
});

btnSessions.addEventListener('click', () => {
  if (sessionsPanelEl.style.display !== 'none') {
    sessionsPanelEl.style.display = 'none';
    return;
  }
  settingsPanelEl.style.display = 'none';
  sessionsPanelEl.innerHTML = '<div class="sessions-loading">Loading...</div>';
  sessionsPanelEl.style.display = 'block';
  vscode.postMessage({ type: 'listSessions' });
});

// ── Messages from extension ───────────────────────────────────────────────────

window.addEventListener('message', (event) => {
  const msg = event.data;

  switch (msg.type) {
    case 'userMessage':
      removeThinking();
      appendMessage('user', msg.text);
      isStreaming = false;
      currentAssistantEl = null;
      currentToolGroupEl = null;
      break;

    case 'thinking':
      appendThinking();
      isStreaming = true;
      btnSend.style.display = 'none';
      btnStop.style.display = 'flex';
      break;

    case 'chunk':
      removeThinking();
      if (!currentAssistantEl) {
        currentAssistantEl = appendMessage('assistant', '');
      }
      // Append raw text, re-render markdown at end
      currentAssistantEl.dataset.raw = (currentAssistantEl.dataset.raw || '') + msg.text;
      currentAssistantEl.innerHTML = renderMarkdown(currentAssistantEl.dataset.raw);
      scrollToBottom();
      break;

    case 'responseEnd':
      isStreaming = false;
      currentAssistantEl = null;
      currentToolGroupEl = null;
      btnSend.style.display = 'flex';
      btnStop.style.display = 'none';
      break;

    case 'toolCall':
      appendToolCall(msg.text);
      break;

    case 'permission':
      appendPermission(msg.requestId, msg.label, msg.detail);
      break;

    case 'onboarding':
      appendOnboarding();
      break;

    case 'error':
      removeThinking();
      appendMessage('system', `Error: ${msg.text}`);
      isStreaming = false;
      btnSend.style.display = 'flex';
      btnStop.style.display = 'none';
      break;

    case 'status':
      statusEl.textContent = msg.text;
      break;

    case 'sessions':
      renderSessionsPanel(msg.sessions);
      break;

    case 'configOptions':
      configOptions = msg.configOptions || [];
      if (settingsPanelEl.style.display !== 'none') renderSettingsPanel();
      break;

    case 'modeChanged':
      currentMode = msg.modeId;
      if (settingsPanelEl.style.display !== 'none') renderSettingsPanel();
      break;

    case 'history':
      msg.messages.forEach(m => appendMessage(m.role === 'user' ? 'user' : 'assistant', m.content));
      scrollToBottom();
      break;

    case 'clearChat':
      messagesEl.innerHTML = '';
      currentAssistantEl = null;
      currentToolGroupEl = null;
      sessionsPanelEl.style.display = 'none';
      break;

    case 'prefill':
      inputEl.value = msg.text;
      inputEl.focus();
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
      break;
  }
});

function appendPermission(requestId, label, detail) {
  const div = document.createElement('div');
  div.className = 'permission-card';
  div.dataset.requestId = String(requestId);

  const title = document.createElement('div');
  title.className = 'permission-title';
  const strong = document.createElement('strong');
  strong.textContent = label;
  title.append('⚠ Allow ', strong, '?');
  div.appendChild(title);

  if (detail) {
    const det = document.createElement('div');
    det.className = 'permission-detail';
    det.textContent = detail;
    div.appendChild(det);
  }

  const actions = document.createElement('div');
  actions.className = 'permission-actions';

  [['allow_once', 'Allow once'], ['allow_always', 'Allow always'], ['reject_once', 'Reject']].forEach(([choice, label]) => {
    const btn = document.createElement('button');
    btn.textContent = label;
    if (choice === 'reject_once') btn.className = 'reject';
    btn.dataset.choice = choice;
    actions.appendChild(btn);
  });

  div.appendChild(actions);
  messagesEl.appendChild(div);
  scrollToBottom();
}

function respondPermission(card, choice) {
  const label = card.querySelector(`[data-choice="${choice}"]`)?.textContent ?? choice;
  card.innerHTML = '';
  const resolved = document.createElement('div');
  resolved.className = 'permission-resolved';
  resolved.textContent = label;
  card.appendChild(resolved);
  vscode.postMessage({ type: 'permissionResponse', requestId: Number(card.dataset.requestId), choice });
}

function renderSettingsPanel() {
  settingsPanelEl.innerHTML = '';

  // Mode toggle
  const modeRow = document.createElement('div');
  modeRow.className = 'settings-row';
  const modeLabel = document.createElement('label');
  modeLabel.className = 'settings-label';
  modeLabel.textContent = 'Mode';
  const modeSelect = document.createElement('select');
  modeSelect.className = 'settings-select';
  [['auto', 'Auto (no confirmations)'], ['manual', 'Manual (confirm writes)']].forEach(([val, name]) => {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = name;
    if (val === currentMode) opt.selected = true;
    modeSelect.appendChild(opt);
  });
  modeSelect.dataset.action = 'setMode';
  modeRow.appendChild(modeLabel);
  modeRow.appendChild(modeSelect);
  settingsPanelEl.appendChild(modeRow);

  // Config options (model, language, etc.)
  configOptions.forEach(opt => {
    const row = document.createElement('div');
    row.className = 'settings-row';

    const label = document.createElement('label');
    label.className = 'settings-label';
    label.textContent = opt.name;

    const select = document.createElement('select');
    select.className = 'settings-select';
    select.dataset.action = 'setConfig';
    select.dataset.configId = opt.id;

    opt.options.forEach(o => {
      const el = document.createElement('option');
      el.value = o.value;
      el.textContent = o.name;
      if (o.value === opt.currentValue) el.selected = true;
      select.appendChild(el);
    });

    row.appendChild(label);
    row.appendChild(select);
    settingsPanelEl.appendChild(row);
  });
}

function renderSessionsPanel(sessions) {
  sessionsPanelEl.innerHTML = '';
  if (!sessions || sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sessions-empty';
    empty.textContent = 'No sessions found';
    sessionsPanelEl.appendChild(empty);
    return;
  }
  sessions.forEach(s => {
    const name = s.title || (s.sessionId ? s.sessionId.slice(0, 24) : 'Session');
    const msgs = s.messageCount ? `${s.messageCount} msgs` : '';
    const date = s.updatedAt ? new Date(s.updatedAt).toLocaleDateString() : '';

    const item = document.createElement('div');
    item.className = 'session-item';
    item.dataset.sessionId = s.sessionId;

    const nameEl = document.createElement('div');
    nameEl.className = 'session-name';
    nameEl.textContent = name;

    const metaEl = document.createElement('div');
    metaEl.className = 'session-meta';
    metaEl.textContent = [msgs, date].filter(Boolean).join(' · ');

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'session-delete';
    deleteBtn.textContent = '×';
    deleteBtn.dataset.sessionId = s.sessionId;
    deleteBtn.dataset.action = 'deleteSession';

    const info = document.createElement('div');
    info.className = 'session-info';
    info.appendChild(nameEl);
    info.appendChild(metaEl);
    item.appendChild(info);
    item.appendChild(deleteBtn);
    sessionsPanelEl.appendChild(item);
  });
}

function appendOnboarding() {
  const div = document.createElement('div');
  div.className = 'onboarding';
  div.innerHTML = `
    <p>Codeep CLI is not installed or not found.</p>
    <p>Install it with:</p>
    <div class="code-block">
      <div class="code-header">terminal<button class="copy-btn" onclick="copyCode(this)">Copy</button></div>
      <pre><code>npm install -g codeep</code></pre>
    </div>
    <p>Then reload this window.</p>`;
  messagesEl.appendChild(div);
  scrollToBottom();
}

// Event delegation for dynamically created elements
messagesEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.permission-actions button');
  if (btn) {
    const card = btn.closest('.permission-card');
    if (card) respondPermission(card, btn.dataset.choice);
  }
});

sessionsPanelEl.addEventListener('click', (e) => {
  const deleteBtn = e.target.closest('[data-action="deleteSession"]');
  if (deleteBtn) {
    e.stopPropagation();
    vscode.postMessage({ type: 'deleteSession', sessionId: deleteBtn.dataset.sessionId });
    return;
  }
  const item = e.target.closest('.session-item');
  if (item && item.dataset.sessionId) {
    sessionsPanelEl.style.display = 'none';
    vscode.postMessage({ type: 'loadSession', sessionId: item.dataset.sessionId });
  }
});

settingsPanelEl.addEventListener('change', (e) => {
  const select = e.target.closest('select');
  if (!select) return;
  if (select.dataset.action === 'setMode') {
    currentMode = select.value;
    vscode.postMessage({ type: 'setMode', modeId: select.value });
  } else if (select.dataset.action === 'setConfig') {
    vscode.postMessage({ type: 'setConfig', configId: select.dataset.configId, value: select.value });
  }
});

// Notify extension that WebView is ready
vscode.postMessage({ type: 'ready' });
statusEl.textContent = 'Connecting to Codeep CLI...';
