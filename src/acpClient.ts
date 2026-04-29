import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';

export class AcpClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer = '';
  private reqId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private sessionId: string | null = null;
  private startFresh = false;
  private suppressNextResponseEnd = false;
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
    this.process = spawn(this.cliPath, ['acp'], {
      cwd: this.workspacePath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
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

    // Create session — params.cwd is what server expects
    const session = await this.request('session/new', { cwd: this.workspacePath, fresh: this.startFresh });
    this.startFresh = false;
    this.sessionId = session?.sessionId ?? null;

    // Enable manual mode so server requests permission for dangerous operations
    if (this.sessionId) {
      await this.request('session/set_mode', { sessionId: this.sessionId, modeId: 'manual' });
    }

    // Emit config options so UI can build settings panel
    if (session?.configOptions) {
      this.emit('configOptions', session.configOptions, session.modes);
    }
  }

  async send(message: string): Promise<void> {
    if (!this.process || !this.sessionId) {
      await this.start(); // fallback if auto-connect failed
    }
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
    this.startFresh = true;
    this.stop();
    await this.start();
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
    if (this.sessionId) {
      await this.request('session/set_mode', { sessionId: this.sessionId, modeId: 'manual' });
    }
    if (result?.configOptions) {
      this.emit('configOptions', result.configOptions, result.modes ?? null);
    }
    this.emit('sessionLoaded', result?.history ?? []);
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    if (!this.sessionId) return;
    const result = await this.request('session/set_config_option', { sessionId: this.sessionId, configId, value });
    if (result?.configOptions) {
      this.emit('configOptions', result.configOptions, null);
    }
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.sessionId) return;
    await this.request('session/set_mode', { sessionId: this.sessionId, modeId });
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
            this.emit('modeChanged', update.currentModeId);
          }
        }
      } catch {
        this.emit('log', `[WARN] Could not parse CLI output: ${line}\n`);
      }
    }
  }
}
