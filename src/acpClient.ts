import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

interface McpServerEntry {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Load the merged MCP server config for a VS Code workspace.
 * Mirrors `src/utils/mcpConfig.ts` in the CLI — kept in-extension (instead
 * of importing from CLI source) so the extension stays self-contained.
 * Project config wins over global on name collisions; the CLI further
 * merges this with anything ACP would pass on its own.
 */
function loadMcpServerConfigForVsCode(workspaceRoot: string): McpServerEntry[] {
  const candidates = [
    join(homedir(), '.codeep', 'mcp_servers.json'),
    workspaceRoot ? join(workspaceRoot, '.codeep', 'mcp_servers.json') : '',
  ].filter(Boolean);

  const byName = new Map<string, McpServerEntry>();
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let raw: string;
    try { raw = readFileSync(path, 'utf-8'); } catch { continue; }
    let parsed: { mcpServers?: Record<string, Omit<McpServerEntry, 'name'>> | McpServerEntry[] };
    try { parsed = JSON.parse(raw); } catch { continue; }
    const servers = parsed.mcpServers;
    if (!servers) continue;
    if (Array.isArray(servers)) {
      for (const s of servers) {
        if (s && typeof s.name === 'string' && typeof s.command === 'string') {
          byName.set(s.name, { ...s, args: Array.isArray(s.args) ? s.args.filter(a => typeof a === 'string') : [] });
        }
      }
    } else {
      for (const [name, cfg] of Object.entries(servers)) {
        if (cfg && typeof cfg.command === 'string') {
          byName.set(name, {
            name,
            command: cfg.command,
            args: Array.isArray(cfg.args) ? cfg.args.filter(a => typeof a === 'string') : [],
            env: cfg.env && typeof cfg.env === 'object' ? cfg.env : undefined,
          });
        }
      }
    }
  }
  return [...byName.values()];
}

