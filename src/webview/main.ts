// Entry point for the chat webview. Wires DOM events, dispatches inbound
// messages from the extension, and bootstraps everything. The actual rendering
// lives in the per-concern modules; this file is the glue.

import {
  agentStatusEl,
  btnNew,
  btnSend,
  btnSessions,
  btnSettings,
  btnStop,
  inputEl,
  messagesEl,
  mentionPopup,
  scrollSentinel,
  scrollToBottom,
  sessionsPanelEl,
  settingsPanelEl,
  statusEl,
} from './dom';
import { renderMarkdown, copyCodeBlock } from './markdown';
import {
  appendMessage,
  appendThought,
  appendToolCall,
  clearAgentStatus,
  dismissLastError,
  finalizeToolGroup,
  renderPlan,
  resetTurn,
  setAgentStatus,
  updateToolCall,
} from './messages';
import {
  appendPermission,
  cancelAllPermissions,
  respondPermission,
} from './permission';
import {
  applyFileSearchResults,
  closeMentionPopup,
  commitMention,
  renderMentionPopup,
  updateMentionPopup,
} from './mention';
import { renderSettingsPanel } from './settings';
import { renderSessionsPanel } from './sessions';
import { appendOnboarding } from './onboarding';
import { state, vscode } from './state';

// ── Send ──────────────────────────────────────────────────────────────────────

function send(): void {
  const text = inputEl.value.trim();
  if (!text) return;
  if (state.isStreaming) {
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
  // Mention popup keyboard nav takes priority while open
  if (state.mention && state.mention.items.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      state.mention.selected = (state.mention.selected + 1) % state.mention.items.length;
      renderMentionPopup();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      state.mention.selected =
        (state.mention.selected - 1 + state.mention.items.length) % state.mention.items.length;
      renderMentionPopup();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      commitMention(state.mention.items[state.mention.selected]);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMentionPopup();
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

inputEl.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab') return;
  updateMentionPopup();
});

inputEl.addEventListener('blur', () => {
  // Small delay so a click on the popup can fire first
  setTimeout(closeMentionPopup, 120);
});

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  updateMentionPopup();
});

mentionPopup.addEventListener('mousedown', (e) => {
  // mousedown beats blur so the textarea keeps focus
  e.preventDefault();
  const target = e.target as HTMLElement;
  const row = target.closest('.mention-item') as HTMLElement | null;
  if (!row || !state.mention) return;
  const i = Number(row.dataset.index);
  commitMention(state.mention.items[i]);
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

// ── Streaming UI helpers ──────────────────────────────────────────────────────

function enterStreaming(placeholder: string): void {
  state.isStreaming = true;
  btnSend.style.display = 'none';
  btnStop.style.display = 'flex';
  inputEl.placeholder = placeholder;
}

function exitStreaming(): void {
  state.isStreaming = false;
  btnSend.style.display = 'flex';
  btnStop.style.display = 'none';
  inputEl.placeholder = 'Ask Codeep anything (type @ to attach a file)';
}

// ── Inbound messages ──────────────────────────────────────────────────────────

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as { type: string; [k: string]: any };

  switch (msg.type) {
    case 'userMessage':
      clearAgentStatus();
      appendMessage('user', msg.text);
      state.isStreaming = false;
      resetTurn();
      if (state.currentPlanEl) { state.currentPlanEl.remove(); state.currentPlanEl = null; }
      break;

    case 'thinking':
      setAgentStatus('Thinking...', true);
      enterStreaming('Working...');
      break;

    case 'chunk':
      clearAgentStatus();
      dismissLastError();
      if (!state.currentAssistantEl) {
        state.currentAssistantEl = appendMessage('assistant', '');
      }
      state.currentAssistantEl.dataset.raw = (state.currentAssistantEl.dataset.raw ?? '') + msg.text;
      state.currentAssistantEl.innerHTML = renderMarkdown(state.currentAssistantEl.dataset.raw ?? '');
      scrollToBottom();
      break;

    case 'responseEnd':
      clearAgentStatus();
      finalizeToolGroup();
      resetTurn();
      exitStreaming();
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
      if (!state.isStreaming) enterStreaming('Working...');
      dismissLastError();
      setAgentStatus(msg.text, false);
      appendToolCall(msg.text, msg.toolCallId);
      break;

    case 'toolCallUpdate':
      updateToolCall(msg.toolCallId, msg.status);
      break;

    case 'permission':
      if (!state.isStreaming) enterStreaming('Working...');
      clearAgentStatus();
      appendPermission(msg.requestId, msg.label, msg.detail, msg.toolName, msg.toolInput);
      break;

    case 'onboarding':
      appendOnboarding();
      break;

    case 'error':
      clearAgentStatus();
      appendMessage('system', `Error: ${msg.text}`);
      exitStreaming();
      break;

    case 'status':
      statusEl.textContent = msg.text;
      break;

    case 'sessions':
      renderSessionsPanel(msg.sessions);
      break;

    case 'configOptions':
      state.configOptions = msg.configOptions || [];
      if (settingsPanelEl.style.display !== 'none') renderSettingsPanel();
      // Surface current model in the status bar
      const modelOpt = state.configOptions.find((o) => o.id === 'model');
      if (modelOpt?.currentValue) {
        const modelName =
          modelOpt.options.find((o) => o.value === modelOpt.currentValue)?.name
          ?? modelOpt.currentValue.split('/').pop();
        const currentStatus = statusEl.textContent || '';
        const base = currentStatus.split(' · ')[0];
        statusEl.textContent = base + ' · ' + modelName;
      }
      break;

    case 'providers':
      state.providers = msg.providers || [];
      state.providersUnavailable = !!msg.unavailable;
      if (settingsPanelEl.style.display !== 'none') renderSettingsPanel();
      break;

    case 'modeChanged':
      state.currentMode = msg.modeId;
      if (settingsPanelEl.style.display !== 'none') renderSettingsPanel();
      break;

    case 'history':
      msg.messages.forEach((m: { role: string; content: string }) =>
        appendMessage(m.role === 'user' ? 'user' : 'assistant', m.content),
      );
      scrollToBottom();
      break;

    case 'clearChat':
      messagesEl.innerHTML = '';
      messagesEl.appendChild(scrollSentinel);
      resetTurn();
      state.currentPlanEl = null;
      state.lastErrorEl = null;
      state.toolCallItems.clear();
      clearAgentStatus();
      exitStreaming();
      sessionsPanelEl.style.display = 'none';
      break;

    case 'prefill':
      inputEl.value = msg.text;
      inputEl.focus();
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
      break;

    case 'fileSearchResults':
      applyFileSearchResults(msg.queryId, msg.items || []);
      break;

    case 'cancelPermissions':
      cancelAllPermissions();
      break;
  }
});

