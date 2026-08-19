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
  ['Cmd+Shift+C',  'Open chat'],
  ['Cmd+Shift+I',  'Edit selection inline'],
  ['Cmd+Shift+X',  'Send selection to chat'],
  ['Cmd+Shift+A',  'Attach active file as @-mention'],
  ['Enter',        'Send message'],
  ['Shift+Enter',  'New line in input'],
  ['@',            'Attach a workspace file or symbol'],
  ['Cmd+K',        'Open VS Code command palette (try "Codeep: …")'],
];

// Slash commands organised so the panel doesn't sprawl. Each chip
// clicks-to-insert the command into the input.
const COMMANDS: Array<[string, string]> = [
  // Core
  ['/help',     'Show all commands'],
  ['/status',   'Show session info'],
  ['/cost',     'Show token usage and cost'],
  ['/compact',  'Summarize older messages to free up context'],
  ['/commands', 'List custom slash commands in .codeep/commands/*.md'],
  ['/recall',   'Search across ALL saved sessions (--summarize for an LLM recap)'],
  // Personalization
  ['/memory',     'Add notes that travel with every request in this project'],
  ['/profile',    'Save / load provider + model + settings presets'],
  ['/personality', 'Switch agent tone (concise / verbose / security / senior-reviewer …)'],
  // Agent flow
  ['/plan',       'Preview the agent\'s plan before any file gets touched'],
  ['/go',         'Execute the plan from /plan'],
  ['/insights',   'Activity summary over the last N days'],
  // Code workflow
  ['/diff',     'Review git diff with AI'],
  ['/review',   'AI code review'],
  ['/commit',   'Generate commit message'],
  ['/fix',      'Fix bugs'],
  ['/test',     'Write or run tests'],
  ['/scan',     'Scan project structure'],
  // Power user
  ['/checkpoint', 'Save a named conversation snapshot'],
  ['/rewind',     'Restore a checkpoint by id'],
  ['/mcp',        'Manage MCP servers (browse, add, remove)'],
  ['/skills',     'Manage skill bundles (browse, install, publish)'],
  ['/hooks',      'Show lifecycle hooks (.codeep/hooks/*.sh)'],
  ['/openrouter', 'OpenRouter routing preferences'],
  ['/export',     'Export conversation as md / json / txt'],
];

function makeMetaItem(label: string, value: string, title?: string): HTMLElement {
  const item = document.createElement('div');
  item.className = 'personality-meta-item';
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.textContent = value;
  if (title) description.title = title;
  item.append(term, description);
  return item;
}

function makePersonalityButton(label: string, command: string, icon: string, primary = false): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `personality-action${primary ? ' is-primary' : ''}`;
  button.dataset.action = 'runVsCodeCommand';
  button.dataset.command = command;
  const iconEl = document.createElement('span');
  iconEl.className = `codicon ${icon}`;
  iconEl.setAttribute('aria-hidden', 'true');
  const labelEl = document.createElement('span');
  labelEl.textContent = label;
  button.append(iconEl, labelEl);
  return button;
}

