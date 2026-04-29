import { messagesEl, agentStatusEl, scrollToBottom } from './dom';
import { renderMarkdown } from './markdown';
import { state } from './state';
import type { PlanEntry } from './types';

export type Role = 'user' | 'assistant' | 'system';

export function appendMessage(role: Role, text: string): HTMLElement {
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
  if (role === 'system') state.lastErrorEl = div;
  scrollToBottom(true);
  return contentEl;
}

export function dismissLastError(): void {
  const el = state.lastErrorEl;
  if (!el) return;
  state.lastErrorEl = null;
  el.style.transition = 'opacity 0.4s';
  el.style.opacity = '0';
  setTimeout(() => el.remove(), 400);
}

// ── Agent status (the small "Thinking…" / current-tool line) ──────────────────

export function setAgentStatus(text: string, isThinking: boolean): void {
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

export function clearAgentStatus(): void {
  agentStatusEl.classList.remove('visible');
  agentStatusEl.innerHTML = '';
}

// ── Tool call group ───────────────────────────────────────────────────────────

export function appendToolCall(text: string, toolCallId: string): void {
  if (!state.currentToolGroupEl) {
    const group = document.createElement('div');
    group.className = 'tool-group collapsed';
    const label = document.createElement('span');
    label.className = 'tool-group-label';
    label.addEventListener('click', () => group.classList.toggle('collapsed'));
    const statusSpan = document.createElement('span');
    statusSpan.className = 'tool-group-status';
    statusSpan.textContent = 'Working...';
    const countSpan = document.createElement('span');
    countSpan.className = 'tool-group-count';
    label.append(statusSpan, ' ', countSpan);
    const items = document.createElement('div');
    items.className = 'tool-group-items';
    group.appendChild(label);
    group.appendChild(items);
    messagesEl.appendChild(group);
    state.currentToolGroupEl = group;
  }
  const item = document.createElement('div');
  item.className = 'tool-item';
  item.textContent = text;
  if (toolCallId) state.toolCallItems.set(toolCallId, item);
  state.currentToolGroupEl.querySelector('.tool-group-items')?.appendChild(item);
  const n = state.currentToolGroupEl.querySelectorAll('.tool-item').length;
  const countSpan = state.currentToolGroupEl.querySelector('.tool-group-count');
  if (countSpan) countSpan.textContent = `(${n})`;
  scrollToBottom(true);
}

export function updateToolCall(toolCallId: string, status: string): void {
  const item = state.toolCallItems.get(toolCallId);
  if (!item) return;
  item.dataset.status = status;
  if (status === 'completed') item.style.opacity = '0.5';
  if (status === 'failed') item.style.color = '#f87171';
  state.toolCallItems.delete(toolCallId);
}

export function finalizeToolGroup(): void {
  if (!state.currentToolGroupEl) return;
  const statusSpan = state.currentToolGroupEl.querySelector('.tool-group-status') as HTMLElement | null;
  if (statusSpan) {
    statusSpan.textContent = '✓ Done';
    statusSpan.style.color = '#4ade80';
  }
}

// ── Thought (collapsible reasoning stream) ────────────────────────────────────

export function appendThought(text: string): void {
  if (!state.currentThoughtEl) {
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
    state.currentThoughtEl = body;
  }
  state.currentThoughtEl.dataset.raw = (state.currentThoughtEl.dataset.raw ?? '') + text;
  state.currentThoughtEl.textContent = state.currentThoughtEl.dataset.raw ?? '';
  scrollToBottom();
}

// ── Plan card (live agent plan with status icons) ────────────────────────────

const PLAN_STATUS_ICON: Record<PlanEntry['status'], string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
};

export function renderPlan(entries: PlanEntry[] | undefined): void {
  if (!entries || entries.length === 0) {
    state.currentPlanEl?.remove();
    state.currentPlanEl = null;
    return;
  }
  if (!state.currentPlanEl) {
    const card = document.createElement('div');
    card.className = 'plan-card';
    const label = document.createElement('div');
    label.className = 'plan-label';
    label.textContent = 'Plan';
    card.appendChild(label);
    const list = document.createElement('div');
    list.className = 'plan-list';
    card.appendChild(list);
    messagesEl.appendChild(card);
    state.currentPlanEl = card;
  }
  const list = state.currentPlanEl.querySelector('.plan-list') as HTMLElement | null;
  if (!list) return;
  list.innerHTML = '';
  entries.forEach((e) => {
    const row = document.createElement('div');
    row.className = `plan-item plan-${e.status ?? 'pending'}`;
    if (e.priority === 'high') row.classList.add('plan-high');
    const icon = document.createElement('span');
    icon.className = 'plan-icon';
    icon.textContent = PLAN_STATUS_ICON[e.status] ?? '○';
    const text = document.createElement('span');
    text.className = 'plan-text';
    text.textContent = e.content ?? '';
    row.appendChild(icon);
    row.appendChild(text);
    list.appendChild(row);
  });
  scrollToBottom();
}

// Reset all per-turn renderers — called on new userMessage and responseEnd.
export function resetTurn(): void {
  state.currentAssistantEl = null;
  state.currentToolGroupEl = null;
  state.currentThoughtEl = null;
}
