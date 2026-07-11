use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use ratatui::backend::TestBackend;
use ratatui::layout::Position;
use ratatui::style::{Color, Modifier};
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
fn slash_command_palette_overlays_transcript_without_moving_prompt() {
    let backend = TestBackend::new(100, 24);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("static shell should render");
    let prompt_row_before = find_buffer_row(&terminal, "Prompt");
    let status_row_before = find_buffer_row(&terminal, "SIM-ONE Alpha | session:");

    app.handle_event(AppEvent::Text("/".to_string()));
    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("command palette should render");

    let frame = terminal_buffer_lines(&terminal);
    assert!(frame.contains("Commands 1-6/9"), "{frame}");
    assert!(frame.contains("/new [title]"), "{frame}");
    assert!(frame.contains("Start a new session"), "{frame}");
    assert!(frame.contains("/rename <title>"), "{frame}");
    assert!(!frame.contains("/compact"), "{frame}");
    assert_eq!(find_buffer_row(&terminal, "Prompt"), prompt_row_before);
    assert_eq!(
        find_buffer_row(&terminal, "SIM-ONE Alpha | session:"),
        status_row_before
    );

    let selected = find_buffer_text_position(&terminal, "/new [title]");
    assert_eq!(
        terminal
            .backend()
            .buffer()
            .cell(selected)
            .expect("selected command cell should exist")
            .style()
            .bg,
        Some(Color::Rgb(58, 64, 72))
    );
}

#[test]
fn slash_command_palette_filters_and_scrolls_selected_command_into_view() {
    let backend = TestBackend::new(100, 24);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();
    app.handle_event(AppEvent::Text("/res".to_string()));

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("filtered command palette should render");
    let filtered = terminal_buffer_lines(&terminal);
    assert!(filtered.contains("Commands 1-1/1"), "{filtered}");
    assert!(filtered.contains("/resume <session-id>"), "{filtered}");
    assert!(!filtered.contains("/new [title]"), "{filtered}");

    app.handle_event(AppEvent::ClearPrompt);
    app.handle_event(AppEvent::Text("/".to_string()));
    for _ in 0..8 {
        app.handle_event(AppEvent::NavigateDown);
    }
    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("scrolled command palette should render");
    let scrolled = terminal_buffer_lines(&terminal);
    assert!(scrolled.contains("Commands 4-9/9"), "{scrolled}");
    assert!(scrolled.contains("/exit"), "{scrolled}");
    assert!(!scrolled.contains("/new [title]"), "{scrolled}");
}

#[test]
fn transcript_text_starts_after_two_column_left_margin() {
    let backend = TestBackend::new(80, 16);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("indented transcript shell should render");

    let row = find_buffer_row(&terminal, "system: SIM-ONE Alpha");
    assert_eq!(
        terminal
            .backend()
            .buffer()
            .cell(Position::new(1, row))
            .expect("first transcript margin cell should exist")
            .symbol(),
        " "
    );
    assert_eq!(
        terminal
            .backend()
            .buffer()
            .cell(Position::new(2, row))
            .expect("second transcript margin cell should exist")
            .symbol(),
        " "
    );
    assert_eq!(
        terminal
            .backend()
            .buffer()
            .cell(Position::new(3, row))
            .expect("first transcript text cell should exist")
            .symbol(),
        "s"
    );
}

