import {
  activityCountEl,
  activityListEl,
  agentStatusEl,
  messagesEl,
  planHostEl,
  scrollToBottom,
  summaryActionsEl,
  summaryChecksEl,
  summaryNextEl,
  taskOverviewEl,
  taskSubtitleEl,
  taskTitleEl,
  toolActivityEl,
} from './dom';
import { renderMarkdown } from './markdown';
import { state } from './state';
import type { PlanEntry } from './types';

export type Role = 'user' | 'assistant' | 'system';

export function appendMessage(role: Role, text: string): HTMLElement {
  document.getElementById('conversation-empty')?.remove();
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
  icon.className = isThinking
    ? 'codicon codicon-loading codicon-modifier-spin'
    : 'codicon codicon-tools';
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

// ACP tool kinds map straight to an icon. The title regex below is only a
// fallback for kinds the CLI doesn't send (or doesn't have) — matching on the
// title alone made "Edit src/webview/list.ts" render the search icon.
const TOOL_KIND_ICON: Record<string, string> = {
  read: 'codicon-search',
  search: 'codicon-search',
  edit: 'codicon-edit',
  write: 'codicon-edit',
  delete: 'codicon-edit',
  move: 'codicon-edit',
  execute: 'codicon-terminal',
  fetch: 'codicon-globe',
  think: 'codicon-lightbulb',
};

function toolIconClass(kind: string | undefined, text: string): string {
  const mapped = kind ? TOOL_KIND_ICON[kind.toLowerCase()] : undefined;
  if (mapped) return mapped;
  const value = text.toLowerCase();
  if (/read|search|inspect|list/.test(value)) return 'codicon-search';
  if (/edit|write|patch|create/.test(value)) return 'codicon-edit';
  if (/command|terminal|run|test|build|lint/.test(value)) return 'codicon-terminal';
  return 'codicon-tools';
}

export { toolIconClass as _toolIconClassForTest };

export function appendToolCall(text: string, toolCallId: string, kind?: string): void {
  if (!state.currentToolGroupEl) {
    activityListEl.innerHTML = '';
    toolActivityEl.classList.remove('is-empty');
    const group = document.createElement('div');
    group.className = 'tool-group';
    const label = document.createElement('button');
    label.className = 'tool-group-label';
    label.type = 'button';
    label.setAttribute('aria-expanded', 'true');
    label.addEventListener('click', () => {
      const collapsed = group.classList.toggle('collapsed');
      label.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
    const leadingIcon = document.createElement('span');
    leadingIcon.className = 'codicon codicon-run-all tool-group-icon';
    leadingIcon.setAttribute('aria-hidden', 'true');
    const statusSpan = document.createElement('span');
    statusSpan.className = 'tool-group-status';
    statusSpan.textContent = 'Current run';
    const countSpan = document.createElement('span');
    countSpan.className = 'tool-group-count';
    const chevron = document.createElement('span');
    chevron.className = 'codicon codicon-chevron-down tool-group-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    label.append(leadingIcon, statusSpan, countSpan, chevron);
    const items = document.createElement('div');
    items.className = 'tool-group-items';
    group.appendChild(label);
    group.appendChild(items);
    activityListEl.appendChild(group);
    state.currentToolGroupEl = group;
  }
  const item = document.createElement('div');
  item.className = 'tool-item';
  const icon = document.createElement('span');
  icon.className = `codicon ${toolIconClass(kind, text)} tool-item-icon`;
  const label = document.createElement('span');
  label.className = 'tool-item-label';
  label.textContent = text;
  item.append(icon, label);
  if (toolCallId) {
    state.toolCallItems.set(toolCallId, item);
    state.toolCallKinds.set(toolCallId, kind ?? '');
  }
  state.currentToolGroupEl.querySelector('.tool-group-items')?.appendChild(item);
  const n = state.currentToolGroupEl.querySelectorAll('.tool-item').length;
  const countSpan = state.currentToolGroupEl.querySelector('.tool-group-count');
  if (countSpan) countSpan.textContent = `${n}`;
  activityCountEl.textContent = `${n}`;
  state.runStats.actions = n;
  updateRunSummary();
}

export function updateToolCall(toolCallId: string, status: string): void {
  const item = state.toolCallItems.get(toolCallId);
  if (!item) return;
  item.dataset.status = status;
  const icon = item.querySelector('.tool-item-icon') as HTMLElement | null;
  if (status === 'completed' && icon) icon.className = 'codicon codicon-check tool-item-icon';
  if (status === 'failed' && icon) icon.className = 'codicon codicon-error tool-item-icon';
  // A single tool call emits multiple tool_call_update notifications
  // (in_progress → completed/failed). Only drop the entry once it reaches a
  // terminal state — deleting on the first non-terminal update would leave the
  // row stuck looking active, because the terminal update then finds no item.
  if (status === 'completed' || status === 'failed') {
    if (!item.dataset.finalized) {
      item.dataset.finalized = 'true';
      // Only command executions count as checks. Matching on the tool title
      // instead made a plain read of `chatPanel.test.ts` register as a check —
      // and a failed read paint the whole run summary red.
      if (state.toolCallKinds.get(toolCallId) === 'execute') {
        if (status === 'completed') state.runStats.checksPassed += 1;
        else state.runStats.checksFailed += 1;
      }
      updateRunSummary();
    }
    state.toolCallItems.delete(toolCallId);
    state.toolCallKinds.delete(toolCallId);
  }
}

export function finalizeToolGroup(): void {
  if (!state.currentToolGroupEl) return;
  const statusSpan = state.currentToolGroupEl.querySelector('.tool-group-status') as HTMLElement | null;
  if (statusSpan) {
    statusSpan.textContent = 'Run complete';
  }
  state.currentToolGroupEl.classList.add('is-complete');
}

// ── Thought (collapsible reasoning stream) ────────────────────────────────────

export function appendThought(text: string): void {
  if (!state.currentThoughtEl) {
    const card = document.createElement('div');
    card.className = 'thought-card collapsed';
    const label = document.createElement('div');
    label.className = 'thought-label';
    label.innerHTML = '<span class="codicon codicon-lightbulb" aria-hidden="true"></span><span>Thinking</span>';
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
  pending: 'codicon-circle-large-outline',
  in_progress: 'codicon-loading codicon-modifier-spin',
  completed: 'codicon-check',
};

export function renderPlan(entries: PlanEntry[] | undefined): void {
  if (!entries || entries.length === 0) {
    state.currentPlanEl?.remove();
    state.currentPlanEl = null;
    if (!document.getElementById('plan-empty')) {
      const empty = document.createElement('div');
      empty.id = 'plan-empty';
      empty.className = 'timeline-empty';
      empty.innerHTML = '<span class="codicon codicon-list-tree" aria-hidden="true"></span><span>Plan steps will appear here as the agent works.</span>';
      planHostEl.appendChild(empty);
    }
    return;
  }
  if (!state.currentPlanEl) {
    document.getElementById('plan-empty')?.remove();
    const card = document.createElement('div');
    card.className = 'plan-card';
    const list = document.createElement('div');
    list.className = 'plan-list';
    card.appendChild(list);
    planHostEl.appendChild(card);
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
    icon.classList.add('codicon', ...(PLAN_STATUS_ICON[e.status] ?? PLAN_STATUS_ICON.pending).split(' '));
    const text = document.createElement('span');
    text.className = 'plan-text';
    text.textContent = e.content ?? '';
    row.appendChild(icon);
    row.appendChild(text);
    list.appendChild(row);
  });
  taskOverviewEl.classList.toggle('is-active', entries.some((e) => e.status === 'in_progress'));
}

function updateRunSummary(): void {
  summaryActionsEl.textContent = `${state.runStats.actions}`;
  const checks = state.runStats.checksPassed + state.runStats.checksFailed;
  if (checks === 0) {
    summaryChecksEl.textContent = 'Not run';
    summaryChecksEl.className = '';
  } else if (state.runStats.checksFailed > 0) {
    summaryChecksEl.textContent = `${state.runStats.checksFailed} failed`;
    summaryChecksEl.className = 'summary-bad';
  } else {
    summaryChecksEl.textContent = `${state.runStats.checksPassed} passed`;
    summaryChecksEl.className = 'summary-good';
  }
}

export function beginTask(text: string): void {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? 'New task';
  taskTitleEl.textContent = firstLine.length > 92 ? `${firstLine.slice(0, 89)}...` : firstLine;
  taskSubtitleEl.textContent = 'Codeep is preparing the execution timeline.';
  taskOverviewEl.classList.remove('is-ready', 'is-complete');
  taskOverviewEl.classList.add('is-active');

  state.currentPlanEl?.remove();
  state.currentPlanEl = null;
  planHostEl.innerHTML = '<div id="plan-empty" class="timeline-empty is-active"><span class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span><span>Building the plan...</span></div>';

  activityListEl.innerHTML = '<div id="activity-empty" class="activity-empty">Waiting for the first tool call.</div>';
  toolActivityEl.classList.add('is-empty');
  activityCountEl.textContent = '0';
  state.runStats.actions = 0;
  state.runStats.checksPassed = 0;
  state.runStats.checksFailed = 0;
  state.toolCallKinds.clear();
  summaryNextEl.textContent = 'In progress';
  updateRunSummary();
}

export function completeTask(): void {
  taskSubtitleEl.textContent = 'Run complete. Review the result or continue with a follow-up.';
  taskOverviewEl.classList.remove('is-active');
  taskOverviewEl.classList.add('is-complete');
  // renderPlan() is the only other thing that clears beginTask()'s spinning
  // "Building the plan..." placeholder, and it only runs on a `plan`
  // notification. Without this, any run that never emitted a plan — including
  // every restored transcript — ends on a spinner that never stops.
  if (!state.currentPlanEl) {
    planHostEl.innerHTML = '<div id="plan-empty" class="timeline-empty"><span class="codicon codicon-list-tree" aria-hidden="true"></span><span>No plan steps for this run.</span></div>';
  }
  summaryNextEl.textContent = state.runStats.checksFailed > 0 ? 'Review checks' : 'Ready for follow-up';
}

export function resetWorkbench(): void {
  taskTitleEl.textContent = 'Ready for your next task';
  taskSubtitleEl.textContent = 'Describe the outcome and Codeep will build a live execution timeline.';
  taskOverviewEl.className = 'is-ready';
  planHostEl.innerHTML = '<div id="plan-empty" class="timeline-empty"><span class="codicon codicon-list-tree" aria-hidden="true"></span><span>Plan steps will appear here as the agent works.</span></div>';
  activityListEl.innerHTML = '<div id="activity-empty" class="activity-empty">File reads, edits and checks will be grouped here.</div>';
  toolActivityEl.classList.add('is-empty');
  activityCountEl.textContent = '0';
  state.runStats.actions = 0;
  state.runStats.checksPassed = 0;
  state.runStats.checksFailed = 0;
  summaryNextEl.textContent = 'Send a task';
  updateRunSummary();
}

// Reset all per-turn renderers — called on new userMessage and responseEnd.
export function resetTurn(): void {
  state.currentAssistantEl = null;
  state.currentToolGroupEl = null;
  state.currentThoughtEl = null;
  // Release element references for any tool calls that never got a terminal
  // update (interrupted/cancelled runs, or a CLI that omits the final update).
  // finalizeToolGroup() already ran at responseEnd, so nothing downstream needs
  // these ids — without this they'd accumulate detached nodes across turns.
  state.toolCallItems.clear();
  state.toolCallKinds.clear();
}
