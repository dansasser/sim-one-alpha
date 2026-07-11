use std::panic;

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
