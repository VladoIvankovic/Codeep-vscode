# Changelog

All notable changes to the Codeep VS Code extension are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## [2.0.2] — 2026-05-19

> Catches up with Codeep CLI 2.0.2. Adds `/plan` and `/go` chips in the Settings panel so you can preview the agent's plan (no file changes) before executing — works with the same CLI binary you already have.

### Added

- **`/plan` + `/go` chips in Settings → Commands.** Click `/plan` to
  scaffold a plan-preview prompt in the chat input; the CLI generates
  a numbered plan (files it would touch, commands it would run, risk
  level) and surfaces it as an assistant message without touching
  anything. Review, then click `/go` to execute the approved plan
  through the regular agent loop — MCP tools, lifecycle hooks,
  permission prompts, and skill bundles all apply unchanged.
- Pairs with the new plan-mode flow in CLI 2.0.2. The extension is a
  thin client over the CLI binary, so as long as `codeep` on your
  `PATH` is 2.0.2+ everything works through the existing webview chat.

### Notes

- This release aligns the marketplace listing with the CLI 2.0.x line.
  2.0.0 was published on 2026-05-18 as a version-parity bump with no
  feature changes; 2.0.1 was skipped on the marketplace.

## [0.2.0] — 2026-05-18

### Added
- **Native diff editor for agent file edits.** When the agent asks
  permission to `write_file` or `edit_file`, the extension now opens a
  real `vscode.diff` editor alongside the inline permission card —
  syntax highlighted, with gutter markers, and respecting the user's
  editor settings. The diff closes automatically once the user clicks
  Allow / Deny.
- **Accept / Reject CodeLens inside the diff editor.** Three actions
  appear at the top of the proposed-change side:
  `$(check) Accept`, `$(x) Reject`, and `(Allow this tool for session)`.
  Clicking either resolves the permission without going back to the
  chat sidebar, and the inline card auto-resolves to stay in sync.
- New file scheme `codeep-edit:` for the right-hand-side virtual
  document — VS Code never tries to save it or list it in the file
  picker.
- **`Codeep: Attach Active File to Chat`** command (`Cmd+Shift+A` /
  `Ctrl+Shift+A`) — prepends `@<path>` to the chat input without
  auto-sending. Closest equivalent to the "Add Context" buttons in
  Cursor / Continue. Also available from the editor right-click menu.
- **`@symbol` mentions.** The `@` autocomplete popup now lists workspace
  symbols (functions, classes, methods) alongside files. Pick one and the
  symbol's definition is embedded in the prompt with a few lines of
  surrounding context — uses VS Code's workspace symbol provider so it
  works for every language with a language server installed.
- **MCP server config from the command palette.** Three new commands manage
  `~/.codeep/mcp_servers.json` and `<workspace>/.codeep/mcp_servers.json`
  without JSON editing:
  - **Codeep: Add MCP Server…** — guided wizard (scope + name + command + args)
  - **Codeep: Remove MCP Server…** — quick-pick across both scopes
  - **Codeep: Open MCP Servers Config** — opens the JSON for power-users
  The extension also auto-loads these files on session start and passes them
  to the CLI via `mcpServers`, so a server you add here works in every
  session, no further wiring needed.

### Changed
- **Permission card labels updated.** "Allow always" is renamed to
  "Allow for this session" — the CLI clears this state when the
  process restarts, so the previous label overstated the lifetime.
  Tooltips spell out the scope of each choice.
- **Diff-editor race condition fixed.** The diff would occasionally
  stay orphaned if the user clicked Allow before VS Code finished
  opening the editor; the cleanup now awaits the open promise.

### Notes
- Requires Codeep CLI ≥ 1.4.0 for the richer `toolInput` payload on
  permission requests (`new_content`, `old_string`, `new_string`).
  Older CLIs still work; the diff editor just won't open for those
  fields it can't see.

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
