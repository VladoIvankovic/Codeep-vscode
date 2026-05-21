import * as vscode from 'vscode';

/**
 * "Generate Commit Message" — adds a sparkle button to the Source Control
 * view title (and a command palette entry). Reads the staged diff via the
 * built-in `vscode.git` extension API, asks Codeep to summarize it as a
 * Conventional Commits message, and writes the result into the repo's commit
 * input box.
 *
 * Uses the stable `scm/title` menu + `Repository.inputBox.value` — the
 * in-input sparkle (`scm/inputBox`) is still a proposed API, so we keep to
 * the title bar to stay marketplace-installable.
 *
 * The git extension types aren't bundled, so the API surface is typed loosely.
 */

type Generate = (diff: string) => Promise<string | null>;

const MAX_DIFF = 12_000; // keep the prompt cheap; truncate huge diffs

interface GitRepoLike {
  rootUri: vscode.Uri;
  inputBox: { value: string };
  diff(cached?: boolean): Promise<string>;
}

async function getRepositories(): Promise<GitRepoLike[] | null> {
  const ext = vscode.extensions.getExtension<any>('vscode.git');
  if (!ext) return null;
  if (!ext.isActive) {
    try { await ext.activate(); } catch { return null; }
  }
  const api = ext.exports?.getAPI?.(1);
  return (api?.repositories as GitRepoLike[]) ?? [];
}

async function pickRepository(scmArg: any): Promise<GitRepoLike | null> {
  const repos = await getRepositories();
  if (repos === null) {
    vscode.window.showWarningMessage('Codeep: the built-in Git extension is not available.');
    return null;
  }
  if (repos.length === 0) {
    vscode.window.showWarningMessage('Codeep: no Git repository found in this workspace.');
    return null;
  }
  // When invoked from the SCM title menu, scmArg.rootUri identifies the repo.
  const rootUri: vscode.Uri | undefined = scmArg?.rootUri;
  if (rootUri) {
    const match = repos.find((r) => r.rootUri?.toString() === rootUri.toString());
    if (match) return match;
  }
  if (repos.length === 1) return repos[0];
  const pick = await vscode.window.showQuickPick(
    repos.map((r) => ({ label: r.rootUri.fsPath, repo: r })),
    { placeHolder: 'Generate a commit message for which repository?' },
  );
  return pick?.repo ?? null;
}

export function registerGenerateCommitMessage(context: vscode.ExtensionContext, generate: Generate): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('codeep.generateCommitMessage', async (scmArg?: any) => {
      const repo = await pickRepository(scmArg);
      if (!repo) return;

      // Prefer the staged diff; fall back to the full working-tree diff so the
      // command is useful even before `git add`.
      let diff = '';
      try { diff = await repo.diff(true); } catch { /* ignore */ }
      if (!diff.trim()) {
        try { diff = await repo.diff(false); } catch { /* ignore */ }
      }
      if (!diff.trim()) {
        vscode.window.showInformationMessage('Codeep: no changes to summarize — stage or modify some files first.');
        return;
      }
      const capped = diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n…(diff truncated)…` : diff;

      let message: string | null = null;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.SourceControl, title: 'Codeep: generating commit message…' },
        async () => {
          try {
            message = await generate(capped);
          } catch (err: any) {
            vscode.window.showErrorMessage(`Codeep: commit message failed — ${err?.message || err}`);
          }
        },
      );
      if (!message || !(message as string).trim()) {
        vscode.window.showWarningMessage('Codeep: no commit message was generated.');
        return;
      }

      // Don't clobber a message the user already typed without asking.
      const existing = repo.inputBox.value.trim();
      if (existing && existing !== (message as string).trim()) {
        const replace = 'Replace';
        const choice = await vscode.window.showWarningMessage(
          'Codeep: the commit message box already has text. Replace it?',
          { modal: false },
          replace,
        );
        if (choice !== replace) return;
      }
      repo.inputBox.value = (message as string).trim();
    }),
  );
}
