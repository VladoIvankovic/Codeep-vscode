import * as vscode from 'vscode';

/**
 * Lightbulb (Code Action) integration.
 *
 * Surfaces Codeep right where the cursor is: select code → the lightbulb
 * offers Explain / Add tests / Add doc comment / Improve, and when the
 * range carries diagnostics (red squigglies) a "Fix this problem"
 * quick-fix. Each action builds a templated prompt and drops it into the
 * chat — same path as "Send Selection", so the full agent (file edits via
 * the diff preview, MCP tools, etc.) is available, not just a text reply.
 *
 * The worker command (`codeep.codeAction`) is registered but deliberately
 * NOT declared in package.json `contributes.commands`, so it never shows
 * up as a broken (argument-less) entry in the command palette — it's only
 * ever invoked by the lightbulb with its arguments pre-bound.
 */

type SendToChat = (text: string) => void;

type ActionKind = 'explain' | 'tests' | 'docs' | 'improve' | 'fix';

const SELECTION_ACTIONS: { kind: ActionKind; title: string; actionKind: vscode.CodeActionKind }[] = [
  { kind: 'explain', title: 'Codeep: Explain this code', actionKind: vscode.CodeActionKind.Empty },
  { kind: 'improve', title: 'Codeep: Improve / refactor this code', actionKind: vscode.CodeActionKind.RefactorRewrite },
  { kind: 'tests', title: 'Codeep: Add tests for this code', actionKind: vscode.CodeActionKind.Empty },
  { kind: 'docs', title: 'Codeep: Add doc comment', actionKind: vscode.CodeActionKind.RefactorRewrite },
];

const PROVIDED_KINDS = [
  vscode.CodeActionKind.QuickFix,
  vscode.CodeActionKind.RefactorRewrite,
  vscode.CodeActionKind.Empty,
];

class CodeepCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    // Quick-fix: only when the range overlaps a diagnostic. Marked preferred
    // so it's the default lightbulb pick on a red squiggly.
    if (context.diagnostics.length > 0) {
      const messages = context.diagnostics.map((d) => d.message);
      const fix = new vscode.CodeAction('Codeep: Fix this problem', vscode.CodeActionKind.QuickFix);
      fix.command = {
        command: 'codeep.codeAction',
        title: 'Fix with Codeep',
        arguments: ['fix', document.uri, range, messages],
      };
      fix.diagnostics = [...context.diagnostics];
      fix.isPreferred = true;
      actions.push(fix);
    }

    // Selection actions only when the user actually has a non-empty
    // selection — otherwise the lightbulb would offer "Explain this code"
    // on every cursor move, which is noise.
    const editor = vscode.window.activeTextEditor;
    const hasSelection =
      editor?.document.uri.toString() === document.uri.toString() && !editor.selection.isEmpty;
    if (hasSelection) {
      for (const a of SELECTION_ACTIONS) {
        const action = new vscode.CodeAction(a.title, a.actionKind);
        action.command = {
          command: 'codeep.codeAction',
          title: a.title,
          arguments: [a.kind, document.uri, editor!.selection],
        };
        actions.push(action);
      }
    }

    return actions;
  }
}

function fence(lang: string, file: string, code: string): string {
  return `\`\`\`${lang}\n// ${file}\n${code}\n\`\`\``;
}

function buildPrompt(
  kind: ActionKind,
  file: string,
  lang: string,
  code: string,
  diagnostics?: string[],
): string {
  const block = fence(lang, file, code);
  switch (kind) {
    case 'explain':
      return `Explain what this code does, step by step. Call out anything subtle or risky.\n\n${block}`;
    case 'improve':
      return `Review this code and improve it — readability, correctness, and performance. Show the refactored version and briefly explain the changes.\n\n${block}`;
    case 'tests':
      return `Write thorough unit tests for this code. Cover edge cases and error paths, and use the test framework already present in the project.\n\n${block}`;
    case 'docs':
      return `Add clear doc comments to this code without changing its behavior. Return the updated code.\n\n${block}`;
    case 'fix': {
      const problems =
        diagnostics && diagnostics.length > 0
          ? `Problems reported here:\n${diagnostics.map((m) => `- ${m}`).join('\n')}\n\n`
          : '';
      return `Fix the problem(s) in this code and explain the fix.\n\n${problems}${block}`;
    }
  }
}

/**
 * Register the lightbulb provider + its worker command. `send` should push
 * the prompt into the chat and reveal the Codeep view.
 */
export function registerCodeActions(context: vscode.ExtensionContext, send: SendToChat): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'codeep.codeAction',
      async (kind: ActionKind, uri: vscode.Uri, range: vscode.Range, diagnostics?: string[]) => {
        let document: vscode.TextDocument;
        try {
          document = await vscode.workspace.openTextDocument(uri);
        } catch {
          vscode.window.showWarningMessage('Codeep: could not read the file for this action.');
          return;
        }
        const code = document.getText(range);
        if (!code.trim()) {
          vscode.window.showInformationMessage('Codeep: nothing to act on — select some code first.');
          return;
        }
        const file = vscode.workspace.asRelativePath(uri);
        const lang = document.languageId;
        send(buildPrompt(kind, file, lang, code, diagnostics));
      },
    ),
  );

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      [{ scheme: 'file' }, { scheme: 'untitled' }],
      new CodeepCodeActionProvider(),
      { providedCodeActionKinds: PROVIDED_KINDS },
    ),
  );
}
