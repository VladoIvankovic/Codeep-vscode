// Inbound messages from the extension (chatPanel.ts → webview).
export interface InboundMessage {
  type: string;
  [key: string]: unknown;
}

export interface ConfigOption {
  id: string;
  name: string;
  currentValue: string;
  options: { value: string; name: string }[];
}

export interface ProviderEntry {
  id: string;
  name: string;
  description: string;
  groupLabel: string;
  hint: string;
  requiresKey: boolean;
  subscribeUrl?: string;
}

export interface PlanEntry {
  id: string;
  content: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
}

export interface SessionListEntry {
  sessionId: string;
  title?: string;
  messageCount?: number;
  updatedAt?: string;
}

export interface FileSearchItem {
  /** Visible name shown in the popup row (filename for files, symbol name for symbols). */
  name: string;
  /** For files: workspace-relative path. For symbols: workspace-relative path of the containing file. */
  path: string;
  /** Discriminator. `'file'` is the legacy default when omitted. */
  kind?: 'file' | 'symbol';
  /** Symbol-only: human-readable kind ("Function", "Class", "Method"...). Drives the popup icon. */
  symbolKind?: string;
  /** Symbol-only: enclosing container (e.g. class name when the symbol is a method). */
  containerName?: string;
  /** Symbol-only: 1-based line number of the symbol's defining range. */
  line?: number;
}

export interface MentionState {
  start: number;
  query: string;
  items: FileSearchItem[];
  selected: number;
}
