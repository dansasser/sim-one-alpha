use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use sim_one_ratatui_tui::agent::{AgentReply, SessionSummary};
use sim_one_ratatui_tui::app::{App, AppEvent, Clock, SCROLL_PAGE_LINES};
use sim_one_ratatui_tui::flue::events::{FlueEvent, StreamControl};
use sim_one_ratatui_tui::flue::stream::AgentStreamUpdate;

#[test]
fn typing_updates_prompt_without_changing_transcript_scroll() {
    let mut app = App::new_for_test();
    app.scroll_page_up();
    let before_scroll = app.transcript_scroll();

    app.handle_event(AppEvent::Text("hello".to_string()));
    app.handle_event(AppEvent::Text(" world".to_string()));

    assert_eq!(app.prompt(), "hello world");
    assert_eq!(app.transcript_scroll(), before_scroll);
    assert!(!app.should_quit());
}

#[test]
fn enter_submits_prompt_to_agent_and_returns_to_tail() {
    let mut app = App::with_agent_sender(
        "primary",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(|_, session, prompt| {
            Ok(agent_reply(format!("session={session}; prompt={prompt}")))
        }),
    );
    app.handle_event(AppEvent::Text("ship the tui".to_string()));
    app.scroll_page_up();

    app.handle_event(AppEvent::Submit);
    wait_for_agent(&mut app);

    assert_eq!(app.prompt(), "");
    assert!(app
        .transcript_lines()
        .iter()
        .any(|line| line.contains("you: ship the tui")));
    assert!(app
        .transcript_lines()
        .iter()
        .any(|line| line.contains("assistant: session=primary; prompt=ship the tui")));
    assert!(app.follow_tail());
    assert_eq!(app.transcript_scroll(), app.max_scroll());
    assert_eq!(app.agent_status(), "ready");
    assert!(!app.is_agent_pending());
}

#[test]
fn pending_turn_starts_with_spinner_elapsed_and_status() {
    let clock = TestClock::new();
    let (mut app, release, calls) = app_with_blocked_sender(&clock);

    app.handle_event(AppEvent::Text("slow work".to_string()));
    app.handle_event(AppEvent::Submit);
    wait_for_calls(&calls, 1);

    assert!(app.is_agent_pending());
    assert_eq!(app.agent_status(), "thinking");
    assert!(app
        .transcript_lines()
        .iter()
        .any(|line| line.contains("assistant: | thinking 00:00 / waiting")));
    let status = app.status_text();
    assert!(status.contains("agent: thinking |"), "{status}");
    assert!(status.contains("turn: 00:00"), "{status}");
    assert!(status.contains("stream: not attached"), "{status}");

    release.send(()).expect("pending sender should release");
    wait_for_agent(&mut app);
}

#[test]
fn pending_tick_advances_spinner_and_elapsed_time() {
    let clock = TestClock::new();
    let (mut app, release, calls) = app_with_blocked_sender(&clock);

    app.handle_event(AppEvent::Text("slow work".to_string()));
    app.handle_event(AppEvent::Submit);
    wait_for_calls(&calls, 1);
    clock.advance(Duration::from_secs(1));
    app.tick();

    assert!(app
        .transcript_lines()
        .iter()
        .any(|line| line.contains("assistant: / thinking 00:01 / waiting")));
    assert!(app.status_text().contains("turn: 00:01"));

    release.send(()).expect("pending sender should release");
    wait_for_agent(&mut app);
}

#[test]
fn duplicate_submit_while_pending_is_visible_and_does_not_enqueue_again() {
    let clock = TestClock::new();
    let (mut app, release, calls) = app_with_blocked_sender(&clock);

    app.handle_event(AppEvent::Text("slow work".to_string()));
    app.handle_event(AppEvent::Submit);
    wait_for_calls(&calls, 1);
    app.handle_event(AppEvent::Submit);

    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(
        app.status_text().contains("input locked"),
        "{}",
        app.status_text()
    );
    assert!(app
        .transcript_lines()
        .iter()
        .any(|line| line.contains("input locked until this response finishes")));

    release.send(()).expect("pending sender should release");
    wait_for_agent(&mut app);
}

#[test]
fn failed_response_settles_pending_state_and_renders_error() {
    let mut app = App::with_agent_sender(
        "primary",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(|_, _, _| Err("synthetic failure".to_string())),
    );

    app.handle_event(AppEvent::Text("fail please".to_string()));
    app.handle_event(AppEvent::Submit);
    wait_for_agent(&mut app);

    assert_eq!(app.agent_status(), "ready");
    assert!(!app.is_agent_pending());
    assert!(app
        .transcript_lines()
        .iter()
        .any(|line| line.contains("error: synthetic failure")));
}

