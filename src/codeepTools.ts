import * as vscode from 'vscode';

/**
 * Language Model Tool: `codeep_skills`.
 *
 * Exposes the workspace's Codeep skill bundles (`.codeep/skills/<name>/SKILL.md`)
 * to VS Code's agent mode and `#codeepSkills` references. This lets the native
 * agent discover and follow the project's own Codeep workflows (deploy steps,
 * review checklists, hotfix flows) instead of guessing.
 *
 * Self-contained: reads the workspace folder via the fs API — no CLI / ACP
 * round-trip. Returns each bundle's name + SKILL.md body, capped so the result
 * stays within a reasonable token budget.
 */

const MAX_BUNDLES = 25;
const MAX_BODY = 4_000; // chars per SKILL.md included in the result

interface SkillBundle {
  name: string;
  body: string;
}

async function readSkillBundles(): Promise<SkillBundle[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const out: SkillBundle[] = [];
  for (const folder of folders) {
    const skillsDir = vscode.Uri.joinPath(folder.uri, '.codeep', 'skills');
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(skillsDir);
    } catch {
      continue; // no .codeep/skills here
    }
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.Directory) continue;
      if (out.length >= MAX_BUNDLES) break;
      const skillFile = vscode.Uri.joinPath(skillsDir, name, 'SKILL.md');
      try {
        const bytes = await vscode.workspace.fs.readFile(skillFile);
        let body = Buffer.from(bytes).toString('utf8');
        if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY)}\n…(truncated)…`;
        out.push({ name, body });
      } catch {
        /* no SKILL.md in this dir — skip */
      }
    }
  }
  return out;
}

class CodeepSkillsTool implements vscode.LanguageModelTool<Record<string, never>> {
  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const bundles = await readSkillBundles();
    if (bundles.length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          'No Codeep skill bundles found in this workspace (.codeep/skills/<name>/SKILL.md).',
        ),
      ]);
    }
    const text = bundles
      .map((b) => `## Skill: ${b.name}\n\n${b.body}`)
      .join('\n\n---\n\n');
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        `Codeep skill bundles defined in this workspace (${bundles.length}). Follow the relevant one when the user's task matches it:\n\n${text}`,
      ),
    ]);
  }

  async prepareInvocation(
    _options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, never>>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.PreparedToolInvocation> {
    return { invocationMessage: 'Reading Codeep skill bundles' };
  }
}

export function registerCodeepTools(context: vscode.ExtensionContext): void {
  // Defensive: lm.registerTool exists from VS Code 1.95+.
  if (!vscode.lm?.registerTool) return;
  context.subscriptions.push(vscode.lm.registerTool('codeep_skills', new CodeepSkillsTool()));
}
