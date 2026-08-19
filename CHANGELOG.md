# Changelog

All notable changes to the Codeep VS Code extension are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## [2.9.0] — 2026-08-19

> Custom bots land in the editor: pick one from the Agent Timeline toolbar, sync the set you built on the dashboard, and see exactly which capabilities each bot is allowed to use.

### Changed

- **The bot picker flags what Git actually grants.** A bot with Git but not
  Files still returns committed content via `git show HEAD:file`, and the same
  allowlist permits `git rm`, `git commit` and `git push` — so the picker line
  reads "Git reads and writes files" rather than letting the capability list
  imply the bot can only look.

### Added

- **First-class Custom Bot picker.** The Agent Timeline toolbar and Settings
  now expose the active Codeep personality without requiring users to remember
  `/personality`. The detail card shows the bot's model, allowed tool groups,
  workspace scope, source, and selected-project list.
- **Dashboard sync and management commands.** `Codeep: Sync Custom Bots from
  Dashboard` uses the structured ACP sync endpoint when available and falls
  back to `codeep account sync` for older CLIs. `Choose Custom Bot`, `Manage
  Custom Bots`, and `Open Personality Builder` are available from the command
  palette and directly from the webview.
- **`custom-bot/v1` compatibility.** Frontmatter metadata is parsed before the
  human-readable Markdown sections. Section-only and legacy personality files
  remain supported; legacy files are explicitly shown as unrestricted rather
  than being assigned invented model/tool/scope constraints. Missing or
  malformed v1 tool metadata is conversation-only, while an invalid structured
  scope is unavailable instead of widening to all projects.

### Compatibility

- Prefers `session/list_personalities`, `session/set_personality`, and
  `session/sync_personalities` from the CLI. If those RPCs are unavailable,
  the extension reads the same project/global files as the CLI and activates
  through the existing `/personality` command.

## [2.8.0] — 2026-08-14

> The sidebar is rebuilt as an **Agent Timeline**: the active task and its live plan on top, the conversation collapsible underneath, grouped tool activity, and a run summary (actions / checks / next step). Icons now come from VS Code's own codicon set instead of unicode glyphs, and the view is renamed "Chat" → "Agent Timeline" to match what it actually shows.

### Changed

- **Agent Timeline workbench.** The panel is no longer a plain message list. It
  now leads with the active task (title, subtitle, live plan), keeps the
  conversation in a collapsible section below it, groups the run's tool calls
  under "Recent tool activity" with a count and per-run collapse, and closes
  with a "Run summary" strip — actions taken, checks passed/failed, and the
  suggested next step. The composer moved into its own shell with attach and
  mode controls.
- **View renamed "Chat" → "Agent Timeline".** The view id (`codeep.chat`) is
  unchanged, so commands, keybindings and saved layouts keep working.
- **Real icons via `@vscode/codicons`.** Tool rows, plan steps, status and the
  toolbar buttons use the codicon font instead of unicode glyphs, so they match
  the editor at every theme and zoom level. `npm run build:webview` copies the
  font and stylesheet into `media/` (`scripts/copy-codicons.mjs`), and the
  webview CSP now allows `img-src`/`font-src` from the extension origin.

### Fixed

- **The plan panel no longer spins forever.** `beginTask()` puts a spinning
  "Building the plan..." placeholder in the plan area, but only a `plan`
  notification cleared it — so any prompt the agent answered without a plan
  ended on a permanent spinner, as did *every* restored transcript (session
  load and window reload both replay a task and complete it immediately).
  Completing a run without a plan now shows "No plan steps for this run."
- **Tool icons follow the ACP tool kind, not the tool's title.** The icon was
  picked by substring-matching the title with the read/search branch first, so
  "Edit src/webview/list.ts" and "Write README.md" drew a magnifying glass, and
  the `execute` kind wasn't recognised at all. The kind is now mapped directly
  (read/search, edit/write/delete/move, execute, fetch, think) and the title
  regex is only a fallback for CLIs that don't send one.
- **"Checks" in the run summary counts commands only.** Any tool call whose
  *title* matched `test|check|lint|build|verify|command` was counted, so simply
  reading `chatPanel.test.ts` scored a check — and a failed read painted the
  summary red. Only `execute` tool calls count now.
