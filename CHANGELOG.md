# Changelog

All notable changes to the Codeep VS Code extension are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.27] — 2026-04-29

### Added
- **Inline edit (`Cmd+Shift+I` / `Ctrl+Shift+I`)** — select code in the editor,
  press the shortcut, type a one-line instruction ("make this async", "extract
  to a function"), and Codeep rewrites the selection in place. Falls back to
  the current line if nothing is selected. `Cmd+Z` to undo.

## [0.1.26] — 2026-04-29

### Added
- **Status bar item** — always-visible indicator in the bottom right showing
  connection state and current model. Click to open chat. Turns yellow during
  reconnect attempts and red on hard failure.

## [0.1.25] — 2026-04-29

### Fixed
- **Graceful fallback for older CLIs** — extension now degrades cleanly when
  the installed Codeep CLI doesn't yet expose `session/list_providers`. The
  settings panel shows a "please update CLI" hint instead of getting stuck on
  "Loading providers…", and the `Codeep: Set API Key` command surfaces a
  warning with a one-click "Update CLI" action that runs
  `npm install -g codeep@latest` in a terminal.

## [0.1.24] — 2026-04-28

### Changed
- **WebView refactored from a single 1234-line `chat.js` to nine TypeScript
  modules** in `src/webview/` (`state.ts`, `dom.ts`, `markdown.ts`,
  `messages.ts`, `permission.ts`, `mention.ts`, `settings.ts`, `sessions.ts`,
  `onboarding.ts`, plus `main.ts` entry point). The output `media/chat.js` is
  now an esbuild IIFE bundle. Type-checked under a separate
  `tsconfig.webview.json`.
- New `npm run typecheck`, `npm run build:extension`, `npm run build:webview`
  scripts. `npm run package` now runs the full build before `vsce package`.

## [0.1.23] — 2026-04-28

### Changed
- **Provider list now comes from the CLI** via the new `session/list_providers`
  ACP method. Eliminates four hardcoded copies of the provider catalog
  (`PROVIDER_GROUP_LABELS`, `ALL_PROVIDERS`, `PROVIDER_HINTS`, the quick-pick
  in `setApiKey`). Adding a new provider in the CLI now propagates to all
  extension UI without code changes here.

## [0.1.22] — 2026-04-28

### Added
- **Richer markdown rendering** — links (`[text](url)` with safe-URL
  whitelist: `http`, `https`, `mailto`, `vscode`), GFM tables with column
  alignment, blockquotes, and inline formatting in headings.

## [0.1.21] — 2026-04-28

### Added
- **`@file` mentions in the chat input** — type `@`, get a workspace-wide
  file picker. Arrow keys + Enter to select, Escape to dismiss. The file
  content is inlined into the prompt as an `[Attached files]` preamble so the
  agent has the context immediately. Files over 200 KB are skipped with a
  marker; multiple mentions in one message are de-duplicated.

## [0.1.20] — 2026-04-28

### Added
- **Auto-reconnect on CLI exit** — exponential backoff (1s → 2s → 4s → 8s
  → 16s → 30s, capped at 6 attempts). Status bar shows the countdown.
- **`Reconnecting in Ns (k/6)…`** progress indicator in the chat panel
  status line.

### Fixed
- **Permission-handler memory leak** — replaced per-request webview
  `onDidReceiveMessage` listeners with a single shared listener and a
  `Map<requestId, callback>` lookup. Previously every active permission
  prompt added another global listener; now it's O(1) per message.

## [0.1.19] — 2026-04-28

### Changed
- **Idle-watchdog replaces fixed prompt timeout** — a `session/prompt`
  request is no longer killed after a hard 5-minute cap. Instead the timer
  resets on every signal from the CLI (chunks, tool calls, thoughts, plan
  updates), so reasoning models doing real work won't get cancelled mid-
  thought. The watchdog only fires when the agent is genuinely silent.
- New `codeep.requestTimeoutMinutes` setting (default `5`, range 1–60).
- When the watchdog does fire, the extension sends `session/cancel` to clean
  up the in-flight turn so the CLI doesn't sit in a half-active state.

## [0.1.18] — 2026-04-28

### Added
- **Diff preview on permission prompts** — manual-mode permission cards now
  render a `-` / `+` diff for `edit_file`, the new content for `write_file`,
  and `$ command` + `cwd` for `execute_command`. Payload is truncated
  (~4 KB per field, 200 lines per file) with a visible marker. Other ACP
  clients (Zed, etc.) ignore the extra fields silently.

## [0.1.17] — 2026-04-28

### Added
- **Live agent plan card** — when the agent works on a multi-step task, a
  green plan card renders in the chat with status icons (`○` pending,
  `◐` in progress, `●` done) that update in place as work progresses.
- **Reasoning stream** — when the model exposes a thinking trace (Claude
  extended thinking, GPT-5 reasoning, DeepSeek R1, etc.) it renders as a
  collapsible "Thinking" card above the answer.

### Changed
- `current_mode_update` notifications from the CLI are now honoured so the
  UI mode selector stays in sync if the mode is changed externally.

## [0.1.16] — earlier

Initial public baseline this changelog covers. Earlier history available in
the Marketplace release notes and `git log`.
