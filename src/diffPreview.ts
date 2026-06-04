/**
 * Native VS Code diff editor for agent file edits.
 *
 * Renders pending writes/edits in a real `vscode.diff` editor instead of a
 * truncated markdown blob inside the chat webview. Two flows:
 *
 *   1. **Permission flow** (`session/request_permission` for write/edit
 *      tools): pop the diff open BEFORE the user clicks Allow so they can
 *      review the change with syntax highlighting, gutter markers, and
 *      proper word-wrap. Diff is closed automatically after the user
 *      responds.
 *
 *   2. **Auto-confirm flow** (no permission prompt — agent runs writes
 *      directly): snapshot the file's current contents on `tool_call`
 *      (in_progress) and pop the diff open on `tool_call_update`
 *      (completed). Read-only review — no accept/reject, just visibility.
 *
 * "After" content for both flows is served from a virtual document under
 * the `codeep-edit:` URI scheme. We use a custom scheme (not `untitled:`)
 * so VS Code doesn't try to save it, prompt for a filename, or list it in
 * the file picker.
 */

import * as vscode from 'vscode';
import { basename } from 'path';

const SCHEME = 'codeep-edit';

class CodeepEditContentProvider implements vscode.TextDocumentContentProvider {
  private contents = new Map<string, string>();
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  /** Set the text for a virtual URI. Triggers a refresh in any open editors. */
  set(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this.emitter.fire(uri);
  }

  /** Drop a virtual URI so it stops occupying memory once the diff closes. */
  clear(uri: vscode.Uri): void {
    this.contents.delete(uri.toString());
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }
}

let provider: CodeepEditContentProvider | null = null;

/**
 * Map of open diff-preview virtual URIs → permission request id. Drives the
 * Accept / Reject CodeLenses: when the lens command fires it looks up the
 * pending request id by the modified-side URI of the active diff editor.
 * Cleared automatically when the diff closes or the user responds.
 */
const pendingPermissionByUri = new Map<string, number>();

/** Register that a virtual URI corresponds to a pending permission request. */
export function trackPendingPermission(uri: vscode.Uri, requestId: number): void {
  pendingPermissionByUri.set(uri.toString(), requestId);
}

/** Look up the permission request id for a virtual URI (or null). */
export function getPendingPermissionForUri(uri: vscode.Uri): number | null {
  return pendingPermissionByUri.get(uri.toString()) ?? null;
}

/** Drop tracking for a virtual URI — call when user responds or diff closes. */
export function clearPendingPermissionForUri(uri: vscode.Uri): void {
  pendingPermissionByUri.delete(uri.toString());
}

/**
 * Register the virtual document provider. Call once from `activate()`.
 * Returns a Disposable that should be added to context.subscriptions.
 */
export function registerDiffPreview(context: vscode.ExtensionContext): vscode.Disposable {
  provider = new CodeepEditContentProvider();
  const disp = vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider);
  context.subscriptions.push(disp);
  return disp;
}

/** The URI scheme used for proposed-change virtual documents. */
export const DIFF_PREVIEW_SCHEME = SCHEME;

interface PreviewHandle {
  /** Virtual URI of the right-hand-side (proposed) document. */
  proposedUri: vscode.Uri;
  /** Close the diff editor tabs that this preview opened. */
  close(): Promise<void>;
}

/**
 * Build the virtual URI for a given physical file. We mirror the original
 * path inside the URI so VS Code derives a useful tab title and picks the
 * right language for syntax highlighting from the extension.
 */
function virtualUriFor(absolutePath: string): vscode.Uri {
  // Encode as opaque path under the scheme: codeep-edit:/<real-path>
  // Using a leading slash keeps it absolute and avoids workspace-relative
  // URI resolution quirks.
  return vscode.Uri.parse(`${SCHEME}:${absolutePath} (proposed)`);
}

/**
 * Show a diff of a pending write/edit. Returns a handle that closes the
 * specific diff tab opened — leaves the user's other tabs alone.
 *
 * @param absolutePath  Full filesystem path of the file being changed.
 * @param newContent    The text the agent wants to write.
 * @param title         Tab title (e.g. `"Codeep proposes: foo.ts"`).
 */
export async function showProposedChange(
  absolutePath: string,
  newContent: string,
  title?: string,
): Promise<PreviewHandle> {
  if (!provider) {
    throw new Error('Diff preview not initialized — call registerDiffPreview() during activate().');
  }

  const fileUri = vscode.Uri.file(absolutePath);
  const proposedUri = virtualUriFor(absolutePath);
  provider.set(proposedUri, newContent);

  // If the file doesn't exist yet (creating a new file), use an empty
  // virtual document on the LHS so the diff shows the whole proposed
  // content as additions instead of erroring.
  let lhsUri: vscode.Uri = fileUri;
  let createdEmptyLhs: vscode.Uri | null = null;
  try {
    await vscode.workspace.fs.stat(fileUri);
  } catch {
    const emptyUri = vscode.Uri.parse(`${SCHEME}:${absolutePath} (current — file does not exist)`);
    provider.set(emptyUri, '');
    lhsUri = emptyUri;
    createdEmptyLhs = emptyUri;
  }

  const tabTitle = title ?? `Codeep: ${basename(absolutePath)} (proposed change)`;
  await vscode.commands.executeCommand('vscode.diff', lhsUri, proposedUri, tabTitle, {
    preview: true,           // single reusable tab — avoids piling up
    preserveFocus: true,     // keep focus in the chat so Allow/Deny stays reachable
  });

  return {
    proposedUri,
    close: async () => {
      // Find and close the specific tab we opened. Iterate over all tab
      // groups so we close the diff regardless of which group VS Code
      // landed it in.
      const groups = vscode.window.tabGroups.all;
      for (const group of groups) {
        for (const tab of group.tabs) {
          const input = tab.input;
          if (input instanceof vscode.TabInputTextDiff) {
            if (input.modified.toString() === proposedUri.toString()) {
              await vscode.window.tabGroups.close(tab);
            }
          }
        }
      }
      if (provider) {
        provider.clear(proposedUri);
        if (createdEmptyLhs) provider.clear(createdEmptyLhs);
      }
      // Always drop the pending-permission mapping — caller may have
      // already cleared it, but this is a safety net for paths where the
      // diff is closed independently of a permission reply.
      pendingPermissionByUri.delete(proposedUri.toString());
    },
  };
}

/**
 * Synthesize the "after" text for an edit_file tool call (single-occurrence
 * find/replace) without calling the model again. Returns null if the
 * replacement target isn't in the current file — caller should fall back
 * to showing just the new_string in that case.
 */
export function synthesizeEditedContent(
  currentContent: string,
  oldString: string,
  newString: string,
): string | null {
  if (!currentContent.includes(oldString)) return null;
  // The agent guarantees a single match (see edit_file in
  // utils/toolExecution.ts), so a single replace mirrors what'll be
  // written. Use a function replacer so the new text is inserted literally —
  // a plain string would let `$&`, `$1`, `$$` etc. (common in shell vars,
  // template literals, regex) corrupt the result.
  return currentContent.replace(oldString, () => newString);
}