- **~267 KB of dead payload dropped from the .vsix.** `media/Screenshot-1.png`
  and `Screenshot-2.png` were still packaged although nothing references them.

### Security

- **The webview CSP nonce now comes from the CSPRNG.** It was
  `Math.random().toString(36)`. Not exploitable — every value interpolated into
  the page is an extension-controlled webview URI — but the nonce is the only
  thing that lets a script run in that document, and this release materially
  grows the webview's DOM surface. It's `crypto.randomBytes(16)` now.

### Internal

- **The release workflow asserts the tag matches `package.json`.** `vsce`
  packages whatever `package.json` says regardless of the `--out` filename, so
  a mismatched tag would have shipped the previous version's bits and then been
  rejected by the Marketplace as a duplicate. It now fails the job instead,
  mirroring the CLI's `release-binaries.yml`.
- Local audit / design-QA scratch (`.codex-audit/`, `design-qa.md`) is
  git-ignored, not just `.vscodeignore`d.

## [2.7.0] — 2026-07-13

> Compatibility sync with CLI 2.15.0. No extension behaviour changes — the extension already speaks ACP to the CLI, so the CLI's new cross-tool features (`AGENTS.md` rules, `.mcp.json`, cross-device `/cloud` resume) are picked up automatically once the user runs the matching CLI. This release just bumps the version and documents the pairing.

### Changed

- **Version bump 2.6.1 → 2.7.0.** Aligns the extension's marketing version with
  the CLI's 2.15 line. The extension's own behaviour is unchanged; this is a
  compatibility-sync release so users have a clear "CLI ≥ 2.15 ↔ extension ≥ 2.7"
  pairing to refer to.
- **ACP registry entry bumped to 2.15.0** (`acp-registry/codeep/agent.json`).
  The registry entry had fallen behind to 2.4.2 — eleven minor releases out of
  date — so ACP clients (Zed, Cursor, etc.) were advertising a stale binary.
  All four platform archives (darwin-aarch64, darwin-x86_64, linux-x86_64,
  linux-aarch64) now point at the `v2.15.0` GitHub release.

## [2.6.1] — 2026-07-01

> Reliability pass on the permission + diff lifecycle: no more dead permission cards after a CLI crash, no spurious toasts on every Allow/Reject, tool rows finish in the right state, and inline edit won't clobber a file you edited mid-run. All eight fixes came out of a detailed adversarial audit of the extension.

### Fixed

- **Permission cards no longer get stuck after a CLI crash.** If the CLI exited
  while a permission card was pending, the card stayed on screen but clicking
  Allow did nothing (the request id no longer existed on the reconnected
  process). The disconnect path now drops the pending resolvers, closes any
  orphaned diff tabs, and dismisses the cards.
- **No more "no pending permission for this diff" toast on every Allow/Reject.**
  The tab-close handler fired an implicit reject for the extension's *own*
  programmatic diff close after a permission resolved, popping a confusing
  toast on every normal approval. It now only reacts when a permission is
  genuinely still pending for the closed diff.
- **Cancel / New chat no longer leaves orphaned diff tabs behind.** A proposed-
  change diff opened for an in-flight write/edit stayed open — showing
  live-looking Accept / Reject lenses — after you cancelled or started a new
  session. Those tabs are now closed and their tracking dropped.
- **Tool rows reach their final state.** A tool that streamed multiple updates
  (in-progress → completed/failed) could get dropped from tracking on the first
  update, so it never dimmed for completed or turned red for failed. The row
  now settles correctly and only stops being tracked once it's terminal.
- **Idle-timeout watchdog no longer fires against the wrong run.** After a
  cancel-and-resend or a new session, a watchdog armed for the previous prompt
  could fire a spurious cancel. Cancelling now disarms it.
- **Inline edit won't clobber a file you edited while it was running.** If the
  document changed during the (possibly minutes-long) model call, the edit is
  now skipped with a warning instead of silently overwriting the wrong region.
- **Internal:** control-plane request timers are now cleared when the response
  arrives, and per-turn tool-call element references are released — small
  resource-hygiene fixes with no user-visible behaviour change.

## [2.6.0] — 2026-06-13

> Chat-surface polish: the conversation survives a window reload, light themes are readable, the keybindings no longer fight VS Code's defaults, Esc stops a run, "New chat" keeps your CLI (and MCP servers) warm, and the permission card shows every option the agent offers.

