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
const agentStatusEl = document.getElementById('agent-status');

let configOptions = [];
let currentMode = 'manual';

let currentAssistantEl = null;
let currentToolGroupEl = null;
let currentThoughtEl = null;
let currentPlanEl = null;
let isStreaming = false;
let lastErrorEl = null;

// Scroll sentinel — always the last child of messagesEl.
// scrollIntoView on it is more reliable than scrollTop = scrollHeight
// because the browser guarantees it's visible regardless of layout timing.
const scrollSentinel = document.createElement('div');
scrollSentinel.style.cssText = 'height:1px;flex-shrink:0;pointer-events:none;';
messagesEl.appendChild(scrollSentinel);

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
  if (role === 'system') lastErrorEl = div;
  scrollToBottom(true);
  return contentEl;
}

/** @type {Map<string, HTMLElement>} */
const toolCallItems = new Map();

function appendToolCall(text, toolCallId) {
  if (!currentToolGroupEl) {
    currentToolGroupEl = document.createElement('div');
    currentToolGroupEl.className = 'tool-group collapsed';
    const label = document.createElement('span');
    label.className = 'tool-group-label';
    const groupEl = currentToolGroupEl;
    label.addEventListener('click', () => groupEl.classList.toggle('collapsed'));
    const statusSpan = document.createElement('span');
    statusSpan.className = 'tool-group-status';
    statusSpan.textContent = 'Working...';
    const countSpan = document.createElement('span');
    countSpan.className = 'tool-group-count';
    label.append(statusSpan, ' ', countSpan);
    const items = document.createElement('div');
    items.className = 'tool-group-items';
    currentToolGroupEl.appendChild(label);
    currentToolGroupEl.appendChild(items);
    messagesEl.appendChild(currentToolGroupEl);
  }
  const item = document.createElement('div');
  item.className = 'tool-item';
  item.textContent = text;
  if (toolCallId) toolCallItems.set(toolCallId, item);
  currentToolGroupEl.querySelector('.tool-group-items').appendChild(item);
  const n = currentToolGroupEl.querySelectorAll('.tool-item').length;
  const countSpan = currentToolGroupEl.querySelector('.tool-group-count');
  if (countSpan) countSpan.textContent = `(${n})`;
  scrollToBottom(true);
}

function updateToolCall(toolCallId, status) {
  const item = toolCallItems.get(toolCallId);
  if (item) {
    item.dataset.status = status;
    if (status === 'completed') item.style.opacity = '0.5';
    if (status === 'failed') item.style.color = '#f87171';
    toolCallItems.delete(toolCallId);
  }
}

function appendThought(text) {
  if (!currentThoughtEl) {
    const card = document.createElement('div');
    card.className = 'thought-card collapsed';
    const label = document.createElement('div');
    label.className = 'thought-label';
    label.textContent = '✦ Thinking';
    label.addEventListener('click', () => card.classList.toggle('collapsed'));
    const body = document.createElement('div');
    body.className = 'thought-body';
    card.appendChild(label);
    card.appendChild(body);
    messagesEl.appendChild(card);
    currentThoughtEl = body;
  }
  currentThoughtEl.dataset.raw = (currentThoughtEl.dataset.raw || '') + text;
  currentThoughtEl.textContent = currentThoughtEl.dataset.raw;
  scrollToBottom();
}

const PLAN_STATUS_ICON = { pending: '○', in_progress: '◐', completed: '●' };

function renderPlan(entries) {
  if (!entries || entries.length === 0) {
    if (currentPlanEl) { currentPlanEl.remove(); currentPlanEl = null; }
    return;
  }
  if (!currentPlanEl) {
    currentPlanEl = document.createElement('div');
    currentPlanEl.className = 'plan-card';
    const label = document.createElement('div');
    label.className = 'plan-label';
    label.textContent = 'Plan';
    currentPlanEl.appendChild(label);
    const list = document.createElement('div');
    list.className = 'plan-list';
    currentPlanEl.appendChild(list);
    messagesEl.appendChild(currentPlanEl);
  }
  const list = currentPlanEl.querySelector('.plan-list');
  list.innerHTML = '';
  entries.forEach((e) => {
    const row = document.createElement('div');
    row.className = `plan-item plan-${e.status || 'pending'}`;
    if (e.priority === 'high') row.classList.add('plan-high');
    const icon = document.createElement('span');
    icon.className = 'plan-icon';
    icon.textContent = PLAN_STATUS_ICON[e.status] || '○';
    const text = document.createElement('span');
    text.className = 'plan-text';
    text.textContent = e.content || '';
    row.appendChild(icon);
    row.appendChild(text);
    list.appendChild(row);
  });
  scrollToBottom();
}

