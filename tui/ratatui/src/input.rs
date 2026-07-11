use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

use crate::app::AppEvent;

pub fn map_terminal_event(event: Event) -> Option<AppEvent> {
    match event {
        Event::Key(key) if key.kind == KeyEventKind::Repeat && key.code == KeyCode::Enter => None,
        Event::Key(key) if matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) => {
            map_key_event(key)
        }
        _ => None,
    }
}

pub fn map_key_event(key: KeyEvent) -> Option<AppEvent> {
    if key.code == KeyCode::Enter && key.modifiers.contains(KeyModifiers::SHIFT) {
        return Some(AppEvent::Text("\n".to_string()));
    }

    if key.modifiers.contains(KeyModifiers::CONTROL) {
        return match key.code {
            KeyCode::Char('c') => Some(AppEvent::Quit),
            KeyCode::Char('a') => Some(AppEvent::MovePromptStart),
            KeyCode::Char('e') => Some(AppEvent::MovePromptEnd),
            KeyCode::Char('u') => Some(AppEvent::ClearPrompt),
            KeyCode::Char('w') => Some(AppEvent::DeletePromptWordLeft),
            KeyCode::Left => Some(AppEvent::MovePromptWordLeft),
            KeyCode::Right => Some(AppEvent::MovePromptWordRight),
            KeyCode::End => Some(AppEvent::JumpToTail),
            _ => None,
        };
    }

    match key.code {
        KeyCode::Char(value) => Some(AppEvent::Text(value.to_string())),
        KeyCode::Backspace => Some(AppEvent::Backspace),
        KeyCode::Delete => Some(AppEvent::Delete),
        KeyCode::Enter => Some(AppEvent::Submit),
        KeyCode::Left => Some(AppEvent::MovePromptLeft),
        KeyCode::Right => Some(AppEvent::MovePromptRight),
        KeyCode::Home => Some(AppEvent::MovePromptStart),
        KeyCode::End => Some(AppEvent::MovePromptEnd),
        KeyCode::PageUp => Some(AppEvent::ScrollPageUp),
        KeyCode::PageDown => Some(AppEvent::ScrollPageDown),
        KeyCode::Up => Some(AppEvent::ScrollLineUp),
        KeyCode::Down => Some(AppEvent::ScrollLineDown),
        KeyCode::Esc => Some(AppEvent::Quit),
        _ => None,
    }
}
