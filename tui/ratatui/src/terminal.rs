use std::panic;

use ratatui::DefaultTerminal;

pub fn install_panic_restore_hook() {
    let original_hook = panic::take_hook();
    panic::set_hook(Box::new(move |panic_info| {
        ratatui::restore();
        original_hook(panic_info);
    }));
}

pub fn init_terminal() -> DefaultTerminal {
    ratatui::init()
}

pub fn restore_terminal() {
    ratatui::restore();
}