### Added

- **Esc stops an in-flight run** from the chat input — mirrors the Stop button.
- **Reject-always in the permission card.** The card now renders the *actual*
  option set the CLI offers (Allow once / Allow for this session / Reject /
  **Reject for this session**) instead of a hardcoded three, so a future CLI
  option shows up with no extension change.

### Changed

- **"New chat" no longer respawns the CLI.** It now opens a fresh session on
  the running process, so warm MCP servers stay up and there's no relaunch
  lag — the CLI already supports multiple sessions per process.

### Fixed

- **Your conversation comes back after a window reload.** The CLI re-attaches
  the previous session server-side, but the webview rendered blank — so it
  looked like the chat was lost while the agent still had the full context.
  The transcript is now replayed on reconnect ("Restored previous chat").
- **Readable on light themes.** ~30 hardcoded translucent-white surfaces and a
  dark code-block background painted white-on-white (and dark-on-light code) on
  light themes. They now use VS Code theme tokens (`--vscode-*`), so code,
  diffs, borders, and buttons adapt to whatever theme you run.
- **Keybindings stop shadowing VS Code defaults.** `⌘⇧C` (open chat) collided
  with "Open New External Terminal" and `⌘⇧X` (send selection) collided with
  the Extensions view; both moved to `⌘⌥`-based shortcuts (`⌘⌥C` / `⌘⌥X`).

## [2.5.1] — 2026-06-09

> Security: the manual-mode permission gate now fails closed. If the extension can't put the agent into manual mode on connect, it refuses to send prompts (with a clear message) instead of letting the agent run tools unguarded.

### Security

- **Manual-mode gate fails closed.** On connect the extension asks the CLI to
  enter manual mode (so dangerous tools require approval). If that request fails
  — e.g. a transient error or a CLI too old to support it — the session would
  otherwise stay in unguarded `auto` mode. The extension now retries once and,
  if it still can't arm the gate, refuses to send prompts and surfaces an
  actionable error ("update the Codeep CLI and reload"), rather than silently
  running tools without confirmation. Pairs with the CLI 2.7.0 ACP hardening.

### Changed

- Pin the `codeep-review` CI workflow to the immutable `codeep-action@v1.0.2`.

## [2.5.0] — 2026-06-04

> Blockquotes render in chat again, and file edits containing a `$` now apply literally instead of corrupting. Also hardens link rendering against an attribute-injection edge case.

### Fixed

- **Blockquotes render again.** The chat markdown renderer escaped `>` to `&gt;`
  before checking for blockquote lines, so the blockquote branch was dead code
  and `> quote` showed as plain text. Fixed.
- **Edits containing `$` apply literally.** Synthesizing the "after" text for an
  `edit_file` diff used `String.replace(old, new)`, which interprets `$&`, `$$`,
  `$1` in the replacement — corrupting any edit whose new text contained `$`
  (template literals, shell vars, regex). Now inserted verbatim.
- **Link rendering hardened.** The markdown escaper didn't escape `"`, so a
  model-supplied link URL containing a quote could break out of the `href`
  attribute. Quotes are now entity-encoded.

## [2.4.1] — 2026-05-25

> Push your profile to the dashboard from the editor.

### Added

- **Codeep: Sync Profile to Dashboard** — runs `/me sync` through the CLI to push
  your `~/.codeep/profile.md` to codeep.dev (and pull it on a fresh machine).

## [2.4.0] — 2026-05-25

> Codeep adapts to you: edit your user profile from the editor, toggle opt-in auto-learn, and a "Personalize Codeep" walkthrough step. Pairs with CLI 2.2.0's `/me` profile.

### Added

- **Codeep: Edit Profile** / **Codeep: Edit Project Profile.** Open (and scaffold
  on first use) `~/.codeep/profile.md` and the workspace `.codeep/profile.md` —
  a short description of how you like to work (reply language, style, stack,
  "always / never"). The CLI/ACP agent injects these into its context on every
  run, so `@codeep` and the chat adapt to you.
- **Codeep: Toggle Profile Auto-Learn** + the `codeep.autoLearnProfile` setting.
  Lets Codeep quietly learn durable preferences from sessions into a separate
  `profile.learned.md`. Pushed live to the running CLI and applied on every
  connect. Off until you turn it on; review with the CLI `/me`, clear with
  `/me forget`.
