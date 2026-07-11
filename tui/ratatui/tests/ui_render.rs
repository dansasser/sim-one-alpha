use std::sync::Arc;

use ratatui::backend::TestBackend;
use ratatui::layout::Position;
use ratatui::symbols::scrollbar;
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
    assert!(buffer.contains("session: resolving"));
    assert!(!buffer.contains("session: primary"));
    assert!(buffer.contains("> Type a message"));
    assert!(buffer.contains("preflight"), "{buffer}");
    assert!(!buffer.contains("scroll test row"), "{buffer}");
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
fn wraps_long_prompt_inside_prompt_box() {
    let backend = TestBackend::new(24, 12);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();
    app.handle_event(AppEvent::Text("abcdefghijklmnopqrstuvwxyz".to_string()));

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("wrapped prompt shell should render");

    let buffer = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(buffer.contains("abcdefghijklmnopqrst"), "{buffer}");
    assert!(buffer.contains("uvwxyz"), "{buffer}");
    assert_eq!(terminal.backend().cursor_position(), Position::new(9, 10));
}

#[test]
fn prompt_uses_five_visible_rows_then_follows_cursor() {
    let backend = TestBackend::new(14, 16);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();
    app.handle_event(AppEvent::Text(
        "aaaaaaaaaabbbbbbbbbbccccccccccddddddddddeeeeeeeeeeffffffff".to_string(),
    ));

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("scrolling prompt shell should render");

    let buffer = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(!buffer.contains("aaaaaaaaaa"), "{buffer}");
    assert!(buffer.contains("bbbbbbbbbb"), "{buffer}");
    assert!(buffer.contains("fffffff"), "{buffer}");
    assert_eq!(terminal.backend().cursor_position(), Position::new(11, 14));
}

#[test]
fn growing_prompt_keeps_transcript_tail_above_prompt_panel() {
    let backend = TestBackend::new(40, 10);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();
    for index in 0..20 {
        app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
            serde_json::json!({
                "type":"log",
                "eventIndex":300 + index,
                "text":format!("history row {index}")
            }),
        )]));
    }
    app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
        serde_json::json!({
            "type":"log",
            "eventIndex":999,
            "text":"visible-tail-marker"
        }),
    )]));
    app.jump_to_tail();

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("initial tail shell should render");
    app.handle_event(AppEvent::Text(
        "line one wraps across the prompt width and keeps going until the input occupies five visible rows without explicit newlines".to_string(),
    ));
    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("grown prompt shell should render");

    let buffer = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(buffer.contains("visible-tail-marker"), "{buffer}");
    assert_eq!(app.transcript_scroll(), app.max_scroll());
    assert!(app.follow_tail());
}

#[test]
fn first_pending_response_is_visible_without_waiting_for_another_prompt() {
    let backend = TestBackend::new(40, 9);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = app_with_pending_response();

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("initial shell should render");
    app.handle_event(AppEvent::Text("first prompt".to_string()));
    app.handle_event(AppEvent::Submit);
    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("first pending response should render");

    let buffer = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(buffer.contains("final response"), "{buffer}");
    assert_eq!(app.transcript_scroll(), app.max_scroll());
}

#[test]
fn shift_enter_newline_renders_prompt_on_next_row() {
    let backend = TestBackend::new(40, 12);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();
    app.handle_event(AppEvent::Text("first".to_string()));
    app.handle_event(AppEvent::Text("\n".to_string()));
    app.handle_event(AppEvent::Text("second".to_string()));

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("multiline prompt shell should render");

    let buffer = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(buffer.contains("first"), "{buffer}");
    assert!(buffer.contains("second"), "{buffer}");
    assert_eq!(terminal.backend().cursor_position(), Position::new(9, 10));
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

#[test]
fn narrow_transcript_tail_reaches_wrapped_bottom_row() {
    let backend = TestBackend::new(24, 10);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();
    app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
        serde_json::json!({
            "type":"thinking_delta",
            "eventIndex":10,
            "text":"alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa bottom-marker"
        }),
    )]));
    app.jump_to_tail();

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("narrow tail shell should render");

    let buffer = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(buffer.contains("marker"), "{buffer}");
}

#[test]
fn small_transcript_tail_reaches_bottom_after_many_wrapped_lines() {
    let backend = TestBackend::new(22, 9);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();
    for index in 0..30 {
        app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
            serde_json::json!({
                "type":"log",
                "eventIndex":100 + index,
                "text":format!("row {index} alpha bravo charlie delta echo foxtrot")
            }),
        )]));
    }
    app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
        serde_json::json!({
            "type":"log",
            "eventIndex":999,
            "text":"tail-ok"
        }),
    )]));
    app.jump_to_tail();

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("small tail shell should render");

    let buffer = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(buffer.contains("tail-ok"), "{buffer}");
}

#[test]
fn transcript_scrollbar_thumb_reaches_bottom_at_tail() {
    let backend = TestBackend::new(40, 16);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();
    for index in 0..20 {
        app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
            serde_json::json!({
                "type":"log",
                "eventIndex":200 + index,
                "text":format!("row {index}")
            }),
        )]));
    }
    app.jump_to_tail();

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("tail scrollbar shell should render");

    let buffer = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    let bottom_track_symbol = terminal
        .backend()
        .buffer()
        .cell(Position::new(39, 9))
        .expect("bottom transcript scrollbar track cell should exist")
        .symbol();

    assert_eq!(
        bottom_track_symbol,
        scrollbar::DOUBLE_VERTICAL.thumb,
        "{buffer}"
    );
}

fn app_with_pending_response() -> App {
    App::with_agent_sender(
        "tui-existing-1",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(|_, _, prompt| {
            Ok(AgentReply {
                text: format!("done: {prompt}"),
                session_id: None,
                command_name: None,
                session_created: None,
            })
        }),
    )
}
