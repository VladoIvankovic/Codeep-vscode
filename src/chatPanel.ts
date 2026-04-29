import * as vscode from 'vscode';
import { AcpClient } from './acpClient';

export interface ProviderEntry {
  id: string;
  name: string;
  description: string;
  groupLabel: string;
  hint: string;
  requiresKey: boolean;
  subscribeUrl?: string;
}

// Connection-level status surfaced to the status bar item. Webview gets a
// formatted text via the existing 'status' message; the status bar reads this
// structured shape and decides its own icon/colour/text.
export interface ChatStatusState {
  connection: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';
  model?: string;
  reconnect?: { attempt: number; max: number; delaySec: number };
}

function friendlyError(msg: string): string {
  if (msg.includes('Request timeout: session/prompt')) {
    const m = msg.match(/no activity for (\d+) min/);
    const mins = m ? m[1] : '5';
    return `The agent went silent for ${mins} min and was cancelled. If you're using a slow reasoning model, raise codeep.requestTimeoutMinutes in settings.`;
  }
  if (msg.includes('Request timeout'))    return 'The CLI did not respond in time and the request was cancelled.';
  if (msg.includes('CLI not running'))    return 'Codeep CLI is not running. Try reloading the window.';
  if (msg.includes('CLI stopped'))        return 'The agent was stopped.';
  if (msg.includes('process exited'))     return 'Codeep CLI crashed unexpectedly. Try reloading the window.';
  if (msg.includes('CLI not found'))      return 'Codeep CLI not found. Run: npm install -g codeep';
  return msg;
}

