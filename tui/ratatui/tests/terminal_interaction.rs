use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::Terminal;
use sim_one_ratatui_tui::agent::AgentReply;
use sim_one_ratatui_tui::app::App;
use sim_one_ratatui_tui::input::map_terminal_event;
use sim_one_ratatui_tui::ui::render;

#[test]
fn backslash_enter_remains_multiline_when_terminal_reports_enter_repeat() {
    let calls = Arc::new(AtomicUsize::new(0));
    let sender_calls = Arc::clone(&calls);
    let mut app = App::with_agent_sender(
        "tui-interaction-test",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(move |_, _, prompt| {
            sender_calls.fetch_add(1, Ordering::SeqCst);
            Ok(AgentReply {
                text: format!("done: {prompt}"),
                submission_id: None,
                stream_offset: None,
                session_id: None,
                session_title: None,
                command_name: None,
                session_created: None,
            })
        }),
    );

    for ch in "first line\\".chars() {
        deliver_key(&mut app, KeyCode::Char(ch), KeyEventKind::Press);
    }
    deliver_key(&mut app, KeyCode::Enter, KeyEventKind::Press);
    deliver_key(&mut app, KeyCode::Enter, KeyEventKind::Repeat);

    assert_eq!(app.prompt(), "first line\n");
    assert!(!app.is_agent_pending());
    assert_eq!(calls.load(Ordering::SeqCst), 0);

    let backend = TestBackend::new(40, 12);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("multiline interaction should render");
    let buffer = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(buffer.contains("first line"), "{buffer}");
}

fn deliver_key(app: &mut App, code: KeyCode, kind: KeyEventKind) {
    let event = Event::Key(KeyEvent::new_with_kind(code, KeyModifiers::NONE, kind));
    if let Some(app_event) = map_terminal_event(event) {
        app.handle_event(app_event);
    }
}
