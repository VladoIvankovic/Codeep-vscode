import * as vscode from 'vscode';
import * as path from 'path';
import { AcpClient } from './acpClient';

export class ChatPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private client?: AcpClient;
  private output = vscode.window.createOutputChannel('Codeep');
  private skipWelcome = true;

  constructor(private context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview, webviewView.webview.cspSource);

    // Handle messages from WebView
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      this.output.appendLine(`[MSG] received: ${msg.type}`);
      switch (msg.type) {
        case 'send':
          await this.handleSend(msg.text);
          break;
        case 'cancel':
          this.client?.cancel();
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
          await this.client?.setConfigOption(msg.configId, msg.value);
          break;
        case 'setMode':
          await this.client?.setMode(msg.modeId);
          break;
        case 'newSession':
          await this.newSession();
          break;
        case 'ready':
          this.output.appendLine('[MSG] WebView ready, initializing client...');
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
    this.view?.webview.postMessage({ type: 'prefill', text });
  }

  async newSession(): Promise<void> {
    try {
      await this.client?.newSession();
      this.view?.webview.postMessage({ type: 'clearChat' });
      this.view?.webview.postMessage({ type: 'status', text: 'New session started' });
    } catch (err: any) {
      this.output.appendLine(`[ERROR] newSession: ${err.message}`);
      this.view?.webview.postMessage({ type: 'error', text: err.message });
    }
  }

  private initClient(): void {
    const config = vscode.workspace.getConfiguration('codeep');
    const cliPath = config.get<string>('cliPath') || 'codeep';
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || require('os').homedir();
    this.output.appendLine(`[INIT] cliPath=${cliPath} workspacePath=${workspacePath}`);

    this.client = new AcpClient(cliPath, workspacePath);

    this.client.on('chunk', (chunk: string) => {
      if (this.skipWelcome) return;
      this.view?.webview.postMessage({ type: 'chunk', text: chunk });
    });

    this.client.on('responseEnd', () => {
      this.view?.webview.postMessage({ type: 'responseEnd' });
    });


    this.client.on('toolCall', (params: any) => {
      const label = params?.tool ? `${params.tool}${params.parameters?.path ? `: ${path.basename(params.parameters.path)}` : ''}` : 'tool call';
      this.view?.webview.postMessage({ type: 'toolCall', text: label });
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
            handler?.dispose();
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
      this.output.appendLine(`[DELETE] sessionId=${sessionId}`);
      await this.client!.deleteSession(sessionId);
      this.output.appendLine(`[DELETE] done`);
      // Refresh session list
      const sessions = await this.client!.listSessions();
      this.view?.webview.postMessage({ type: 'sessions', sessions });
    } catch (err: any) {
      this.output.appendLine(`[DELETE ERROR] ${err.message}`);
      this.view?.webview.postMessage({ type: 'error', text: err.message });
    }
  }

  private async handleLoadSession(sessionId: string): Promise<void> {
    try {
      if (!this.client) this.initClient();
      await this.client!.loadSession(sessionId);
    } catch (err: any) {
      this.view?.webview.postMessage({ type: 'error', text: err.message });
    }
  }

  private async handleSend(text: string): Promise<void> {
    if (!text.trim()) return;

    this.view?.webview.postMessage({ type: 'userMessage', text });
    this.view?.webview.postMessage({ type: 'thinking' });

    try {
      if (!this.client) this.initClient();
      this.skipWelcome = false; // first real message — allow chunks through
      this.output.appendLine(`[SEND] ${text}`);
      this.output.show(true);
      await this.client!.send(text);
    } catch (err: any) {
      this.output.appendLine(`[ERROR] ${err.message}`);
      this.view?.webview.postMessage({ type: 'error', text: `CLI error: ${err.message}` });
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