export class ChatPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private client?: AcpClient;
  private output = vscode.window.createOutputChannel('Codeep');
  private skipWelcome = true;
  private pendingPrefill?: string;
  // requestId → callback that resolves a pending session/request_permission.
  // Single-listener design: the main onDidReceiveMessage switch dispatches
  // permissionResponse messages here. Previously each permission request
  // installed its own listener — fine for one-off prompts but every webview
  // message ran through every active handler, scaling O(n) per message.
  private pendingPermissions = new Map<number, (reply: any) => void>();
  // Cached provider list from CLI's session/list_providers. Static for the
  // lifetime of a CLI process; cleared on disconnect so a reconnect re-fetches.
  // providersUnavailable=true when the CLI is older than v0.1.34 (the version
  // that introduced session/list_providers) — in that case we keep the rest of
  // the UI working and surface a "please update" hint where the provider list
  // would otherwise appear.
  private providerCache: ProviderEntry[] | null = null;
  private providerFetchPromise: Promise<ProviderEntry[]> | null = null;
  private providersUnavailable = false;

  // Status bar feed. We track structured connection state here and fire
  // onStatusChange whenever it shifts; extension.ts listens and renders.
  private currentStatus: ChatStatusState = { connection: 'connecting' };
  private statusEmitter = new vscode.EventEmitter<ChatStatusState>();
  public readonly onStatusChange = this.statusEmitter.event;

  constructor(private context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    if (this.pendingPrefill) {
      const text = this.pendingPrefill;
      this.pendingPrefill = undefined;
      setTimeout(() => this.view?.webview.postMessage({ type: 'prefill', text }), 600);
    }

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview, webviewView.webview.cspSource);

    // Handle messages from WebView
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'send':
          await this.handleSend(msg.text);
          break;
        case 'cancel':
          this.clearPermissionHandlers();
          this.view?.webview.postMessage({ type: 'cancelPermissions' });
          this.client?.cancel();
          break;
        case 'cancelAndSend':
          await this.handleCancelAndSend(msg.text);
          break;
        case 'listSessions':
          await this.handleListSessions();
          break;
        case 'loadSession':
          await this.handleLoadSession(msg.sessionId);
          break;
        case 'deleteSession':
          await this.handleDeleteSession(msg.sessionId);
          break;
        case 'setConfig':
          try {
            await this.client?.setConfigOption(msg.configId, msg.value);
          } catch (err: any) {
            this.view?.webview.postMessage({ type: 'error', text: err.message });
          }
          break;
        case 'setMode':
          try {
            await this.client?.setMode(msg.modeId);
          } catch (err: any) {
            this.view?.webview.postMessage({ type: 'error', text: err.message });
          }
          break;
        case 'newSession':
          await this.newSession();
          break;
        case 'fileSearch':
          await this.handleFileSearch(msg.query, msg.queryId);
          break;
        case 'permissionResponse': {
          const cb = this.pendingPermissions.get(msg.requestId);
          if (cb) {
            this.pendingPermissions.delete(msg.requestId);
            cb(msg);
          }
          break;
        }
        case 'ready':
          this.initClient();
          // Auto-connect so user sees "Connected" immediately
          this.client!.start().catch((err: Error) => {
            this.output.appendLine(`[ERROR] Auto-connect failed: ${err.message}`);
            this.view?.webview.postMessage({ type: 'status', text: '⚠ CLI not found' });
            this.view?.webview.postMessage({ type: 'onboarding' });
          });
          break;
      }
    });
  }

  sendToChat(text: string): void {
    if (this.view) {
      this.view.webview.postMessage({ type: 'prefill', text });
    } else {
      this.pendingPrefill = text;
    }
  }

  /**
   * Store an API key by delegating to the CLI's `/login` command over ACP.
   * This is the only place where the extension writes into the user's Codeep
   * config — it goes through the same code path as `/login` in the TUI, so the
   * key ends up in `~/.config/codeep/config.json` and is immediately usable.
   */
  /**
   * Fetch the canonical provider list from the CLI, cached for the life of the
   * connection. Used by both the chat WebView (settings panel) and the
   * `Codeep: Set API Key` quick-pick — eliminates the previous three copies
   * of this list scattered around the extension.
   */
  async getProviders(): Promise<ProviderEntry[]> {
    if (this.providerCache) return this.providerCache;
    if (this.providerFetchPromise) return this.providerFetchPromise;
    this.initClient();
    this.providerFetchPromise = (async () => {
      try {
        const providers = await this.client!.listProviders();
        this.providerCache = providers as ProviderEntry[];
        this.providersUnavailable = false;
        return this.providerCache;
      } catch (err: any) {
        // Older CLIs don't implement session/list_providers. Don't treat that
        // as a hard error — the rest of the extension stays usable and the
        // settings panel surfaces a "please update" hint instead.
        if (typeof err?.message === 'string' && err.message.includes('Method not found')) {
          this.providersUnavailable = true;
          this.providerCache = [];
          return [];
        }
        throw err;
      } finally {
        this.providerFetchPromise = null;
      }
    })();
    return this.providerFetchPromise;
  }

  isProviderListAvailable(): boolean {
    return !this.providersUnavailable;
  }

  getStatusState(): ChatStatusState {
    return this.currentStatus;
  }

  /**
   * Patch the status state and notify listeners. We clear `reconnect` info
   * on every successful connection so the status bar doesn't keep showing
   * a stale "Reconnect 3/6" label after recovery.
   */
  private updateStatus(patch: Partial<ChatStatusState>): void {
    this.currentStatus = { ...this.currentStatus, ...patch };
    if (patch.connection === 'connected') {
      this.currentStatus.reconnect = undefined;
    }
    this.statusEmitter.fire(this.currentStatus);
  }

  async setApiKey(providerId: string, apiKey: string): Promise<void> {
    this.initClient();
    if (!this.client) throw new Error('CLI not running');
    // `/login` doesn't need a running session context, but ACP requires one.
    // Making sure the client is started up-front avoids a "no session" error
    // when this command runs before the chat view has been opened.
    await this.client.send(`/login ${providerId} ${apiKey}`);
  }

  /**
   * Inline edit (Cmd+Shift+I) — ask the agent to rewrite a chunk of code
   * according to natural-language instructions. Returns the new code (just
   * the inside of the first ``` block) or null if the agent refused or
   * returned something unparseable.
   *
   * The exchange flows through the normal session, so it's also visible in
   * the chat view. The user sees both: the inline edit applied to the file,
   * and the conversation in the sidebar if they have it open.
   */
  async requestInlineEdit(code: string, lang: string, instructions: string, fileName: string): Promise<string | null> {
    this.initClient();
    if (!this.client) throw new Error('CLI not running');

    // Strict prompt: we want only the code, no markdown, no commentary.
    // The agent doesn't always comply, so we still try to extract a code
    // block from whatever comes back.
    const prompt = [
      'You are performing a focused edit on a single block of code.',
      'Return ONLY the updated code, wrapped in a single ``` code block.',
      'No explanation, no preamble, no trailing notes.',
      '',
      `File: ${fileName}`,
      `Language: ${lang || 'plaintext'}`,
      '',
      'Original:',
      '```' + (lang || ''),
      code,
      '```',
      '',
      `Instruction: ${instructions}`,
    ].join('\n');

    this.skipWelcome = false;
    this.view?.webview.postMessage({ type: 'userMessage', text: `[inline edit] ${instructions}` });
    this.view?.webview.postMessage({ type: 'thinking' });

    const response = await this.client.sendAndCollect(prompt);

    // Extract first fenced code block. Tolerate optional language tag and
    // surrounding whitespace; agent might wrap or include a brief label.
    const match = response.match(/```[a-zA-Z0-9_+\-]*\n?([\s\S]*?)```/);
    if (!match) return null;
    return match[1].replace(/\n$/, '');
  }

  async newSession(): Promise<void> {
    this.clearPermissionHandlers();
    try {
      await this.client?.newSession();
      this.view?.webview.postMessage({ type: 'clearChat' });
      this.view?.webview.postMessage({ type: 'status', text: 'New session started' });
    } catch (err: any) {
      this.output.appendLine(`[ERROR] newSession: ${err.message}`);
      this.view?.webview.postMessage({ type: 'error', text: err.message });
    }
  }

  private clearPermissionHandlers(): void {
    this.pendingPermissions.clear();
  }

  private initClient(): void {
    if (this.client) return;
    const config = vscode.workspace.getConfiguration('codeep');
    const cliPath = config.get<string>('cliPath') || 'codeep';
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || require('os').homedir();
    const timeoutMin = Math.max(1, Math.min(60, config.get<number>('requestTimeoutMinutes') ?? 5));

    this.client = new AcpClient(cliPath, workspacePath, timeoutMin * 60_000);

    this.client.on('chunk', (chunk: string) => {
      if (this.skipWelcome) return;
      this.view?.webview.postMessage({ type: 'chunk', text: chunk });
    });

    this.client.on('responseEnd', () => {
      this.view?.webview.postMessage({ type: 'responseEnd' });
    });

    this.client.on('thought', (text: string) => {
      if (this.skipWelcome) return;
      this.view?.webview.postMessage({ type: 'thought', text });
    });

    this.client.on('plan', (entries: any[]) => {
      this.view?.webview.postMessage({ type: 'plan', entries });
    });

    this.client.on('toolCall', (params: any) => {
      this.view?.webview.postMessage({ type: 'toolCall', text: params.title ?? 'Working...', toolCallId: params.toolCallId });
    });

    this.client.on('toolCallUpdate', (params: any) => {
      this.view?.webview.postMessage({ type: 'toolCallUpdate', toolCallId: params.toolCallId, status: params.status });
    });

    this.client.on('disconnected', (code: number) => {
      this.output.appendLine(`[ACP] Disconnected (exit code: ${code})`);
      // Provider list belongs to the CLI process — drop it so a reconnect
      // refetches against the new server (it might be a different version).
      this.providerCache = null;
      this.providersUnavailable = false;
      this.updateStatus({ connection: 'disconnected' });
      this.view?.webview.postMessage({ type: 'status', text: 'Disconnected' });
    });

    this.client.on('reconnecting', (info: { attempt: number; max: number; delayMs: number }) => {
      const secs = Math.round(info.delayMs / 1000);
      this.output.appendLine(`[ACP] Reconnecting in ${secs}s (attempt ${info.attempt}/${info.max})`);
      this.updateStatus({
        connection: 'reconnecting',
        reconnect: { attempt: info.attempt, max: info.max, delaySec: secs },
      });
      this.view?.webview.postMessage({
        type: 'status',
        text: `Reconnecting in ${secs}s (${info.attempt}/${info.max})…`,
      });
    });

    this.client.on('reconnected', () => {
      this.output.appendLine('[ACP] Reconnected');
      this.updateStatus({ connection: 'connected' });
      this.view?.webview.postMessage({ type: 'status', text: 'Reconnected' });
    });

    this.client.on('reconnectFailed', (attempts: number) => {
      this.output.appendLine(`[ACP] Reconnect failed after ${attempts} attempts`);
      this.updateStatus({ connection: 'failed' });
      this.view?.webview.postMessage({ type: 'status', text: 'Disconnected — reload window' });
      this.view?.webview.postMessage({
        type: 'error',
        text: `Could not reach Codeep CLI after ${attempts} attempts. Reload the window or check the CLI installation.`,
      });
    });

    this.client.on('configOptions', (configOptions: any[], modes: any) => {
      // Mirror current model name into status state so the status bar can
      // show "Codeep · gpt-5.5" without round-tripping through the webview.
      const modelOpt = configOptions.find((o) => o?.id === 'model');
      if (modelOpt?.currentValue) {
        const friendly =
          modelOpt.options?.find((o: any) => o.value === modelOpt.currentValue)?.name
          ?? String(modelOpt.currentValue).split('/').pop();
        this.updateStatus({ model: friendly });
      }
      this.view?.webview.postMessage({ type: 'configOptions', configOptions, modes });
    });

    this.client.on('modeChanged', (modeId: string) => {
      this.view?.webview.postMessage({ type: 'modeChanged', modeId });
    });

    this.client.on('sessionLoaded', (history: { role: string; content: string }[]) => {
      this.view?.webview.postMessage({ type: 'clearChat' });
      this.view?.webview.postMessage({ type: 'history', messages: history });
      this.view?.webview.postMessage({ type: 'status', text: 'Session loaded' });
    });

    this.client.on('connected', () => {
      this.output.appendLine('[ACP] Connected');
      this.updateStatus({ connection: 'connected' });
      this.view?.webview.postMessage({ type: 'status', text: 'Connected' });
      this.skipWelcome = true; // filter welcome message on each connect
      // Fetch provider list once we're connected and forward it to the
      // WebView so the settings panel can populate without hardcoding.
      this.getProviders()
        .then((providers) => this.view?.webview.postMessage({
          type: 'providers',
          providers,
          unavailable: this.providersUnavailable,
        }))
        .catch((err) => this.output.appendLine(`[providers] fetch failed: ${err.message}`));
    });

    this.client.on('log', (msg: string) => {
      this.output.append('[CLI] ' + msg);
    });

    this.client.on('serverRequest', (msg: any) => {
      if (msg.method === 'session/request_permission') {
        const toolName: string = msg.params?.toolCall?.toolName ?? 'unknown tool';
        const toolInput: any = msg.params?.toolCall?.toolInput ?? {};
        const detail = toolInput.path ?? toolInput.command ?? JSON.stringify(toolInput).slice(0, 100);
        const label = toolName.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());

        // Show inline permission card in chat WebView. We forward the full
        // toolInput so the webview can render a diff/preview of what's about
        // to be written or executed — letting the user verify before allowing.
        this.view?.webview.postMessage({
          type: 'permission',
          requestId: msg.id,
          label,
          detail,
          toolName,
          toolInput,
        });

        // Register a one-shot resolver. The main webview message switch picks
        // it up via pendingPermissions and forwards the reply to the CLI.
        this.pendingPermissions.set(msg.id, (reply: any) => {
          const optionId = reply.choice === 'allow_once'   ? 'allow_once'
                         : reply.choice === 'allow_always' ? 'allow_always'
                         : 'reject_once';
          this.client!.respond(msg.id, {
            outcome: reply.choice
              ? { type: 'selected', optionId }
              : { type: 'cancelled' },
          });
        });
      }
    });

    this.client.on('error', (err: Error) => {
      this.output.appendLine('[ACP ERROR] ' + err.message);
      this.view?.webview.postMessage({ type: 'error', text: err.message });
    });
  }

  private async handleListSessions(): Promise<void> {
    try {
      if (!this.client) this.initClient();
      const sessions = await this.client!.listSessions();
      this.view?.webview.postMessage({ type: 'sessions', sessions });
    } catch (err: any) {
      this.view?.webview.postMessage({ type: 'error', text: err.message });
    }
  }

  private async handleDeleteSession(sessionId: string): Promise<void> {
    try {
      if (!this.client) this.initClient();
      await this.client!.deleteSession(sessionId);
      // Refresh session list
      const sessions = await this.client!.listSessions();
      this.view?.webview.postMessage({ type: 'sessions', sessions });
    } catch (err: any) {
      this.view?.webview.postMessage({ type: 'error', text: err.message });
    }
  }

  private async handleLoadSession(sessionId: string): Promise<void> {
    this.clearPermissionHandlers();
    try {
      if (!this.client) this.initClient();
      await this.client!.loadSession(sessionId);
    } catch (err: any) {
      this.view?.webview.postMessage({ type: 'error', text: err.message });
    }
  }

  private async handleCancelAndSend(text: string): Promise<void> {
    if (!text.trim()) return;
    this.view?.webview.postMessage({ type: 'userMessage', text });
    this.view?.webview.postMessage({ type: 'thinking' });
    try {
      if (!this.client) this.initClient();
      this.skipWelcome = false;
      const expanded = await this.expandMentions(text);
      await this.client!.cancelAndSend(expanded);
    } catch (err: any) {
      this.output.appendLine(`[ERROR] cancelAndSend: ${err.message}`);
      this.view?.webview.postMessage({ type: 'error', text: friendlyError(err.message) });
    }
  }

  private async handleSend(text: string): Promise<void> {
    if (!text.trim()) return;

    // Show the user's typed text in the chat as-is (without inlined file
    // contents), so the message bubble stays readable. The expanded version
    // — with @file contents prepended — is what actually gets sent to the CLI.
    this.view?.webview.postMessage({ type: 'userMessage', text });
    this.view?.webview.postMessage({ type: 'thinking' });

    try {
      if (!this.client) this.initClient();
      this.skipWelcome = false; // first real message — allow chunks through
      const expanded = await this.expandMentions(text);
      await this.client!.send(expanded);
    } catch (err: any) {
      this.output.appendLine(`[ERROR] ${err.message}`);
      this.view?.webview.postMessage({ type: 'error', text: friendlyError(err.message) });
    }
  }

  /**
   * Workspace file search for @-mentions in the chat input. Uses VS Code's
   * indexed glob matcher so results match what the file picker shows.
   * Cap at 20 entries — the dropdown isn't meant for browsing.
   */
  private async handleFileSearch(query: string, queryId: number): Promise<void> {
    try {
      const trimmed = (query ?? '').trim();
      // Empty query returns recent files (fallback to a wildcard).
      const pattern = trimmed ? `**/*${trimmed}*` : '**/*';
      const exclude = '**/{node_modules,.git,dist,build,out,.next,.codeep}/**';
      const uris = await vscode.workspace.findFiles(pattern, exclude, 20);
      const items = uris.map((u) => ({
        path: vscode.workspace.asRelativePath(u),
        name: u.path.split('/').pop() ?? '',
      }));
      this.view?.webview.postMessage({ type: 'fileSearchResults', queryId, items });
    } catch (err: any) {
      this.view?.webview.postMessage({ type: 'fileSearchResults', queryId, items: [] });
      this.output.appendLine(`[fileSearch] ${err.message}`);
    }
  }

  /**
   * Replace @-mentions in a user prompt with an "[Attached files]" preamble,
   * so the agent has the file content in-context without us needing CLI-side
   * state. Mentions remain visible in the original message text, which keeps
   * the chat bubble readable.
   *
   * - Mention syntax: `@<relative-path>` — anything up to whitespace.
   * - Files larger than 200 KB are skipped with a marker rather than embedded
   *   to avoid blowing up the prompt.
   * - Missing files are silently dropped (typo, stale path).
   */
  private async expandMentions(text: string): Promise<string> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return text;

    const MENTION = /(^|\s)@([^\s@]+)/g;
    const matches = [...text.matchAll(MENTION)];
    if (matches.length === 0) return text;

    const MAX_BYTES = 200 * 1024;
    const seen = new Set<string>();
    const attachments: string[] = [];

    for (const m of matches) {
      const rel = m[2];
      if (seen.has(rel)) continue;
      seen.add(rel);
      // Try each workspace folder until one resolves
      for (const f of folders) {
        const uri = vscode.Uri.joinPath(f.uri, rel);
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.type !== vscode.FileType.File) continue;
          if (stat.size > MAX_BYTES) {
            attachments.push(`File: ${rel}\n[skipped — file is ${Math.round(stat.size / 1024)} KB, over the 200 KB inline limit]`);
            break;
          }
          const buf = await vscode.workspace.fs.readFile(uri);
          const content = Buffer.from(buf).toString('utf8');
          attachments.push(`File: ${rel}\n\`\`\`\n${content}\n\`\`\``);
          break;
        } catch {
          // Not in this folder — try next
        }
      }
    }

    if (attachments.length === 0) return text;
    return `[Attached files]\n${attachments.join('\n\n')}\n\n${text}`;
  }

  private getHtml(webview: vscode.Webview, cspSource: string): string {
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.js')
    );
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.css')
    );
    const nonce = Math.random().toString(36).slice(2);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${cssUri}">
  <title>Codeep</title>
</head>
<body>
  <div id="toolbar">
    <span id="status">Initializing...</span>
    <div id="toolbar-buttons">
      <button id="btn-settings">Settings</button>
      <button id="btn-sessions">Sessions</button>
      <button id="btn-new">New</button>
    </div>
  </div>
  <div id="settings-panel" style="display:none"></div>
  <div id="sessions-panel" style="display:none"></div>
  <div id="messages"></div>
  <div id="agent-status"></div>
  <div id="input-area">
    <div id="mention-popup" style="display:none"></div>
    <textarea id="input" placeholder="Ask Codeep anything (type @ to attach a file)" rows="1"></textarea>
    <button id="btn-send">↑</button>
    <button id="btn-stop" style="display:none">■</button>
  </div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}
