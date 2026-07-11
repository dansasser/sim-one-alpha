use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

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
fn prompt_does_not_split_a_word_longer_than_the_input_width() {
    let backend = TestBackend::new(24, 12);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();
    app.handle_event(AppEvent::Text("abcdefghijklmnopqrstuvwxyz".to_string()));

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("long-word prompt shell should render");

    let buffer = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(buffer.contains("abcdefghijklmnopqrst"), "{buffer}");
    assert!(!buffer.contains("uvwxyz"), "{buffer}");
    assert_eq!(terminal.backend().cursor_position(), Position::new(22, 9));
}

#[test]
fn prompt_wraps_before_a_word_that_does_not_fit() {
    let backend = TestBackend::new(14, 12);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();
    app.handle_event(AppEvent::Text("alpha bravo charlie".to_string()));

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("word-wrapped prompt shell should render");

    let frame = terminal_buffer_lines(&terminal);
    let rows = frame.lines().collect::<Vec<_>>();
    assert!(rows[8].contains("> alpha"), "{frame}");
    assert!(rows[9].contains("  bravo"), "{frame}");
    assert!(rows[10].contains("  charlie"), "{frame}");
    assert!(!frame.contains("alpha brav"), "{frame}");
    assert_eq!(terminal.backend().cursor_position(), Position::new(10, 10));

    app.handle_event(AppEvent::MovePromptWordLeft);
    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("word-wrapped prompt cursor should render");
    assert_eq!(terminal.backend().cursor_position(), Position::new(3, 10));
}

#[test]
fn prompt_uses_five_visible_rows_then_follows_cursor() {
    let backend = TestBackend::new(14, 16);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();
    app.handle_event(AppEvent::Text(
        "aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee ffffffff".to_string(),
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
    assert_eq!(terminal.backend().cursor_position().y, 14);
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
fn live_tail_reanchors_when_transcript_wrap_count_changes_between_frames() {
    let backend = TestBackend::new(40, 9);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = app_with_pending_response();
    app.handle_event(AppEvent::Text("first prompt".to_string()));
    app.handle_event(AppEvent::Submit);

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("initial pending response should render");
    assert_eq!(app.transcript_scroll(), app.max_scroll());

    app.handle_event(AppEvent::Submit);
    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("grown pending response should render at live tail");

    let buffer = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert_eq!(app.transcript_scroll(), app.max_scroll());
    assert!(buffer.contains("finishes"), "{buffer}");
}

#[test]
fn retry_completion_renders_final_response_at_live_tail() {
    let backend = TestBackend::new(40, 9);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::with_agent_sender(
        "tui-retry-test",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(|_, _, _| {
            Ok(AgentReply {
                text: "retry completed and the final response is visible at TAIL_OK".to_string(),
                session_id: None,
                command_name: None,
                session_created: None,
            })
        }),
    );
    app.handle_event(AppEvent::Text("retry this prompt".to_string()));
    app.handle_event(AppEvent::Submit);
    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("pending retry prompt should render");

    app.handle_stream_update(AgentStreamUpdate::Events(vec![
        FlueEvent::from_value(serde_json::json!({
            "type":"turn",
            "eventIndex":10,
            "isError":true,
            "error":"Request timed out."
        })),
        FlueEvent::from_value(serde_json::json!({
            "type":"log",
            "eventIndex":11,
            "message":"[flue:model-retry] Retrying transient model error"
        })),
        FlueEvent::from_value(serde_json::json!({
            "type":"turn_start",
            "eventIndex":12
        })),
        FlueEvent::from_value(serde_json::json!({
            "type":"tool",
            "eventIndex":13,
            "toolCallId":"protocol-retry",
            "toolName":"load_protocols",
            "isError":false
        })),
    ]));
    wait_for_agent(&mut app);
    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("retry final response should render at live tail");

    let buffer = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(buffer.contains("TAIL_OK"), "{buffer}");
    assert_eq!(app.transcript_scroll(), app.max_scroll());
    assert!(app.follow_tail());
}

#[test]
fn flue_final_message_is_visible_before_http_request_settles() {
    let backend = TestBackend::new(133, 35);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = Arc::new(Mutex::new(release_rx));
    let sender_release_rx = Arc::clone(&release_rx);
    let mut app = App::with_agent_sender(
        "tui-visible-final-test",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(move |_, _, _| {
            sender_release_rx
                .lock()
                .expect("release receiver should lock")
                .recv_timeout(Duration::from_secs(2))
                .expect("test should release blocked sender");
            Ok(AgentReply {
                text: "FINAL_VISIBLE_MARKER".to_string(),
                session_id: None,
                command_name: None,
                session_created: None,
            })
        }),
    );

    for index in 0..24 {
        app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
            serde_json::json!({
                "type":"log",
                "eventIndex":100 + index,
                "text":format!("history row {index}")
            }),
        )]));
    }
    app.handle_event(AppEvent::Text("show the final response".to_string()));
    app.handle_event(AppEvent::Submit);
    app.handle_stream_update(AgentStreamUpdate::Events(vec![
        FlueEvent::from_value(serde_json::json!({
            "type":"message_end",
            "eventIndex":200,
            "role":"assistant",
            "text":"FINAL_VISIBLE_MARKER"
        })),
        FlueEvent::from_value(serde_json::json!({
            "type":"turn",
            "eventIndex":201,
            "isError":false
        })),
        FlueEvent::from_value(serde_json::json!({
            "type":"operation",
            "eventIndex":202,
            "name":"operation",
            "isError":false
        })),
    ]));

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("Flue-complete frame should render");

    let transcript_has_final = app
        .transcript_lines()
        .iter()
        .any(|line| line.contains("FINAL_VISIBLE_MARKER"));
    let frame = terminal_buffer_lines(&terminal);
    let frame_has_final = frame.contains("FINAL_VISIBLE_MARKER");
    release_tx.send(()).expect("pending sender should release");

    assert!(
        transcript_has_final && frame_has_final,
        "Flue delivered the final message, but transcript_has_final={transcript_has_final}, frame_has_final={frame_has_final}\nframe:\n{frame}"
    );
}