function setAgentStatus(text, isThinking) {
  agentStatusEl.innerHTML = '';
  const icon = document.createElement('span');
  icon.id = 'agent-status-icon';
  if (isThinking) {
    icon.innerHTML = '<span class="thinking-dots"><span></span><span></span><span></span></span>';
  } else {
    icon.textContent = '▸';
  }
  const label = document.createElement('span');
  label.id = 'agent-status-text';
  label.textContent = text;
  agentStatusEl.appendChild(icon);
  agentStatusEl.appendChild(label);
  agentStatusEl.classList.add('visible');
}

function clearAgentStatus() {
  agentStatusEl.classList.remove('visible');
  agentStatusEl.innerHTML = '';
}

function dismissLastError() {
  if (lastErrorEl) {
    const el = lastErrorEl;
    lastErrorEl = null;
    el.style.transition = 'opacity 0.4s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 400);
  }
}

function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
}

function scrollToBottom(force = false) {
  if (force || isNearBottom()) {
    // Move sentinel to end (in case new elements were appended after it)
    messagesEl.appendChild(scrollSentinel);
    scrollSentinel.scrollIntoView({ block: 'end' });
  }
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
  }).catch(() => {
    btn.textContent = 'Failed';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
  });
}

// ── Send ──────────────────────────────────────────────────────────────────────

function send() {
  const text = inputEl.value.trim();
  if (!text) return;
  if (isStreaming) {
    // Interrupt: cancel current agent run, then send reply
    inputEl.value = '';
    inputEl.style.height = 'auto';
    settingsPanelEl.style.display = 'none';
    sessionsPanelEl.style.display = 'none';
    vscode.postMessage({ type: 'cancelAndSend', text });
    return;
  }
  inputEl.value = '';
  inputEl.style.height = 'auto';
  settingsPanelEl.style.display = 'none';
  sessionsPanelEl.style.display = 'none';
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
      clearAgentStatus();
      appendMessage('user', msg.text);
      isStreaming = false;
      currentAssistantEl = null;
      currentToolGroupEl = null;
      currentThoughtEl = null;
      if (currentPlanEl) { currentPlanEl.remove(); currentPlanEl = null; }
      break;

    case 'thinking':
      setAgentStatus('Thinking...', true);
      isStreaming = true;
      btnSend.style.display = 'none';
      btnStop.style.display = 'flex';
      inputEl.placeholder = 'Working...';
      break;

    case 'chunk':
      clearAgentStatus();
      dismissLastError();
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
      clearAgentStatus();
      if (currentToolGroupEl) {
        const statusSpan = currentToolGroupEl.querySelector('.tool-group-status');
        if (statusSpan) { statusSpan.textContent = '✓ Done'; statusSpan.style.color = '#4ade80'; }
      }
      currentAssistantEl = null;
      currentToolGroupEl = null;
      currentThoughtEl = null;
      btnSend.style.display = 'flex';
      btnStop.style.display = 'none';
      inputEl.placeholder = 'Ask Codeep anything...';
      break;

    case 'thought':
      dismissLastError();
      appendThought(msg.text);
      break;

    case 'plan':
      dismissLastError();
      renderPlan(msg.entries);
      break;

    case 'toolCall':
      if (!isStreaming) {
        isStreaming = true;
        btnSend.style.display = 'none';
        btnStop.style.display = 'flex';
        inputEl.placeholder = 'Working...';
      }
      dismissLastError();
      setAgentStatus(msg.text, false);
      appendToolCall(msg.text, msg.toolCallId);
      break;

    case 'toolCallUpdate':
      updateToolCall(msg.toolCallId, msg.status);
      break;

    case 'permission':
      if (!isStreaming) {
        isStreaming = true;
        btnSend.style.display = 'none';
        btnStop.style.display = 'flex';
        inputEl.placeholder = 'Working...';
      }
      clearAgentStatus();
      appendPermission(msg.requestId, msg.label, msg.detail, msg.toolName, msg.toolInput);
      break;

    case 'onboarding':
      appendOnboarding();
      break;

    case 'error':
      clearAgentStatus();
      appendMessage('system', `Error: ${msg.text}`);
      isStreaming = false;
      btnSend.style.display = 'flex';
      btnStop.style.display = 'none';
      inputEl.placeholder = 'Ask Codeep anything...';
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
      // Update status bar with current model
      const modelOpt = configOptions.find(o => o.id === 'model');
      if (modelOpt?.currentValue) {
        const modelName = modelOpt.options.find(o => o.value === modelOpt.currentValue)?.name ?? modelOpt.currentValue.split('/').pop();
        const currentStatus = statusEl.textContent || '';
        const base = currentStatus.split(' · ')[0];
        statusEl.textContent = base + ' · ' + modelName;
      }
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
      messagesEl.appendChild(scrollSentinel);
      currentAssistantEl = null;
      currentToolGroupEl = null;
      currentThoughtEl = null;
      currentPlanEl = null;
      lastErrorEl = null;
      toolCallItems.clear();
      clearAgentStatus();
      isStreaming = false;
      btnSend.style.display = 'flex';
      btnStop.style.display = 'none';
      inputEl.placeholder = 'Ask Codeep anything...';
      sessionsPanelEl.style.display = 'none';
      break;

    case 'prefill':
      inputEl.value = msg.text;
      inputEl.focus();
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
      break;

    case 'cancelPermissions':
      messagesEl.querySelectorAll('.permission-card').forEach(card => {
        if (!card.querySelector('.permission-resolved')) {
          card.innerHTML = '<div class="permission-resolved">Cancelled</div>';
        }
        setTimeout(() => {
          card.style.transition = 'opacity 0.4s';
          card.style.opacity = '0';
          setTimeout(() => card.remove(), 400);
        }, 1000);
      });
      break;
  }
});

