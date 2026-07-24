use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crossterm::event::{KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::backend::TestBackend;
use ratatui::layout::Position;
use ratatui::style::{Color, Modifier};
use ratatui::symbols::scrollbar;
use ratatui::Terminal;
use sim_one_ratatui_tui::agent::{AgentReply, SessionLifecycleReply};
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
    let frame = terminal_buffer_lines(&terminal);
    assert!(frame.starts_with("┌SIM-ONE Alpha"), "{frame}");
    assert!(!buffer.contains("Transcript - live tail"));
    assert!(!buffer.contains("Transcript - scrolled back"));
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
    assert!(
        filtered.contains("/resume <session-id-or-name>"),
        "{filtered}"
    );
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
fn prompt_mouse_click_places_cursor_and_drag_selection_replaces_text() {
    let backend = TestBackend::new(50, 16);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();
    app.handle_event(AppEvent::Text("alpha bravo charlie".to_string()));
    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("editable prompt should render");
    let bravo = find_buffer_cell_text_position(&terminal, "bravo");

    app.handle_event(AppEvent::Mouse(mouse_at(
        MouseEventKind::Down(MouseButton::Left),
        bravo,
    )));
    app.handle_event(AppEvent::Mouse(mouse_at(
        MouseEventKind::Up(MouseButton::Left),
        bravo,
    )));
    app.handle_event(AppEvent::Text("X".to_string()));
    assert_eq!(app.prompt(), "alpha Xbravo charlie");

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("updated prompt should render");
    let alpha = find_buffer_cell_text_position(&terminal, "alpha");
    let xbravo = find_buffer_cell_text_position(&terminal, "Xbravo");
    let selection_end = Position::new(xbravo.x + "Xbravo".len() as u16 - 1, xbravo.y);
    app.handle_event(AppEvent::Mouse(mouse_at(
        MouseEventKind::Down(MouseButton::Left),
        alpha,
    )));
    app.handle_event(AppEvent::Mouse(mouse_at(
        MouseEventKind::Drag(MouseButton::Left),
        selection_end,
    )));
    app.handle_event(AppEvent::Mouse(mouse_at(
        MouseEventKind::Up(MouseButton::Left),
        selection_end,
    )));
    assert_eq!(app.prompt_selection_text().as_deref(), Some("alpha Xbravo"));
    assert_eq!(app.take_clipboard_text().as_deref(), Some("alpha Xbravo"));

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("selected prompt should render");
    assert!(terminal
        .backend()
        .buffer()
        .cell(alpha)
        .expect("selected prompt cell should exist")
        .modifier
        .contains(Modifier::REVERSED));

    app.handle_event(AppEvent::Text("replaced".to_string()));
    assert_eq!(app.prompt(), "replaced charlie");
    assert!(app.prompt_selection_text().is_none());
}

#[test]
fn prompt_selection_supports_copy_cut_and_delete_without_quitting() {
    let backend = TestBackend::new(50, 16);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();
    app.handle_event(AppEvent::Text("keep remove tail".to_string()));
    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("prompt selection shell should render");

    select_buffer_text(&mut app, &terminal, "remove");
    let _ = app.take_clipboard_text();
    app.handle_event(AppEvent::Quit);
    assert!(!app.should_quit());
    assert_eq!(app.take_clipboard_text().as_deref(), Some("remove"));

    app.handle_event(AppEvent::CutPromptSelection);
    assert_eq!(app.prompt(), "keep  tail");
    assert_eq!(app.take_clipboard_text().as_deref(), Some("remove"));

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("prompt should rerender after cut");
    select_buffer_text(&mut app, &terminal, "tail");
    app.handle_event(AppEvent::Backspace);
    assert_eq!(app.prompt(), "keep  ");
}

#[test]
fn prompt_reverse_mouse_selection_edits_unicode_on_char_boundaries() {
    let backend = TestBackend::new(50, 16);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();
    app.handle_event(AppEvent::Text("go 界界 now".to_string()));
    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("Unicode prompt should render");
    let glyphs = find_buffer_symbol_positions(&terminal, "界");
    assert_eq!(glyphs.len(), 2, "{}", terminal_buffer_lines(&terminal));

    app.handle_event(AppEvent::Mouse(mouse_at(
        MouseEventKind::Down(MouseButton::Left),
        glyphs[1],
    )));
    app.handle_event(AppEvent::Mouse(mouse_at(
        MouseEventKind::Drag(MouseButton::Left),
        glyphs[0],
    )));
    app.handle_event(AppEvent::Mouse(mouse_at(
        MouseEventKind::Up(MouseButton::Left),
        glyphs[0],
    )));
    assert_eq!(app.prompt_selection_text().as_deref(), Some("界界"));

    app.handle_event(AppEvent::Text("OK".to_string()));
    assert_eq!(app.prompt(), "go OK now");
}

#[test]
fn prompt_mouse_wheel_scrolls_only_the_prompt_viewport() {
    let backend = TestBackend::new(50, 16);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();
    app.handle_event(AppEvent::Text(
        "one\ntwo\nthree\nfour\nfive\nsix\nseven".to_string(),
    ));
    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("scrollable prompt should render");
    let transcript_scroll = app.transcript_scroll();
    let prompt_scroll = app.prompt_scroll();
    let prompt = find_buffer_text_position(&terminal, "Prompt");

    app.handle_event(AppEvent::Mouse(mouse_at(
        MouseEventKind::ScrollUp,
        Position::new(prompt.x + 3, prompt.y + 1),
    )));

    assert_eq!(app.transcript_scroll(), transcript_scroll);
    assert_eq!(app.prompt_scroll(), prompt_scroll.saturating_sub(1));
}

#[test]
fn transcript_scrollbar_click_and_drag_cover_full_scroll_range() {
    let backend = TestBackend::new(50, 16);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();
    for index in 0..30 {
        app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
            serde_json::json!({
                "type":"log",
                "eventIndex":9_000 + index,
                "text":format!("scrollbar row {index}")
            }),
        )]));
    }
    app.jump_to_tail();
    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("scrollbar shell should render");
    let status_row = find_buffer_row(&terminal, "SIM-ONE Alpha | session:");
    let top = Position::new(49, 1);
    let bottom = Position::new(49, status_row.saturating_sub(2));

    click_mouse(&mut app, top);
    assert_eq!(app.transcript_scroll(), 0);
    assert!(!app.follow_tail());

    app.handle_event(AppEvent::Mouse(mouse_at(
        MouseEventKind::Down(MouseButton::Left),
        top,
    )));
    app.handle_event(AppEvent::Mouse(mouse_at(
        MouseEventKind::Drag(MouseButton::Left),
        bottom,
    )));
    app.handle_event(AppEvent::Mouse(mouse_at(
        MouseEventKind::Up(MouseButton::Left),
        bottom,
    )));
    assert_eq!(app.transcript_scroll(), app.max_scroll());
    assert!(app.follow_tail());
}

