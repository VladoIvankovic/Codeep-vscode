# Codeep for VS Code

AI coding assistant sidebar for VS Code — powered by the [Codeep CLI](https://github.com/VladoIvankovic/Codeep).

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/VladoIvankovic.codeep?label=VS%20Code%20Marketplace&color=0065a9)](https://marketplace.visualstudio.com/items?itemName=VladoIvankovic.codeep)

![Codeep chat sidebar](media/Screenshot-1.png)

![Codeep settings panel](media/Screenshot-2.png)

## Requirements

Install the Codeep CLI first:

```bash
npm install -g codeep
```

## Features

- **Chat sidebar** — ask questions, get explanations, request changes, all within VS Code
- **Streaming responses** — see the AI reply as it's being generated, with rich markdown rendering (links, tables, blockquotes, code blocks, lists)
- **Live agent plan** — when the agent works on a multi-step task, watch its plan update in real time (○ pending, ◐ in progress, ● done)
- **Reasoning stream** — collapsible "Thinking" card shows the model's reasoning before the answer (when the model exposes it)
- **`@file` mentions** — type `@` in the chat input to attach any workspace file. Arrow keys + Enter to pick, file content is sent inline with your prompt
- **Inline edit** — select code, press `Cmd+Shift+I`, type a one-line instruction ("make this async", "extract to a function"), and the agent rewrites it in place. `Cmd+Z` to undo
- **Send selection** — highlight code and send it directly to chat (`Cmd+Shift+X`)
- **Review file** — right-click any file to run an AI code review
- **Session browser** — list, load, and delete past conversations
- **Settings panel** — switch AI model, provider, and permission mode without leaving the editor
- **Inline permission prompts with diff preview** — see exactly what the agent wants to write, edit, or run before approving (no surprises)
- **New session** — start a fresh conversation at any time
- **Auto-reconnect** — if the CLI crashes, the extension reconnects on its own with exponential backoff (1s → 30s, max 6 tries)
- **Status bar item** — always-visible indicator (bottom right) showing connection state and current model. Click to open chat. Turns yellow during reconnect, red on hard failure.

## Usage

Open the Codeep panel from the activity bar (red bracket icon), or press `Cmd+Shift+C`.

The extension connects to the Codeep CLI automatically on startup. Once connected, type your message and press `Enter` to send (`Shift+Enter` for a new line).

### Commands

| Command | Shortcut | Description |
|---|---|---|
| Codeep: Open Chat | `Cmd+Shift+C` | Open the chat sidebar |
| Codeep: Edit Selection (Inline) | `Cmd+Shift+I` | Rewrite the selected code with a natural-language instruction |
| Codeep: Send Selection to Chat | `Cmd+Shift+X` | Send selected code to chat |
| Codeep: Review Current File | — | AI review of the active file |
| Codeep: New Session | — | Start a new conversation |

### Sessions

Click **Sessions** in the toolbar to browse past conversations. Click a session to load it (history is restored in the chat). Use the × button to delete a session.

### Settings

Click **Settings** in the toolbar to change the AI model, provider, and permission mode. Changes take effect immediately.

### Permission prompts

When the agent wants to write a file or run a shell command, an inline card appears in the chat asking you to **Allow once**, **Allow always**, or **Deny**. No popups.

The card now shows a **preview** of what would happen:

- **Edit file** → side-by-side `-` / `+` diff of the change
- **Write file** → full content preview (first 200 lines for large files)
- **Run command** → the exact `$ command` and `cwd` that would execute

Truncated payloads are marked so you know you're not seeing the full thing.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `codeep.cliPath` | `codeep` | Path to the Codeep CLI executable |
| `codeep.provider` | _(CLI default)_ | Override AI provider |
| `codeep.model` | _(CLI default)_ | Override AI model |
| `codeep.requestTimeoutMinutes` | `5` | Idle timeout in minutes for an in-flight prompt. Resets on every signal from the CLI (chunks, tool calls, thoughts), so it only fires when the agent is genuinely wedged. Bump to 15+ for slow reasoning models. |

If `codeep` is not on your PATH, set the full path in settings:

```json
{
  "codeep.cliPath": "/usr/local/bin/codeep"
}
```

## How it works

The extension communicates with the Codeep CLI via the **Agent Client Protocol (ACP)** — a JSON-RPC protocol over stdio. Each VS Code workspace gets its own CLI session, so the agent has full context of your project.

## License

MIT
