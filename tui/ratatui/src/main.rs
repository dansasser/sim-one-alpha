use std::io;

use crossterm::event::{self, Event};
use ratatui::DefaultTerminal;
use sim_one_ratatui_tui::app::{App, AppEvent};
use sim_one_ratatui_tui::input::map_key_event;
use sim_one_ratatui_tui::terminal::{init_terminal, install_panic_restore_hook, restore_terminal};
use sim_one_ratatui_tui::ui;

fn main() -> io::Result<()> {
    install_panic_restore_hook();
    let terminal = init_terminal();
    let result = run(terminal);
    restore_terminal();
    result
}

fn run(mut terminal: DefaultTerminal) -> io::Result<()> {
    let mut app = App::new();

    while !app.should_quit() {
        terminal.draw(|frame| ui::render(frame, &app))?;
        if let Some(app_event) = read_app_event()? {
            app.handle_event(app_event);
        }
    }

    Ok(())
}

fn read_app_event() -> io::Result<Option<AppEvent>> {
    match event::read()? {
        Event::Key(key) => Ok(map_key_event(key)),
        Event::Resize(_, _) => Ok(None),
        _ => Ok(None),
    }
}
