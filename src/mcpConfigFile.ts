/**
 * VS Code-side mirror of `src/utils/mcpConfig.ts` from the CLI. Kept here
 * (instead of importing from the CLI) so the extension stays self-
 * contained — VS Code shouldn't depend on the CLI's source tree being
 * present at runtime.
 *
 * Used by:
 *   - `acpClient.ts loadMcpServerConfigForVsCode()` — read on session start
 *   - `extension.ts codeep.mcpAddServer / codeep.mcpRemoveServer` — write
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

export interface VsCodeMcpServer {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export type McpScope = 'project' | 'global';

interface ConfigFile {
  mcpServers?: Record<string, Omit<VsCodeMcpServer, 'name'>> | VsCodeMcpServer[];
}

const REL = '.codeep/mcp_servers.json';

function pathFor(scope: McpScope, workspaceRoot?: string): string | null {
  if (scope === 'global') return join(homedir(), REL);
  return workspaceRoot ? join(workspaceRoot, REL) : null;
}

function readConfig(path: string): ConfigFile {
  if (!existsSync(path)) return { mcpServers: {} };
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ConfigFile;
  } catch {
    // Don't overwrite a file the user might be midway through editing.
    return { mcpServers: {} };
  }
}

function configToMap(cfg: ConfigFile): Record<string, Omit<VsCodeMcpServer, 'name'>> {
  if (Array.isArray(cfg.mcpServers)) {
    const map: Record<string, Omit<VsCodeMcpServer, 'name'>> = {};
    for (const s of cfg.mcpServers) {
      const { name: n, ...rest } = s;
      map[n] = rest;
    }
    return map;
  }
  return cfg.mcpServers ?? {};
}

function writeConfig(path: string, cfg: ConfigFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
}

/** List all servers in a given scope. Empty array if the file doesn't exist. */
export function listServers(scope: McpScope, workspaceRoot?: string): VsCodeMcpServer[] {
  const path = pathFor(scope, workspaceRoot);
  if (!path) return [];
  const cfg = readConfig(path);
  const map = configToMap(cfg);
  return Object.entries(map).map(([name, rest]) => ({ name, ...rest }));
}

/** Add or replace a server entry in the given scope's config file. */
export function addServer(scope: McpScope, server: VsCodeMcpServer, workspaceRoot?: string): void {
  const path = pathFor(scope, workspaceRoot);
  if (!path) throw new Error('Cannot save MCP server: no workspace open.');
  const cfg = readConfig(path);
  const map = configToMap(cfg);
  const { name, ...rest } = server;
  map[name] = rest;
  cfg.mcpServers = map;
  writeConfig(path, cfg);
}

/** Remove a server entry from the given scope's config file. */
export function removeServer(scope: McpScope, name: string, workspaceRoot?: string): boolean {
  const path = pathFor(scope, workspaceRoot);
  if (!path || !existsSync(path)) return false;
  const cfg = readConfig(path);
  const map = configToMap(cfg);
  if (!map[name]) return false;
  delete map[name];
  cfg.mcpServers = map;
  writeConfig(path, cfg);
  return true;
}

/** Resolve the on-disk path for a given scope (for "Open Config" actions). */
export function configPath(scope: McpScope, workspaceRoot?: string): string | null {
  return pathFor(scope, workspaceRoot);
}
