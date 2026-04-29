import * as vscode from 'vscode';
import { ChatPanel, type ChatStatusState } from './chatPanel';

export function activate(context: vscode.ExtensionContext) {
  const chatPanel = new ChatPanel(context);

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
    switch (s.connection) {
      case 'connecting':
        statusBar.text = '$(loading~spin) Codeep';
        statusBar.tooltip = 'Connecting to Codeep CLI…';
        statusBar.backgroundColor = undefined;
        break;
      case 'connected':
        statusBar.text = s.model ? `$(circuit-board) Codeep · ${s.model}` : '$(circuit-board) Codeep';
        statusBar.tooltip = new vscode.MarkdownString(
          `Codeep CLI · **connected**${s.model ? ` · model \`${s.model}\`` : ''}\n\nClick to open chat.`,
        );
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
}

export function deactivate() {}
