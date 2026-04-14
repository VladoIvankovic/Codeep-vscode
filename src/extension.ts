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
}

export function deactivate() {}
