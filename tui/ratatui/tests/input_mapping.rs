use crossterm::event::{
    Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseEvent, MouseEventKind,
};
use sim_one_ratatui_tui::app::AppEvent;
use sim_one_ratatui_tui::input::{map_key_event, map_terminal_event};

#[test]
fn maps_prompt_editing_and_submit_keys() {
    assert_eq!(
        map_key_event(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE)),
        Some(AppEvent::Text("a".to_string()))
    );
    assert_eq!(
        map_key_event(KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE)),
        Some(AppEvent::Backspace)
    );
    assert_eq!(
        map_key_event(KeyEvent::new(KeyCode::Delete, KeyModifiers::NONE)),
        Some(AppEvent::Delete)
    );
    assert_eq!(
        map_key_event(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE)),
        Some(AppEvent::MovePromptLeft)
    );
    assert_eq!(
        map_key_event(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE)),
        Some(AppEvent::MovePromptRight)
    );
    assert_eq!(
        map_key_event(KeyEvent::new(KeyCode::Left, KeyModifiers::CONTROL)),
        Some(AppEvent::MovePromptWordLeft)
    );
    assert_eq!(
        map_key_event(KeyEvent::new(KeyCode::Right, KeyModifiers::CONTROL)),
        Some(AppEvent::MovePromptWordRight)
    );
    assert_eq!(
        map_key_event(KeyEvent::new(KeyCode::Char('w'), KeyModifiers::CONTROL)),
        Some(AppEvent::DeletePromptWordLeft)
    );
    assert_eq!(
        map_key_event(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL)),
        Some(AppEvent::CutPromptSelection)
    );
    assert_eq!(
        map_key_event(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL)),
        Some(AppEvent::MovePromptStart)
    );
    assert_eq!(
        map_key_event(KeyEvent::new(KeyCode::Char('e'), KeyModifiers::CONTROL)),
        Some(AppEvent::MovePromptEnd)
    );
    assert_eq!(
        map_key_event(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL)),
        Some(AppEvent::ClearPrompt)
    );
    assert_eq!(
        map_key_event(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE)),
        Some(AppEvent::MovePromptStart)
    );
    assert_eq!(
        map_key_event(KeyEvent::new(KeyCode::End, KeyModifiers::NONE)),
        Some(AppEvent::MovePromptEnd)
    );
    assert_eq!(
        map_key_event(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppEvent::Submit)
    );
    assert_eq!(
        map_key_event(KeyEvent::new(KeyCode::Enter, KeyModifiers::SHIFT)),
        Some(AppEvent::Text("\n".to_string()))
    );
    assert_eq!(
        map_key_event(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)),
        Some(AppEvent::SelectCommand)
    );
}

#[test]
fn maps_transcript_scroll_and_exit_keys() {
    assert_eq!(
        map_key_event(KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE)),
        Some(AppEvent::ScrollPageUp)
    );
    assert_eq!(
        map_key_event(KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE)),
        Some(AppEvent::ScrollPageDown)
    );
    assert_eq!(
        map_key_event(KeyEvent::new(KeyCode::End, KeyModifiers::CONTROL)),
        Some(AppEvent::JumpToTail)
    );
    assert_eq!(
        map_key_event(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE)),
        Some(AppEvent::NavigateUp)
    );
    assert_eq!(
        map_key_event(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE)),
        Some(AppEvent::NavigateDown)
    );
    assert_eq!(
        map_key_event(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
        Some(AppEvent::Cancel)
    );
    assert_eq!(
        map_key_event(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
        Some(AppEvent::Quit)
    );
}

#[test]
fn terminal_mapper_ignores_release_events_and_enter_repeats() {
    assert_eq!(
        map_terminal_event(Event::Key(KeyEvent::new_with_kind(
            KeyCode::Char('a'),
            KeyModifiers::NONE,
            KeyEventKind::Release,
        ))),
        None
    );
    assert_eq!(
        map_terminal_event(Event::Key(KeyEvent::new_with_kind(
            KeyCode::Char('a'),
            KeyModifiers::NONE,
            KeyEventKind::Repeat,
        ))),
        Some(AppEvent::Text("a".to_string()))
    );
    assert_eq!(
        map_terminal_event(Event::Key(KeyEvent::new_with_kind(
            KeyCode::Enter,
            KeyModifiers::NONE,
            KeyEventKind::Repeat,
        ))),
        None
    );
    assert_eq!(
        map_terminal_event(Event::Key(KeyEvent::new_with_kind(
            KeyCode::Enter,
            KeyModifiers::NONE,
            KeyEventKind::Release,
        ))),
        None
    );
    assert_eq!(map_terminal_event(Event::Resize(80, 24)), None);
}

#[test]
fn terminal_mapper_preserves_mouse_kind_coordinates_and_modifiers() {
    for mouse in [
        MouseEvent {
            kind: MouseEventKind::ScrollUp,
            column: 10,
            row: 5,
            modifiers: KeyModifiers::NONE,
        },
        MouseEvent {
            kind: MouseEventKind::ScrollDown,
            column: 11,
            row: 6,
            modifiers: KeyModifiers::CONTROL,
        },
        MouseEvent {
            kind: MouseEventKind::Down(crossterm::event::MouseButton::Left),
            column: 12,
            row: 7,
            modifiers: KeyModifiers::SHIFT,
        },
        MouseEvent {
            kind: MouseEventKind::Drag(crossterm::event::MouseButton::Left),
            column: 13,
            row: 8,
            modifiers: KeyModifiers::NONE,
        },
        MouseEvent {
            kind: MouseEventKind::Up(crossterm::event::MouseButton::Left),
            column: 14,
            row: 9,
            modifiers: KeyModifiers::NONE,
        },
    ] {
        assert_eq!(
            map_terminal_event(Event::Mouse(mouse)),
            Some(AppEvent::Mouse(mouse))
        );
    }
}