#[test]
fn active_prompt_editor_has_gray_background_across_visible_rows() {
    let backend = TestBackend::new(40, 12);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("prompt background shell should render");

    for y in [9, 10] {
        for x in 1..39 {
            let cell = terminal
                .backend()
                .buffer()
                .cell(Position::new(x, y))
                .expect("prompt editor cell should exist");
            assert_eq!(
                cell.style().bg,
                Some(Color::Rgb(38, 38, 40)),
                "missing prompt-editor background at ({x}, {y})"
            );
        }
    }
    assert_eq!(
        terminal
            .backend()
            .buffer()
            .cell(Position::new(0, 9))
            .expect("prompt border cell should exist")
            .style()
            .bg,
        Some(Color::Reset)
    );
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
fn multiline_prompt_arrows_move_the_visible_cursor_without_scrolling_transcript() {
    let backend = TestBackend::new(40, 14);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();
    app.handle_event(AppEvent::Text("first line\nsecond line".to_string()));

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("multiline prompt should render");
    let transcript_scroll = app.transcript_scroll();
    let lower_cursor = terminal.backend().cursor_position();

    app.handle_event(AppEvent::NavigateUp);
    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("moved multiline prompt should render");
    let upper_cursor = terminal.backend().cursor_position();

    assert!(upper_cursor.y < lower_cursor.y);
    assert_eq!(app.transcript_scroll(), transcript_scroll);
}

#[test]
fn renamed_session_title_is_rendered_in_status_bar() {
    let backend = TestBackend::new(120, 18);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::with_agent_sender(
        "tui-existing-1",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(|_, _, _| {
            Ok(AgentReply {
                text: "Renamed session tui-existing-1 to \"Release Work\".".to_string(),
                session_id: Some("tui-existing-1".to_string()),
                session_title: Some("Release Work".to_string()),
                command_name: Some("rename".to_string()),
                session_created: Some(false),
            })
        }),
    );
    app.handle_event(AppEvent::Text("/rename Release Work".to_string()));
    app.handle_event(AppEvent::Submit);
    wait_for_agent(&mut app);

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("renamed session status should render");
    let frame = terminal_buffer_lines(&terminal);
    assert!(frame.contains("session: Release Work"), "{frame}");
    assert!(!frame.contains("Release Work (tui-existing-1)"), "{frame}");
}

#[test]
fn submitted_prompt_and_wrapped_continuation_have_gray_background() {
    let backend = TestBackend::new(24, 16);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = app_with_pending_response();
    app.handle_event(AppEvent::Text("alpha bravo charlie delta".to_string()));
    app.handle_event(AppEvent::Submit);

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("submitted prompt shell should render");

    let first_row = find_buffer_row(&terminal, "you: alpha bravo");
    let continuation_row = find_buffer_row(&terminal, "charlie delta");
    for row in [first_row, continuation_row] {
        for x in [1, 2] {
            assert_eq!(
                terminal
                    .backend()
                    .buffer()
                    .cell(Position::new(x, row))
                    .expect("submitted-prompt margin cell should exist")
                    .symbol(),
                " ",
                "submitted-prompt text should start after the margin"
            );
        }
        for x in 1..23 {
            let cell = terminal
                .backend()
                .buffer()
                .cell(Position::new(x, row))
                .expect("prompt background cell should exist");
            assert_eq!(
                cell.style().bg,
                Some(Color::Rgb(52, 52, 56)),
                "missing submitted-prompt background at ({x}, {row})"
            );
        }
    }
}

#[test]
fn transcript_wrap_width_excludes_the_left_margin() {
    let backend = TestBackend::new(24, 16);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("margin-aware transcript shell should render");

    let first_row = find_buffer_row(&terminal, "system: SIM-ONE");
    let first_row_text = buffer_row_text(&terminal, first_row);
    assert!(!first_row_text.contains("Alpha"), "{first_row_text}");

    let continuation_row = find_buffer_row(&terminal, "Alpha Ratatui TUI");
    assert_eq!(
        terminal
            .backend()
            .buffer()
            .cell(Position::new(3, continuation_row))
            .expect("wrapped continuation text cell should exist")
            .symbol(),
        "A"
    );
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
fn unicode_prompt_wraps_and_places_cursor_by_terminal_columns() {
    let backend = TestBackend::new(12, 12);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();
    app.handle_event(AppEvent::Text("test 界界".to_string()));

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("Unicode prompt shell should render");

    let frame = terminal_buffer_lines(&terminal);
    let rows = frame.lines().collect::<Vec<_>>();
    assert!(rows[9].contains("> test"), "{frame}");
    assert_eq!(
        terminal
            .backend()
            .buffer()
            .cell(Position::new(3, 10))
            .expect("first CJK glyph cell should exist")
            .symbol(),
        "界"
    );
    assert_eq!(
        terminal
            .backend()
            .buffer()
            .cell(Position::new(5, 10))
            .expect("second CJK glyph cell should exist")
            .symbol(),
        "界"
    );
    assert_eq!(terminal.backend().cursor_position(), Position::new(7, 10));
    for y in [9, 10] {
        for x in 1..11 {
            if y == 10 && matches!(x, 4 | 6) {
                continue;
            }
            assert_eq!(
                terminal
                    .backend()
                    .buffer()
                    .cell(Position::new(x, y))
                    .expect("Unicode prompt background cell should exist")
                    .style()
                    .bg,
                Some(Color::Rgb(38, 38, 40)),
                "missing Unicode prompt background at ({x}, {y})"
            );
        }
    }
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
                session_title: None,
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
                session_title: None,
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
fn live_assistant_stream_is_dimmed_until_final_message_replaces_it() {
    let backend = TestBackend::new(80, 20);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = Arc::new(Mutex::new(release_rx));
    let sender_release_rx = Arc::clone(&release_rx);
    let mut app = App::with_agent_sender(
        "tui-live-assistant-style",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(move |_, _, _| {
            sender_release_rx
                .lock()
                .expect("release receiver should lock")
                .recv_timeout(Duration::from_secs(2))
                .expect("test should release blocked sender");
            Ok(AgentReply {
                text: "Live **answer** finalized.".to_string(),
                session_id: None,
                session_title: None,
                command_name: None,
                session_created: None,
            })
        }),
    );
    app.handle_event(AppEvent::Text("stream the answer".to_string()));
    app.handle_event(AppEvent::Submit);
    app.handle_stream_update(AgentStreamUpdate::Events(vec![
        FlueEvent::from_value(serde_json::json!({
            "type":"text_delta",
            "eventIndex":5,
            "timestamp":"2026-07-11T18:37:02Z",
            "session":"default",
            "text":"Live **answer** "
        })),
        FlueEvent::from_value(serde_json::json!({
            "type":"text_delta",
            "eventIndex":6,
            "timestamp":"2026-07-11T18:37:03Z",
            "session":"default",
            "text":"streaming."
        })),
    ]));

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("live assistant stream should render");
    release_tx.send(()).expect("pending sender should release");
    let live_row = find_buffer_row(&terminal, "assistant: Live answer streaming.");
    for x in [3, 14] {
        assert!(
            terminal
                .backend()
                .buffer()
                .cell(Position::new(x, live_row))
                .expect("live assistant cell should exist")
                .style()
                .add_modifier
                .contains(Modifier::DIM),
            "live assistant cell at x={x} should be dimmed"
        );
    }
    let live_bold = Position::new(
        buffer_row_text(&terminal, live_row)
            .find("answer")
            .expect("live assistant row should contain bold text") as u16,
        live_row,
    );
    assert!(terminal
        .backend()
        .buffer()
        .cell(live_bold)
        .expect("live Markdown bold cell should exist")
        .style()
        .add_modifier
        .contains(Modifier::BOLD));

    app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
        serde_json::json!({
            "type":"message_end",
            "eventIndex":21,
            "timestamp":"2026-07-11T18:37:09Z",
            "session":"default",
            "message":{"role":"assistant","content":[{"type":"text","text":"Live **answer** finalized."}]}
        }),
    )]));
    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("final assistant message should render");
    let final_row = find_buffer_row(&terminal, "assistant: Live answer finalized.");
    for x in [3, 14] {
        assert!(!terminal
            .backend()
            .buffer()
            .cell(Position::new(x, final_row))
            .expect("final assistant cell should exist")
            .style()
            .add_modifier
            .contains(Modifier::DIM));
    }
    let final_bold = Position::new(
        buffer_row_text(&terminal, final_row)
            .find("answer")
            .expect("final assistant row should contain bold text") as u16,
        final_row,
    );
    let final_style = terminal
        .backend()
        .buffer()
        .cell(final_bold)
        .expect("final Markdown bold cell should exist")
        .style();
    assert!(final_style.add_modifier.contains(Modifier::BOLD));
    assert!(!final_style.add_modifier.contains(Modifier::DIM));

    wait_for_agent(&mut app);
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

    let thinking_row = find_buffer_row(&terminal, "thinking: checking protocol");
    let thinking_cell = terminal
        .backend()
        .buffer()
        .cell(Position::new(3, thinking_row))
        .expect("thinking cell should exist");
    assert_eq!(thinking_cell.style().fg, Some(Color::DarkGray));
    assert!(
        thinking_cell
            .style()
            .add_modifier
            .contains(Modifier::ITALIC),
        "thinking row should be italic"
    );

    let tool_row = find_buffer_row(&terminal, "tool: list_capabilities running");
    let tool_cell = terminal
        .backend()
        .buffer()
        .cell(Position::new(3, tool_row))
        .expect("tool cell should exist");
    assert!(!tool_cell.style().add_modifier.contains(Modifier::ITALIC));
}

