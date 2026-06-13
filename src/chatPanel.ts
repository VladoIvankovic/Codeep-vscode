import * as vscode from 'vscode';
import { AcpClient } from './acpClient';
import { showProposedChange, synthesizeEditedContent, trackPendingPermission, clearPendingPermissionForUri } from './diffPreview';

export interface ProviderEntry {
  id: string;
  name: string;
  description: string;
  groupLabel: string;
  hint: string;
  requiresKey: boolean;
  subscribeUrl?: string;
  // Added in CLI 2.1.2 — older CLIs omit these; the model picker falls back
  // to a free-text input when `models` is missing/empty or `dynamicModels`.
  models?: { id: string; name: string }[];
  defaultModel?: string;
  dynamicModels?: boolean;
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
  /** Set by extension.ts so we can refresh the diff CodeLens after a new permission is tracked. */
  private diffLensRefresher: (() => void) | null = null;
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
  // Fires when the saved-session list may have changed (new / load / delete),
  // so the Sessions tree view can refresh itself.
  private sessionsEmitter = new vscode.EventEmitter<void>();
  public readonly onSessionsChanged = this.sessionsEmitter.event;

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
        case 'runVsCodeCommand': {
          // Webview "Extensions" panel surfaces palette commands as
          // buttons. Allowlist the codeep.* prefix so the webview can't
          // ask us to run arbitrary VS Code commands.
          const cmd = String(msg.command ?? '');
          if (cmd.startsWith('codeep.')) {
            try { await vscode.commands.executeCommand(cmd); }
            catch (err) { this.output.appendLine(`[runVsCodeCommand] ${cmd}: ${(err as Error).message}`); }
          }
          break;
        }
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
   * Installed by extension.ts so the diff CodeLens provider can be told to
   * re-query lenses when a new permission request is registered (otherwise
   * the lens won't appear until the user clicks in the diff editor).
   */
  setDiffLensRefresher(fn: () => void): void {
    this.diffLensRefresher = fn;
  }

  /**
   * Forwarded from the diff editor's Accept/Reject CodeLens. Looks up the
   * pending permission resolver for the given proposed-change URI and
   * fires it the same way the inline chat buttons do.
   */
  respondToPermissionFromDiff(uri: vscode.Uri, choice: 'allow_once' | 'allow_always' | 'reject_once'): void {
    const { getPendingPermissionForUri } = require('./diffPreview') as typeof import('./diffPreview');
    const requestId = getPendingPermissionForUri(uri);
    if (requestId === null) {
      vscode.window.showInformationMessage('Codeep: no pending permission for this diff (already resolved?).');
      return;
    }
    const resolver = this.pendingPermissions.get(requestId);
    if (!resolver) {
      vscode.window.showInformationMessage('Codeep: permission already responded to.');
      return;
    }
    resolver({ choice });
    this.pendingPermissions.delete(requestId);
    clearPendingPermissionForUri(uri);
    // Also forward to the webview so its inline card resolves and animates
    // out — keeps the two surfaces in sync.
    this.view?.webview.postMessage({ type: 'permissionResolved', requestId, choice });
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
   * Switch the active provider + model via ACP. The CLI server applies it to
   * the shared config and echoes a config_option_update, which updates the
   * status bar model automatically (see the 'configOptions' handler).
   * setConfigOption auto-starts the client, so this works from a cold status-bar click.
   */
  async setModel(providerId: string, modelId: string): Promise<void> {
    this.initClient();
    if (!this.client) throw new Error('CLI not running');
    await this.client.setConfigOption('model', `${providerId}/${modelId}`);
  }

  /**
   * Toggle profile auto-learn on the running CLI. Mirrors setModel: auto-starts
   * the client and pushes the config option live so it takes effect this session.
   */
  async setAutoLearn(enabled: boolean): Promise<void> {
    this.initClient();
    if (!this.client) throw new Error('CLI not running');
    await this.client.setConfigOption('autoLearnProfile', String(enabled));
  }

  /**
   * Push the user profile to the codeep.dev dashboard via the CLI's `/me sync`
   * (handled by the ACP command layer). Returns the CLI's response text.
   */
  async syncProfile(): Promise<string> {
    this.initClient();
    if (!this.client) throw new Error('CLI not running');
    return (await this.client.sendAndCollect('/me sync')).trim();
  }

  /**
   * Generate a Conventional Commits message from a git diff. Routes through
   * the session (visible in chat, like inline edit) and returns the cleaned
   * message text. Caller writes it into the SCM input box.
   */
  async generateCommitMessage(diff: string): Promise<string | null> {
    this.initClient();
    if (!this.client) throw new Error('CLI not running');

    const prompt = [
      'Write a git commit message for the staged changes below.',
      'Format: Conventional Commits — a `type(scope): subject` summary line',
      '(type one of: feat, fix, docs, refactor, test, chore, perf, build, ci),',
      'imperative mood, ~72 chars max, no trailing period. For non-trivial',
      'changes add a blank line then 1–4 concise bullet points (`- `).',
      'Output ONLY the commit message — no code fences, no preamble, no quotes.',
      '',
      'Diff:',
      diff,
    ].join('\n');

    this.skipWelcome = false;
    this.view?.webview.postMessage({ type: 'userMessage', text: '[generate commit message]' });
    this.view?.webview.postMessage({ type: 'thinking' });

    const raw = await this.client.sendAndCollect(prompt);
    // Strip accidental wrapping code fences / quotes the model might add.
    const cleaned = raw
      .replace(/^\s*```[a-zA-Z0-9_+-]*\n?/i, '')
      .replace(/```\s*$/i, '')
      .replace(/^["'`]+|["'`]+$/g, '')
      .trim();
    return cleaned || null;
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
    // The new session emits a welcome message; filter it like a fresh
    // connect does. Without this, the in-process new-session path (no
    // reconnect, so the 'connected' handler doesn't re-arm the flag) leaks
    // the welcome bubble into the empty chat.
    this.skipWelcome = true;
    try {
      await this.client?.newSession();
      this.view?.webview.postMessage({ type: 'clearChat' });
      this.view?.webview.postMessage({ type: 'status', text: 'New session started' });
      this.sessionsEmitter.fire();
    } catch (err: any) {
      this.output.appendLine(`[ERROR] newSession: ${err.message}`);
      this.view?.webview.postMessage({ type: 'error', text: err.message });
    }
  }

  // ── Sessions tree view support ──────────────────────────────────────────────
  // Public, tree-friendly wrappers over the same ACP session ops the webview
  // uses. They keep the webview in sync (it listens for 'sessions'/'clearChat')
  // and fire onSessionsChanged so the tree refreshes.

  /** List saved sessions for the tree. Returns [] on any failure. */
  async getSessions(): Promise<{ sessionId: string; title?: string; updatedAt?: string }[]> {
    try {
      if (!this.client) this.initClient();
      return await this.client!.listSessions();
    } catch {
      return [];
    }
  }

  /** Load a session into the chat and reveal the chat view. */
  async openSession(sessionId: string): Promise<void> {
    await this.handleLoadSession(sessionId);
    await vscode.commands.executeCommand('workbench.view.extension.codeep');
    this.view?.webview.postMessage({ type: 'status', text: 'Session loaded' });
    this.sessionsEmitter.fire();
  }

  /** Delete a session and refresh the webview list + tree. */
  async deleteSessionById(sessionId: string): Promise<void> {
    await this.handleDeleteSession(sessionId);
    this.sessionsEmitter.fire();
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
    // Optional pins — empty/undefined means "use the CLI's own config".
    const overrides = {
      provider: config.get<string>('provider')?.trim() || undefined,
      model: config.get<string>('model')?.trim() || undefined,
      baseUrl: config.get<string>('baseUrl')?.trim() || undefined,
      autoLearnProfile: config.get<boolean>('autoLearnProfile'),
    };

    this.client = new AcpClient(cliPath, workspacePath, timeoutMin * 60_000, overrides);

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

    // Auto-replay the prior transcript after a window reload — the CLI
    // re-attached the session server-side (fresh=false), so the agent still
    // has the context; this just repaints it instead of a blank chat.
    this.client.on('historyRestored', (history: { role: string; content: string }[]) => {
      this.view?.webview.postMessage({ type: 'clearChat' });
      this.view?.webview.postMessage({ type: 'history', messages: history });
      this.view?.webview.postMessage({ type: 'status', text: 'Restored previous chat' });
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
          // The server's actual option set (allow_once / allow_always /
          // reject_once / reject_always). Forward it so the webview renders
          // exactly what's offered — including Reject-always — instead of a
          // hardcoded three, and so future CLI options appear with no change.
          options: msg.params?.options ?? [],
        });

        // For write/edit tools, also open a native VS Code diff editor so
        // the user reviews the full proposed change with syntax highlighting
        // and gutter markers — the inline webview preview is unavoidably
        // cramped and truncated.
        //
        // We keep the Promise (not the resolved handle) so the resolver
        // can clean up even when the user answers instantly — the earlier
        // shape stored the handle in a `.then`, which left the diff
        // orphaned if the permission reply landed before the open finished.
        const diffHandlePromise: Promise<{ proposedUri: vscode.Uri; close: () => Promise<void> } | null> =
          this.openDiffForPermission(toolName, toolInput).catch(() => null);
        // Register the URI → request-id mapping as soon as the diff opens,
        // so the Accept/Reject CodeLens can resolve `getPendingPermissionForUri`
        // and respond from inside the diff editor without going back to chat.
        diffHandlePromise.then(handle => {
          if (handle) {
            trackPendingPermission(handle.proposedUri, msg.id);
            this.diffLensRefresher?.();  // nudge VS Code to re-render lenses
          }
        });

        // Register a one-shot resolver. The main webview message switch picks
        // it up via pendingPermissions and forwards the reply to the CLI.
        this.pendingPermissions.set(msg.id, (reply: any) => {
          // Prefer the exact optionId the webview chose from the server's
          // option set (covers reject_always + any future option). Fall back
          // to the legacy `choice` kind from the diff-lens path, where the
          // built-in optionId equals the kind string.
          const optionId: string | undefined = reply.optionId ?? reply.choice;
          this.client!.respond(msg.id, {
            outcome: optionId
              ? { type: 'selected', optionId }
              : { type: 'cancelled' },
          });
          // Close the diff editor we opened (if any). Await the open promise
          // first so we cover the case where the user answered faster than
          // the diff finished opening. Best-effort — failures are silent
          // because the diff might already be closed manually. Also drops
          // the URI → request-id mapping so a stray late lens click can't
          // re-fire the resolver.
          diffHandlePromise.then(h => {
            if (h) clearPendingPermissionForUri(h.proposedUri);
            return h?.close().catch(() => {});
          });
        });
      }
    });

    this.client.on('error', (err: Error) => {
      this.output.appendLine('[ACP ERROR] ' + err.message);
      this.view?.webview.postMessage({ type: 'error', text: err.message });
    });
  }

  /**
   * Open a native VS Code diff editor for a pending write/edit permission.
   * Returns a handle the caller can use to close the diff once the user
   * answers. Returns null for tools we don't preview (commands, deletes,
   * etc. — those don't have a meaningful "before vs after" view).
   */
  private async openDiffForPermission(
    toolName: string,
    toolInput: any,
  ): Promise<{ proposedUri: vscode.Uri; close: () => Promise<void> } | null> {
    const filePath: string | undefined = toolInput?.path;
    if (!filePath) return null;

    try {
      if (toolName === 'write_file') {
        // `new_content` may be truncated by the agent — use it for the
        // diff preview anyway; user is reviewing intent, not byte-perfect
        // output. The actual write uses the full content server-side.
        const newContent: string = toolInput.new_content ?? toolInput.content ?? '';
        if (!newContent) return null;
        return await showProposedChange(filePath, newContent);
      }

      if (toolName === 'edit_file') {
        const oldString: string = toolInput.old_string ?? '';
        const newString: string = toolInput.new_string ?? '';
        if (!oldString && !newString) return null;

        // Read current file contents from disk and synthesize the post-edit
        // version. If the file isn't on disk (rare for edit_file but possible
        // for proposed new files) fall back to a minimal preview.
        let currentContent = '';
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
          currentContent = Buffer.from(bytes).toString('utf-8');
        } catch {
          // File not readable — preview just the new_string.
          return await showProposedChange(filePath, newString);
        }
        const proposed = synthesizeEditedContent(currentContent, oldString, newString);
        if (proposed === null) {
          // old_string wasn't found in the file (agent might be working from
          // stale state). Showing the user the new_string in isolation is
          // still more useful than no preview.
          return await showProposedChange(filePath, newString);
        }
        return await showProposedChange(filePath, proposed);
      }
    } catch (err) {
      this.output.appendLine(`[diff-preview] failed to open: ${(err as Error).message}`);
    }
    return null;
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
   * Workspace search for @-mentions in the chat input. Returns both:
   *   - files matching the query (uses VS Code's indexed glob matcher)
   *   - workspace symbols (functions / classes / methods) matching the
   *     query when it looks "symbol-y" (starts with a letter that could
   *     plausibly be an identifier, not a path).
   *
   * Results are merged and capped at 20 total so the dropdown stays
   * usable. Symbol search is intentionally fired in parallel with the
   * file search and joined — the empty-query case shouldn't ask the
   * symbol provider for the entire workspace.
   */
  private async handleFileSearch(query: string, queryId: number): Promise<void> {
    try {
      const trimmed = (query ?? '').trim();
      const exclude = '**/{node_modules,.git,dist,build,out,.next,.codeep}/**';
      const pattern = trimmed ? `**/*${trimmed}*` : '**/*';

      const filesPromise: Promise<{ path: string; name: string; kind: 'file' }[]> =
        Promise.resolve(vscode.workspace.findFiles(pattern, exclude, 15)).then(uris =>
          uris.map(u => ({
            path: vscode.workspace.asRelativePath(u),
            name: u.path.split('/').pop() ?? '',
            kind: 'file' as const,
          })),
        );

      // Only query the symbol provider when the user has typed at least one
      // character that doesn't look like a path segment. Path-style queries
      // (containing `/`, `.`, leading lowercase typical of file names) are
      // very rarely meant to look up symbols, and the provider call is
      // surprisingly slow on large workspaces.
      const symbolsPromise: Promise<{ path: string; name: string; kind: 'symbol'; symbolKind?: string; containerName?: string; line?: number }[]> =
        (trimmed.length >= 1 && !/[/\\]/.test(trimmed))
          ? (vscode.commands.executeCommand<vscode.SymbolInformation[]>(
              'vscode.executeWorkspaceSymbolProvider',
              trimmed,
            ) as Promise<vscode.SymbolInformation[] | undefined>).then(syms => {
              if (!syms) return [];
              return syms.slice(0, 15).map(s => ({
                name: s.name,
                path: vscode.workspace.asRelativePath(s.location.uri),
                kind: 'symbol' as const,
                symbolKind: vscode.SymbolKind[s.kind],
                containerName: s.containerName || undefined,
                line: s.location.range.start.line + 1,
              }));
            }).catch(() => [])
          : Promise.resolve([]);

      const [files, symbols] = await Promise.all([filesPromise, symbolsPromise]);

      // Merge: symbols first when the query likely targets a symbol (no
      // dot, no slash, capitalized or with a paren), files first otherwise.
      // Trim to 20 total — popup isn't meant for browsing.
      const symbolFirst = /^[A-Z_]/.test(trimmed) || trimmed.includes('(');
      const items = symbolFirst
        ? [...symbols, ...files].slice(0, 20)
        : [...files, ...symbols].slice(0, 20);

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
   * Mention syntax: `@<token>` — anything up to whitespace. The token is
   * resolved in this order:
   *   1. As a workspace-relative file path → embed the file's contents
   *      (capped at 200 KB to avoid blowing up the prompt).
   *   2. As a workspace symbol name (function / class / method) → embed
   *      the symbol's definition range with a few lines of context.
   *   3. Drop silently (typo, stale name).
   */
  private async expandMentions(text: string): Promise<string> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return text;

    const MENTION = /(^|\s)@([^\s@]+)/g;
    const matches = [...text.matchAll(MENTION)];
    if (matches.length === 0) return text;

    const MAX_BYTES = 200 * 1024;
    const SYMBOL_CONTEXT_LINES = 3;
    const seen = new Set<string>();
    const attachments: string[] = [];

    for (const m of matches) {
      const token = m[2];
      if (seen.has(token)) continue;
      seen.add(token);

      // 1. Try as a workspace-relative file path.
      let resolved = false;
      for (const f of folders) {
        const uri = vscode.Uri.joinPath(f.uri, token);
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.type !== vscode.FileType.File) continue;
          if (stat.size > MAX_BYTES) {
            attachments.push(`File: ${token}\n[skipped — file is ${Math.round(stat.size / 1024)} KB, over the 200 KB inline limit]`);
          } else {
            const buf = await vscode.workspace.fs.readFile(uri);
            const content = Buffer.from(buf).toString('utf8');
            attachments.push(`File: ${token}\n\`\`\`\n${content}\n\`\`\``);
          }
          resolved = true;
          break;
        } catch {
          // Not in this folder — try next
        }
      }
      if (resolved) continue;

      // 2. Try as a workspace symbol. We take the first exact-name match
      // (or first overall if no exact). The mention popup already showed
      // the user which one they were picking, but if multiple symbols
      // share the name we surface a "showing 1 of N" hint so the agent
      // knows there's ambiguity and can ask the user to disambiguate.
      try {
        const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
          'vscode.executeWorkspaceSymbolProvider',
          token,
        );
        const exactMatches = symbols?.filter(s => s.name === token) ?? [];
        const symbol = exactMatches[0] ?? symbols?.[0];
        if (!symbol) continue;

        const symUri = symbol.location.uri;
        const symRel = vscode.workspace.asRelativePath(symUri);
        const range = symbol.location.range;
        const buf = await vscode.workspace.fs.readFile(symUri);
        const lines = Buffer.from(buf).toString('utf8').split(/\r?\n/);
        const startLine = Math.max(0, range.start.line - SYMBOL_CONTEXT_LINES);
        const endLine = Math.min(lines.length - 1, range.end.line + SYMBOL_CONTEXT_LINES);
        const slice = lines.slice(startLine, endLine + 1).join('\n');
        const kindLabel = vscode.SymbolKind[symbol.kind] ?? 'Symbol';
        const container = symbol.containerName ? ` (${symbol.containerName})` : '';
        const ambiguity = exactMatches.length > 1
          ? `\n[Note: ${exactMatches.length} symbols share this name — showing the first match. Other matches: ${exactMatches.slice(1, 4).map(s => vscode.workspace.asRelativePath(s.location.uri)).join(', ')}${exactMatches.length > 4 ? '…' : ''}]`
          : '';
        attachments.push(
          `Symbol: ${symbol.name}${container} — ${kindLabel} in ${symRel}:${range.start.line + 1}${ambiguity}\n\`\`\`\n${slice}\n\`\`\``,
        );
      } catch {
        // Symbol provider unavailable or threw — drop the mention silently
        // rather than fail the whole prompt.
      }
    }

    if (attachments.length === 0) return text;
    return `[Attached context]\n${attachments.join('\n\n')}\n\n${text}`;
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
