/**
 * Status-bar rendering for the Codeep VS Code extension.
 *
 * Extracted from `extension.ts` so the per-state presentation rules
 * (icon, text, tooltip, background colour) can be unit-tested without
 * spinning up a full extension host. The renderer is a pure function:
 * given a `ChatStatusState`, it returns the fields a caller should
 * apply to its `StatusBarItem`.
 */
import * as vscode from 'vscode';
import type { ChatStatusState } from './chatPanel';

// `ChatStatusState` (connection / model / reconnect) is re-exported from
// `chatPanel.ts` so there's a single source of truth for the status payload.

/** The status-bar fields the renderer decides. */
export interface StatusBarFields {
  /** `StatusBarItem.text` — may include `$(codicon)` glyphs. */
  text: string;
  /** `StatusBarItem.tooltip` — string or MarkdownString. */
  tooltip: string | vscode.MarkdownString;
  /** `StatusBarItem.command` — fired on click. */
  command: string;
  /** `StatusBarItem.backgroundColor` — warning/error tint, or undefined. */
  backgroundColor: vscode.ThemeColor | undefined;
}

/**
 * Render the status-bar fields for a given chat state.
 *
 * The default click action is "open chat"; the connected state overrides
 * it to the model picker so clicking "Codeep · <model>" lets the user
 * switch models.
 */
export function renderStatusBar(s: ChatStatusState): StatusBarFields {
  switch (s.connection) {
    case 'connecting':
      return {
        text: '$(loading~spin) Codeep',
        tooltip: 'Connecting to Codeep CLI…',
        command: 'codeep.openChat',
        backgroundColor: undefined,
      };
    case 'connected':
      return {
        text: s.model ? `$(circuit-board) Codeep · ${s.model}` : '$(circuit-board) Codeep',
        tooltip: new vscode.MarkdownString(
          `Codeep CLI · **connected**${s.model ? ` · model \`${s.model}\`` : ''}\n\nClick to change model.`,
        ),
        command: 'codeep.selectModel',
        backgroundColor: undefined,
      };
    case 'reconnecting':
      return {
        text: s.reconnect
          ? `$(sync~spin) Codeep · Reconnect ${s.reconnect.attempt}/${s.reconnect.max}`
          : '$(sync~spin) Codeep · Reconnecting',
        tooltip: s.reconnect
          ? `Reconnecting in ${s.reconnect.delaySec}s (attempt ${s.reconnect.attempt}/${s.reconnect.max})`
          : 'Reconnecting to Codeep CLI…',
        command: 'codeep.openChat',
        backgroundColor: new vscode.ThemeColor('statusBarItem.warningBackground'),
      };
    case 'disconnected':
      return {
        text: '$(plug) Codeep · Off',
        tooltip: 'Codeep CLI disconnected — click to open chat',
        command: 'codeep.openChat',
        backgroundColor: new vscode.ThemeColor('statusBarItem.warningBackground'),
      };
    case 'failed':
      return {
        text: '$(error) Codeep · Failed',
        tooltip: 'Codeep CLI reconnect failed — reload the window',
        command: 'codeep.openChat',
        backgroundColor: new vscode.ThemeColor('statusBarItem.errorBackground'),
      };
  }
}