#[test]
fn semantic_transcript_prefixes_are_bold_and_color_coded() {
    let backend = TestBackend::new(120, 40);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = app_with_pending_response();
    app.handle_event(AppEvent::Text("format this response".to_string()));
    app.handle_event(AppEvent::Submit);
    wait_for_agent(&mut app);
    app.handle_stream_update(AgentStreamUpdate::Events(vec![
        FlueEvent::from_value(serde_json::json!({
            "type":"thinking_delta",
            "eventIndex":100,
            "text":"checking styles"
        })),
        FlueEvent::from_value(serde_json::json!({
            "type":"tool_start",
            "eventIndex":101,
            "toolCallId":"format-tool",
            "toolName":"formatter"
        })),
        FlueEvent::from_value(serde_json::json!({
            "type":"task_start",
            "eventIndex":102,
            "taskId":"format-task",
            "taskName":"reviewer"
        })),
        FlueEvent::from_value(serde_json::json!({
            "type":"operation_start",
            "eventIndex":103,
            "name":"render"
        })),
        FlueEvent::from_value(serde_json::json!({
            "type":"log",
            "eventIndex":104,
            "text":"frame ready"
        })),
        FlueEvent::from_value(serde_json::json!({
            "type":"turn_start",
            "eventIndex":105
        })),
    ]));

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("semantic transcript shell should render");

    assert_prefix_style(
        &terminal,
        "system: SIM-ONE Alpha",
        "system:",
        Color::LightGreen,
    );
    assert_prefix_style(
        &terminal,
        "preflight: waiting",
        "preflight:",
        Color::LightGreen,
    );
    assert_prefix_style(&terminal, "assistant: done", "assistant:", Color::Cyan);
    assert_prefix_style(
        &terminal,
        "thinking: checking styles",
        "thinking:",
        Color::DarkGray,
    );
    assert_prefix_style(&terminal, "tool: formatter running", "tool:", Color::Blue);
    assert_prefix_style(&terminal, "task: reviewer running", "task:", Color::Magenta);
    assert_prefix_style(
        &terminal,
        "operation: render running",
        "operation:",
        Color::Yellow,
    );
    assert_prefix_style(&terminal, "turn: model active", "turn:", Color::Green);
    assert_prefix_style(&terminal, "log: frame ready", "log:", Color::DarkGray);
}

