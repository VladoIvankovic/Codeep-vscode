import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { listServers, addServer, removeServer, configPath } from './mcpConfigFile';

let root: string;

function writeRaw(content: string): void {
  const dir = join(root, '.codeep');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'mcp_servers.json'), content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codeep-mcpcfg-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('listServers', () => {
  it('returns [] when no config file exists', () => {
    expect(listServers('project', root)).toEqual([]);
  });

  it('returns [] for project scope with no workspaceRoot', () => {
    expect(listServers('project', undefined)).toEqual([]);
  });

  it('reads the object form (name → config)', () => {
    writeRaw(JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['-y', 'server-fs'] } } }));
    const servers = listServers('project', root);
    expect(servers).toEqual([{ name: 'fs', command: 'npx', args: ['-y', 'server-fs'] }]);
  });

  it('reads the array form (configToMap merge)', () => {
    writeRaw(JSON.stringify({ mcpServers: [{ name: 'gh', command: 'gh-mcp', args: [] }] }));
    const servers = listServers('project', root);
    expect(servers).toEqual([{ name: 'gh', command: 'gh-mcp', args: [] }]);
  });

  it('tolerates malformed JSON (returns [] instead of throwing)', () => {
    writeRaw('{ this is not valid json ');
    expect(listServers('project', root)).toEqual([]);
  });

  it('preserves the env field', () => {
    writeRaw(JSON.stringify({ mcpServers: { db: { command: 'pg', args: [], env: { PGHOST: 'x' } } } }));
    expect(listServers('project', root)[0].env).toEqual({ PGHOST: 'x' });
  });
});

describe('addServer', () => {
  it('creates the file and the entry, round-tripping via listServers', () => {
    addServer('project', { name: 'fs', command: 'npx', args: ['a'] }, root);
    expect(listServers('project', root)).toEqual([{ name: 'fs', command: 'npx', args: ['a'] }]);
  });

  it('upserts (replaces an existing entry by name)', () => {
    addServer('project', { name: 'fs', command: 'old', args: [] }, root);
    addServer('project', { name: 'fs', command: 'new', args: ['x'] }, root);
    const servers = listServers('project', root);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toEqual({ name: 'fs', command: 'new', args: ['x'] });
  });

  it('converts an existing array-form file to object form while preserving entries', () => {
    writeRaw(JSON.stringify({ mcpServers: [{ name: 'gh', command: 'gh-mcp', args: [] }] }));
    addServer('project', { name: 'fs', command: 'npx', args: [] }, root);
    const names = listServers('project', root).map((s) => s.name).sort();
    expect(names).toEqual(['fs', 'gh']);
    // Written back as the canonical object form, not an array.
    const onDisk = JSON.parse(readFileSync(join(root, '.codeep', 'mcp_servers.json'), 'utf-8'));
    expect(Array.isArray(onDisk.mcpServers)).toBe(false);
  });

  it('throws for project scope without a workspaceRoot', () => {
    expect(() => addServer('project', { name: 'x', command: 'y', args: [] }, undefined)).toThrow();
  });
});

describe('removeServer', () => {
  it('removes an entry and returns true', () => {
    addServer('project', { name: 'fs', command: 'npx', args: [] }, root);
    expect(removeServer('project', 'fs', root)).toBe(true);
    expect(listServers('project', root)).toEqual([]);
  });

  it('returns false when the entry is missing', () => {
    addServer('project', { name: 'fs', command: 'npx', args: [] }, root);
    expect(removeServer('project', 'nope', root)).toBe(false);
  });

  it('returns false when no config file exists', () => {
    expect(removeServer('project', 'fs', root)).toBe(false);
  });
});

describe('configPath', () => {
  it('resolves the project path under the workspace root', () => {
    expect(configPath('project', root)).toBe(join(root, '.codeep', 'mcp_servers.json'));
  });

  it('returns null for project scope without a workspace', () => {
    expect(configPath('project', undefined)).toBeNull();
  });
});
