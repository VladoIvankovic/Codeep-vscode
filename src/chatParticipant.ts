import * as vscode from 'vscode';
import { AcpClient } from './acpClient';

/**
 * `@codeep` chat participant for the native VS Code Chat view.
 *
 * Lets users invoke Codeep from the built-in chat (alongside other
 * participants / agent mode) without opening the Codeep sidebar. Responses
 * come from Codeep's own CLI backend — NOT VS Code's `request.model` — so the
 * provider/model the user configured for Codeep is what answers.
 *
 * Uses a DEDICATED AcpClient (its own `codeep acp` session, separate from the
 * webview's) so the native chat and the sidebar chat stay independent and the
 * participant's streaming doesn't bleed into the webview. The client is spawned
 * lazily on first use and torn down on deactivate.
 */

const COMMAND_PREFIX: Record<string, string> = {
  explain: 'Explain the following code / answer this question about it. Be concise and concrete.\n\n',
  review: 'Do a focused code review — call out bugs, edge cases, security issues, and concrete improvements.\n\n',
};

function buildClient(): AcpClient {
  const config = vscode.workspace.getConfiguration('codeep');
  const cliPath = config.get<string>('cliPath') || 'codeep';
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || require('os').homedir();
  const timeoutMin = Math.max(1, Math.min(60, config.get<number>('requestTimeoutMinutes') ?? 5));
  const overrides = {
    provider: config.get<string>('provider')?.trim() || undefined,
    model: config.get<string>('model')?.trim() || undefined,
    baseUrl: config.get<string>('baseUrl')?.trim() || undefined,
  };
  const client = new AcpClient(cliPath, workspacePath, timeoutMin * 60_000, overrides);
  // EventEmitter throws on an unhandled 'error' — a dedicated client has no
  // other listeners, so absorb it here (surfaced to the user per-turn instead).
  client.on('error', () => { /* swallowed; per-turn errors handled in the handler */ });
  return client;
}

/** Append the active selection (or nothing) as lightweight context. */
function withEditorContext(prompt: string): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return prompt;
  const selection = editor.document.getText(editor.selection);
  if (!selection.trim()) return prompt;
  const rel = vscode.workspace.asRelativePath(editor.document.uri);
  return `${prompt}\n\nActive selection (${rel}):\n\`\`\`${editor.document.languageId}\n${selection}\n\`\`\``;
}

export function registerChatParticipant(context: vscode.ExtensionContext): void {
  // Defensive: chat may be unavailable in stripped-down builds.
  if (!vscode.chat?.createChatParticipant) return;

  let client: AcpClient | null = null;
  const ensureClient = (): AcpClient => {
    if (!client) {
      client = buildClient();
      context.subscriptions.push({ dispose: () => client?.stop() });
    }
    return client;
  };

  const handler: vscode.ChatRequestHandler = async (request, _ctx, stream, token) => {
    const base = request.command ? (COMMAND_PREFIX[request.command] ?? '') : '';
    const prompt = withEditorContext(`${base}${request.prompt}`.trim());
    if (!prompt) {
      stream.markdown('Ask me something about your code — e.g. `@codeep /explain` with a selection, or just type a question.');
      return {};
    }

    const c = ensureClient();
    stream.progress('Codeep is thinking…');

    const onChunk = (text: string) => stream.markdown(text);
    c.on('chunk', onChunk);
    const cancelSub = token.onCancellationRequested(() => c.cancel());
    try {
      await c.sendAndCollect(prompt);
    } catch (err: any) {
      stream.markdown(`\n\n_Codeep error: ${err?.message || err}. Is the \`codeep\` CLI installed and on your PATH?_`);
    } finally {
      c.off('chunk', onChunk);
      cancelSub.dispose();
    }
    return {};
  };

  const participant = vscode.chat.createChatParticipant('codeep.assistant', handler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'Codeep.png');
  context.subscriptions.push(participant);
}
