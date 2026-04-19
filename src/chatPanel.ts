import * as vscode from 'vscode';
import { AcpClient } from './acpClient';

function friendlyError(msg: string): string {
  if (msg.includes('Request timeout'))    return 'The agent took too long to respond and was stopped. You can send a new message to continue.';
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
  private permissionHandlers = new Map<number, vscode.Disposable>();

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
    this.permissionHandlers.forEach(h => h.dispose());
    this.permissionHandlers.clear();
  }

  private initClient(): void {
    if (this.client) return;
    const config = vscode.workspace.getConfiguration('codeep');
    const cliPath = config.get<string>('cliPath') || 'codeep';
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || require('os').homedir();

    this.client = new AcpClient(cliPath, workspacePath);

    this.client.on('chunk', (chunk: string) => {
      if (this.skipWelcome) return;
      this.view?.webview.postMessage({ type: 'chunk', text: chunk });
    });

    this.client.on('responseEnd', () => {
      this.view?.webview.postMessage({ type: 'responseEnd' });
    });


    this.client.on('toolCall', (params: any) => {
      this.view?.webview.postMessage({ type: 'toolCall', text: params.title ?? 'Working...', toolCallId: params.toolCallId });
    });

    this.client.on('toolCallUpdate', (params: any) => {
      this.view?.webview.postMessage({ type: 'toolCallUpdate', toolCallId: params.toolCallId, status: params.status });
    });

    this.client.on('disconnected', (code: number) => {
      this.output.appendLine(`[ACP] Disconnected (exit code: ${code})`);
      this.view?.webview.postMessage({ type: 'status', text: 'Disconnected' });
    });

    this.client.on('configOptions', (configOptions: any[], modes: any) => {
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
      this.view?.webview.postMessage({ type: 'status', text: 'Connected' });
      this.skipWelcome = true; // filter welcome message on each connect
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

        // Show inline permission card in chat WebView
        this.view?.webview.postMessage({
          type: 'permission',
          requestId: msg.id,
          label,
          detail,
        });

        // Listen for response from WebView
        const handler = this.view?.webview.onDidReceiveMessage((reply: any) => {
          if (reply.type === 'permissionResponse' && reply.requestId === msg.id) {
            this.permissionHandlers.get(msg.id)?.dispose();
            this.permissionHandlers.delete(msg.id);
            const optionId = reply.choice === 'allow_once'   ? 'allow_once'
                           : reply.choice === 'allow_always' ? 'allow_always'
                           : 'reject_once';
            this.client!.respond(msg.id, {
              outcome: reply.choice
                ? { type: 'selected', optionId }
                : { type: 'cancelled' },
            });
          }
        });
        if (handler) this.permissionHandlers.set(msg.id, handler);
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
      await this.client!.cancelAndSend(text);
    } catch (err: any) {
      this.output.appendLine(`[ERROR] cancelAndSend: ${err.message}`);
      this.view?.webview.postMessage({ type: 'error', text: friendlyError(err.message) });
    }
  }

  private async handleSend(text: string): Promise<void> {
    if (!text.trim()) return;

    this.view?.webview.postMessage({ type: 'userMessage', text });
    this.view?.webview.postMessage({ type: 'thinking' });

    try {
      if (!this.client) this.initClient();
      this.skipWelcome = false; // first real message — allow chunks through
      await this.client!.send(text);
    } catch (err: any) {
      this.output.appendLine(`[ERROR] ${err.message}`);
      this.view?.webview.postMessage({ type: 'error', text: friendlyError(err.message) });
    }
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
    <textarea id="input" placeholder="Ask Codeep anything..." rows="1"></textarea>
    <button id="btn-send">↑</button>
    <button id="btn-stop" style="display:none">■</button>
  </div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}
