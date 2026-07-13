import { describe, it, expect, vi } from 'vitest';

// statusBarRenderer.ts imports 'vscode' for `MarkdownString` and
// `ThemeColor`. Neither does real work in a unit-test context — we just
// need the constructors to exist so the renderer can build the values
// it would hand to the real StatusBarItem. A minimal stub is enough.
vi.mock('vscode', () => {
  class MarkdownString {
    constructor(public value: string) {}
  }
  class ThemeColor {
    constructor(public id: string) {}
  }
  return { MarkdownString, ThemeColor };
});

import * as vscode from 'vscode';
import { renderStatusBar } from './statusBarRenderer';
import type { ChatStatusState } from './chatPanel';

function state(s: Partial<ChatStatusState>): ChatStatusState {
  return { connection: 'connecting', ...s };
}

describe('renderStatusBar', () => {
  describe('connecting', () => {
    it('shows the loading spinner with the "Codeep" label', () => {
      const f = renderStatusBar(state({ connection: 'connecting' }));
      expect(f.text).toBe('$(loading~spin) Codeep');
    });

    it('keeps the default open-chat command', () => {
      const f = renderStatusBar(state({ connection: 'connecting' }));
      expect(f.command).toBe('codeep.openChat');
    });

    it('uses a plain-string tooltip and no background tint', () => {
      const f = renderStatusBar(state({ connection: 'connecting' }));
      expect(f.tooltip).toBe('Connecting to Codeep CLI…');
      expect(f.backgroundColor).toBeUndefined();
    });
  });

  describe('connected', () => {
    it('includes the model name when one is set', () => {
      const f = renderStatusBar(state({ connection: 'connected', model: 'claude-4-opus' }));
      expect(f.text).toBe('$(circuit-board) Codeep · claude-4-opus');
    });

    it('omits the separator when no model is set', () => {
      const f = renderStatusBar(state({ connection: 'connected' }));
      expect(f.text).toBe('$(circuit-board) Codeep');
    });

    it('switches the click command to the model picker', () => {
      const f = renderStatusBar(state({ connection: 'connected', model: 'x' }));
      expect(f.command).toBe('codeep.selectModel');
    });

    it('builds a MarkdownString tooltip that mentions the model', () => {
      const f = renderStatusBar(state({ connection: 'connected', model: 'gpt-5' }));
      expect(f.tooltip).toBeInstanceOf(vscode.MarkdownString);
      expect((f.tooltip as vscode.MarkdownString).value).toContain('gpt-5');
      expect((f.tooltip as vscode.MarkdownString).value).toContain('connected');
    });

    it('omits the model from the tooltip when none is set', () => {
      const f = renderStatusBar(state({ connection: 'connected' }));
      const md = (f.tooltip as vscode.MarkdownString).value;
      expect(md).not.toContain('model `');
    });
  });

  describe('reconnecting', () => {
    it('shows the attempt counter when reconnect info is present', () => {
      const f = renderStatusBar(state({
        connection: 'reconnecting',
        reconnect: { attempt: 2, max: 5, delaySec: 10 },
      }));
      expect(f.text).toBe('$(sync~spin) Codeep · Reconnect 2/5');
      expect(f.tooltip).toBe('Reconnecting in 10s (attempt 2/5)');
    });

    it('falls back to a generic label when reconnect info is absent', () => {
      const f = renderStatusBar(state({ connection: 'reconnecting' }));
      expect(f.text).toBe('$(sync~spin) Codeep · Reconnecting');
      expect(f.tooltip).toBe('Reconnecting to Codeep CLI…');
    });

    it('uses the warning background tint', () => {
      const f = renderStatusBar(state({ connection: 'reconnecting' }));
      expect(f.backgroundColor).toBeInstanceOf(vscode.ThemeColor);
      expect((f.backgroundColor as vscode.ThemeColor).id).toBe('statusBarItem.warningBackground');
    });
  });

  describe('disconnected', () => {
    it('shows the plug icon and "Off"', () => {
      const f = renderStatusBar(state({ connection: 'disconnected' }));
      expect(f.text).toBe('$(plug) Codeep · Off');
    });

    it('uses the warning background tint', () => {
      const f = renderStatusBar(state({ connection: 'disconnected' }));
      expect((f.backgroundColor as vscode.ThemeColor).id).toBe('statusBarItem.warningBackground');
    });

    it('keeps the open-chat command so a click reopens the sidebar', () => {
      const f = renderStatusBar(state({ connection: 'disconnected' }));
      expect(f.command).toBe('codeep.openChat');
    });
  });

  describe('failed', () => {
    it('shows the error icon and "Failed"', () => {
      const f = renderStatusBar(state({ connection: 'failed' }));
      expect(f.text).toBe('$(error) Codeep · Failed');
    });

    it('uses the error background tint (not warning)', () => {
      const f = renderStatusBar(state({ connection: 'failed' }));
      expect(f.backgroundColor).toBeInstanceOf(vscode.ThemeColor);
      expect((f.backgroundColor as vscode.ThemeColor).id).toBe('statusBarItem.errorBackground');
    });

    it('tells the user to reload the window', () => {
      const f = renderStatusBar(state({ connection: 'failed' }));
      expect(f.tooltip).toContain('reload');
    });
  });
});
