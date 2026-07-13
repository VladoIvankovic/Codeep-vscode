import { describe, it, expect, vi } from 'vitest';

// chatPanel.ts imports 'vscode' for the WebviewViewProvider surface, but
// `friendlyError` is pure — a minimal stub lets the module load in node.
vi.mock('vscode', () => ({
  EventEmitter: class { event = () => undefined; fire() {} dispose() {} },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
  window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
  workspace: { workspaceFolders: [] },
  ViewColumn: { One: 1 },
}));

import { _friendlyErrorForTest as friendlyError } from './chatPanel';

describe('friendlyError', () => {
  it('explains a session/prompt timeout and surfaces the configured minutes', () => {
    const out = friendlyError('Request timeout: session/prompt — no activity for 12 min');
    expect(out).toContain('12 min');
    expect(out).toContain('codeep.requestTimeoutMinutes');
  });

  it('defaults to 5 min when the regex misses the duration', () => {
    const out = friendlyError('Request timeout: session/prompt (no duration in message)');
    expect(out).toContain('5 min');
  });

  it('returns a short message for a generic request timeout', () => {
    expect(friendlyError('Request timeout: something else'))
      .toBe('The CLI did not respond in time and the request was cancelled.');
  });

  it('maps each known CLI failure to its user-facing hint', () => {
    expect(friendlyError('CLI not running')).toBe('Codeep CLI is not running. Try reloading the window.');
    expect(friendlyError('CLI stopped')).toBe('The agent was stopped.');
    expect(friendlyError('process exited with code 1')).toBe('Codeep CLI crashed unexpectedly. Try reloading the window.');
    expect(friendlyError('CLI not found in PATH')).toBe('Codeep CLI not found. Run: npm install -g codeep');
  });

  it('passes through unknown messages verbatim', () => {
    expect(friendlyError('something completely different')).toBe('something completely different');
  });

  it('does not swallow empty strings', () => {
    expect(friendlyError('')).toBe('');
  });
});