// ── Event delegation for dynamic elements ────────────────────────────────────

messagesEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  // Permission buttons
  const permBtn = target.closest('.permission-actions button') as HTMLButtonElement | null;
  if (permBtn) {
    const card = permBtn.closest('.permission-card') as HTMLElement | null;
    if (card) respondPermission(card, permBtn.dataset.choice ?? '');
    return;
  }
  // Code block copy buttons
  const copyBtn = target.closest('.copy-btn') as HTMLElement | null;
  if (copyBtn && copyBtn.dataset.action === 'copy') {
    copyCodeBlock(copyBtn);
    return;
  }
});

sessionsPanelEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const deleteBtn = target.closest('[data-action="deleteSession"]') as HTMLElement | null;
  if (deleteBtn) {
    e.stopPropagation();
    vscode.postMessage({ type: 'deleteSession', sessionId: deleteBtn.dataset.sessionId });
    return;
  }
  const item = target.closest('.session-item') as HTMLElement | null;
  if (item && item.dataset.sessionId) {
    sessionsPanelEl.style.display = 'none';
    vscode.postMessage({ type: 'loadSession', sessionId: item.dataset.sessionId });
  }
});

settingsPanelEl.addEventListener('change', (e) => {
  const select = (e.target as HTMLElement).closest('select') as HTMLSelectElement | null;
  if (!select) return;
  if (select.dataset.action === 'setMode') {
    state.currentMode = select.value;
    vscode.postMessage({ type: 'setMode', modeId: select.value });
  } else if (select.dataset.action === 'setConfig') {
    vscode.postMessage({ type: 'setConfig', configId: select.dataset.configId, value: select.value });
  }
});

settingsPanelEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
  if (!btn) return;

  if (btn.dataset.action === 'setApiKey') {
    const keyInput = settingsPanelEl.querySelector('#api-key-input') as HTMLInputElement | null;
    const providerSelect = settingsPanelEl.querySelector('#api-key-provider') as HTMLSelectElement | null;
    const key = keyInput?.value.trim();
    const providerId = providerSelect?.value;
    if (!key || !providerId) return;
    vscode.postMessage({ type: 'setConfig', configId: 'login', value: `${providerId}:${key}` });
    if (keyInput) keyInput.value = '';
    btn.textContent = 'Saved!';
    setTimeout(() => { btn.textContent = 'Set'; }, 2000);
  }

  if (btn.dataset.action === 'insertCommand') {
    settingsPanelEl.style.display = 'none';
    inputEl.value = (btn.dataset.command ?? '') + ' ';
    inputEl.focus();
  }
});

// Notify extension that webview is ready
vscode.postMessage({ type: 'ready' });
statusEl.textContent = 'Connecting to Codeep CLI...';
