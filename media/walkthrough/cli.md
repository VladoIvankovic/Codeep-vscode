# Install the Codeep CLI

This extension is a thin client over the local **Codeep CLI** — the CLI does the
agent work, the editor is the UI. Install it once:

```bash
npm install -g codeep
# or
brew install codeep
```

Verify:

```bash
codeep --version
```

If `codeep` isn't on your `PATH`, set **`codeep.cliPath`** in Settings to the
full path of the binary.
