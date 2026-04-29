import type { ConfigOption, MentionState, ProviderEntry } from './types';

// Shared mutable state for the webview. We keep it in a single object so
// modules can read/write without each importing live ES module bindings —
// makes call-sites obvious (`state.x = y` vs an opaque setter).
export const state = {
  configOptions: [] as ConfigOption[],
  currentMode: 'manual',
  providers: [] as ProviderEntry[],
  providersUnavailable: false,

  currentAssistantEl: null as HTMLElement | null,
  currentToolGroupEl: null as HTMLElement | null,
  currentThoughtEl: null as HTMLElement | null,
  currentPlanEl: null as HTMLElement | null,
  isStreaming: false,
  lastErrorEl: null as HTMLElement | null,

  toolCallItems: new Map<string, HTMLElement>(),

  mention: null as MentionState | null,
  mentionQueryId: 0,
  mentionDebounce: null as ReturnType<typeof setTimeout> | null,
};

export const vscode = acquireVsCodeApi();