#[test]
fn slash_palette_mouse_scroll_click_and_outside_dismiss_are_routed_first() {
    let backend = TestBackend::new(80, 20);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();
    app.handle_event(AppEvent::Text("/".to_string()));
    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("mouse palette should render");
    let first = find_buffer_cell_text_position(&terminal, "/new [title]");

    app.handle_event(AppEvent::Mouse(mouse_at(MouseEventKind::ScrollDown, first)));
    assert_eq!(app.command_palette_selected(), 1);

    let resume = find_buffer_cell_text_position(&terminal, "/resume <session-id-or-name>");
    click_mouse(&mut app, resume);
    assert_eq!(app.prompt(), "/resume ");
    assert!(!app.command_palette_open());

    app.handle_event(AppEvent::ClearPrompt);
    app.handle_event(AppEvent::Text("/".to_string()));
    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("palette should reopen");
    click_mouse(&mut app, Position::new(5, 1));
    assert!(!app.command_palette_open());
}

#[test]
fn renamed_session_title_is_rendered_in_header_without_changing_status_bar() {
    let backend = TestBackend::new(120, 18);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::with_agent_sender(
        "tui-existing-1",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(|_, _, _| {
            Ok(AgentReply {
                text: "Renamed session tui-existing-1 to \"Release Work\".".to_string(),
                submission_id: None,
                stream_offset: None,
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
    assert!(
        frame.starts_with("┌SIM-ONE Alpha - Release Work"),
        "{frame}"
    );
    assert!(frame.contains("session: Release Work"), "{frame}");
    assert!(!frame.contains("Release Work (tui-existing-1)"), "{frame}");
}

#[test]
fn lifecycle_startup_rows_and_resumed_title_are_rendered() {
    let backend = TestBackend::new(120, 24);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut fresh = App::with_agent_sender_and_lifecycle(
        "",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(|_, _, _| {
            Ok(AgentReply {
                text: "Hello Daniel. All systems are go.".to_string(),
                submission_id: None,
                stream_offset: None,
                session_id: Some("tui-fresh-1".to_string()),
                session_title: None,
                command_name: None,
                session_created: Some(false),
            })
        }),
        Arc::new(|_| {
            Ok(SessionLifecycleReply {
                id: "tui-fresh-1".to_string(),
                title: None,
                created: true,
            })
        }),
        Arc::new(|_, _| panic!("fresh startup must not resume")),
    );
    fresh.start_startup_preflight(false);
    wait_for_startup(&mut fresh);

    terminal
        .draw(|frame| render(frame, &mut fresh))
        .expect("fresh lifecycle should render");
    let frame = terminal_buffer_lines(&terminal);
    assert!(
        frame.contains("preflight: created fresh TUI session tui-fresh-1"),
        "{frame}"
    );
    assert!(frame.contains("preflight: all systems go"), "{frame}");
    assert!(frame.contains("assistant: Hello Daniel"), "{frame}");

    let mut resumed = App::with_agent_sender_and_lifecycle(
        "",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(|_, _, _| panic!("explicit resume must not greet")),
        Arc::new(|_| panic!("explicit resume must not create")),
        Arc::new(|_, session_id| {
            assert_eq!(session_id, "tui-existing-1");
            Ok(SessionLifecycleReply {
                id: session_id,
                title: Some("Release Work".to_string()),
                created: false,
            })
        }),
    );
    resumed.start_explicit_resume("tui-existing-1".to_string(), false);
    wait_for_startup(&mut resumed);

    terminal
        .draw(|frame| render(frame, &mut resumed))
        .expect("resumed lifecycle should render");
    let frame = terminal_buffer_lines(&terminal);
    assert!(
        frame.starts_with("┌SIM-ONE Alpha - Release Work"),
        "{frame}"
    );
    assert!(frame.contains("session: Release Work"), "{frame}");
    assert!(
        frame.contains("preflight: resumed TUI session tui-existing-1"),
        "{frame}"
    );
}

#[test]
fn transcript_header_does_not_change_with_scroll_position() {
    let backend = TestBackend::new(80, 16);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::with_session("tui-existing-1", "test gateway", "http://127.0.0.1:3940");
    for index in 0..20 {
        app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
            serde_json::json!({
                "type":"log",
                "eventIndex":900 + index,
                "text":format!("header scroll row {index}")
            }),
        )]));
    }

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("live header should render");
    assert!(
        terminal_buffer_lines(&terminal).starts_with("┌SIM-ONE Alpha"),
        "{}",
        terminal_buffer_lines(&terminal)
    );

    app.scroll_page_up();
    assert!(app.status_text().contains("tail: scrolled"));
    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("scrolled header should render");
    let scrolled = terminal_buffer_lines(&terminal);
    assert!(scrolled.starts_with("┌SIM-ONE Alpha"), "{scrolled}");
    assert!(
        !scrolled.contains("Transcript - scrolled back"),
        "{scrolled}"
    );
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
fn prompt_splits_a_token_that_is_longer_than_the_input_width() {
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
    assert!(buffer.contains("uvwxyz"), "{buffer}");
    assert_eq!(terminal.backend().cursor_position(), Position::new(9, 10));
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
    assert!(app.is_agent_pending());
    assert!(buffer.contains("thinking"), "{buffer}");
    assert!(!buffer.contains("done: first prompt"), "{buffer}");
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
                submission_id: None,
                stream_offset: None,
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
                submission_id: None,
                stream_offset: None,
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
                submission_id: None,
                stream_offset: None,
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
    assert!(!terminal_buffer_lines(&terminal).contains("turn: model active"));
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
                submission_id: None,
                stream_offset: None,
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
                submission_id: None,
                stream_offset: None,
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
                submission_id: None,
                stream_offset: None,
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
fn failed_activity_prefixes_keep_their_labels_and_use_error_color() {
    let backend = TestBackend::new(100, 20);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();
    app.handle_stream_update(AgentStreamUpdate::Events(vec![
        FlueEvent::from_value(serde_json::json!({
            "type":"tool",
            "submissionId":"failed-activity",
            "eventIndex":1,
            "toolCallId":"tool-1",
            "toolName":"formatter",
            "isError":true
        })),
        FlueEvent::from_value(serde_json::json!({
            "type":"task",
            "submissionId":"failed-activity",
            "eventIndex":2,
            "taskId":"task-1",
            "taskName":"reviewer",
            "isError":true
        })),
        FlueEvent::from_value(serde_json::json!({
            "type":"operation",
            "submissionId":"failed-activity",
            "eventIndex":3,
            "operationId":"root",
            "operationKind":"orchestrate",
            "isError":true
        })),
    ]));

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("failed activities should render");

    assert_prefix_style(
        &terminal,
        "tool: formatter failed",
        "tool:",
        Color::LightRed,
    );
    assert_prefix_style(&terminal, "task: reviewer failed", "task:", Color::LightRed);
    assert_prefix_style(
        &terminal,
        "operation: orchestrate failed",
        "operation:",
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
fn transcript_mouse_drag_highlights_and_copies_logical_text_across_wraps() {
    let backend = TestBackend::new(50, 16);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();
    app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
        serde_json::json!({
            "type":"log",
            "eventIndex":450,
            "text":"alpha bravo charlie delta echo foxtrot golf hotel india juliet"
        }),
    )]));

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("selectable transcript should render");
    let start = find_buffer_cell_text_position(&terminal, "alpha");
    let hotel = find_buffer_cell_text_position(&terminal, "hotel");
    let end = Position::new(hotel.x + "hotel".len() as u16 - 1, hotel.y);

    app.handle_event(AppEvent::Mouse(mouse_at(
        MouseEventKind::Down(MouseButton::Left),
        start,
    )));
    app.handle_event(AppEvent::Mouse(mouse_at(
        MouseEventKind::Drag(MouseButton::Left),
        end,
    )));
    app.handle_event(AppEvent::Mouse(mouse_at(
        MouseEventKind::Up(MouseButton::Left),
        end,
    )));

    assert_eq!(
        app.transcript_selection_text().as_deref(),
        Some("alpha bravo charlie delta echo foxtrot golf hotel")
    );
    assert_eq!(
        app.take_clipboard_text().as_deref(),
        Some("alpha bravo charlie delta echo foxtrot golf hotel")
    );

    app.handle_event(AppEvent::Quit);
    assert!(!app.should_quit());
    assert_eq!(
        app.take_clipboard_text().as_deref(),
        Some("alpha bravo charlie delta echo foxtrot golf hotel")
    );

    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("selected transcript should render");
    for position in [start, end] {
        assert!(
            terminal
                .backend()
                .buffer()
                .cell(position)
                .expect("selected cell should exist")
                .modifier
                .contains(Modifier::REVERSED),
            "{}",
            terminal_buffer_lines(&terminal)
        );
    }
}

#[test]
fn transcript_reverse_drag_copies_rendered_markdown_text_without_markers() {
    let backend = TestBackend::new(40, 16);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::with_agent_sender(
        "tui-markdown-selection",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(|_, _, _| {
            Ok(AgentReply {
                text: "Use **bold words** and `code sample` for this test.".to_string(),
                submission_id: None,
                stream_offset: None,
                session_id: None,
                session_title: None,
                command_name: None,
                session_created: None,
            })
        }),
    );
    app.handle_event(AppEvent::Text("render markdown".to_string()));
    app.handle_event(AppEvent::Submit);
    wait_for_agent(&mut app);
    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("markdown transcript should render");
    let bold = find_buffer_cell_text_position(&terminal, "bold");
    let sample = find_buffer_cell_text_position(&terminal, "sample");
    let sample_end = Position::new(sample.x + "sample".len() as u16 - 1, sample.y);

    app.handle_event(AppEvent::Mouse(mouse_at(
        MouseEventKind::Down(MouseButton::Left),
        sample_end,
    )));
    app.handle_event(AppEvent::Mouse(mouse_at(
        MouseEventKind::Drag(MouseButton::Left),
        bold,
    )));
    app.handle_event(AppEvent::Mouse(mouse_at(
        MouseEventKind::Up(MouseButton::Left),
        bold,
    )));

    assert_eq!(
        app.take_clipboard_text().as_deref(),
        Some("bold words and code sample")
    );
}

#[test]
fn mouse_wheel_routes_by_pane_without_changing_keyboard_scroll_behavior() {
    let backend = TestBackend::new(50, 16);
    let mut terminal = Terminal::new(backend).expect("test backend should initialize");
    let mut app = App::new_for_test();
    for index in 0..30 {
        app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
            serde_json::json!({
                "type":"log",
                "eventIndex":500 + index,
                "text":format!("mouse routing row {index}")
            }),
        )]));
    }
    app.jump_to_tail();
    terminal
        .draw(|frame| render(frame, &mut app))
        .expect("pane routing shell should render");

    let tail = app.transcript_scroll();
    let prompt_title = find_buffer_text_position(&terminal, "Prompt");
    app.handle_event(AppEvent::Mouse(mouse_at(
        MouseEventKind::ScrollUp,
        Position::new(prompt_title.x + 2, prompt_title.y + 1),
    )));
    assert_eq!(app.transcript_scroll(), tail);

    app.handle_event(AppEvent::Mouse(mouse_at(
        MouseEventKind::ScrollUp,
        Position::new(10, 2),
    )));
    assert_eq!(app.transcript_scroll(), tail.saturating_sub(1));

    app.handle_event(AppEvent::ScrollLineDown);
    assert_eq!(app.transcript_scroll(), tail);
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
            60,
            18,
            "line one of a draft\nline two of a draft\nline three of a draft",
        ),
        (
            100,
            30,
            "line one of a draft\nline two of a draft\nline three of a draft\nline four of a draft\nline five of a draft",
        ),
        (
            140,
            40,
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
                    submission_id: None,
                    stream_offset: None,
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
        let final_row = find_buffer_row(&terminal, "TAIL_OK");
        let prompt_row = find_buffer_row(&terminal, "Prompt");
        assert!(
            final_row + 1 < prompt_row,
            "final response overlaps the transcript margin or prompt at {width}x{height}:\n{frame}"
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
                submission_id: None,
                stream_offset: None,
                session_id: None,
                session_title: None,
                command_name: None,
                session_created: None,
            })
        }),
    )
}

