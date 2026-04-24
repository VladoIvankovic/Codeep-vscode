import * as vscode from 'vscode';
import { ChatPanel } from './chatPanel';

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

  // Command: set API key — saves into the CLI's config so both extension and
  // terminal share the same credentials. Without this, fresh users had to open
  // a terminal and run `/login` manually before the extension would work.
  context.subscriptions.push(
    vscode.commands.registerCommand('codeep.setApiKey', async () => {
      // Keep this list in sync with src/config/providers.ts in the CLI. We hard-code
      // it here so the UX doesn't depend on a round-trip to the CLI just to fill a
      // quick-pick — if a provider is missing, the user can still run /login in the
      // chat panel by hand.
      const providers: Array<{ label: string; id: string; detail: string }> = [
        { label: 'Z.AI (subscription)',         id: 'z.ai',        detail: 'GLM-5.1, GLM-4.6 — international coding plan' },
        { label: 'Z.AI API (pay-per-use)',      id: 'z.ai-api',    detail: 'International pay-per-token endpoint' },
        { label: 'Z.AI China (subscription)',   id: 'z.ai-cn',     detail: 'China coding plan' },
        { label: 'Z.AI China API',              id: 'z.ai-cn-api', detail: 'China pay-per-token endpoint' },
        { label: 'OpenAI',                       id: 'openai',      detail: 'GPT-5.5, GPT-5.4, Mini, Nano' },
        { label: 'Anthropic',                    id: 'anthropic',   detail: 'Claude Mythos Preview / Opus 4.7 / Sonnet 4.6 / Haiku 4.5' },
        { label: 'DeepSeek',                     id: 'deepseek',    detail: 'DeepSeek V4 Pro, V4 Flash' },
        { label: 'Google AI (Gemini)',           id: 'google',      detail: 'Gemini 3.1 Pro, 3 Flash, 2.5' },
        { label: 'MiniMax (subscription)',       id: 'minimax',     detail: 'M2.7, M2.5 — international' },
        { label: 'MiniMax API (pay-per-use)',    id: 'minimax-api', detail: 'International pay-per-token' },
        { label: 'MiniMax China',                id: 'minimax-cn',  detail: 'China endpoint' },
      ];

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