#[test]
fn stream_updates_change_status_without_touching_prompt() {
    let mut app = App::new_for_test();
    app.handle_event(AppEvent::Text("keep this prompt".to_string()));

    app.handle_stream_update(AgentStreamUpdate::Connecting);
    assert_eq!(app.stream_status(), "connecting");
    assert_eq!(app.prompt(), "keep this prompt");

    app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
        serde_json::json!({"type":"thinking_delta","eventIndex":3}),
    )]));
    assert_eq!(app.stream_status(), "live");
    assert_eq!(app.last_stream_event(), Some("thinking_delta"));
    assert!(app.status_text().contains("last: thinking_delta"));

    app.handle_stream_update(AgentStreamUpdate::Control(StreamControl {
        up_to_date: true,
        ..StreamControl::default()
    }));
    assert_eq!(app.stream_status(), "idle");
    assert_eq!(app.prompt(), "keep this prompt");
}

#[test]
fn stream_reconnect_and_failure_are_visible_in_status() {
    let mut app = App::new_for_test();

    app.handle_stream_update(AgentStreamUpdate::Reconnecting(
        "temporary outage".to_string(),
    ));
    assert_eq!(app.stream_status(), "reconnecting");
    assert!(app.status_text().contains("temporary outage"));

    app.handle_stream_update(AgentStreamUpdate::Failed("permanent failure".to_string()));
    assert_eq!(app.stream_status(), "failed");
    assert!(app.status_text().contains("permanent failure"));
}

#[test]
fn stream_activity_rows_are_synced_into_transcript() {
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

    assert!(app
        .transcript_lines()
        .iter()
        .any(|line| line == "thinking: checking protocol"));
    assert!(app
        .transcript_lines()
        .iter()
        .any(|line| line == "tool: list_capabilities running"));
}

#[test]
fn stream_activity_updates_do_not_snap_when_scrolled_back() {
    let mut app = App::new_for_test();
    app.jump_to_tail();
    app.scroll_page_up();
    let before_scroll = app.transcript_scroll();

    app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
        serde_json::json!({
            "type":"thinking_delta",
            "eventIndex":10,
            "text":"checking protocol"
        }),
    )]));

    assert_eq!(app.transcript_scroll(), before_scroll);
    assert!(!app.follow_tail());
}

#[test]
fn stream_activity_updates_follow_tail_when_at_bottom() {
    let mut app = App::new_for_test();
    app.jump_to_tail();

    app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
        serde_json::json!({
            "type":"thinking_delta",
            "eventIndex":10,
            "text":"checking protocol"
        }),
    )]));

    assert!(app.follow_tail());
    assert_eq!(app.transcript_scroll(), app.max_scroll());
}

#[test]
fn multiline_agent_response_reindexes_stream_activity_rows() {
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = Arc::new(Mutex::new(release_rx));
    let sender_release_rx = Arc::clone(&release_rx);
    let mut app = App::with_agent_sender(
        "primary",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(move |_, _, _| {
            sender_release_rx
                .lock()
                .expect("release receiver should lock")
                .recv_timeout(Duration::from_secs(5))
                .expect("test should release blocked sender");
            Ok(agent_reply("first line\nsecond line\nthird line"))
        }),
    );

    app.handle_event(AppEvent::Text("multiline".to_string()));
    app.handle_event(AppEvent::Submit);
    app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
        serde_json::json!({"type":"turn_start","eventIndex":20}),
    )]));
    release_tx.send(()).expect("pending sender should release");
    wait_for_agent(&mut app);

    assert!(app
        .transcript_lines()
        .iter()
        .any(|line| line == "assistant: first line"));
    assert!(app
        .transcript_lines()
        .iter()
        .any(|line| line == "  second line"));

    app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
        serde_json::json!({"type":"turn","eventIndex":21}),
    )]));

    assert!(app
        .transcript_lines()
        .iter()
        .any(|line| line == "  second line"));
    assert!(app
        .transcript_lines()
        .iter()
        .any(|line| line == "turn: completed"));
}

