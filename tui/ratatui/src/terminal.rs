use std::io::{self, Write};
use std::panic;

use crossterm::clipboard::CopyToClipboard;
use crossterm::event::{DisableMouseCapture, EnableMouseCapture};
use crossterm::execute;
use ratatui::DefaultTerminal;

pub fn install_panic_restore_hook() {
    let original_hook = panic::take_hook();
    panic::set_hook(Box::new(move |panic_info| {
        let _ = execute!(std::io::stdout(), DisableMouseCapture);
        ratatui::restore();
        original_hook(panic_info);
    }));
}

pub fn init_terminal() -> DefaultTerminal {
    let terminal = ratatui::init();
    execute!(std::io::stdout(), EnableMouseCapture).expect("failed to enable mouse capture");
    terminal
}

pub fn restore_terminal() {
    let _ = execute!(std::io::stdout(), DisableMouseCapture);
    ratatui::restore();
}

pub fn copy_to_clipboard(text: &str) -> io::Result<()> {
    write_clipboard(&mut std::io::stdout(), text)
}

fn write_clipboard(writer: &mut impl Write, text: &str) -> io::Result<()> {
    execute!(writer, CopyToClipboard::to_clipboard_from(text))
}

#[cfg(test)]
mod tests {
    use super::write_clipboard;

    #[test]
    fn clipboard_copy_emits_osc52_for_the_host_clipboard() {
        let mut output = Vec::new();
        write_clipboard(&mut output, "alpha beta").expect("OSC52 should write");

        assert_eq!(output, b"\x1b]52;c;YWxwaGEgYmV0YQ==\x1b\\");
    }
}
