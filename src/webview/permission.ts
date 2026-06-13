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

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export function appendPermission(
  requestId: number,
  label: string,
  detail: string | undefined,
  toolName: string | undefined,
  toolInput: ToolInput | undefined,
  options?: PermissionOption[],
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
  // Per-kind UI hints. The CLI's allow_always / reject_always are
  // session-scoped (cleared when the CLI exits), not persisted — but
  // "always" reads as "forever", so relabel to make the scope explicit.
  const HINTS: Record<string, { label: string; tooltip: string }> = {
    allow_once:    { label: 'Allow',                  tooltip: 'Allow this tool just for this call' },
    allow_always:  { label: 'Allow for this session', tooltip: 'Auto-allow this tool until the CLI restarts' },
    reject_once:   { label: 'Reject',                 tooltip: 'Block this call; the agent may try a different approach' },
    reject_always: { label: 'Reject for this session', tooltip: 'Block this tool until the CLI restarts' },
  };
  // Render the server's actual option set when present (includes
  // reject_always, and any option a future CLI adds); fall back to the
  // built-in three for older CLIs that send no options array.
  const opts: PermissionOption[] = (options && options.length)
    ? options
    : [
        { optionId: 'allow_once',   name: 'Allow',                  kind: 'allow_once' },
        { optionId: 'allow_always', name: 'Allow for this session', kind: 'allow_always' },
        { optionId: 'reject_once',  name: 'Reject',                 kind: 'reject_once' },
      ];
  opts.forEach((opt) => {
    const hint = HINTS[opt.kind];
    const btn = document.createElement('button');
    btn.textContent = hint?.label ?? opt.name;
    if (hint) btn.title = hint.tooltip;
    if (opt.kind.startsWith('reject')) btn.className = 'reject';
    btn.dataset.choice = opt.kind;
    btn.dataset.optionId = opt.optionId;
    actions.appendChild(btn);
  });
  div.appendChild(actions);

  messagesEl.appendChild(div);
  setTimeout(() => div.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
}

export function respondPermission(card: HTMLElement, choice: string, optionId?: string): void {
  const btn = card.querySelector<HTMLElement>(`[data-choice="${choice}"]`);
  const label = btn?.textContent ?? choice;
  // Resolve the exact server optionId: explicit arg (button click) →
  // the button's stored id → the kind string (diff-lens path; the
  // built-in optionId equals its kind).
  const resolvedOptionId = optionId ?? btn?.dataset.optionId ?? choice;
  card.innerHTML = '';
  const resolved = document.createElement('div');
  resolved.className = 'permission-resolved';
  resolved.textContent = label;
  card.appendChild(resolved);
  vscode.postMessage({
    type: 'permissionResponse',
    requestId: Number(card.dataset.requestId),
    choice,
    optionId: resolvedOptionId,
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