- **"Personalize Codeep" walkthrough step** in the Get Started walkthrough.

## [2.3.0] — 2026-05-21

> Deeper editor integration: a `@codeep` participant in the native Chat view, a `#codeepSkills` agent tool, generate commit messages from the Source Control panel, a native Sessions tree, JSON validation for MCP config, and Workspace Trust support.

> Also ships the editor features from the (unreleased) 2.2: **Code Actions** lightbulb (Explain / Improve / Add tests / Add doc comment / Fix), a **status-bar model picker**, a **`codeep.baseUrl`** setting for self-hosted OpenAI-compatible endpoints, and a **Get Started walkthrough**. See the 2.2.0 entry below for details.

### Added

- **`@codeep` chat participant.** Invoke Codeep from the native VS Code Chat
  view — type `@codeep` and ask, or use `@codeep /explain` and `@codeep /review`
  with a selection. Answers come from your configured Codeep provider/model (via
  the CLI), not VS Code's model picker. Runs on its own session, independent of
  the sidebar chat.
- **`#codeepSkills` language-model tool.** Exposes the workspace's Codeep skill
  bundles (`.codeep/skills/*/SKILL.md`) to VS Code agent mode and `#`-references,
  so the native agent can discover and follow your project's own workflows.
- **Generate Commit Message.** A sparkle button in the Source Control title
  (and **Codeep: Generate Commit Message** in the palette) reads your staged
  diff — falling back to the working-tree diff — and writes a Conventional
  Commits message into the commit box. It asks before replacing a message
  you've already typed.
- **Sessions tree view.** A native **Sessions** view in the Codeep sidebar
  lists your saved conversations (title + age). Click to load one into the
  chat; use the inline trash to delete; the title bar has New Session +
  Refresh. Stays in sync with the chat panel.
- **MCP config validation.** `.codeep/mcp_servers.json` (project and global)
  now gets JSON schema validation + autocomplete — catches a mistyped
  `command`/`args`/`env` before you start a session.

### Changed

- **Workspace Trust** — the extension now declares limited support for
  untrusted workspaces. Codeep runs a local agent that can edit files and run
  commands, so in untrusted folders you'll be reminded to review permission
  prompts carefully.
- **Minimum VS Code raised to 1.95** — required for the stable Chat Participant
  and Language Model Tools APIs.

### Notes

- No new CLI requirement — 2.3.0 builds on ACP methods already in the shipped
  CLI. Pure additive UI; safe upgrade with zero migration.

## [2.2.0] — 2026-05-21

> A big editor-experience update: lightbulb code actions (Explain / Fix / Add tests / Add doc comment), a one-click model picker in the status bar, a `codeep.baseUrl` setting for self-hosted endpoints, and a Get Started walkthrough.

### Added

- **Code Actions (lightbulb).** Select code and press `Ctrl+.` for
  **Explain**, **Improve / refactor**, **Add tests**, and **Add doc comment**.
  When the line has an error or warning, a **Fix this problem** quick-fix sends
  the diagnostic plus the code to Codeep. Everything routes through the chat,
  so the full agent — file edits via the diff preview, MCP tools — is available.
- **Model picker in the status bar.** Click `Codeep · <model>` (or run
  **Codeep: Select Provider & Model**) to switch provider + model from a
  quick-pick. Providers with open-ended catalogs (OpenRouter, Ollama, custom
  endpoints) let you type a model id.
- **`codeep.baseUrl` setting.** Point the extension at a self-hosted
  OpenAI-compatible server (vLLM / LiteLLM / LM Studio / text-generation-webui)
  without hand-editing `~/.codeep/config.json`. Pairs with `codeep.provider`
  (`custom` or `openai`) and `codeep.model`.
- **Get Started walkthrough.** A native VS Code walkthrough covering CLI
  install, opening the chat, editor actions, and choosing a model / custom
  endpoint.

### Changed

- **`codeep.provider` and `codeep.model` settings now actually apply.**
  Previously declared but never wired, they're now pushed to the CLI on every
  connect (so they stay authoritative across reconnects). Leave them empty to
  use the CLI's own config.

### Requires

