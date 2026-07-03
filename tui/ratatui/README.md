# SIM-ONE Alpha Ratatui TUI

This directory contains the active Ratatui terminal-interface experiment for SIM-ONE Alpha.

It is a local gateway client, not the agent runtime. The production behavior will be to connect to the same SIM-ONE Alpha gateway used by other connectors and clients. During Phase 1, the app is a static shell only: it proves the terminal layout, transcript scrolling, prompt input, clean exit path, and terminal restore behavior before gateway wiring begins.

## Phase 1 Commands

```sh
cargo run -p sim-one-ratatui-tui
cargo test -p sim-one-ratatui-tui
cargo check -p sim-one-ratatui-tui
```

## Phase 1 Controls

```text
Type text    Edit the prompt
Enter        Append a placeholder prompt/response
PgUp/PgDown  Scroll the transcript by a page
Up/Down      Scroll the transcript by one line
End          Jump back to the live tail
Ctrl+C       Exit cleanly
Esc          Exit cleanly
```