#[test]
fn render_preserves_manual_scrollback_after_transcript_growth() {
    let backend = TestBackend::new(40, 12);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();
    for index in 0..20 {
        app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
            serde_json::json!({
                "type":"log",
                "eventIndex":500 + index,
                "text":format!("history row {index}")
            }),
        )]));
    }
    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("history should render at tail");
    app.scroll_page_up();
    let scrollback_position = app.transcript_scroll();

    app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
        serde_json::json!({
            "type":"log",
            "eventIndex":999,
            "text":"new tail content that must not snap manual scrollback"
        }),
    )]));
    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("manual scrollback should render without snapping");

    assert_eq!(app.transcript_scroll(), scrollback_position);
    assert!(!app.follow_tail());
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

#[test]
fn live_tail_renders_final_content_above_blank_margin_row() {
    let backend = TestBackend::new(40, 12);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();
    for index in 0..8 {
        app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
            serde_json::json!({
                "type":"log",
                "eventIndex":700 + index,
                "text":format!("history row {index}")
            }),
        )]));
    }
    app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
        serde_json::json!({
            "type":"log",
            "eventIndex":799,
            "text":"TAIL_MARGIN_MARKER"
        }),
    )]));
    app.jump_to_tail();

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("tail margin shell should render");

    let buffer = terminal.backend().buffer();
    let content_row = (1..39)
        .filter_map(|x| buffer.cell(Position::new(x, 4)))
        .map(|cell| cell.symbol())
        .collect::<String>();
    let margin_row = (1..39)
        .filter_map(|x| buffer.cell(Position::new(x, 5)))
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(content_row.contains("TAIL_MARGIN_MARKER"), "{content_row}");
    assert!(margin_row.trim().is_empty(), "{margin_row:?}");
}

#[test]
fn streamed_final_remains_visible_across_terminal_and_prompt_sizes() {
    for (width, height, draft) in [
        (22, 9, "short draft"),
        (
            40,
            12,
            "a growing draft prompt that wraps across several rows below the transcript",
        ),
        (
            80,
            24,
            "line one of a draft\nline two of a draft\nline three of a draft\nline four of a draft\nline five of a draft",
        ),
        (
            133,
            35,
            "line one of a draft\nline two of a draft\nline three of a draft\nline four of a draft\nline five of a draft",
        ),
    ] {
        let backend = TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).expect("test backend should initialize");
        let mut app = App::with_agent_sender(
            "tui-size-matrix",
            "test gateway",
            "http://127.0.0.1:3940",
            Arc::new(|_, _, _| {
                Ok(AgentReply {
                    text: "TAIL_OK".to_string(),
                    session_id: None,
                    command_name: None,
                    session_created: None,
                })
            }),
        );
        for index in 0..30 {
            app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
                serde_json::json!({
                    "type":"log",
                    "eventIndex":900 + index,
                    "text":format!("history row {index}")
                }),
            )]));
        }
        app.handle_event(AppEvent::Text("show the final response".to_string()));
        app.handle_event(AppEvent::Submit);
        app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
            serde_json::json!({
                "type":"message_end",
                "eventIndex":999,
                "message":{"role":"assistant","content":"TAIL_OK"}
            }),
        )]));
        app.handle_event(AppEvent::Text(draft.to_string()));

        terminal
            .draw(|frame| render(frame, &mut app))
            .expect("size-matrix shell should render");
        let frame = terminal_buffer_lines(&terminal);
        assert!(
            frame.contains("TAIL_OK"),
            "final response missing at {width}x{height}:\n{frame}"
        );
        assert!(app.follow_tail(), "live tail disabled at {width}x{height}");
        assert_eq!(
            app.transcript_scroll(),
            app.max_scroll(),
            "tail offset wrong at {width}x{height}"
        );
    }
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

fn wait_for_agent(app: &mut App) {
    let deadline = Instant::now() + Duration::from_secs(2);
    while app.is_agent_pending() && Instant::now() < deadline {
        app.poll_agent();
        thread::sleep(Duration::from_millis(5));
    }
    app.poll_agent();
    assert!(!app.is_agent_pending(), "agent response did not settle");
}

fn terminal_buffer_lines(terminal: &Terminal<TestBackend>) -> String {
    let buffer = terminal.backend().buffer();
    (0..buffer.area.height)
        .map(|y| {
            (0..buffer.area.width)
                .filter_map(|x| buffer.cell(Position::new(x, y)))
                .map(|cell| cell.symbol())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}
