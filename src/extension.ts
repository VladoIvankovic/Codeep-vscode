import * as vscode from 'vscode';
import { ChatPanel, type ChatStatusState } from './chatPanel';
import { registerDiffPreview, DIFF_PREVIEW_SCHEME } from './diffPreview';
import { DiffPreviewCodeLensProvider } from './diffCodeLens';
import { listServers, addServer, removeServer, configPath, McpScope, VsCodeMcpServer } from './mcpConfigFile';
import { registerCodeActions } from './codeActions';
import { registerGenerateCommitMessage } from './commitMessage';
import { registerSessionsTree } from './sessionsTree';
import { registerChatParticipant } from './chatParticipant';
import { registerCodeepTools } from './codeepTools';
import { registerProfileCommands } from './profile';

export function activate(context: vscode.ExtensionContext) {
  // Register before ChatPanel — chatPanel.ts calls showProposedChange()
  // which requires the provider to exist.
  registerDiffPreview(context);

  const chatPanel = new ChatPanel(context);

  // Accept / Reject CodeLens above the proposed-change diff editor — lets
  // the user respond to a permission request from the diff itself without
  // round-tripping to the chat sidebar.
  const codeLensProvider = new DiffPreviewCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: DIFF_PREVIEW_SCHEME }, codeLensProvider),
  );
  // Expose a refresher to ChatPanel so it can re-query lenses after a
  // permission request appears (initial doc opens before VS Code asks for
  // lenses, so we need to nudge after we register the URI mapping).
  chatPanel.setDiffLensRefresher(() => codeLensProvider.refresh());

  // Commands fired by the lens. Forward to the chat panel which already
  // tracks pending permission resolvers — same code path as the webview
  // Allow/Reject buttons.
  const respondFromDiff = (uriStr: string, choice: 'allow_once' | 'allow_always' | 'reject_once') => {
    try {
      const uri = vscode.Uri.parse(uriStr);
      chatPanel.respondToPermissionFromDiff(uri, choice);
    } catch (err) {
      vscode.window.showWarningMessage(`Codeep: could not respond to diff (${(err as Error).message})`);
    }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('codeep.acceptProposedChange', (uriStr: string) =>
      respondFromDiff(uriStr, 'allow_once')),
    vscode.commands.registerCommand('codeep.acceptProposedChangeAlways', (uriStr: string) =>
      respondFromDiff(uriStr, 'allow_always')),
    vscode.commands.registerCommand('codeep.rejectProposedChange', (uriStr: string) =>
      respondFromDiff(uriStr, 'reject_once')),
  );

  // If the user closes the diff tab without clicking Accept / Reject, treat
  // that as an implicit reject so the agent doesn't hang forever waiting on
  // a permission reply. Same outcome as if they'd clicked Reject in the
  // chat sidebar — clean failure rather than mysterious timeout.
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs((evt) => {
      for (const tab of evt.closed) {
        const input = tab.input;
        if (input instanceof vscode.TabInputTextDiff) {
          if (input.modified.scheme === DIFF_PREVIEW_SCHEME) {
            chatPanel.respondToPermissionFromDiff(input.modified, 'reject_once');
          }
        }
      }
    }),
  );

  // Register sidebar webview provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codeep.chat', chatPanel, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // Command: open chat
  context.subscriptions.push(
    vscode.commands.registerCommand('codeep.openChat', () => {
      vscode.commands.executeCommand('workbench.view.extension.codeep');
    })
  );

  // Status bar item — always visible in the bottom bar, click opens chat.
  // Renders connection state + current model so users don't have to open the
  // sidebar to know whether Codeep is reachable or which model is loaded.
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'codeep.openChat';
  statusBar.show();
  context.subscriptions.push(statusBar);

  const renderStatusBar = (s: ChatStatusState): void => {
    // Default action is "open chat"; the connected state overrides it to the
    // model picker so a click on "Codeep · <model>" lets you switch models.
    statusBar.command = 'codeep.openChat';
    switch (s.connection) {
      case 'connecting':
        statusBar.text = '$(loading~spin) Codeep';
        statusBar.tooltip = 'Connecting to Codeep CLI…';
        statusBar.backgroundColor = undefined;
        break;
      case 'connected':
        statusBar.text = s.model ? `$(circuit-board) Codeep · ${s.model}` : '$(circuit-board) Codeep';
        statusBar.tooltip = new vscode.MarkdownString(
          `Codeep CLI · **connected**${s.model ? ` · model \`${s.model}\`` : ''}\n\nClick to change model.`,
        );
        statusBar.command = 'codeep.selectModel';
        statusBar.backgroundColor = undefined;
        break;
      case 'reconnecting':
        statusBar.text = s.reconnect
          ? `$(sync~spin) Codeep · Reconnect ${s.reconnect.attempt}/${s.reconnect.max}`
          : '$(sync~spin) Codeep · Reconnecting';
        statusBar.tooltip = s.reconnect
          ? `Reconnecting in ${s.reconnect.delaySec}s (attempt ${s.reconnect.attempt}/${s.reconnect.max})`
          : 'Reconnecting to Codeep CLI…';
        statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      case 'disconnected':
        statusBar.text = '$(plug) Codeep · Off';
        statusBar.tooltip = 'Codeep CLI disconnected — click to open chat';
        statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      case 'failed':
        statusBar.text = '$(error) Codeep · Failed';
        statusBar.tooltip = 'Codeep CLI reconnect failed — reload the window';
        statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
    }
  };

  renderStatusBar(chatPanel.getStatusState());
  context.subscriptions.push(chatPanel.onStatusChange(renderStatusBar));

  // Command: pick provider + model from a quick-pick (wired to the status bar
  // when connected). Two-step: provider → model, with a free-text fallback for
  // providers whose model list is dynamic (OpenRouter, Ollama, custom endpoints)
  // or when an older CLI doesn't report models.
  context.subscriptions.push(
    vscode.commands.registerCommand('codeep.selectModel', async () => {
      let providers;
      try {
        providers = await chatPanel.getProviders();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Codeep: could not reach the CLI to load providers — ${err?.message || err}`);
        return;
      }
      if (!providers || providers.length === 0) {
        if (!chatPanel.isProviderListAvailable()) {
          const upgrade = 'Update CLI';
          const choice = await vscode.window.showWarningMessage(
            'Codeep: your installed CLI is too old to report providers/models. Run "npm install -g codeep@latest" and reload the window.',
            upgrade,
          );
          if (choice === upgrade) {
            const term = vscode.window.createTerminal('Codeep CLI update');
            term.sendText('npm install -g codeep@latest');
            term.show();
          }
        } else {
          vscode.window.showWarningMessage('Codeep: no providers reported by the CLI.');
        }
        return;
      }

      const provPick = await vscode.window.showQuickPick(
        providers.map((p) => ({ label: p.groupLabel || p.name, description: p.id, detail: p.hint, entry: p })),
        { placeHolder: 'Select a provider', matchOnDetail: true },
      );
      if (!provPick) return;
      const provider = provPick.entry;

      const models = provider.models ?? [];
      let modelId: string | undefined;
      if (provider.dynamicModels || models.length === 0) {
        modelId = await vscode.window.showInputBox({
          prompt: `Model id for ${provider.groupLabel || provider.name}`,
          placeHolder: provider.defaultModel || 'e.g. qwen3-coder-30b',
          value: provider.defaultModel || '',
          ignoreFocusOut: true,
          validateInput: (v) => (v.trim() ? null : 'Enter a model id'),
        });
      } else {
        const CUSTOM = '__custom__';
        const modelPick = await vscode.window.showQuickPick(
          [
            ...models.map((m) => ({
              label: m.name || m.id,
              description: m.id === provider.defaultModel ? 'default' : '',
              detail: m.id,
              modelId: m.id,
            })),
            { label: '$(edit) Enter a custom model id…', description: '', detail: '', modelId: CUSTOM },
          ],
          { placeHolder: `Select a model for ${provider.groupLabel || provider.name}`, matchOnDetail: true },
        );
        if (!modelPick) return;
        modelId =
          modelPick.modelId === CUSTOM
            ? await vscode.window.showInputBox({
                prompt: 'Model id',
                value: provider.defaultModel || '',
                ignoreFocusOut: true,
                validateInput: (v) => (v.trim() ? null : 'Enter a model id'),
              })
            : modelPick.modelId;
      }
      if (!modelId || !modelId.trim()) return;

      try {
        await chatPanel.setModel(provider.id, modelId.trim());
        vscode.window.showInformationMessage(
          `Codeep: switched to ${modelId.trim()} (${provider.groupLabel || provider.name}).`,
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(`Codeep: failed to switch model — ${err?.message || err}`);
      }
    }),
  );

  // Lightbulb (Code Action) integration — Explain / Improve / Add tests /
  // Add doc comment on a selection, plus a "Fix this problem" quick-fix on
  // diagnostics. Routes the templated prompt through the chat so the full
  // agent (file edits via diff preview, tools) is available.
  registerCodeActions(context, (text: string) => {
    chatPanel.sendToChat(text);
    vscode.commands.executeCommand('workbench.view.extension.codeep');
  });

  // "Generate Commit Message" — sparkle button in the Source Control title.
  registerGenerateCommitMessage(context, (diff: string) => chatPanel.generateCommitMessage(diff));

  // Native "Sessions" tree view in the Codeep sidebar (browse / load / delete).
  registerSessionsTree(context, chatPanel);

  // `@codeep` participant in the native Chat view + `codeep_skills` LM tool.
  registerChatParticipant(context);
  registerCodeepTools(context);

  // Profile commands: edit ~/.codeep/profile.md (global) and the project one,
  // plus the auto-learn toggle. The CLI/ACP agent reads these files on every run.
  registerProfileCommands(context, chatPanel);

  // Command: send selected code to chat
  context.subscriptions.push(
    vscode.commands.registerCommand('codeep.sendSelection', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const selection = editor.document.getText(editor.selection);
      if (!selection) return;
      const lang = editor.document.languageId;
      const file = vscode.workspace.asRelativePath(editor.document.uri);
      chatPanel.sendToChat(`\`\`\`${lang}\n// ${file}\n${selection}\n\`\`\``);
      vscode.commands.executeCommand('workbench.view.extension.codeep');
    })
  );

  // Command: attach active file as @-mention in chat input. Lighter than
  // sendSelection — doesn't auto-send, just prepends `@<path>` so the user
  // can add a question. Closest equivalent to Cursor's "Add Context" flow.
  context.subscriptions.push(
    vscode.commands.registerCommand('codeep.attachActiveFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('Codeep: no active editor to attach.');
        return;
      }
      const rel = vscode.workspace.asRelativePath(editor.document.uri);
      chatPanel.sendToChat(`@${rel} `);
      await vscode.commands.executeCommand('workbench.view.extension.codeep');
    })
  );

  // Command: review current file
  context.subscriptions.push(
    vscode.commands.registerCommand('codeep.reviewFile', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const file = vscode.workspace.asRelativePath(editor.document.uri);
      chatPanel.sendToChat(`/review ${file}`);
      vscode.commands.executeCommand('workbench.view.extension.codeep');
    })
  );

  // Command: new session
  context.subscriptions.push(
    vscode.commands.registerCommand('codeep.newSession', () => {
      chatPanel.newSession();
    })
  );

  // Command: inline edit — Cmd+Shift+I in editor. Asks the agent to rewrite
  // the current selection (or current line) according to a one-line
  // instruction. Replaces the range directly; user can Cmd+Z to undo.
  context.subscriptions.push(
    vscode.commands.registerCommand('codeep.inlineChat', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('Codeep: open a file first.');
        return;
      }

      // Operate on the current selection, or fall back to the current line
      // if the user just placed their caret somewhere without selecting.
      const range = editor.selection.isEmpty
        ? editor.document.lineAt(editor.selection.active.line).range
        : new vscode.Range(editor.selection.start, editor.selection.end);
      const code = editor.document.getText(range);
      if (!code.trim()) {
        vscode.window.showInformationMessage('Codeep: select some code first.');
        return;
      }

      const instructions = await vscode.window.showInputBox({
        prompt: 'How should Codeep change this code?',
        placeHolder: 'e.g. "make this async", "extract to a function", "add error handling"',
        ignoreFocusOut: true,
      });
      if (!instructions) return;

      const fileName = vscode.workspace.asRelativePath(editor.document.uri);
      const lang = editor.document.languageId;

      let newCode: string | null = null;
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Codeep is editing…',
          cancellable: false,
        },
        async () => {
          try {
            newCode = await chatPanel.requestInlineEdit(code, lang, instructions, fileName);
          } catch (err: any) {
            vscode.window.showErrorMessage(`Codeep inline edit failed: ${err?.message || err}`);
          }
        },
      );

      if (newCode === null) {
        vscode.window.showWarningMessage(
          'Codeep returned no replacement code. Check the chat view for the model\'s response.',
        );
        return;
      }
      if (newCode === code) {
        vscode.window.showInformationMessage('Codeep: model returned the same code, no change applied.');
        return;
      }

      const ok = await editor.edit((b) => b.replace(range, newCode!));
      if (!ok) {
        vscode.window.showErrorMessage('Codeep: failed to apply edit (read-only file?).');
        return;
      }
      vscode.window.setStatusBarMessage('Codeep edit applied — Cmd+Z to undo', 4000);
    })
  );

  // Command: set API key — saves into the CLI's config so both extension and
  // terminal share the same credentials. Without this, fresh users had to open
  // a terminal and run `/login` manually before the extension would work.
  context.subscriptions.push(
    vscode.commands.registerCommand('codeep.setApiKey', async () => {
      // Provider list comes from the CLI itself via session/list_providers —
      // no hardcoded copy to drift out of sync. Filters out no-key providers
      // (e.g. Ollama) since there's nothing to set for them.
      let entries;
      try {
        entries = await chatPanel.getProviders();
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `Codeep: Could not reach CLI to load provider list — ${err?.message || err}`
        );
        return;
      }

      const providers = entries
        .filter((p) => p.requiresKey)
        .map((p) => ({ label: p.groupLabel, id: p.id, detail: p.hint }));

      if (providers.length === 0) {
        // Most likely cause: CLI is older than v0.1.34 and doesn't expose
        // session/list_providers. Tell the user how to upgrade rather than
        // a generic "no providers" message that doesn't suggest a fix.
        if (!chatPanel.isProviderListAvailable()) {
          const upgrade = 'Update CLI';
          const choice = await vscode.window.showWarningMessage(
            'Codeep: Your installed CLI is too old to expose the provider list. Run "npm install -g codeep@latest" and reload the window. You can still set keys via "/login <provider>" in the chat panel.',
            upgrade,
          );
          if (choice === upgrade) {
            const term = vscode.window.createTerminal('Codeep CLI update');
            term.sendText('npm install -g codeep@latest');
            term.show();
          }
          return;
        }
        vscode.window.showWarningMessage('Codeep: No providers reported by the CLI.');
        return;
      }

      const pick = await vscode.window.showQuickPick(providers, {
        placeHolder: 'Select a provider to set the API key for',
        matchOnDetail: true,
      });
      if (!pick) return;

      const key = await vscode.window.showInputBox({
        prompt: `Paste your ${pick.label} API key`,
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => {
          const t = v.trim();
          if (!t) return 'Key is empty';
          if (/\s/.test(t)) return 'Key contains whitespace — paste again';
          if (t.length < 16) return 'Key looks too short — paste the full value';
          return null;
        },
      });
      if (!key) return;

      try {
        await chatPanel.setApiKey(pick.id, key.trim());
        vscode.window.showInformationMessage(
          `Codeep: API key saved for ${pick.label}. The CLI will use it automatically.`
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `Codeep: Failed to save key — ${err?.message || String(err)}`
        );
      }
    })
  );

  // ── MCP server management ──────────────────────────────────────────────────
  // Wraps the same `.codeep/mcp_servers.json` files the CLI reads, so the
  // user can add an MCP server through the command palette without having
  // to know the file format. Changes take effect on the next session/new
  // (start a new session or reload the window).
  const workspaceRoot = (): string | undefined => {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('codeep.mcpAddServer', async () => {
      const root = workspaceRoot();
      const scopePick = await vscode.window.showQuickPick(
        [
          { label: 'Project (.codeep/mcp_servers.json)', value: 'project' as McpScope, picked: !!root, description: root ? '' : 'Open a workspace first' },
          { label: 'Global (~/.codeep/mcp_servers.json)', value: 'global' as McpScope },
        ],
        { placeHolder: 'Where should this MCP server be saved?' },
      );
      if (!scopePick) return;
      if (scopePick.value === 'project' && !root) {
        vscode.window.showWarningMessage('Codeep: open a workspace folder first to save a project-scoped MCP server.');
        return;
      }

      const name = await vscode.window.showInputBox({
        prompt: 'Server name (also used as the agent-side tool prefix: `<name>__<tool>`)',
        placeHolder: 'e.g. fs, gh, postgres',
        validateInput: (v) => /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(v.trim()) ? null : 'Letters, digits, _ and - only; must start with a letter; max 32 chars',
      });
      if (!name) return;

      const command = await vscode.window.showInputBox({
        prompt: 'Command to spawn the MCP server',
        placeHolder: 'e.g. npx, uvx, /path/to/server',
      });
      if (!command) return;

      const argsRaw = await vscode.window.showInputBox({
        prompt: 'Arguments (space-separated, leave blank for none)',
        placeHolder: 'e.g. @modelcontextprotocol/server-filesystem /path',
      });
      // Simple split — quoted paths with spaces aren't supported; for those
      // the user should edit the JSON directly.
      const args = argsRaw?.trim() ? argsRaw.trim().split(/\s+/) : [];

      const server: VsCodeMcpServer = { name: name.trim(), command: command.trim(), args };
      try {
        addServer(scopePick.value, server, root);
        vscode.window.showInformationMessage(
          `Codeep: MCP server "${server.name}" saved (${scopePick.value}). Start a new session to spawn it.`,
          'Reload Window',
        ).then(choice => {
          if (choice === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');
        });
      } catch (err: any) {
        vscode.window.showErrorMessage(`Codeep: Failed to save MCP server — ${err?.message || String(err)}`);
      }
    }),

    vscode.commands.registerCommand('codeep.mcpRemoveServer', async () => {
      const root = workspaceRoot();
      // Build a combined list across both scopes so the user can pick from one menu.
      const items: (vscode.QuickPickItem & { scope: McpScope; serverName: string })[] = [];
      for (const s of listServers('project', root)) {
        items.push({ label: s.name, description: 'project', detail: `${s.command} ${s.args.join(' ')}`, scope: 'project', serverName: s.name });
      }
      for (const s of listServers('global', root)) {
        items.push({ label: s.name, description: 'global', detail: `${s.command} ${s.args.join(' ')}`, scope: 'global', serverName: s.name });
      }
      if (items.length === 0) {
        vscode.window.showInformationMessage('Codeep: no MCP servers configured.');
        return;
      }
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Remove which MCP server?' });
      if (!pick) return;
      removeServer(pick.scope, pick.serverName, root);
      vscode.window.showInformationMessage(`Codeep: removed MCP server "${pick.serverName}" (${pick.scope}). Reload window to take effect.`);
    }),

    vscode.commands.registerCommand('codeep.skillsBundles', async () => {
      const root = workspaceRoot();
      if (!root) { vscode.window.showWarningMessage('Codeep: open a workspace first.'); return; }
      const skillsDir = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, '.codeep', 'skills');
      try {
        const entries = await vscode.workspace.fs.readDirectory(skillsDir);
        const bundles = entries.filter(([, type]) => type === vscode.FileType.Directory);
        if (bundles.length === 0) {
          vscode.window.showInformationMessage('Codeep: no skill bundles in this workspace. Use "Codeep: Create Skill Bundle…" to add one.');
          return;
        }
        const pick = await vscode.window.showQuickPick(
          bundles.map(([name]) => ({ label: name, detail: vscode.Uri.joinPath(skillsDir, name, 'SKILL.md').fsPath })),
          { placeHolder: 'Open which skill bundle?' },
        );
        if (!pick) return;
        const skillFile = vscode.Uri.joinPath(skillsDir, pick.label, 'SKILL.md');
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(skillFile));
      } catch {
        vscode.window.showInformationMessage('Codeep: no .codeep/skills/ folder in this workspace yet. Use "Codeep: Create Skill Bundle…" to start one.');
      }
    }),

    vscode.commands.registerCommand('codeep.skillsCreateBundle', async () => {
      const root = workspaceRoot();
      if (!root) { vscode.window.showWarningMessage('Codeep: open a workspace first.'); return; }
      const name = await vscode.window.showInputBox({
        prompt: 'Skill bundle name (lowercase, hyphens allowed; this becomes the directory name)',
        placeHolder: 'e.g. deploy-staging, lint-fix, hotfix-flow',
        validateInput: (v) => /^[a-z0-9][a-z0-9-]{0,40}$/.test(v.trim()) ? null : 'Lowercase letters / digits / hyphens; must start with a letter or digit; max 41 chars',
      });
      if (!name) return;
      const description = await vscode.window.showInputBox({
        prompt: 'One-sentence description (shown in the agent\'s catalog)',
        placeHolder: 'e.g. Deploy the current branch to staging via npm scripts',
        validateInput: (v) => v.trim().length > 0 ? null : 'Description is required',
      });
      if (!description) return;

      const skillsDir = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, '.codeep', 'skills', name);
      const skillFile = vscode.Uri.joinPath(skillsDir, 'SKILL.md');
      try {
        await vscode.workspace.fs.stat(skillFile);
        vscode.window.showWarningMessage(`Codeep: skill "${name}" already exists.`);
        return;
      } catch {
        // Doesn't exist yet — create.
      }

      const body = `---
name: ${name}
description: ${description}
triggers:
  - keyword
  - phrase
# Optional Codeep-specific keys:
# codeep-min-version: 2.0.0
# codeep-requires-mcp: [postgres, filesystem]
# allowed-tools: [read_file, write_file, execute_command]
# version: 0.1.0
---

# ${name}

${description}

## Steps

1. First step
2. Second step
3. …

## Notes

Anything else the agent should know — edge cases, gotchas, things to double-check.
`;
      await vscode.workspace.fs.writeFile(skillFile, Buffer.from(body, 'utf-8'));
      const doc = await vscode.workspace.openTextDocument(skillFile);
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(`Codeep: created skill bundle "${name}". Edit SKILL.md to define the workflow.`);
    }),

    vscode.commands.registerCommand('codeep.skillsOpenFolder', async () => {
      const root = workspaceRoot();
      if (!root) {
        // No workspace open — fall back to the global folder
        const home = require('os').homedir() as string;
        const globalDir = vscode.Uri.file(require('path').join(home, '.codeep', 'skills'));
        await vscode.commands.executeCommand('revealFileInOS', globalDir);
        return;
      }
      const skillsDir = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, '.codeep', 'skills');
      await vscode.commands.executeCommand('revealFileInOS', skillsDir);
    }),

    vscode.commands.registerCommand('codeep.mcpOpenConfig', async () => {
      const root = workspaceRoot();
      const scopePick = await vscode.window.showQuickPick(
        [
          { label: 'Project config', detail: root ? configPath('project', root)! : '(no workspace open)', value: 'project' as McpScope },
          { label: 'Global config', detail: configPath('global')!, value: 'global' as McpScope },
        ],
        { placeHolder: 'Open which MCP config file?' },
      );
      if (!scopePick) return;
      const path = configPath(scopePick.value, root);
      if (!path) { vscode.window.showWarningMessage('Codeep: no workspace open.'); return; }
      try {
        // Open even if the file doesn't exist — VS Code prompts to create.
        const uri = vscode.Uri.file(path);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Codeep: could not open ${path} — ${err?.message || String(err)}`);
      }
    }),
  );
}

export function deactivate() {}
