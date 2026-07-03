use ratatui::backend::TestBackend;
use ratatui::layout::Position;
use ratatui::Terminal;
use sim_one_ratatui_tui::app::{App, AppEvent};
use sim_one_ratatui_tui::ui::render;

#[test]
fn renders_static_shell_with_transcript_status_and_prompt() {
    let backend = TestBackend::new(96, 28);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let app = App::new_for_test();

    terminal
        .draw(|frame| render(frame, &app))
        .expect("static shell should render");

    let buffer = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(buffer.contains("Transcript"));
    assert!(buffer.contains("SIM-ONE Alpha"));
    assert!(buffer.contains("session: primary"));
    assert!(buffer.contains("> Type a message"));
    assert!(buffer.contains("assistant:"), "{buffer}");
}

#[test]
fn renders_prompt_cursor_at_edit_position() {
    let backend = TestBackend::new(96, 28);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();
    app.handle_event(AppEvent::Text("hello world".to_string()));
    app.handle_event(AppEvent::MovePromptWordLeft);

    terminal
        .draw(|frame| render(frame, &app))
        .expect("shell should render with cursor");

    assert_eq!(terminal.backend().cursor_position(), Position::new(9, 25));
}
