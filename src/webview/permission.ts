import { messagesEl } from './dom';
import { vscode } from './state';

interface ToolInput {
  old_string?: string;
  new_string?: string;
  new_content?: string;
  command?: string;
  args?: string;
  cwd?: string;
  [key: string]: unknown;
}

function renderPermissionPreview(toolName: string | undefined, input: ToolInput | null | undefined): HTMLElement | null {
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

  // execute_command: command + cwd in monospace
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

  return null;
}

export function appendPermission(
  requestId: number,
  label: string,
  detail: string | undefined,
  toolName: string | undefined,
  toolInput: ToolInput | undefined,
): void {
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
  const choices: Array<['allow_once' | 'allow_always' | 'reject_once', string]> = [
    ['allow_once', 'Allow once'],
    ['allow_always', 'Allow always'],
    ['reject_once', 'Reject'],
  ];
  choices.forEach(([choice, btnLabel]) => {
    const btn = document.createElement('button');
    btn.textContent = btnLabel;
    if (choice === 'reject_once') btn.className = 'reject';
    btn.dataset.choice = choice;
    actions.appendChild(btn);
  });
  div.appendChild(actions);

  messagesEl.appendChild(div);
  setTimeout(() => div.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
}

export function respondPermission(card: HTMLElement, choice: string): void {
  const label = card.querySelector(`[data-choice="${choice}"]`)?.textContent ?? choice;
  card.innerHTML = '';
  const resolved = document.createElement('div');
  resolved.className = 'permission-resolved';
  resolved.textContent = label;
  card.appendChild(resolved);
  vscode.postMessage({
    type: 'permissionResponse',
    requestId: Number(card.dataset.requestId),
    choice,
  });
  setTimeout(() => {
    card.style.transition = 'opacity 0.4s';
    card.style.opacity = '0';
    setTimeout(() => card.remove(), 400);
  }, 3000);
}

export function cancelAllPermissions(): void {
  messagesEl.querySelectorAll('.permission-card').forEach((node) => {
    const card = node as HTMLElement;
    if (!card.querySelector('.permission-resolved')) {
      card.innerHTML = '<div class="permission-resolved">Cancelled</div>';
    }
    setTimeout(() => {
      card.style.transition = 'opacity 0.4s';
      card.style.opacity = '0';
      setTimeout(() => card.remove(), 400);
    }, 1000);
  });
}