#[test]
fn semantic_prefix_formatting_preserves_body_and_continuation_styles() {
    let backend = TestBackend::new(24, 16);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::with_agent_sender(
        "tui-prefix-wrap",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(|_, _, _| {
            Ok(AgentReply {
                text: "alpha bravo charlie delta echo".to_string(),
                session_id: None,
                session_title: None,
                command_name: None,
                session_created: None,
            })
        }),
    );
    app.handle_event(AppEvent::Text("wrap it".to_string()));
    app.handle_event(AppEvent::Submit);
    wait_for_agent(&mut app);

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("wrapped semantic transcript shell should render");

    let assistant_row = find_buffer_row(&terminal, "assistant: alpha");
    let assistant_body = terminal
        .backend()
        .buffer()
        .cell(Position::new(14, assistant_row))
        .expect("assistant body cell should exist");
    assert_eq!(assistant_body.style().fg, Some(Color::Reset));
    assert!(!assistant_body.style().add_modifier.contains(Modifier::BOLD));

    let continuation_row = find_buffer_row(&terminal, "bravo charlie delta");
    let continuation_cell = terminal
        .backend()
        .buffer()
        .cell(Position::new(3, continuation_row))
        .expect("assistant continuation cell should exist");
    assert_eq!(continuation_cell.style().fg, Some(Color::Reset));
    assert!(!continuation_cell
        .style()
        .add_modifier
        .contains(Modifier::BOLD));

    let user_row = find_buffer_row(&terminal, "you: wrap it");
    assert_eq!(
        terminal
            .backend()
            .buffer()
            .cell(Position::new(1, user_row))
            .expect("user row cell should exist")
            .style()
            .bg,
        Some(Color::Rgb(52, 52, 56))
    );
}

