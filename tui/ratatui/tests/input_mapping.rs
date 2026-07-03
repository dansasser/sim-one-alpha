use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use sim_one_ratatui_tui::app::AppEvent;
use sim_one_ratatui_tui::input::map_key_event;

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
        map_key_event(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppEvent::Submit)
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
        map_key_event(KeyEvent::new(KeyCode::End, KeyModifiers::NONE)),
        Some(AppEvent::JumpToTail)
    );
    assert_eq!(
        map_key_event(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
        Some(AppEvent::Quit)
    );
}