fn mouse_at(kind: MouseEventKind, position: Position) -> MouseEvent {
    MouseEvent {
        kind,
        column: position.x,
        row: position.y,
        modifiers: KeyModifiers::NONE,
    }
}

fn click_mouse(app: &mut App, position: Position) {
    app.handle_event(AppEvent::Mouse(mouse_at(
        MouseEventKind::Down(MouseButton::Left),
        position,
    )));
    app.handle_event(AppEvent::Mouse(mouse_at(
        MouseEventKind::Up(MouseButton::Left),
        position,
    )));
}

fn select_buffer_text(app: &mut App, terminal: &Terminal<TestBackend>, text: &str) {
    let start = find_buffer_cell_text_position(terminal, text);
    let end = Position::new(start.x + text.len() as u16 - 1, start.y);
    app.handle_event(AppEvent::Mouse(mouse_at(
        MouseEventKind::Down(MouseButton::Left),
        start,
    )));
    app.handle_event(AppEvent::Mouse(mouse_at(
        MouseEventKind::Drag(MouseButton::Left),
        end,
    )));
    app.handle_event(AppEvent::Mouse(mouse_at(
        MouseEventKind::Up(MouseButton::Left),
        end,
    )));
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

fn wait_for_startup(app: &mut App) {
    let deadline = Instant::now() + Duration::from_secs(1);
    while (!app.startup_complete() || app.is_agent_pending()) && Instant::now() < deadline {
        app.tick();
        app.poll_agent();
        thread::sleep(Duration::from_millis(1));
    }
    app.poll_agent();
    assert!(app.startup_succeeded(), "startup lifecycle should succeed");
    assert!(!app.is_agent_pending(), "startup lifecycle should settle");
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

fn find_buffer_cell_text_position(terminal: &Terminal<TestBackend>, needle: &str) -> Position {
    let buffer = terminal.backend().buffer();
    for y in 0..buffer.area.height {
        for x in 0..buffer.area.width {
            let suffix = (x..buffer.area.width)
                .filter_map(|column| buffer.cell(Position::new(column, y)))
                .map(|cell| cell.symbol())
                .collect::<String>();
            if suffix.starts_with(needle) {
                return Position::new(x, y);
            }
        }
    }
    panic!(
        "could not find {needle:?} in:\n{}",
        terminal_buffer_lines(terminal)
    );
}

fn find_buffer_symbol_positions(terminal: &Terminal<TestBackend>, symbol: &str) -> Vec<Position> {
    let buffer = terminal.backend().buffer();
    let mut positions = Vec::new();
    for y in 0..buffer.area.height {
        for x in 0..buffer.area.width {
            if buffer
                .cell(Position::new(x, y))
                .is_some_and(|cell| cell.symbol() == symbol)
            {
                positions.push(Position::new(x, y));
            }
        }
    }
    positions
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