function renderPermissionPreview(toolName, input) {
  if (!input || typeof input !== 'object') return null;

  // edit_file: side-by-side old/new with line markers
  if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    const wrap = document.createElement('div');
    wrap.className = 'permission-diff';
    const oldLines = input.old_string.split('\n');
    const newLines = input.new_string.split('\n');
    oldLines.forEach((l) => {
      const row = document.createElement('div');
      row.className = 'diff-line diff-del';
      row.textContent = '- ' + l;
      wrap.appendChild(row);
    });
    newLines.forEach((l) => {
      const row = document.createElement('div');
      row.className = 'diff-line diff-add';
      row.textContent = '+ ' + l;
      wrap.appendChild(row);
    });
    return wrap;
  }

  // write_file: preview of new content (treated as all-additions)
  if (typeof input.new_content === 'string') {
    const wrap = document.createElement('div');
    wrap.className = 'permission-diff';
    input.new_content.split('\n').forEach((l) => {
      const row = document.createElement('div');
      row.className = 'diff-line diff-add';
      row.textContent = '+ ' + l;
      wrap.appendChild(row);
    });
    return wrap;
  }

  // execute_command: show command + cwd in monospace
  if (toolName === 'execute_command' && typeof input.command === 'string') {
    const wrap = document.createElement('div');
    wrap.className = 'permission-cmd';
    const cmdLine = document.createElement('div');
    cmdLine.className = 'permission-cmd-line';
    const fullCmd = input.args ? `${input.command} ${input.args}` : input.command;
    cmdLine.textContent = '$ ' + fullCmd;
    wrap.appendChild(cmdLine);
    if (input.cwd) {
      const cwd = document.createElement('div');
      cwd.className = 'permission-cwd';
      cwd.textContent = 'cwd: ' + input.cwd;
      wrap.appendChild(cwd);
    }
    return wrap;
  }

  // delete_file: bold warning, no extra preview block needed (path is in detail)
  return null;
}

