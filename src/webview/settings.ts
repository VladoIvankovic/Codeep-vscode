import { settingsPanelEl } from './dom';
import { state } from './state';

function makeSection(title: string): HTMLElement {
  const sec = document.createElement('div');
  sec.className = 'settings-section';
  const h = document.createElement('div');
  h.className = 'settings-section-title';
  h.textContent = title;
  sec.appendChild(h);
  return sec;
}

function makeRow(labelText: string, control: HTMLElement): HTMLElement {
  const row = document.createElement('div');
  row.className = 'settings-row';
  const label = document.createElement('label');
  label.className = 'settings-label';
  label.textContent = labelText;
  row.appendChild(label);
  row.appendChild(control);
  return row;
}

type SelectOption = { value: string; name: string } | [string, string];

function makeSelect(
  options: SelectOption[],
  currentValue: string,
  action: string,
  configId?: string,
): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'settings-select';
  select.dataset.action = action;
  if (configId) select.dataset.configId = configId;
  options.forEach((o) => {
    const value = Array.isArray(o) ? o[0] : o.value;
    const name = Array.isArray(o) ? o[1] : o.name;
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = name;
    if (value === currentValue) opt.selected = true;
    select.appendChild(opt);
  });
  return select;
}

function providerGroupLabel(id: string): string {
  return state.providers.find((p) => p.id === id)?.groupLabel ?? id;
}

function makeGroupedModelSelect(
  options: { value: string; name: string }[],
  currentValue: string,
  action: string,
  configId?: string,
): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'settings-select';
  select.dataset.action = action;
  if (configId) select.dataset.configId = configId;

  // Group models by provider prefix (part before '/')
  const groups = new Map<string, { value: string; name: string }[]>();
  options.forEach((o) => {
    const slash = o.value.indexOf('/');
    const pid = slash !== -1 ? o.value.slice(0, slash) : '_';
    if (!groups.has(pid)) groups.set(pid, []);
    groups.get(pid)!.push(o);
  });

  groups.forEach((models, pid) => {
    const group = document.createElement('optgroup');
    group.label = providerGroupLabel(pid);
    models.forEach((o) => {
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

const SHORTCUTS: Array<[string, string]> = [
  ['Cmd+Shift+C', 'Open chat'],
  ['Cmd+Shift+I', 'Edit selection inline'],
  ['Cmd+Shift+X', 'Send selection'],
  ['Enter', 'Send message'],
  ['Shift+Enter', 'New line'],
  ['@', 'Attach a workspace file'],
];

const COMMANDS: Array<[string, string]> = [
  ['/help', 'Show all commands'],
  ['/review', 'AI code review'],
  ['/diff', 'Review git diff'],
  ['/commit', 'Generate commit message'],
  ['/scan', 'Scan project structure'],
  ['/fix', 'Fix bugs'],
  ['/test', 'Write or run tests'],
  ['/status', 'Show session info'],
  ['/cost', 'Show token usage'],
  ['/export', 'Export conversation'],
];

export function renderSettingsPanel(): void {
  // Don't yank the panel out from under the user mid-edit
  if (document.activeElement && settingsPanelEl.contains(document.activeElement)) return;
  settingsPanelEl.innerHTML = '';

  // ── Model & Mode ──
  const modelSection = makeSection('Model & Mode');
  const modeSelect = makeSelect(
    [['auto', 'Auto — agent acts freely'], ['manual', 'Manual — confirm writes']],
    state.currentMode,
    'setMode',
  );
  modelSection.appendChild(makeRow('Mode', modeSelect));

  const modelOpt = state.configOptions.find((o) => o.id === 'model');
  if (modelOpt) {
    const modelSelect = makeGroupedModelSelect(
      modelOpt.options,
      modelOpt.currentValue,
      'setConfig',
      'model',
    );
    modelSection.appendChild(makeRow('Model', modelSelect));
  }
  settingsPanelEl.appendChild(modelSection);

  // ── Preferences ──
  const otherOpts = state.configOptions.filter((o) => o.id !== 'model');
  if (otherOpts.length > 0) {
    const prefSection = makeSection('Preferences');
    otherOpts.forEach((opt) => {
      const select = makeSelect(opt.options, opt.currentValue, 'setConfig', opt.id);
      prefSection.appendChild(makeRow(opt.name, select));
    });
    settingsPanelEl.appendChild(prefSection);
  }

  // ── API Key ──
  const apiSection = makeSection('API Key');

  if (state.providersUnavailable) {
    // CLI is older than v0.1.34 — session/list_providers is missing. Tell
    // the user how to upgrade rather than rendering a broken/empty form.
    const upgrade = document.createElement('div');
    upgrade.className = 'settings-hint settings-upgrade';
    upgrade.innerHTML =
      'Update the Codeep CLI to use API key UI from VS Code:<br>' +
      '<code>npm install -g codeep@latest</code><br>' +
      'Until then, run <code>/login &lt;provider&gt;</code> in the chat.';
    apiSection.appendChild(upgrade);
    settingsPanelEl.appendChild(apiSection);
  } else {
    const noKeyProviders = new Set(state.providers.filter((p) => !p.requiresKey).map((p) => p.id));
    const providerEntries =
      state.providers.length > 0
        ? state.providers
        : [{ id: '', groupLabel: 'Loading providers…', requiresKey: true } as { id: string; groupLabel: string; requiresKey: boolean }];

    const currentProvider = (modelOpt?.currentValue ?? '').split('/')[0] || '';

    const providerSelect = document.createElement('select');
    providerSelect.className = 'settings-select';
    providerSelect.id = 'api-key-provider';
    providerEntries.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.groupLabel;
      if (p.id === currentProvider) opt.selected = true;
      providerSelect.appendChild(opt);
    });
    apiSection.appendChild(makeRow('Provider', providerSelect));

    providerSelect.addEventListener('change', () => {
      const keyRow = apiSection.querySelector('.api-key-row') as HTMLElement | null;
      if (keyRow) {
        keyRow.style.display = noKeyProviders.has(providerSelect.value) ? 'none' : 'flex';
      }
    });

    const keyRow = document.createElement('div');
    keyRow.className = 'settings-row api-key-row';
    if (noKeyProviders.has(currentProvider)) keyRow.style.display = 'none';
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

    const hint = document.createElement('div');
    hint.className = 'settings-hint';
    hint.id = 'provider-hint';
    const updateHint = (pid: string) => {
      const p = state.providers.find((x) => x.id === pid);
      hint.textContent = p?.hint ?? '';
      hint.style.display = hint.textContent ? 'block' : 'none';
    };
    updateHint(currentProvider);
    providerSelect.addEventListener('change', () => updateHint(providerSelect.value));
    apiSection.appendChild(hint);
    settingsPanelEl.appendChild(apiSection);
  }

  // ── Shortcuts ──
  const helpSection = makeSection('Shortcuts');
  const shortcutGrid = document.createElement('div');
  shortcutGrid.className = 'settings-shortcuts';
  SHORTCUTS.forEach(([key, desc]) => {
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

  // ── Commands ──
  const cmdSection = makeSection('Commands');
  const cmdGrid = document.createElement('div');
  cmdGrid.className = 'settings-commands';
  COMMANDS.forEach(([cmd, desc]) => {
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
