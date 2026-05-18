/**
 * Accept / Reject CodeLens for the proposed-change diff editor.
 *
 * When `showProposedChange` opens a diff (LHS = current file, RHS = virtual
 * `codeep-edit:` doc), VS Code renders this CodeLens at the top of the RHS
 * document. Clicking either action fires a command registered in
 * `extension.ts` which forwards the answer to the CLI as if the user had
 * clicked the inline webview button.
 *
 * Why CodeLens instead of CodeAction / quick fix? CodeLens is always
 * visible at the top of the document — there's no menu to discover and
 * no keyboard shortcut to memorise. For an Allow/Deny prompt where the
 * decision is the whole point of the editor being open, "always on top"
 * is the right affordance.
 */

import * as vscode from 'vscode';
import { DIFF_PREVIEW_SCHEME, getPendingPermissionForUri } from './diffPreview';

export class DiffPreviewCodeLensProvider implements vscode.CodeLensProvider {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  /** Force VS Code to re-query lenses. Call when a permission flow finishes. */
  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.uri.scheme !== DIFF_PREVIEW_SCHEME) return [];

    // Only show lenses when there's actually a pending permission request
    // attached to this URI. If the diff was opened via some other code
    // path (e.g. a stale tab) we don't want fake Accept/Reject buttons.
    if (getPendingPermissionForUri(document.uri) === null) return [];

    // Lens anchors to line 0 — VS Code renders it above the first line
    // of the document so it sits at the very top of the right pane.
    const range = new vscode.Range(0, 0, 0, 0);
    return [
      new vscode.CodeLens(range, {
        title: '$(check) Accept',
        command: 'codeep.acceptProposedChange',
        arguments: [document.uri.toString()],
      }),
      new vscode.CodeLens(range, {
        title: '$(x) Reject',
        command: 'codeep.rejectProposedChange',
        arguments: [document.uri.toString()],
      }),
      // The "Allow for this session" mirror of the webview button — same
      // semantics: auto-approve this tool until the CLI restarts. Wrapped
      // in parens so users don't mis-click it as "Accept".
      new vscode.CodeLens(range, {
        title: '(Allow this tool for session)',
        command: 'codeep.acceptProposedChangeAlways',
        arguments: [document.uri.toString()],
      }),
    ];
  }
}