function appendPermission(requestId, label, detail, toolName, toolInput) {
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

  const preview = renderPermissionPreview(toolName, toolInput);
  if (preview) div.appendChild(preview);

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
  // Scroll so the whole card is visible from the top, not just the buttons
  setTimeout(() => div.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
}

function respondPermission(card, choice) {
  const label = card.querySelector(`[data-choice="${choice}"]`)?.textContent ?? choice;
  card.innerHTML = '';
  const resolved = document.createElement('div');
  resolved.className = 'permission-resolved';
  resolved.textContent = label;
  card.appendChild(resolved);
  vscode.postMessage({ type: 'permissionResponse', requestId: Number(card.dataset.requestId), choice });
  // Auto-remove after 3s with fade
  setTimeout(() => {
    card.style.transition = 'opacity 0.4s';
    card.style.opacity = '0';
    setTimeout(() => card.remove(), 400);
  }, 3000);
}

function makeSection(title) {
  const sec = document.createElement('div');
  sec.className = 'settings-section';
  const h = document.createElement('div');
  h.className = 'settings-section-title';
  h.textContent = title;
  sec.appendChild(h);
  return sec;
}

function makeRow(labelText, control) {
  const row = document.createElement('div');
  row.className = 'settings-row';
  const label = document.createElement('label');
  label.className = 'settings-label';
  label.textContent = labelText;
  row.appendChild(label);
  row.appendChild(control);
  return row;
}

function makeSelect(options, currentValue, action, configId) {
  const select = document.createElement('select');
  select.className = 'settings-select';
  select.dataset.action = action;
  if (configId) select.dataset.configId = configId;
  options.forEach((o) => {
    const value = Array.isArray(o) ? o[0] : o.value;
    const name  = Array.isArray(o) ? o[1] : o.name;
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = name;
    if (value === currentValue) opt.selected = true;
    select.appendChild(opt);
  });
  return select;
}

const PROVIDER_GROUP_LABELS = {
  'z.ai':          'Z.AI — Subscription (GLM Coding Plan)',
  'z.ai-api':      'Z.AI — API (pay-per-use)',
  'z.ai-cn':       'Z.AI China — Subscription (GLM Coding Plan)',
  'z.ai-cn-api':   'Z.AI China — API (pay-per-use)',
  'minimax':       'MiniMax — Subscription',
  'minimax-api':   'MiniMax — API (pay-per-use)',
  'minimax-cn':    'MiniMax China — Subscription',
  'anthropic':     'Anthropic',
  'openai':        'OpenAI',
  'deepseek':      'DeepSeek',
  'google':        'Google AI',
  'ollama':        'Ollama (local)',
};

function makeGroupedModelSelect(options, currentValue, action, configId) {
  const select = document.createElement('select');
  select.className = 'settings-select';
  select.dataset.action = action;
  if (configId) select.dataset.configId = configId;

  // Group models by provider prefix (part before '/')
  const groups = new Map();
  options.forEach(o => {
    const slash = o.value.indexOf('/');
    const pid = slash !== -1 ? o.value.slice(0, slash) : '_';
    if (!groups.has(pid)) groups.set(pid, []);
    groups.get(pid).push(o);
  });

  groups.forEach((models, pid) => {
    const groupLabel = PROVIDER_GROUP_LABELS[pid] ?? pid;
    const group = document.createElement('optgroup');
    group.label = groupLabel;
    models.forEach(o => {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.name;
      if (o.value === currentValue) opt.selected = true;
      group.appendChild(opt);
    });
    select.appendChild(group);
  });

  return select;
}

function renderSettingsPanel() {
  if (document.activeElement && settingsPanelEl.contains(document.activeElement)) return;
  settingsPanelEl.innerHTML = '';

  // ── Model & Mode ─────────────────────────────────────────────────────────────
  const modelSection = makeSection('Model & Mode');

  const modeSelect = makeSelect(
    [['auto', 'Auto — agent acts freely'], ['manual', 'Manual — confirm writes']],
    currentMode, 'setMode'
  );
  modelSection.appendChild(makeRow('Mode', modeSelect));

  const modelOpt = configOptions.find(o => o.id === 'model');
  if (modelOpt) {
    const modelSelect = makeGroupedModelSelect(modelOpt.options, modelOpt.currentValue, 'setConfig', 'model');
    modelSection.appendChild(makeRow('Model', modelSelect));
  }

  settingsPanelEl.appendChild(modelSection);

  // ── Preferences ──────────────────────────────────────────────────────────────
  const otherOpts = configOptions.filter(o => o.id !== 'model');
  if (otherOpts.length > 0) {
    const prefSection = makeSection('Preferences');
    otherOpts.forEach(opt => {
      const select = makeSelect(opt.options, opt.currentValue, 'setConfig', opt.id);
      prefSection.appendChild(makeRow(opt.name, select));
    });
    settingsPanelEl.appendChild(prefSection);
  }

  // ── API Key ───────────────────────────────────────────────────────────────────
  const apiSection = makeSection('API Key');

  const NO_KEY_PROVIDERS = new Set(['ollama']);

  // Full hardcoded provider list — always show all, regardless of which models are active
  const ALL_PROVIDERS = [
    { id: 'z.ai',        name: 'Z.AI — Subscription (GLM Coding Plan)' },
    { id: 'z.ai-api',    name: 'Z.AI — API (pay-per-use)' },
    { id: 'z.ai-cn',     name: 'Z.AI China — Subscription (GLM Coding Plan)' },
    { id: 'z.ai-cn-api', name: 'Z.AI China — API (pay-per-use)' },
    { id: 'minimax',     name: 'MiniMax — Subscription' },
    { id: 'minimax-api', name: 'MiniMax — API (pay-per-use)' },
    { id: 'minimax-cn',  name: 'MiniMax China — Subscription' },
    { id: 'anthropic',   name: 'Anthropic' },
    { id: 'openai',      name: 'OpenAI' },
    { id: 'deepseek',    name: 'DeepSeek' },
    { id: 'google',      name: 'Google AI' },
    { id: 'ollama',      name: 'Ollama (no key needed)' },
  ];

  const currentProvider = (modelOpt?.currentValue ?? '').split('/')[0] || '';

  const providerSelect = document.createElement('select');
  providerSelect.className = 'settings-select';
  providerSelect.id = 'api-key-provider';
  ALL_PROVIDERS.forEach(({ id, name }) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = name;
    if (id === currentProvider) opt.selected = true;
    providerSelect.appendChild(opt);
  });
  apiSection.appendChild(makeRow('Provider', providerSelect));

  // Show/hide API key row and update hint on provider change
  providerSelect.addEventListener('change', () => {
    const keyRow = apiSection.querySelector('.api-key-row');
    if (keyRow) keyRow.style.display = NO_KEY_PROVIDERS.has(providerSelect.value) ? 'none' : 'flex';
  });

  const keyRow = document.createElement('div');
  keyRow.className = 'settings-row api-key-row';
  if (NO_KEY_PROVIDERS.has(currentProvider)) keyRow.style.display = 'none';
  const keyLabel = document.createElement('label');
  keyLabel.className = 'settings-label';
  keyLabel.textContent = 'API Key';
  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.className = 'settings-input';
  keyInput.placeholder = 'Paste key here…';
  keyInput.id = 'api-key-input';
  const keyBtn = document.createElement('button');
  keyBtn.className = 'settings-btn';
  keyBtn.textContent = 'Set';
  keyBtn.dataset.action = 'setApiKey';
  const keyWrap = document.createElement('div');
  keyWrap.className = 'settings-key-wrap';
  keyWrap.appendChild(keyInput);
  keyWrap.appendChild(keyBtn);
  keyRow.appendChild(keyLabel);
  keyRow.appendChild(keyWrap);
  apiSection.appendChild(keyRow);

  // Provider type hint
  const hint = document.createElement('div');
  hint.className = 'settings-hint';
  hint.id = 'provider-hint';
  const PROVIDER_HINTS = {
    'z.ai':        'Uses your Z.AI subscription — no per-token charges.',
    'z.ai-api':    'Pay-per-use via Z.AI API key (zai.ai → API Keys).',
    'z.ai-cn':     'Uses your ZhipuAI China subscription.',
    'z.ai-cn-api': 'Pay-per-use via ZhipuAI China API key.',
    'minimax':     'Uses your MiniMax subscription — no per-token charges.',
    'minimax-api': 'Pay-per-use via MiniMax API key (minimaxi.com → API Keys).',
    'minimax-cn':  'Uses your MiniMax China subscription.',
    'anthropic':   'Pay-per-use via Anthropic API key (console.anthropic.com).',
    'openai':      'Pay-per-use via OpenAI API key (platform.openai.com).',
    'deepseek':    'Pay-per-use via DeepSeek API key (platform.deepseek.com).',
    'google':      'Pay-per-use via Google AI API key (aistudio.google.com).',
    'ollama':      'Runs locally — no API key or account needed.',
  };
  function updateHint(pid) {
    hint.textContent = PROVIDER_HINTS[pid] ?? '';
    hint.style.display = hint.textContent ? 'block' : 'none';
  }
  updateHint(currentProvider);
  const ps = apiSection.querySelector('#api-key-provider');
  if (ps) ps.addEventListener('change', () => updateHint(ps.value));
  apiSection.appendChild(hint);

  settingsPanelEl.appendChild(apiSection);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────────
  const helpSection = makeSection('Shortcuts');
  const shortcuts = [
    ['Cmd+Shift+C', 'Open chat'],
    ['Cmd+Shift+X', 'Send selection'],
    ['Enter', 'Send message'],
    ['Shift+Enter', 'New line'],
  ];
  const shortcutGrid = document.createElement('div');
  shortcutGrid.className = 'settings-shortcuts';
  shortcuts.forEach(([key, desc]) => {
    const k = document.createElement('kbd');
    k.className = 'settings-kbd';
    k.textContent = key;
    const d = document.createElement('span');
    d.className = 'settings-kbd-desc';
    d.textContent = desc;
    shortcutGrid.appendChild(k);
    shortcutGrid.appendChild(d);
  });
  helpSection.appendChild(shortcutGrid);
  settingsPanelEl.appendChild(helpSection);

  // ── Commands ─────────────────────────────────────────────────────────────────
  const cmdSection = makeSection('Commands');
  const commands = [
    ['/help',    'Show all commands'],
    ['/review',  'AI code review'],
    ['/diff',    'Review git diff'],
    ['/commit',  'Generate commit message'],
    ['/scan',    'Scan project structure'],
    ['/fix',     'Fix bugs'],
    ['/test',    'Write or run tests'],
    ['/status',  'Show session info'],
    ['/cost',    'Show token usage'],
    ['/export',  'Export conversation'],
  ];
  const cmdGrid = document.createElement('div');
  cmdGrid.className = 'settings-commands';
  commands.forEach(([cmd, desc]) => {
    const c = document.createElement('button');
    c.className = 'settings-cmd-chip';
    c.textContent = cmd;
    c.title = desc;
    c.dataset.action = 'insertCommand';
    c.dataset.command = cmd;
    cmdGrid.appendChild(c);
  });
  cmdSection.appendChild(cmdGrid);
  settingsPanelEl.appendChild(cmdSection);
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

  const p1 = document.createElement('p');
  p1.textContent = 'Codeep CLI is not installed or not found.';
  const p2 = document.createElement('p');
  p2.textContent = 'Install it with:';

  const block = document.createElement('div');
  block.className = 'code-block';

  const header = document.createElement('div');
  header.className = 'code-header';
  header.textContent = 'terminal';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', () => copyCode(copyBtn));
  header.appendChild(copyBtn);

  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = 'npm install -g codeep';
  pre.appendChild(code);
  block.appendChild(header);
  block.appendChild(pre);

  const p3 = document.createElement('p');
  p3.textContent = 'Then reload this window.';

  div.appendChild(p1);
  div.appendChild(p2);
  div.appendChild(block);
  div.appendChild(p3);
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

settingsPanelEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;

  if (btn.dataset.action === 'setApiKey') {
    const keyInput = settingsPanelEl.querySelector('#api-key-input');
    const providerSelect = settingsPanelEl.querySelector('#api-key-provider');
    const key = keyInput?.value?.trim();
    const providerId = providerSelect?.value;
    if (!key || !providerId) return;
    vscode.postMessage({ type: 'setConfig', configId: 'login', value: `${providerId}:${key}` });
    keyInput.value = '';
    btn.textContent = 'Saved!';
    setTimeout(() => { btn.textContent = 'Set'; }, 2000);
  }

  if (btn.dataset.action === 'insertCommand') {
    settingsPanelEl.style.display = 'none';
    inputEl.value = btn.dataset.command + ' ';
    inputEl.focus();
  }
});

// Notify extension that WebView is ready
vscode.postMessage({ type: 'ready' });
statusEl.textContent = 'Connecting to Codeep CLI...';