#[test]
fn second_turn_start_does_not_rewrite_previous_ephemeral_rows() {
    let mut app = App::new_for_test();

    app.handle_stream_update(AgentStreamUpdate::Events(vec![
        FlueEvent::from_value(serde_json::json!({
            "type":"turn_start",
            "eventIndex":1,
            "timestamp":"2026-07-03T00:00:00Z"
        })),
        FlueEvent::from_value(serde_json::json!({
            "type":"thinking_delta",
            "eventIndex":2,
            "timestamp":"2026-07-03T00:00:01Z",
            "text":"first"
        })),
        FlueEvent::from_value(serde_json::json!({
            "type":"turn",
            "eventIndex":3,
            "timestamp":"2026-07-03T00:00:02Z"
        })),
    ]));

    let first_turn_line = app
        .transcript_lines()
        .iter()
        .position(|line| line == "turn: completed")
        .expect("first turn should render as completed");
    let first_stream_line = app
        .transcript_lines()
        .iter()
        .position(|line| line == "thinking: first")
        .expect("first thinking activity should render");

    app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
        serde_json::json!({
            "type":"turn_start",
            "eventIndex":1,
            "timestamp":"2026-07-03T00:01:00Z"
        }),
    )]));

    let lines = app.transcript_lines();
    assert_eq!(lines[first_turn_line], "turn: completed");
    assert_eq!(lines[first_stream_line], "thinking: first");
    assert_eq!(
        lines
            .iter()
            .filter(|line| line.as_str() == "thinking: first")
            .count(),
        1
    );
    assert!(lines
        .iter()
        .skip(first_stream_line + 1)
        .any(|line| line == "turn: model active"));
}

#[test]
fn max_scroll_uses_rendered_viewport_height() {
    let mut app = App::new_for_test();

    app.set_transcript_viewport_height(20);
    app.jump_to_tail();
    assert_eq!(
        app.max_scroll(),
        app.transcript_lines().len().saturating_sub(20)
    );
    assert_eq!(app.transcript_scroll(), app.max_scroll());

    app.set_transcript_viewport_height(5);
    assert_eq!(
        app.max_scroll(),
        app.transcript_lines().len().saturating_sub(5)
    );
    assert_eq!(app.transcript_scroll(), app.max_scroll());
}

#[test]
fn prompt_cursor_allows_insertion_navigation_and_word_delete() {
    let mut app = App::new_for_test();

    app.handle_event(AppEvent::Text("hello wrld".to_string()));
    app.handle_event(AppEvent::MovePromptLeft);
    app.handle_event(AppEvent::MovePromptLeft);
    app.handle_event(AppEvent::MovePromptLeft);
    app.handle_event(AppEvent::Text("o".to_string()));

    assert_eq!(app.prompt(), "hello world");
    assert_eq!(app.prompt_cursor_chars(), 8);

    app.handle_event(AppEvent::MovePromptWordLeft);
    assert_eq!(app.prompt_cursor_chars(), 6);

    app.handle_event(AppEvent::DeletePromptWordLeft);
    assert_eq!(app.prompt(), "world");
    assert_eq!(app.prompt_cursor(), 0);

    app.handle_event(AppEvent::MovePromptEnd);
    app.handle_event(AppEvent::Backspace);
    assert_eq!(app.prompt(), "worl");
}

#[test]
fn transcript_scroll_controls_are_bounded_and_independent_from_prompt() {
    let mut app = App::new_for_test();
    app.handle_event(AppEvent::Text("still typing".to_string()));

    app.jump_to_tail();
    let tail = app.transcript_scroll();
    app.scroll_page_up();

    assert_eq!(app.prompt(), "still typing");
    assert_eq!(
        app.transcript_scroll(),
        tail.saturating_sub(SCROLL_PAGE_LINES)
    );
    assert!(!app.follow_tail());

    for _ in 0..100 {
        app.scroll_page_up();
    }
    assert_eq!(app.transcript_scroll(), 0);

    for _ in 0..100 {
        app.scroll_page_down();
    }
    assert_eq!(app.transcript_scroll(), app.max_scroll());
    assert!(app.follow_tail());
}

#[test]
fn ctrl_c_marks_app_for_clean_exit() {
    let mut app = App::new_for_test();

    app.handle_event(AppEvent::Quit);

    assert!(app.should_quit());
}

#[test]
fn slash_exit_marks_app_for_clean_exit_and_preserves_session_id() {
    let mut app = App::new_for_test();

    app.handle_event(AppEvent::Text("/exit".to_string()));
    app.handle_event(AppEvent::Submit);

    assert!(app.should_quit());
    assert_eq!(app.prompt(), "");
    assert_eq!(app.exit_session_id(), Some("primary"));
}

#[test]
fn slash_session_renders_current_session_without_calling_agent() {
    let calls = Arc::new(AtomicUsize::new(0));
    let sender_calls = Arc::clone(&calls);
    let mut app = App::with_agent_sender(
        "primary",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(move |_, _, _| {
            sender_calls.fetch_add(1, Ordering::SeqCst);
            Ok(agent_reply("should not call"))
        }),
    );

    app.handle_event(AppEvent::Text("/session".to_string()));
    app.handle_event(AppEvent::Submit);

    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(app.prompt(), "");
    assert!(app
        .transcript_lines()
        .iter()
        .any(|line| line == "system: current session primary"));
}

