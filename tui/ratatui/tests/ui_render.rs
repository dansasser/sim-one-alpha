use std::sync::Arc;

use ratatui::backend::TestBackend;
use ratatui::layout::Position;
use ratatui::Terminal;
use sim_one_ratatui_tui::agent::AgentReply;
use sim_one_ratatui_tui::app::{App, AppEvent};
use sim_one_ratatui_tui::flue::events::FlueEvent;
use sim_one_ratatui_tui::flue::stream::AgentStreamUpdate;
use sim_one_ratatui_tui::ui::render;

#[test]
fn renders_static_shell_with_transcript_status_and_prompt() {
    let backend = TestBackend::new(96, 28);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();

    terminal
        .draw(|frame| render(frame, &mut app))
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
    assert!(buffer.contains("context"), "{buffer}");
}

#[test]
fn renders_prompt_cursor_at_edit_position() {
    let backend = TestBackend::new(96, 28);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();
    app.handle_event(AppEvent::Text("hello world".to_string()));
    app.handle_event(AppEvent::MovePromptWordLeft);

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("shell should render with cursor");

    assert_eq!(terminal.backend().cursor_position(), Position::new(9, 25));
}

#[test]
fn renders_pending_spinner_status_without_covering_prompt() {
    let backend = TestBackend::new(160, 28);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = app_with_pending_response();
    app.handle_event(AppEvent::Text("slow prompt".to_string()));
    app.handle_event(AppEvent::Submit);
    app.tick();

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("pending shell should render");

    let buffer = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(buffer.contains("thinking"), "{buffer}");
    assert!(buffer.contains("turn: 00:00"), "{buffer}");
    assert!(buffer.contains("stream: not attached"), "{buffer}");
    assert!(buffer.contains("Prompt"), "{buffer}");
    assert!(buffer.contains("> Type a message"), "{buffer}");
}

#[test]
fn narrow_status_truncates_instead_of_overlapping_prompt() {
    let backend = TestBackend::new(42, 12);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new(
        "http://127.0.0.1:3940 started:true with a very long status segment",
        "http://127.0.0.1:3940",
    );

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("narrow shell should render");

    let buffer = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(buffer.contains("SIM-ONE Alpha"), "{buffer}");
    assert!(buffer.contains("..."), "{buffer}");
    assert!(buffer.contains("Prompt"), "{buffer}");
    assert!(buffer.contains("> Type a message"), "{buffer}");
}

#[test]
fn renders_thinking_and_tool_activity_rows() {
    let backend = TestBackend::new(120, 28);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();
    app.handle_stream_update(AgentStreamUpdate::Events(vec![
        FlueEvent::from_value(serde_json::json!({
            "type":"thinking_delta",
            "eventIndex":10,
            "text":"checking protocol"
        })),
        FlueEvent::from_value(serde_json::json!({
            "type":"tool_start",
            "eventIndex":11,
            "toolCallId":"cap",
            "toolName":"list_capabilities"
        })),
    ]));

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("activity shell should render");

    let buffer = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(buffer.contains("thinking: checking protocol"), "{buffer}");
    assert!(
        buffer.contains("tool: list_capabilities running"),
        "{buffer}"
    );
}

fn app_with_pending_response() -> App {
    App::with_agent_sender(
        "primary",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(|_, _, prompt| {
            Ok(AgentReply {
                text: format!("done: {prompt}"),
                session_id: None,
                command_name: None,
            })
        }),
    )
}