- CLI **2.1.2+** for the full experience (per-provider model lists, and pinning
  `provider` / `custom` base URL over ACP). Degrades gracefully on older CLIs:
  the model picker falls back to a free-text input, and `codeep.baseUrl` still
  works for the `openai` provider via `OPENAI_BASE_URL`. Run
  `npm i -g codeep@latest` or `brew upgrade codeep`.

## [2.1.1] — 2026-05-20

> Custom OpenAI-compatible endpoints now work through the extension. Point Codeep at a self-hosted vLLM / LiteLLM / LM Studio server and use it in the VS Code chat — no commercial provider required.

### Added

- **Custom (OpenAI-compatible) endpoint support** (via CLI 2.1.1). Run any
  OpenAI-compatible server — vLLM, LiteLLM, LM Studio, text-generation-webui —
  and the extension talks to it through the same `codeep` agent. Configure it
  once in the CLI: set provider `custom` + `customBaseUrl`
  (e.g. `http://host:8000/v1`) in `~/.codeep/config.json` or via
  `/settings → Custom Base URL`, then pick your model with `/model`. The
  `openai` provider also honors the `OPENAI_BASE_URL` env var.

### Requires

- CLI **2.1.1+** on your `PATH`. The extension is a thin client that spawns
  `codeep acp`, so endpoint resolution happens in the CLI — there's no separate
  extension setting and nothing to configure inside VS Code beyond the shared
  `~/.codeep` config. Run `npm i -g codeep@latest` or `brew upgrade codeep`.

### Notes

- No extension code changes — this is a version-parity release so the
  marketplace listing reflects that CLI 2.1.1 unlocked self-hosted / custom
  endpoints for editor users too. Safe upgrade with zero migration.

## [2.1.0] — 2026-05-20

> Surfaces the new CLI 2.1.0 `/recall` command in the chat autocomplete and the Settings panel. Search across *every* saved session — not just the current one — with `--summarize` for an LLM recap of what you actually did.

### Added

- **`/recall` chip in chat autocomplete + Settings → Commands.** Type
  `/recall <query>` to search across ALL your saved sessions (vs
  `/search`, which scans only the current conversation). Append
  `--summarize` for an LLM-written recap of what you accomplished across
  the matching sessions, or `--resume` to jump straight into the
  top-matching one. The extension just inserts the command — the CLI
  does the cross-session search, ranking, and summary.

### Requires

- CLI **2.1.0+** on your `PATH`. The extension is a thin client over the
  local `codeep` binary, so `/recall` only works once `codeep --version`
  reports 2.1.0 or newer. Run `npm i -g codeep@latest` or
  `brew upgrade codeep` if your shell still shows 2.0.x.

### Notes

- Pure additive command-list entry — no webview, activation, or settings
  schema changes. Safe upgrade with zero migration. The CLI 2.1.0 release
  also adds AI-generated session titles (so `/recall` and `/sessions`
  read like "OAuth2 migration" instead of raw IDs) and portable
  personalities + custom-command sync via `codeep account sync`.

## [2.0.3] — 2026-05-19

> Surfaces the new CLI 2.0.3 commands as one-click chips in the Settings panel: `/personality` (six built-in agent tones plus your own from `.codeep/personalities/*.md`) and `/insights` (activity summary over the last N days).

### Added

- **`/personality` chip in Settings → Commands → Personalization.**
  Click to scaffold a `/personality ` prompt in the chat input. Type a
  preset name (`concise`, `verbose`, `security`, `senior-reviewer`,
  `junior-mentor`, `ship-it`) or `off` to clear. Custom personalities
  from `.codeep/personalities/<name>.md` (project) and
  `~/.codeep/personalities/<name>.md` (global) work the same way —
  CLI handles the lookup, extension is just a launcher.
- **`/insights` chip in Settings → Commands → Agent flow.** Click to
  insert `/insights ` — append `--days N` for a custom window
  (default 7 days). Output renders in the chat as a Markdown table:
  runs, tool actions, active time, by-project / top-tools /
  most-touched files / recent runs.

### Requires

- CLI **2.0.3+** on your `PATH` (the extension is a thin client over
  the local `codeep` binary, so the chips just insert text — the CLI
  does the actual work). Run `npm i -g codeep@latest` or
  `brew upgrade codeep` if your shell still shows `2.0.2` or older
  from `codeep --version`.

### Notes

- No webview / activation / settings schema changes — pure additive
  chips in the existing Settings panel. Safe upgrade with zero
  migration.

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
