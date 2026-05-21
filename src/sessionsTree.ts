import * as vscode from 'vscode';

/**
 * Native "Sessions" tree view in the Codeep sidebar — browse, load, and delete
 * saved conversations without opening the webview's session panel. Backed by
 * the same ACP session ops (session/list, session/load, session/delete) the
 * chat uses, via a minimal source interface so this file stays decoupled from
 * the ChatPanel internals.
 */

export interface SessionSource {
  getSessions(): Promise<{ sessionId: string; title?: string; updatedAt?: string }[]>;
  openSession(id: string): Promise<void>;
  deleteSessionById(id: string): Promise<void>;
  readonly onSessionsChanged: vscode.Event<void>;
}

function relativeAge(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

class SessionNode extends vscode.TreeItem {
  constructor(public readonly sessionId: string, title: string | undefined, updatedAt: string | undefined) {
    super(title?.trim() || sessionId, vscode.TreeItemCollapsibleState.None);
    this.description = relativeAge(updatedAt);
    this.tooltip = new vscode.MarkdownString(
      `**${title?.trim() || sessionId}**\n\nID: \`${sessionId}\`${updatedAt ? `\n\n${relativeAge(updatedAt)}` : ''}`,
    );
    this.iconPath = new vscode.ThemeIcon('comment-discussion');
    this.contextValue = 'codeepSession';
    this.command = { command: 'codeep.tree.openSession', title: 'Open Session', arguments: [sessionId] };
  }
}

class SessionsTreeProvider implements vscode.TreeDataProvider<SessionNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly source: SessionSource) {
    source.onSessionsChanged(() => this._onDidChangeTreeData.fire());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: SessionNode): vscode.TreeItem {
    return node;
  }

  async getChildren(): Promise<SessionNode[]> {
    const sessions = await this.source.getSessions();
    return sessions.map((s) => new SessionNode(s.sessionId, s.title, s.updatedAt));
  }
}

export function registerSessionsTree(context: vscode.ExtensionContext, source: SessionSource): void {
  const provider = new SessionsTreeProvider(source);
  context.subscriptions.push(vscode.window.registerTreeDataProvider('codeep.sessions', provider));

  context.subscriptions.push(
    vscode.commands.registerCommand('codeep.tree.openSession', (sessionId: string) => {
      if (sessionId) void source.openSession(sessionId);
    }),
    vscode.commands.registerCommand('codeep.tree.refreshSessions', () => provider.refresh()),
    vscode.commands.registerCommand('codeep.tree.deleteSession', async (node?: SessionNode) => {
      if (!node?.sessionId) return;
      const label = typeof node.label === 'string' ? node.label : node.sessionId;
      const confirm = 'Delete';
      const choice = await vscode.window.showWarningMessage(
        `Delete session "${label}"? This can't be undone.`,
        { modal: true },
        confirm,
      );
      if (choice !== confirm) return;
      await source.deleteSessionById(node.sessionId);
    }),
  );
}