#[test]
fn slash_help_renders_command_reference_without_calling_agent() {
    let calls = Arc::new(AtomicUsize::new(0));
    let sender_calls = Arc::clone(&calls);
    let mut app = App::with_agent_sender(
        "primary",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(move |_, _, _| {
            sender_calls.fetch_add(1, Ordering::SeqCst);
            Ok(agent_reply("should not call"))
        }),
    );

    app.handle_event(AppEvent::Text("/help".to_string()));
    app.handle_event(AppEvent::Submit);

    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let help = app.transcript_lines().join("\n");
    for command in [
        "/new",
        "/resume",
        "/sessions",
        "/session",
        "/rename",
        "/compact",
        "/help",
        "/exit",
    ] {
        assert!(help.contains(command), "help should mention {command}");
    }
}

#[test]
fn slash_sessions_lists_recent_sessions_without_calling_agent() {
    let calls = Arc::new(AtomicUsize::new(0));
    let sender_calls = Arc::clone(&calls);
    let mut app = App::with_agent_sender_and_session_lister(
        "primary",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(move |_, _, _| {
            sender_calls.fetch_add(1, Ordering::SeqCst);
            Ok(agent_reply("should not call"))
        }),
        Arc::new(|_, limit| {
            assert_eq!(limit, 10);
            Ok(vec![SessionSummary {
                id: "tui-abc123".to_string(),
                origin: "tui".to_string(),
                title: Some("Release polish".to_string()),
                updated_at: "2026-07-06T21:00:00.000Z".to_string(),
            }])
        }),
    );

    app.handle_event(AppEvent::Text("/sessions".to_string()));
    app.handle_event(AppEvent::Submit);

    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(app
        .transcript_lines()
        .iter()
        .any(|line| line == "system: recent sessions"));
    assert!(app.transcript_lines().iter().any(|line| {
        line == "system: tui-abc123 | tui | Release polish | 2026-07-06T21:00:00.000Z"
    }));
}

#[test]
fn command_response_switches_active_session_and_announces_it() {
    let mut app = App::with_agent_sender(
        "primary",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(|_, _, _| {
            Ok(AgentReply {
                text: "Started new session tui-new-1.".to_string(),
                session_id: Some("tui-new-1".to_string()),
                command_name: Some("new".to_string()),
            })
        }),
    );

    app.handle_event(AppEvent::Text("/new Demo".to_string()));
    app.handle_event(AppEvent::Submit);
    wait_for_agent(&mut app);

    assert_eq!(app.session_id(), "tui-new-1");
    assert!(app
        .transcript_lines()
        .iter()
        .any(|line| line == "system: active session tui-new-1"));
}

fn wait_for_agent(app: &mut App) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while app.is_agent_pending() && Instant::now() < deadline {
        app.poll_agent();
        thread::sleep(Duration::from_millis(10));
    }
    app.poll_agent();
    assert!(!app.is_agent_pending(), "agent response did not settle");
}

fn agent_reply(text: impl Into<String>) -> AgentReply {
    AgentReply {
        text: text.into(),
        session_id: None,
        command_name: None,
    }
}

fn wait_for_calls(calls: &AtomicUsize, expected: usize) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while calls.load(Ordering::SeqCst) < expected && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(calls.load(Ordering::SeqCst), expected);
}

fn app_with_blocked_sender(clock: &TestClock) -> (App, mpsc::Sender<()>, Arc<AtomicUsize>) {
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = Arc::new(Mutex::new(release_rx));
    let calls = Arc::new(AtomicUsize::new(0));
    let sender_calls = Arc::clone(&calls);
    let sender_release_rx = Arc::clone(&release_rx);
    let app = App::with_agent_sender_and_clock(
        "primary",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(move |_, _, prompt| {
            sender_calls.fetch_add(1, Ordering::SeqCst);
            sender_release_rx
                .lock()
                .expect("release receiver should lock")
                .recv_timeout(Duration::from_secs(5))
                .expect("test should release blocked sender");
            Ok(agent_reply(format!("done: {prompt}")))
        }),
        Arc::new(|_, _| Ok(Vec::new())),
        clock.clock(),
    );

    (app, release_tx, calls)
}

#[derive(Clone)]
struct TestClock {
    now: Arc<Mutex<Instant>>,
}

impl TestClock {
    fn new() -> Self {
        Self {
            now: Arc::new(Mutex::new(Instant::now())),
        }
    }

    fn advance(&self, duration: Duration) {
        let mut now = self.now.lock().expect("test clock should lock");
        *now += duration;
    }

    fn clock(&self) -> Clock {
        let now = Arc::clone(&self.now);
        Arc::new(move || *now.lock().expect("test clock should lock"))
    }
}