function renderPersonalitySection(): HTMLElement {
  const section = makeSection('Custom bot');
  section.classList.add('personality-section');

  const heading = document.createElement('div');
  heading.className = 'personality-heading';
  const mark = document.createElement('span');
  mark.className = 'personality-mark codicon codicon-sparkle';
  mark.setAttribute('aria-hidden', 'true');
  const headingCopy = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = 'Specialist for this run';
  const copy = document.createElement('span');
  copy.textContent = 'Choose how Codeep works before you send the next task.';
  headingCopy.append(title, copy);
  heading.append(mark, headingCopy);
  section.appendChild(heading);

  if (!state.personalitiesLoaded) {
    const loading = document.createElement('div');
    loading.className = 'personality-loading';
    loading.setAttribute('role', 'status');
    loading.innerHTML = '<span class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span><span>Loading custom bots…</span>';
    section.appendChild(loading);
  } else {
    const pickerLabel = document.createElement('label');
    pickerLabel.className = 'sr-only';
    pickerLabel.htmlFor = 'personality-select';
    pickerLabel.textContent = 'Active custom bot';
    const picker = document.createElement('select');
    picker.id = 'personality-select';
    picker.className = 'settings-select personality-select';
    picker.dataset.action = 'setPersonality';

    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Default Codeep';
    defaultOption.selected = state.activePersonality === null;
    picker.appendChild(defaultOption);

    const groups = new Map([
      ['project', document.createElement('optgroup')],
      ['global', document.createElement('optgroup')],
      ['builtin', document.createElement('optgroup')],
    ]);
    groups.get('project')!.label = 'This project';
    groups.get('global')!.label = 'Your custom bots';
    groups.get('builtin')!.label = 'Built in';
    state.personalities.forEach((personality) => {
      const option = document.createElement('option');
      option.value = personality.name;
      option.textContent = personality.available
        ? personality.displayName
        : `${personality.displayName} — unavailable here`;
      option.disabled = !personality.available;
      option.selected = personality.name === state.activePersonality;
      groups.get(personality.source)?.appendChild(option);
    });
    groups.forEach((group) => {
      if (group.childElementCount > 0) picker.appendChild(group);
    });
    section.append(pickerLabel, picker);

    const active = state.personalities.find((item) => item.name === state.activePersonality);
    const card = document.createElement('article');
    card.className = 'personality-card';
    card.setAttribute('aria-live', 'polite');
    const cardHeader = document.createElement('div');
    cardHeader.className = 'personality-card-header';
    const identity = document.createElement('div');
    const activeName = document.createElement('strong');
    activeName.textContent = active?.displayName || 'Default Codeep';
    const slug = document.createElement('code');
    slug.textContent = active ? active.name : 'default';
    identity.append(activeName, slug);
    const badge = document.createElement('span');
    badge.className = 'personality-source';
    badge.textContent = active
      ? active.source === 'builtin' ? 'Built-in' : active.source === 'project' ? 'Project' : 'Synced'
      : 'Default';
    cardHeader.append(identity, badge);

    const description = document.createElement('p');
    description.textContent = active?.description || 'The standard Codeep agent with your current model and unrestricted tools.';

    const metadata = document.createElement('dl');
    metadata.className = 'personality-meta';
    const model = active?.model || 'Automatic';
    const tools = active
      ? active.restrictTools
        ? active.tools.length > 0 ? active.tools.join(', ') : 'None'
        : 'Unrestricted'
      : 'Unrestricted';
    const scope = active?.scope || 'All projects';
    const scopeTitle = active?.scope === 'Selected projects' && active.projects.length > 0
      ? active.projects.join(', ')
      : undefined;
    metadata.append(
      makeMetaItem('Model', model, model),
      makeMetaItem('Tools', tools, tools),
      makeMetaItem('Scope', scope, scopeTitle),
    );
    if (active?.scope === 'Selected projects') {
      const projectList = active.projects.length > 0 ? active.projects.join(', ') : 'No projects selected';
      metadata.append(makeMetaItem('Projects', projectList, projectList));
    }
    card.append(cardHeader, description, metadata);

    if (active && !active.structured) {
      const legacy = document.createElement('div');
      legacy.className = 'personality-legacy';
      const legacyIcon = document.createElement('span');
      legacyIcon.className = 'codicon codicon-info';
      legacyIcon.setAttribute('aria-hidden', 'true');
      const legacyCopy = document.createElement('span');
      legacyCopy.textContent = active.source === 'builtin'
        ? 'Built-in personality: model, tools, and scope remain unrestricted.'
        : 'Legacy prompt: model, tools, and scope remain unrestricted.';
      legacy.append(legacyIcon, legacyCopy);
      card.appendChild(legacy);
    }
    section.appendChild(card);
  }

  if (state.personalityError) {
    const error = document.createElement('div');
    error.className = 'personality-error';
    error.setAttribute('role', 'alert');
    error.textContent = state.personalityError;
    section.appendChild(error);
  }

  const actions = document.createElement('div');
  actions.className = 'personality-actions';
  actions.append(
    makePersonalityButton('Manage', 'codeep.managePersonalities', 'codicon-settings-gear', true),
    makePersonalityButton('Sync', 'codeep.syncPersonalities', 'codicon-sync'),
  );
  section.appendChild(actions);
  const footer = document.createElement('p');
  footer.className = 'personality-footer';
  footer.textContent = state.personalitySource === 'rpc'
    ? 'Connected to Codeep CLI · runtime rules are enforced by the core agent.'
    : 'Compatible mode · reads shared project and ~/.codeep personality files.';
  section.appendChild(footer);
  return section;
}

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

  // ── Custom bot ──
  settingsPanelEl.appendChild(renderPersonalitySection());

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

  // ── Extensions (MCP + Skills) ──
  // Surfaced here as a discoverability fix: the audit flagged that these
  // capabilities are reachable only through the command palette. Each
  // chip dispatches a `runVsCodeCommand` message the host extension
  // handles by executing the named VS Code command.
  const extSection = makeSection('Extensions');
  const extGrid = document.createElement('div');
  extGrid.className = 'settings-commands';
  const EXTENSION_CMDS: Array<[string, string, string]> = [
    // [label,                         VS Code command id,             tooltip]
    ['+ MCP server',                   'codeep.mcpAddServer',          'Add an MCP server (wizard writes to .codeep/mcp_servers.json)'],
    ['Manage MCP',                     'codeep.mcpRemoveServer',       'Remove a configured MCP server'],
    ['Open MCP config',                'codeep.mcpOpenConfig',         'Open mcp_servers.json directly'],
    ['+ Skill bundle',                 'codeep.skillsCreateBundle',    'Scaffold a new project skill bundle'],
    ['Browse skill bundles',           'codeep.skillsBundles',         'Open an installed bundle\'s SKILL.md'],
    ['Open skills folder',             'codeep.skillsOpenFolder',      'Reveal .codeep/skills/ in OS file manager'],
  ];
  EXTENSION_CMDS.forEach(([label, cmd, tooltip]) => {
    const btn = document.createElement('button');
    btn.className = 'settings-cmd-chip';
    btn.textContent = label;
    btn.title = tooltip;
    btn.dataset.action = 'runVsCodeCommand';
    btn.dataset.command = cmd;
    extGrid.appendChild(btn);
  });
  extSection.appendChild(extGrid);
  settingsPanelEl.appendChild(extSection);
}