#[test]
fn assistant_markdown_renders_inline_styles_without_source_markers() {
    let backend = TestBackend::new(120, 20);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::with_agent_sender(
        "tui-markdown-inline",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(|_, _, _| {
            Ok(AgentReply {
                text: "Plain **bold** *italic* `code` [docs](https://example.com)".to_string(),
                session_id: None,
                session_title: None,
                command_name: None,
                session_created: None,
            })
        }),
    );
    app.handle_event(AppEvent::Text("format markdown".to_string()));
    app.handle_event(AppEvent::Submit);
    wait_for_agent(&mut app);

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("Markdown transcript should render");

    let frame = terminal_buffer_lines(&terminal);
    assert!(!frame.contains("**bold**"), "{frame}");
    assert!(!frame.contains("*italic*"), "{frame}");
    assert!(!frame.contains("`code`"), "{frame}");
    assert!(!frame.contains("[docs]"), "{frame}");

    let bold = find_buffer_text_position(&terminal, "bold");
    assert!(terminal
        .backend()
        .buffer()
        .cell(bold)
        .expect("bold Markdown cell should exist")
        .style()
        .add_modifier
        .contains(Modifier::BOLD));

    let italic = find_buffer_text_position(&terminal, "italic");
    assert!(terminal
        .backend()
        .buffer()
        .cell(italic)
        .expect("italic Markdown cell should exist")
        .style()
        .add_modifier
        .contains(Modifier::ITALIC));

    let code = find_buffer_text_position(&terminal, "code");
    assert_eq!(
        terminal
            .backend()
            .buffer()
            .cell(code)
            .expect("inline-code Markdown cell should exist")
            .style()
            .bg,
        Some(Color::Rgb(38, 38, 40))
    );

    let link = find_buffer_text_position(&terminal, "https://example.com");
    assert!(terminal
        .backend()
        .buffer()
        .cell(link)
        .expect("link Markdown cell should exist")
        .style()
        .add_modifier
        .contains(Modifier::UNDERLINED));
}