export class AcpClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer = '';
  private reqId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private sessionId: string | null = null;
  private startFresh = false;
  private suppressNextResponseEnd = false;
  // Fail-closed permission gate: true once the server has confirmed a session
  // mode (we set 'manual' on connect, or the user switched mode). If arming
  // manual mode FAILS on connect, the CLI session stays in its default 'auto'
  // (no confirmation prompts), so we refuse to send prompts rather than let
  // dangerous tools auto-run unguarded. See armManualMode() + send().
  private modeGuardArmed = false;
  // Idle-watchdog state: a long-running session/prompt is allowed to take as long
  // as it likes, as long as the CLI keeps emitting *some* signal (chunk, tool
  // call, thought). If nothing comes through for `idleTimeoutMs`, we assume the
  // agent is wedged and cancel the in-flight prompt. This replaces the old
  // fixed 5-minute cap that was tripping reasoning models on hard tasks.
  private activePromptId: number | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  // Reconnect bookkeeping. We auto-reconnect when the CLI exits unexpectedly
  // (crash, OOM kill, parent restart) but stay quiet when the user explicitly
  // tears the client down (newSession, deactivate). intentionalShutdown is the
  // gate; reconnectAttempts drives exponential backoff capped at 30s/6 tries.
  private intentionalShutdown = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly MAX_RECONNECT_ATTEMPTS = 6;

  constructor(
    private cliPath: string,
    private workspacePath: string,
    private idleTimeoutMs: number = 300_000,
    // Optional pins from VS Code settings (codeep.provider/model/baseUrl/
    // autoLearnProfile). Empty/undefined fields mean "use the CLI's own
    // config". Applied on every connect so the editor's settings stay
    // authoritative across reconnects.
    private overrides: { provider?: string; model?: string; baseUrl?: string; autoLearnProfile?: boolean } = {},
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.process) return;
    // Caller wants the client running — clear any pending reconnect so we don't
    // race a delayed retry against this fresh start.
    this.intentionalShutdown = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // On Windows, npm global binaries are .cmd wrappers — use shell:true to resolve them
    const isWindows = process.platform === 'win32';
    // Pass codeep.baseUrl through as OPENAI_BASE_URL so the `openai` provider
    // picks it up (the CLI honors that env var). The `custom` provider is
    // configured separately via the customBaseUrl config option below.
    const baseUrl = this.overrides.baseUrl?.trim();
    this.process = spawn(this.cliPath, ['acp'], {
      cwd: this.workspacePath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: baseUrl ? { ...process.env, OPENAI_BASE_URL: baseUrl } : { ...process.env },
      shell: isWindows,
    });

    const proc = this.process;

    // Fail fast if binary not found (instead of waiting for request timeout)
    await new Promise<void>((resolve, reject) => {
      proc.once('error', reject);
      proc.once('spawn', resolve);
    }).catch((err) => {
      this.process = null;
      throw err;
    });

    proc.stdout?.on('data', (data: Buffer) => {
      this.buffer += data.toString();
      this.flush();
    });

    proc.stderr?.on('data', (data: Buffer) => {
      this.emit('log', data.toString());
    });

    proc.on('exit', (code) => {
      if (this.process === proc) {
        this.process = null;
        this.sessionId = null;
        this.modeGuardArmed = false; // a new session must re-arm; never carry a stale armed state
        this.rejectAllPending(new Error('CLI process exited'));
        this.emit('disconnected', code);
        if (!this.intentionalShutdown) this.scheduleReconnect();
      }
    });

    proc.on('error', (err) => {
      this.emit('error', err);
    });

    // Initialize ACP
    await this.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'codeep-vscode', version: '0.1.0' },
    });
    // Successful handshake — clear any reconnect counter so the next failure
    // gets a fresh backoff curve, not a 30s wait off the bat.
    this.reconnectAttempts = 0;
    this.emit('connected');

    // Create session — params.cwd is what server expects. Also pass any
    // MCP server config from the workspace's `.codeep/mcp_servers.json` (or
    // the global `~/.codeep/mcp_servers.json`) so the agent gets the same
    // tools whether you launch from Zed, the VS Code extension, or `codeep`
    // directly. The CLI also reads these files itself; ACP-provided ones win
    // on name collisions.
    const mcpServers = loadMcpServerConfigForVsCode(this.workspacePath);
    const wasFresh = this.startFresh;
    const session = await this.request('session/new', {
      cwd: this.workspacePath,
      fresh: this.startFresh,
      ...(mcpServers.length > 0 ? { mcpServers } : {}),
    });
    this.startFresh = false;
    this.sessionId = session?.sessionId ?? null;

    // Arm manual mode so the server asks permission for dangerous operations.
    // Fails closed (see armManualMode): if it can't be set, send() refuses.
    await this.armManualMode();

    // Apply VS Code setting pins (codeep.provider/model/baseUrl) so they're
    // authoritative on every (re)connect. Order matters: provider first (it
    // resets the model to the provider default), then model overrides that,
    // then the custom base URL. Best-effort — a bad value shouldn't abort the
    // whole connect. The server echoes config_option_update notifications which
    // refresh the UI/status bar.
    await this.applyOverrides();

    // Emit config options so UI can build settings panel
    if (session?.configOptions) {
      this.emit('configOptions', session.configOptions, session.modes);
    }

    // On a resume (not a fresh new-session), session/new returns the prior
    // transcript. Replay it so a window reload doesn't show an empty chat
    // while the agent still has the history server-side. Fresh starts have
    // nothing to replay.
    if (!wasFresh && Array.isArray(session?.history) && session.history.length > 0) {
      const replay = (session.history as Array<{ role: string; content: string }>)
        .filter((m) => m.role === 'user' || m.role === 'assistant');
      if (replay.length > 0) this.emit('historyRestored', replay);
    }
  }

  /** Push codeep.provider/model/baseUrl pins to the server, if set. */
  private async applyOverrides(): Promise<void> {
    if (!this.sessionId) return;
    const apply = async (configId: string, value?: string) => {
      const v = value?.trim();
      if (!v) return;
      try {
        await this.request('session/set_config_option', { sessionId: this.sessionId, configId, value: v });
      } catch {
        /* older CLI without this option, or invalid value — ignore */
      }
    };
    await apply('provider', this.overrides.provider);
    await apply('model', this.overrides.model);
    await apply('customBaseUrl', this.overrides.baseUrl);
    // Push the profile auto-learn pin only when the user expressed a VS Code
    // preference (undefined = leave the CLI's own setting untouched).
    if (this.overrides.autoLearnProfile !== undefined) {
      await apply('autoLearnProfile', String(this.overrides.autoLearnProfile));
    }
  }

  /**
   * Set the session to manual mode (server asks permission for dangerous tools).
   * Retries once on a transient failure, then FAILS CLOSED: marks the gate
   * un-armed and emits 'modeGuardFailed' so the UI can warn and send() refuses
   * to run prompts (the CLI session would otherwise stay in unguarded 'auto').
   */
  private async armManualMode(): Promise<void> {
    if (!this.sessionId) { this.modeGuardArmed = false; return; }
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.request('session/set_mode', { sessionId: this.sessionId, modeId: 'manual' });
        this.modeGuardArmed = true;
        return;
      } catch (err) {
        if (attempt === 2) {
          this.modeGuardArmed = false;
          this.emit('modeGuardFailed', err);
        }
      }
    }
  }

  /** Whether the manual-mode confirmation gate is armed (server confirmed a mode). */
  get isModeGuarded(): boolean {
    return this.modeGuardArmed;
  }

  /** Throw if the manual-mode confirmation gate isn't armed (fail closed). */
  private assertModeGuardArmed(): void {
    if (!this.modeGuardArmed) {
      throw new Error(
        "Codeep: the confirmation gate isn't active — manual mode couldn't be set on the agent " +
        '(update the Codeep CLI and reload the window). Refusing to send to avoid running tools without approval.',
      );
    }
  }

  async send(message: string): Promise<void> {
    if (!this.process || !this.sessionId) {
      await this.start(); // fallback if auto-connect failed
    }
    this.assertModeGuardArmed();
    // session/prompt resolving = response complete
    await this.request('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text: message }],
    });
    if (this.suppressNextResponseEnd) {
      this.suppressNextResponseEnd = false;
    } else {
      this.emit('responseEnd');
    }
  }

  /**
   * Send a prompt and accumulate the assistant's text into a single string
   * (instead of streaming via 'chunk' events). Used by inline edit (Cmd+Shift+I)
   * which needs the full reply to extract the replacement code block.
   *
   * Note: 'chunk' events are still emitted to other listeners — chatPanel will
   * still mirror the exchange into the chat view if that's what's wired up.
   * This makes inline edits visible in chat history, which we treat as a
   * feature rather than something to suppress.
   */
  async sendAndCollect(message: string): Promise<string> {
    if (!this.process || !this.sessionId) {
      await this.start();
    }
    this.assertModeGuardArmed();
    let buffer = '';
    const onChunk = (text: string) => { buffer += text; };
    this.on('chunk', onChunk);
    try {
      await this.request('session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: message }],
      });
    } finally {
      this.off('chunk', onChunk);
    }
    if (this.suppressNextResponseEnd) {
      this.suppressNextResponseEnd = false;
    } else {
      this.emit('responseEnd');
    }
    return buffer;
  }

  async cancelAndSend(message: string): Promise<void> {
    this.suppressNextResponseEnd = true;
    this.cancel();
    await new Promise(resolve => setTimeout(resolve, 150));
    try {
      await this.send(message);
    } catch (err) {
      this.suppressNextResponseEnd = false;
      throw err;
    }
  }

  async newSession(): Promise<void> {
    // Not connected yet → full start (which creates a fresh session).
    if (!this.process) {
      this.startFresh = true;
      await this.start();
      this.emit('newSession');
      return;
    }
    // Connected → spin up a new session on the SAME process. The CLI
    // supports multiple sessions per process, so this drops the old chat
    // without tearing down warm MCP servers (and the seconds of relaunch
    // latency a respawn cost). Cancel any in-flight run first so its stream
    // can't bleed into the new session.
    this.cancel();
    const mcpServers = loadMcpServerConfigForVsCode(this.workspacePath);
    const session = await this.request('session/new', {
      cwd: this.workspacePath,
      fresh: true,
      ...(mcpServers.length > 0 ? { mcpServers } : {}),
    });
    this.sessionId = session?.sessionId ?? null;
    // Re-arm manual mode (fails closed) and re-apply the VS Code config pins
    // for the new session, mirroring start().
    await this.armManualMode();
    await this.applyOverrides();
    if (session?.configOptions) {
      this.emit('configOptions', session.configOptions, session.modes);
    }
    this.emit('newSession');
  }

  respond(id: number, result: unknown): void {
    if (this.process?.stdin) {
      const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
      this.process.stdin.write(msg + '\n');
    }
  }

  async listSessions(): Promise<any[]> {
    if (!this.process) await this.start();
    const result = await this.request('session/list', { cwd: this.workspacePath });
    return result?.sessions ?? [];
  }

  async loadSession(codeepSessionId: string): Promise<void> {
    if (!this.process) await this.start();
    const result = await this.request('session/load', {
      sessionId: codeepSessionId,
      cwd: this.workspacePath,
    });
    this.sessionId = result?.sessionId ?? codeepSessionId;
    await this.armManualMode();
    if (result?.configOptions) {
      this.emit('configOptions', result.configOptions, result.modes ?? null);
    }
    this.emit('sessionLoaded', result?.history ?? []);
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    // Auto-start so callers like the status-bar model picker work even
    // before the chat view has been opened (mirrors listProviders/deleteSession).
    if (!this.process) await this.start();
    if (!this.sessionId) return;
    const result = await this.request('session/set_config_option', { sessionId: this.sessionId, configId, value });
    if (result?.configOptions) {
      this.emit('configOptions', result.configOptions, null);
    }
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.sessionId) return;
    await this.request('session/set_mode', { sessionId: this.sessionId, modeId });
    // A user-initiated mode switch the server accepted — the gate is armed
    // (they've explicitly chosen this mode, including 'auto' on purpose).
    this.modeGuardArmed = true;
    this.emit('modeChanged', modeId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.process) await this.start();
    await this.request('session/delete', { sessionId, cwd: this.workspacePath });
  }

  async listProviders(): Promise<any[]> {
    if (!this.process) await this.start();
    const result = await this.request('session/list_providers', {});
    return result?.providers ?? [];
  }

  cancel(): void {
    if (this.sessionId && this.process?.stdin) {
      // session/cancel is a notification (no id, no response expected)
      const msg = JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } });
      this.process.stdin.write(msg + '\n');
    }
  }

  stop(): void {
    this.intentionalShutdown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    this.rejectAllPending(new Error('CLI stopped'));
    this.process?.kill();
    this.process = null;
    this.sessionId = null;
    this.modeGuardArmed = false; // a new session must re-arm; never carry a stale armed state
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= AcpClient.MAX_RECONNECT_ATTEMPTS) {
      this.emit('reconnectFailed', this.reconnectAttempts);
      return;
    }
    // 1s, 2s, 4s, 8s, 16s, 30s — capped so we don't churn but don't give up
    // immediately on transient crashes either.
    const delay = Math.min(30_000, 1000 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts++;
    this.emit('reconnecting', { attempt: this.reconnectAttempts, max: AcpClient.MAX_RECONNECT_ATTEMPTS, delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start()
        .then(() => this.emit('reconnected'))
        .catch((err: Error) => {
          this.emit('log', `[reconnect] attempt ${this.reconnectAttempts} failed: ${err.message}\n`);
          this.scheduleReconnect();
        });
    }, delay);
  }

  private rejectAllPending(err: Error): void {
    this.clearIdleTimer();
    this.activePromptId = null;
    for (const { reject } of this.pending.values()) {
      reject(err);
    }
    this.pending.clear();
  }

  private request(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        reject(new Error('CLI not running'));
        return;
      }
      const id = this.reqId++;
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.process.stdin.write(msg + '\n');

      if (method === 'session/prompt') {
        this.activePromptId = id;
        this.armIdleTimer();
      } else {
        // Short fixed timeout for control-plane requests (set_mode, list, etc.)
        setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            reject(new Error(`Request timeout: ${method}`));
          }
        }, 30_000);
      }
    });
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const id = this.activePromptId;
      if (id === null || !this.pending.has(id)) return;
      this.activePromptId = null;
      // Tell CLI to stop the wedged turn, then reject so the UI returns to idle.
      this.cancel();
      const pending = this.pending.get(id);
      this.pending.delete(id);
      const minutes = Math.round(this.idleTimeoutMs / 60_000);
      pending?.reject(
        new Error(`Request timeout: session/prompt (no activity for ${minutes} min)`)
      );
    }, this.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /**
   * Test seam: feed raw stdout bytes through the same buffer + framing path the
   * live `proc.stdout.on('data')` handler uses. Lets unit tests exercise the
   * JSON-RPC framing/dispatch without spawning a process. Harmless in prod
   * (nothing calls it outside the data handler / tests).
   */
  ingest(chunk: string): void {
    this.buffer += chunk;
    this.flush();
  }

  private flush(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);

        // Any incoming line counts as activity — keeps the idle watchdog quiet
        // while the agent is genuinely working (streaming chunks, tool calls,
        // thoughts, etc). If we never see anything, idleTimer eventually fires.
        if (this.activePromptId !== null) this.armIdleTimer();

        // Response to a pending request
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          if (msg.id === this.activePromptId) {
            this.activePromptId = null;
            this.clearIdleTimer();
          }
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
          continue;
        }

        // Incoming request from server (has id + method, not in pending)
        if (msg.id !== undefined && msg.method) {
          this.emit('serverRequest', msg);
          continue;
        }

        // Notification (no id)
        if (msg.method === 'session/update' && msg.params?.update) {
          const update = msg.params.update;

          if (update.sessionUpdate === 'agent_message_chunk' && update.content?.text) {
            this.emit('chunk', update.content.text);
          }

          if (update.sessionUpdate === 'agent_thought_chunk' && update.content?.text) {
            this.emit('thought', update.content.text);
          }

          if (update.sessionUpdate === 'tool_call' && update.status === 'in_progress') {
            this.emit('toolCall', { title: update.title, kind: update.kind, toolCallId: update.toolCallId });
          }

          if (update.sessionUpdate === 'tool_call_update') {
            this.emit('toolCallUpdate', { toolCallId: update.toolCallId, status: update.status });
          }

          if ((update.sessionUpdate === 'config_options_update' || update.sessionUpdate === 'config_option_update') && update.configOptions) {
            this.emit('configOptions', update.configOptions, null);
          }

          if (update.sessionUpdate === 'plan' && Array.isArray(update.entries)) {
            this.emit('plan', update.entries);
          }

          if (update.sessionUpdate === 'current_mode_update' && update.currentModeId) {
            // Server confirmed a session mode → the gate is armed.
            this.modeGuardArmed = true;
            this.emit('modeChanged', update.currentModeId);
          }
        }
      } catch {
        this.emit('log', `[WARN] Could not parse CLI output: ${line}\n`);
      }
    }
  }
}
