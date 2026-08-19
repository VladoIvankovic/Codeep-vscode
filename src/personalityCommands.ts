import { spawn } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import * as vscode from 'vscode';
import type { ChatPanel } from './chatPanel';
import { personalityDetail, type PersonalityDefinition } from './personalities';

const DASHBOARD_URL = 'https://codeep.dev/dashboard/personalities';

function runAccountSync(cliPath: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const processHandle = spawn(cliPath, ['account', 'sync'], {
      cwd,
      env: process.env,
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    processHandle.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    processHandle.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    processHandle.once('error', reject);
    processHandle.once('close', (code) => {
      const output = `${stdout}\n${stderr}`.replace(/\u001b\[[0-9;]*m/g, '').trim();
      if (code !== 0 || /not linked|failed/i.test(output)) {
        reject(new Error(output || `Codeep CLI exited with code ${code ?? 'unknown'}`));
        return;
      }
      resolve(output);
    });
  });
}

function quickPickDetail(personality: PersonalityDefinition): string {
  const origin = personality.source === 'builtin' ? 'Built-in' : personality.source === 'project' ? 'Project' : 'Cloud / global';
  return `${origin} · ${personalityDetail(personality)}`;
}

async function openDirectory(uri: vscode.Uri): Promise<void> {
  await vscode.workspace.fs.createDirectory(uri);
  await vscode.commands.executeCommand('revealFileInOS', uri);
}

export function registerPersonalityCommands(context: vscode.ExtensionContext, chatPanel: ChatPanel): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('codeep.selectPersonality', async () => {
      try {
        const state = await chatPanel.getPersonalityState(true);
        const choices = [
          {
            label: '$(circle-slash) Default Codeep',
            description: state.activePersonality === null ? 'active' : 'No custom bot',
            detail: 'Current model · unrestricted tools · all projects',
            personality: null as PersonalityDefinition | null,
          },
          ...state.personalities.map((personality) => ({
            label: `$(sparkle) ${personality.displayName}`,
            description: !personality.available
              ? state.source === 'files' && personality.structured
                ? `update Codeep CLI · ${personality.name}`
                : `unavailable here · ${personality.name}`
              : personality.name === state.activePersonality ? `active · ${personality.name}` : personality.name,
            detail: `${personality.description}\n${quickPickDetail(personality)}`,
            personality,
          })),
        ];
        const picked = await vscode.window.showQuickPick(choices, {
          title: 'Choose a Codeep custom bot',
          placeHolder: 'The selected bot applies to CLI, VS Code, and the shared Codeep config',
          matchOnDescription: true,
          matchOnDetail: true,
        });
        if (!picked) return;
        if (picked.personality && !picked.personality.available) {
          vscode.window.showWarningMessage(
            state.source === 'files' && picked.personality.structured
              ? `Codeep: update the CLI before using ${picked.personality.displayName}; this runtime cannot enforce its model, tools, and scope.`
              : `Codeep: ${picked.personality.displayName} is not available in this workspace or mode.`,
          );
          return;
        }
        const selected = await chatPanel.setPersonality(picked.personality?.name ?? null);
        vscode.window.showInformationMessage(
          selected ? `Codeep: ${selected.displayName} is now active.` : 'Codeep: using the default agent.',
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Codeep: could not switch custom bot — ${(error as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('codeep.syncPersonalities', async () => {
      const config = vscode.workspace.getConfiguration('codeep');
      const cliPath = config.get<string>('cliPath')?.trim() || 'codeep';
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || homedir();
      let requiresCliUpdate = false;
      try {
        const updated = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Codeep: syncing custom bots from dashboard…',
            cancellable: false,
          },
          async () => {
            const rpcUpdated = await chatPanel.syncPersonalitiesViaRpc();
            if (rpcUpdated !== null) return rpcUpdated;
            await runAccountSync(cliPath, cwd);
            await chatPanel.refreshPersonalities();
            const state = await chatPanel.getPersonalityState();
            requiresCliUpdate = state.source === 'files' && state.personalities.some(item => item.structured);
            return null;
          },
        );
        if (requiresCliUpdate) {
          vscode.window.showWarningMessage(
            'Codeep: bots are synced, but structured bots require a newer Codeep CLI before their runtime controls can be enforced.',
          );
        } else {
          vscode.window.showInformationMessage(
            `Codeep: custom bots are synced${updated !== null && updated > 0 ? ` (${updated} updated)` : ''} and ready to use.`,
          );
        }
      } catch (error) {
        const action = 'Open terminal';
        const choice = await vscode.window.showWarningMessage(
          `Codeep: sync failed — ${(error as Error).message}`,
          action,
        );
        if (choice === action) {
          const terminal = vscode.window.createTerminal('Codeep account');
          terminal.sendText(`${cliPath} account`);
          terminal.show();
        }
      }
    }),

    vscode.commands.registerCommand('codeep.openPersonalityBuilder', () =>
      vscode.env.openExternal(vscode.Uri.parse(DASHBOARD_URL))),

    vscode.commands.registerCommand('codeep.managePersonalities', async () => {
      const state = await chatPanel.getPersonalityState(true);
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const options: Array<{
        label: string;
        description?: string;
        detail?: string;
        action: 'dashboard' | 'global-folder' | 'project-folder' | 'edit';
        personality?: PersonalityDefinition;
      }> = [
        {
          label: '$(globe) Open Personality Builder',
          description: 'codeep.dev',
          detail: 'Create and edit structured custom bots in the guided dashboard builder.',
          action: 'dashboard',
        },
        {
          label: '$(folder-opened) Open global custom bots',
          description: '~/.codeep/personalities',
          action: 'global-folder',
        },
      ];
      if (workspaceRoot) {
        options.push({
          label: '$(root-folder-opened) Open project custom bots',
          description: '.codeep/personalities',
          action: 'project-folder',
        });
      }
      for (const personality of state.personalities.filter((item) => item.filePath)) {
        options.push({
          label: `$(edit) ${personality.displayName}`,
          description: personality.source,
          detail: quickPickDetail(personality),
          action: 'edit',
          personality,
        });
      }

      const picked = await vscode.window.showQuickPick(options, {
        title: 'Manage Codeep custom bots',
        placeHolder: 'Use the dashboard builder or edit a compatible Markdown file',
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!picked) return;
      if (picked.action === 'dashboard') {
        await vscode.env.openExternal(vscode.Uri.parse(DASHBOARD_URL));
      } else if (picked.action === 'global-folder') {
        await openDirectory(vscode.Uri.file(join(homedir(), '.codeep', 'personalities')));
      } else if (picked.action === 'project-folder' && workspaceRoot) {
        await openDirectory(vscode.Uri.file(join(workspaceRoot, '.codeep', 'personalities')));
      } else if (picked.action === 'edit' && picked.personality?.filePath) {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(picked.personality.filePath));
        await vscode.window.showTextDocument(document);
      }
    }),
  );
}
