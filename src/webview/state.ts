import type { ConfigOption, MentionState, PersonalityEntry, ProviderEntry } from './types';

// Shared mutable state for the webview. We keep it in a single object so
// modules can read/write without each importing live ES module bindings —
// makes call-sites obvious (`state.x = y` vs an opaque setter).
export const state = {
  configOptions: [] as ConfigOption[],
  currentMode: 'manual',
  providers: [] as ProviderEntry[],
  providersUnavailable: false,
  personalities: [] as PersonalityEntry[],
  activePersonality: null as string | null,
  personalitiesLoaded: false,
  personalitySource: 'files' as 'files' | 'rpc',
  personalityError: '',

  currentAssistantEl: null as HTMLElement | null,
  currentToolGroupEl: null as HTMLElement | null,
  currentThoughtEl: null as HTMLElement | null,
  currentPlanEl: null as HTMLElement | null,
  isStreaming: false,
  lastErrorEl: null as HTMLElement | null,

  toolCallItems: new Map<string, HTMLElement>(),
  toolCallKinds: new Map<string, string>(),
  runStats: {
    actions: 0,
    checksPassed: 0,
    checksFailed: 0,
  },

  mention: null as MentionState | null,
  mentionQueryId: 0,
  mentionDebounce: null as ReturnType<typeof setTimeout> | null,
};

export const vscode = acquireVsCodeApi();
