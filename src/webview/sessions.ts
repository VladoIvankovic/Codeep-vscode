import { sessionsPanelEl } from './dom';
import type { SessionListEntry } from './types';

export function renderSessionsPanel(sessions: SessionListEntry[] | undefined): void {
  sessionsPanelEl.innerHTML = '';
  if (!sessions || sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sessions-empty';
    empty.textContent = 'No sessions found';
    sessionsPanelEl.appendChild(empty);
    return;
  }
  sessions.forEach((s) => {
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
