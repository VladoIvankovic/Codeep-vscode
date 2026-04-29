import { inputEl, mentionPopup } from './dom';
import { state, vscode } from './state';
import type { FileSearchItem } from './types';

function getMentionContext(): { start: number; query: string } | null {
  const caret = inputEl.selectionStart;
  if (caret === null) return null;
  const before = inputEl.value.slice(0, caret);
  // Match an @-token at the end of `before`. Token must be preceded by start
  // or whitespace so we don't catch email addresses or decorators.
  const m = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return null;
  return { start: caret - m[1].length - 1, query: m[1] };
}

export function updateMentionPopup(): void {
  const ctx = getMentionContext();
  if (!ctx) {
    closeMentionPopup();
    return;
  }
  state.mention = state.mention ?? { start: ctx.start, query: ctx.query, items: [], selected: 0 };
  state.mention.start = ctx.start;
  state.mention.query = ctx.query;
  if (state.mentionDebounce) clearTimeout(state.mentionDebounce);
  state.mentionDebounce = setTimeout(() => {
    const id = ++state.mentionQueryId;
    vscode.postMessage({ type: 'fileSearch', query: ctx.query, queryId: id });
  }, 100);
  renderMentionPopup();
}

export function renderMentionPopup(): void {
  if (!state.mention) {
    mentionPopup.style.display = 'none';
    return;
  }
  mentionPopup.innerHTML = '';
  if (state.mention.items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'mention-empty';
    empty.textContent = state.mention.query
      ? `No matches for "${state.mention.query}"`
      : 'Type to search files…';
    mentionPopup.appendChild(empty);
  } else {
    state.mention.items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'mention-item' + (i === state.mention!.selected ? ' selected' : '');
      row.dataset.index = String(i);
      const name = document.createElement('span');
      name.className = 'mention-name';
      name.textContent = it.name;
      const path = document.createElement('span');
      path.className = 'mention-path';
      const dir = it.path.slice(0, Math.max(0, it.path.length - it.name.length - 1));
      path.textContent = dir;
      row.appendChild(name);
      if (dir) row.appendChild(path);
      mentionPopup.appendChild(row);
    });
  }
  mentionPopup.style.display = 'block';
}

export function closeMentionPopup(): void {
  state.mention = null;
  mentionPopup.style.display = 'none';
  if (state.mentionDebounce) {
    clearTimeout(state.mentionDebounce);
    state.mentionDebounce = null;
  }
}

export function commitMention(item: FileSearchItem | undefined): void {
  if (!state.mention || !item) return;
  const before = inputEl.value.slice(0, state.mention.start);
  const after = inputEl.value.slice(inputEl.selectionStart ?? state.mention.start);
  const insert = '@' + item.path + ' ';
  inputEl.value = before + insert + after;
  const newCaret = before.length + insert.length;
  inputEl.setSelectionRange(newCaret, newCaret);
  closeMentionPopup();
  inputEl.focus();
}

export function applyFileSearchResults(queryId: number, items: FileSearchItem[]): void {
  // Ignore stale responses (slow query returning after a newer one)
  if (!state.mention || queryId !== state.mentionQueryId) return;
  state.mention.items = items;
  state.mention.selected = 0;
  renderMentionPopup();
}
