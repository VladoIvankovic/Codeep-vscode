// DOM element references. The HTML is owned by chatPanel.ts (server-side
// template) — these are looked up once at module load and cached. If you add
// a new id in the template, mirror it here.

export const messagesEl = document.getElementById('messages') as HTMLDivElement;
export const inputEl = document.getElementById('input') as HTMLTextAreaElement;
export const btnSend = document.getElementById('btn-send') as HTMLButtonElement;
export const btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
export const btnNew = document.getElementById('btn-new') as HTMLButtonElement;
export const btnSessions = document.getElementById('btn-sessions') as HTMLButtonElement;
export const btnSettings = document.getElementById('btn-settings') as HTMLButtonElement;
export const btnPersonality = document.getElementById('btn-personality') as HTMLButtonElement;
export const btnAttach = document.getElementById('btn-attach') as HTMLButtonElement;
export const btnMode = document.getElementById('btn-mode') as HTMLButtonElement;
export const sessionsPanelEl = document.getElementById('sessions-panel') as HTMLDivElement;
export const settingsPanelEl = document.getElementById('settings-panel') as HTMLDivElement;
export const statusEl = document.getElementById('status') as HTMLSpanElement;
export const modelBadgeEl = document.getElementById('model-badge') as HTMLSpanElement;
export const agentStatusEl = document.getElementById('agent-status') as HTMLDivElement;
export const mentionPopup = document.getElementById('mention-popup') as HTMLDivElement;
export const workspaceEl = document.getElementById('workspace') as HTMLElement;
export const taskOverviewEl = document.getElementById('task-overview') as HTMLElement;
export const taskTitleEl = document.getElementById('task-title') as HTMLHeadingElement;
export const taskSubtitleEl = document.getElementById('task-subtitle') as HTMLParagraphElement;
export const planHostEl = document.getElementById('plan-host') as HTMLDivElement;
export const conversationSectionEl = document.getElementById('conversation-section') as HTMLElement;
export const conversationToggleEl = document.getElementById('conversation-toggle') as HTMLButtonElement;
export const toolActivityEl = document.getElementById('tool-activity') as HTMLElement;
export const activityListEl = document.getElementById('activity-list') as HTMLDivElement;
export const activityCountEl = document.getElementById('activity-count') as HTMLSpanElement;
export const summaryActionsEl = document.getElementById('summary-actions') as HTMLElement;
export const summaryChecksEl = document.getElementById('summary-checks') as HTMLElement;
export const summaryNextEl = document.getElementById('summary-next') as HTMLElement;
export const modeLabelEl = document.getElementById('mode-label') as HTMLSpanElement;
export const personalityLabelEl = document.getElementById('personality-label') as HTMLSpanElement;

// Scroll sentinel — always the last child of messagesEl. scrollIntoView on it
// is more reliable than scrollTop = scrollHeight because the browser
// guarantees it's visible regardless of layout timing.
export const scrollSentinel = document.createElement('div');
scrollSentinel.style.cssText = 'height:1px;flex-shrink:0;pointer-events:none;';
messagesEl.appendChild(scrollSentinel);

export function isNearBottom(): boolean {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
}

export function scrollToBottom(force = false): void {
  if (force || isNearBottom()) {
    messagesEl.appendChild(scrollSentinel);
    scrollSentinel.scrollIntoView({ block: 'end' });
  }
}
