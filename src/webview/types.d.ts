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
  path: string;
  name: string;
}

export interface MentionState {
  start: number;
  query: string;
  items: FileSearchItem[];
  selected: number;
}
