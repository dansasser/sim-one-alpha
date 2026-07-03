# SIM-ONE Alpha Ratatui TUI

This directory contains the active Ratatui terminal-interface experiment for SIM-ONE Alpha.

It is a local gateway client, not the agent runtime. It connects to the same SIM-ONE Alpha gateway used by other connectors and clients, starts the built server when needed, sends prompts to the Flue orchestrator agent, and renders the returned assistant text in the transcript.

## Product-Style Commands

```sh
pnpm run build
pnpm run build:tui:ratatui
pnpm run test:tui:ratatui
./.gorombo/sim-one-ratatui/sim-one-ratatui-tui
```

The `build:tui:ratatui` script writes the standalone terminal binary to:

```text
.gorombo/sim-one-ratatui/sim-one-ratatui-tui
```

That binary owns the same startup contract as the Ink TUI: it checks the gateway health endpoint, starts `.gorombo/sim-one-alpha/server.mjs` if needed, and cleans up only a server child it started itself.

## Developer Checks

```sh
cargo test -p sim-one-ratatui-tui
cargo check -p sim-one-ratatui-tui
```

## Controls

```text
Type text            Edit the prompt at the cursor
Enter                Send the prompt to the orchestrator
Left/Right           Move the prompt cursor by one character
Ctrl+Left/Right      Move the prompt cursor by one word
Home/End             Move to the start/end of the prompt
Backspace/Delete     Delete around the prompt cursor
Ctrl+W               Delete the previous word
Ctrl+U               Clear the prompt
PgUp/PgDown          Scroll the transcript by a page
Up/Down              Scroll the transcript by one line
Ctrl+End             Jump the transcript back to the live tail
Ctrl+C               Exit cleanly
Esc                  Exit cleanly
```
