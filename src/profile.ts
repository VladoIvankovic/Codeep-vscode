import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import type { ChatPanel } from './chatPanel';

// Templates mirror the CLI's `/me init` so a profile created here reads
// identically to one created in the terminal. The CLI/ACP agent injects these
// files into its context on every run (~/.codeep/profile.md is global,
// <workspace>/.codeep/profile.md is project-scoped).
const GLOBAL_TEMPLATE = `# About Me

<!-- Codeep reads this file and adapts to you on every project. Write in any
     language. Keep it short — it is added to the agent's context on each
     request. Delete the hints you don't use. -->

## Preferences
- Reply language:
- Response style: (concise / detailed)
- Explain before making changes: (yes / no)

## My stack
- Languages:
- Frameworks / tools:

## Always / Never
- Always:
- Never:
`;

const PROJECT_TEMPLATE = `# About This Project (for me)

<!-- Project-specific context Codeep should know when working here. This sits
     alongside .codeep/rules.md, which is for hard project rules. -->

## My role on this project


## Goals


## Constraints / don't touch


## Deploy target
`;

/** Open a profile file, scaffolding it from a template when it doesn't exist. */
async function openOrCreate(uri: vscode.Uri, template: string): Promise<void> {
  let created = false;
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    // workspace.fs.writeFile creates missing parent directories.
    await vscode.workspace.fs.writeFile(uri, Buffer.from(template, 'utf-8'));
    created = true;
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  if (created) {
    vscode.window.showInformationMessage('Codeep: created your profile — fill it in and Codeep adapts automatically.');
  }
}

export function registerProfileCommands(context: vscode.ExtensionContext, chatPanel: ChatPanel): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('codeep.editProfile', async () => {
      const uri = vscode.Uri.file(path.join(os.homedir(), '.codeep', 'profile.md'));
      await openOrCreate(uri, GLOBAL_TEMPLATE);
    }),

    vscode.commands.registerCommand('codeep.editProjectProfile', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) {
        vscode.window.showWarningMessage('Codeep: open a workspace first to edit its project profile.');
        return;
      }
      const uri = vscode.Uri.joinPath(root, '.codeep', 'profile.md');
      await openOrCreate(uri, PROJECT_TEMPLATE);
    }),

    vscode.commands.registerCommand('codeep.toggleAutoLearn', async () => {
      const config = vscode.workspace.getConfiguration('codeep');
      const next = !(config.get<boolean>('autoLearnProfile') ?? false);
      await config.update('autoLearnProfile', next, vscode.ConfigurationTarget.Global);
      // Push live to a running session; harmless if the CLI isn't started yet
      // (the pin applies on the next connect via acpClient overrides).
      try { await chatPanel.setAutoLearn(next); } catch { /* not running yet */ }
      vscode.window.showInformationMessage(
        next
          ? 'Codeep: profile auto-learn ON — Codeep will quietly learn your preferences from sessions. Review with the CLI `/me`, clear with `/me forget`.'
          : 'Codeep: profile auto-learn OFF.',
      );
    }),

    vscode.commands.registerCommand('codeep.syncProfile', async () => {
      try {
        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Codeep: syncing profile to dashboard…' },
          () => chatPanel.syncProfile(),
        );
        vscode.window.showInformationMessage(`Codeep: ${result || 'profile synced.'}`);
      } catch (err) {
        vscode.window.showWarningMessage(`Codeep: profile sync failed — ${(err as Error).message}. Make sure the CLI is linked (run \`codeep account\`).`);
      }
    }),
  );
}
