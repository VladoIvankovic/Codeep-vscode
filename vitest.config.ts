import { defineConfig } from 'vitest/config';

// Unit tests cover the vscode-free modules (acpClient, mcpConfigFile) — the
// most logic-dense, bug-prone code (JSON-RPC stream framing, MCP config merge).
// Files that import 'vscode' need the Electron host and aren't unit-tested here.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