#[test]
fn assistant_markdown_renders_blocks_and_preserves_word_wrapping() {
    let backend = TestBackend::new(28, 24);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::with_agent_sender(
        "tui-markdown-blocks",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(|_, _, _| {
            Ok(AgentReply {
                text: "# Summary\n\n- alpha bravo charlie delta echo\n- second item\n\n```rust\nlet value = 1;\n```"
                    .to_string(),
                session_id: None,
                session_title: None,
                command_name: None,
                session_created: None,
            })
        }),
    );
    app.handle_event(AppEvent::Text("render blocks".to_string()));
    app.handle_event(AppEvent::Submit);
    wait_for_agent(&mut app);

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("block Markdown transcript should render");

    let frame = terminal_buffer_lines(&terminal);
    assert!(frame.contains("# Summary"), "{frame}");
    assert!(frame.contains("- alpha bravo charlie"), "{frame}");
    assert!(frame.contains("delta echo"), "{frame}");
    assert!(frame.contains("let value = 1;"), "{frame}");
    assert!(!frame.contains("charlie delta"), "{frame}");

    let heading = find_buffer_text_position(&terminal, "Summary");
    assert!(terminal
        .backend()
        .buffer()
        .cell(heading)
        .expect("heading Markdown cell should exist")
        .style()
        .add_modifier
        .contains(Modifier::BOLD));
    let code = find_buffer_text_position(&terminal, "let value = 1;");
    assert_eq!(
        terminal
            .backend()
            .buffer()
            .cell(code)
            .expect("code-block Markdown cell should exist")
            .style()
            .bg,
        Some(Color::Rgb(38, 38, 40))
    );
}

#[test]
fn error_prefix_is_bold_light_red() {
    let backend = TestBackend::new(80, 16);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::with_agent_sender(
        "tui-prefix-error",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(|_, _, _| Err("gateway rejected the prompt".to_string())),
    );
    app.handle_event(AppEvent::Text("trigger error".to_string()));
    app.handle_event(AppEvent::Submit);
    wait_for_agent(&mut app);

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("error transcript shell should render");

    assert_prefix_style(
        &terminal,
        "error: gateway rejected",
        "error:",
        Color::LightRed,
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
                    session_title: None,
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
                session_title: None,
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

fn buffer_row_text(terminal: &Terminal<TestBackend>, row: u16) -> String {
    let buffer = terminal.backend().buffer();
    (0..buffer.area.width)
        .filter_map(|x| buffer.cell(Position::new(x, row)))
        .map(|cell| cell.symbol())
        .collect()
}

fn find_buffer_text_position(terminal: &Terminal<TestBackend>, needle: &str) -> Position {
    let buffer = terminal.backend().buffer();
    for y in 0..buffer.area.height {
        let row = buffer_row_text(terminal, y);
        if let Some(x) = row.find(needle) {
            return Position::new(x as u16, y);
        }
    }
    panic!(
        "could not find {needle:?} in:\n{}",
        terminal_buffer_lines(terminal)
    );
}

fn find_buffer_row(terminal: &Terminal<TestBackend>, needle: &str) -> u16 {
    let buffer = terminal.backend().buffer();
    (0..buffer.area.height)
        .find(|&y| {
            (0..buffer.area.width)
                .filter_map(|x| buffer.cell(Position::new(x, y)))
                .map(|cell| cell.symbol())
                .collect::<String>()
                .contains(needle)
        })
        .unwrap_or_else(|| {
            panic!(
                "could not find {needle:?} in:\n{}",
                terminal_buffer_lines(terminal)
            )
        })
}

fn assert_prefix_style(
    terminal: &Terminal<TestBackend>,
    row_needle: &str,
    prefix: &str,
    expected_color: Color,
) {
    let row = find_buffer_row(terminal, row_needle);
    for offset in 0..prefix.len() {
        let cell = terminal
            .backend()
            .buffer()
            .cell(Position::new(3 + offset as u16, row))
            .expect("prefix cell should exist");
        assert_eq!(
            cell.style().fg,
            Some(expected_color),
            "wrong prefix color for {row_needle:?} at offset {offset}"
        );
        assert!(
            cell.style().add_modifier.contains(Modifier::BOLD),
            "prefix should be bold for {row_needle:?} at offset {offset}"
        );
    }

    let body_cell = terminal
        .backend()
        .buffer()
        .cell(Position::new(4 + prefix.len() as u16, row))
        .expect("body cell should exist");
    if prefix == "thinking:" {
        assert_eq!(body_cell.style().fg, Some(Color::DarkGray));
        assert!(body_cell.style().add_modifier.contains(Modifier::ITALIC));
    } else {
        assert_eq!(body_cell.style().fg, Some(Color::Reset));
        assert!(!body_cell.style().add_modifier.contains(Modifier::BOLD));
    }
}
