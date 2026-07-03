use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::app::AppEvent;

pub fn map_key_event(key: KeyEvent) -> Option<AppEvent> {
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        return Some(AppEvent::Quit);
    }

    match key.code {
        KeyCode::Char(value) => Some(AppEvent::Text(value.to_string())),
        KeyCode::Backspace => Some(AppEvent::Backspace),
        KeyCode::Enter => Some(AppEvent::Submit),
        KeyCode::PageUp => Some(AppEvent::ScrollPageUp),
        KeyCode::PageDown => Some(AppEvent::ScrollPageDown),
        KeyCode::Up => Some(AppEvent::ScrollLineUp),
        KeyCode::Down => Some(AppEvent::ScrollLineDown),
        KeyCode::End => Some(AppEvent::JumpToTail),
        KeyCode::Esc => Some(AppEvent::Quit),
        _ => None,
    }
}
