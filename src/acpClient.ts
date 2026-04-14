import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';

export class AcpClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer = '';
  private reqId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private sessionId: string | null = null;
  private startFresh = false;

  constructor(private cliPath: string, private workspacePath: string) {
    super();
  }

  async start(): Promise<void> {
    if (this.process) return;

    this.process = spawn(this.cliPath, ['acp'], {
      cwd: this.workspacePath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const proc = this.process;

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
        this.emit('disconnected', code);
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
    this.emit('responseEnd');
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
    // session/load creates a new ACP session that restores the given Codeep session from disk
    const result = await this.request('session/load', {
      sessionId: codeepSessionId,
      cwd: this.workspacePath,
    });
    this.sessionId = result?.sessionId ?? codeepSessionId;
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

  cancel(): void {
    if (this.sessionId && this.process?.stdin) {
      // session/cancel is a notification (no id, no response expected)
      const msg = JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } });
      this.process.stdin.write(msg + '\n');
    }
  }

  stop(): void {
    this.process?.kill();
    this.process = null;
    this.sessionId = null;
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
      // Timeout — session/prompt can take a long time for agent tasks
      const timeout = method === 'session/prompt' ? 300_000 : 30_000;
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, timeout);
    });
  }

  private flush(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);

        // Response to a pending request
        if (msg.id !== undefined && this.pending.has(msg.id)) {
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

          if (update.sessionUpdate === 'tool_use_start' && update.toolCall) {
            this.emit('toolCall', update.toolCall);
          }

          if (update.sessionUpdate === 'config_options_update' && update.configOptions) {
            this.emit('configOptions', update.configOptions, null);
          }
        }
      } catch {
        // not JSON
      }
    }
  }
}
