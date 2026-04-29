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
export const sessionsPanelEl = document.getElementById('sessions-panel') as HTMLDivElement;
export const settingsPanelEl = document.getElementById('settings-panel') as HTMLDivElement;
export const statusEl = document.getElementById('status') as HTMLSpanElement;
export const agentStatusEl = document.getElementById('agent-status') as HTMLDivElement;
export const mentionPopup = document.getElementById('mention-popup') as HTMLDivElement;

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
