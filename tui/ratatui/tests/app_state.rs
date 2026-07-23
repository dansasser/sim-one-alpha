use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crossterm::event::{KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::layout::Rect;
use sim_one_ratatui_tui::agent::{
    AgentPromptOrigin, AgentReply, SessionLifecycleReply, SessionSummary,
};
use sim_one_ratatui_tui::app::{App, AppEvent, Clock, MouseRegions, SCROLL_PAGE_LINES};
use sim_one_ratatui_tui::flue::events::{FlueEvent, StreamControl};
use sim_one_ratatui_tui::flue::stream::AgentStreamUpdate;
use sim_one_ratatui_tui::history::{
    TranscriptActivity, TranscriptActivityKind, TranscriptActivityStatus,
    TranscriptAssistantMessage, TranscriptExchange, TranscriptPage, TranscriptPageInfo,
    TranscriptPrompt, TranscriptPromptVisibility, TranscriptSession, TranscriptStreamCursor,
};

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
fn transcript_drag_at_viewport_edge_autoscrolls_without_losing_selection() {
    let mut app = App::new_for_test();
    for index in 0..20 {
        app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
            serde_json::json!({
                "type":"log",
                "eventIndex":8_000 + index,
                "text":format!("selection history row {index}")
            }),
        )]));
    }
    app.set_transcript_viewport_size(3, 24);
    app.set_mouse_regions(MouseRegions {
        transcript_text: Some(Rect::new(4, 10, 24, 3)),
        ..MouseRegions::default()
    });
    app.jump_to_tail();
    app.scroll_page_up();
    let before_drag = app.transcript_scroll();

    app.handle_event(AppEvent::Mouse(MouseEvent {
        kind: MouseEventKind::Down(MouseButton::Left),
        column: 8,
        row: 11,
        modifiers: KeyModifiers::NONE,
    }));
    app.handle_event(AppEvent::Mouse(MouseEvent {
        kind: MouseEventKind::Drag(MouseButton::Left),
        column: 8,
        row: 10,
        modifiers: KeyModifiers::NONE,
    }));

    assert_eq!(app.transcript_scroll(), before_drag.saturating_sub(1));
    assert!(app.transcript_selection_text().is_some());
}

#[test]
fn enter_submits_prompt_to_agent_and_returns_to_tail() {
    let mut app = App::with_agent_sender(
        "tui-existing-1",
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
        .any(|line| line.contains("assistant: session=tui-existing-1; prompt=ship the tui")));
    assert!(app.follow_tail());
    assert_eq!(app.transcript_scroll(), app.max_scroll());
    assert_eq!(app.agent_status(), "ready");
    assert!(!app.is_agent_pending());
}

#[test]
fn assistant_markdown_is_preserved_canonically_but_rendered_without_inline_markers() {
    let mut app = App::with_agent_sender(
        "tui-markdown-render",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(|_, _, _| {
            Ok(agent_reply(
                "Use **bold text**, *italic text*, `inline code`, and [the docs](https://example.com).",
            ))
        }),
    );

    app.handle_event(AppEvent::Text("show markdown".to_string()));
    app.handle_event(AppEvent::Submit);
    wait_for_agent(&mut app);

    let canonical = app.transcript_lines().join("\n");
    assert!(canonical.contains("**bold text**"), "{canonical}");
    assert!(canonical.contains("`inline code`"), "{canonical}");

    let rendered = app.transcript_rendered_lines().join("\n");
    assert!(rendered.contains("bold text"), "{rendered}");
    assert!(rendered.contains("italic text"), "{rendered}");
    assert!(rendered.contains("inline code"), "{rendered}");
    assert!(!rendered.contains("**"), "{rendered}");
    assert!(!rendered.contains('`'), "{rendered}");
    assert!(!rendered.contains("[the docs]"), "{rendered}");
}

#[test]
fn first_submit_keeps_new_pending_response_at_visible_tail() {
    let clock = TestClock::new();
    let (mut app, release, calls) = app_with_blocked_sender(&clock);
    app.set_transcript_viewport_size(2, 80);
    app.jump_to_tail();

    app.handle_event(AppEvent::Text("first prompt".to_string()));
    app.handle_event(AppEvent::Submit);
    wait_for_calls(&calls, 1);

    assert!(app.follow_tail());
    assert_eq!(app.transcript_scroll(), app.max_scroll());

    release.send(()).expect("pending sender should release");
    wait_for_agent(&mut app);
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
fn final_agent_response_moves_below_stream_activity_rows() {
    let clock = TestClock::new();
    let (mut app, release, calls) = app_with_blocked_sender(&clock);

    app.handle_event(AppEvent::Text("order the transcript".to_string()));
    app.handle_event(AppEvent::Submit);
    wait_for_calls(&calls, 1);

    app.handle_stream_update(AgentStreamUpdate::Events(vec![
        FlueEvent::from_value(serde_json::json!({
            "type":"thinking_delta",
            "eventIndex":10,
            "text":"checking protocol"
        })),
        FlueEvent::from_value(serde_json::json!({
            "type":"tool",
            "eventIndex":11,
            "toolCallId":"cap",
            "toolName":"activate_skill"
        })),
    ]));

    release.send(()).expect("pending sender should release");
    wait_for_agent(&mut app);

    let lines = app.transcript_lines();
    let final_line = lines
        .iter()
        .position(|line| line == "assistant: done: order the transcript")
        .expect("final assistant response should render");
    let thinking_line = lines
        .iter()
        .position(|line| line == "thinking: checking protocol")
        .expect("thinking row should render");
    let tool_line = lines
        .iter()
        .position(|line| line == "tool: activate_skill completed")
        .expect("tool row should render");

    assert!(thinking_line < final_line, "{lines:?}");
    assert!(tool_line < final_line, "{lines:?}");
    assert_eq!(
        lines.last().map(String::as_str),
        Some("assistant: done: order the transcript")
    );

    app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
        serde_json::json!({
            "type":"operation",
            "eventIndex":12,
            "name":"operation"
        }),
    )]));

    let lines = app.transcript_lines();
    let final_line = lines
        .iter()
        .position(|line| line == "assistant: done: order the transcript")
        .expect("final assistant response should still render");
    let operation_line = lines
        .iter()
        .position(|line| line == "operation: operation completed")
        .expect("later operation row should render");
    assert!(operation_line < final_line, "{lines:?}");
    assert_eq!(
        lines.last().map(String::as_str),
        Some("assistant: done: order the transcript")
    );
}

#[test]
fn streamed_final_response_reconciles_in_place_after_late_activity() {
    let clock = TestClock::new();
    let (mut app, release, calls) = app_with_blocked_sender(&clock);

    app.handle_event(AppEvent::Text("keep one final row".to_string()));
    app.handle_event(AppEvent::Submit);
    wait_for_calls(&calls, 1);
    app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
        serde_json::json!({
            "type":"message_end",
            "eventIndex":20,
            "message":{"role":"assistant","content":"streamed final answer"}
        }),
    )]));

    assert!(app.is_agent_pending());
    assert_eq!(
        app.transcript_lines().last().map(String::as_str),
        Some("assistant: streamed final answer")
    );

    app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
        serde_json::json!({
            "type":"operation",
            "eventIndex":21,
            "name":"operation",
            "isError":false
        }),
    )]));
    let lines = app.transcript_lines();
    let operation_line = lines
        .iter()
        .position(|line| line == "operation: operation completed")
        .expect("late operation should render");
    let streamed_final_line = lines
        .iter()
        .position(|line| line == "assistant: streamed final answer")
        .expect("streamed final should remain rendered");
    assert!(operation_line < streamed_final_line, "{lines:?}");

    release.send(()).expect("pending sender should release");
    wait_for_agent(&mut app);

    let lines = app.transcript_lines();
    assert_eq!(
        lines
            .iter()
            .filter(|line| line.starts_with("assistant: "))
            .count(),
        1,
        "{lines:?}"
    );
    assert_eq!(
        lines.last().map(String::as_str),
        Some("assistant: done: keep one final row")
    );
    assert!(!lines
        .iter()
        .any(|line| line.contains("streamed final answer")));
}

#[test]
fn multiline_stream_final_and_http_result_consolidate_without_orphaned_lines() {
    let answer = "Good catch - the researcher reports to me.\n\nA bit more detail follows.\n\nSo: I shape the result for you.";
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = Arc::new(Mutex::new(release_rx));
    let sender_release_rx = Arc::clone(&release_rx);
    let sender_answer = answer.to_string();
    let mut app = App::with_agent_sender(
        "tui-multiline-consolidation",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(move |_, _, _| {
            sender_release_rx
                .lock()
                .expect("release receiver should lock")
                .recv_timeout(Duration::from_secs(5))
                .expect("test should release blocked sender");
            Ok(agent_reply(sender_answer.clone()))
        }),
    );

    app.handle_event(AppEvent::Text("explain the research handoff".to_string()));
    app.handle_event(AppEvent::Submit);
    app.handle_stream_update(AgentStreamUpdate::Events(vec![
        FlueEvent::from_value(serde_json::json!({
            "type":"message_end",
            "eventIndex":21,
            "message":{"role":"assistant","content":[{"type":"text","text":answer}]}
        })),
        FlueEvent::from_value(serde_json::json!({
            "type":"turn",
            "eventIndex":23,
            "isError":false
        })),
        FlueEvent::from_value(serde_json::json!({
            "type":"operation",
            "eventIndex":25,
            "name":"operation",
            "isError":false
        })),
    ]));
    app.tick();
    release_tx.send(()).expect("pending sender should release");
    wait_for_agent(&mut app);

    let lines = app.transcript_lines();
    assert_eq!(
        lines
            .iter()
            .filter(|line| {
                line.as_str() == "assistant: Good catch - the researcher reports to me."
            })
            .count(),
        1,
        "{lines:?}"
    );
    assert_eq!(
        lines
            .iter()
            .filter(|line| line.as_str() == "  A bit more detail follows.")
            .count(),
        1,
        "{lines:?}"
    );
    assert_eq!(
        lines
            .iter()
            .filter(|line| line.as_str() == "  So: I shape the result for you.")
            .count(),
        1,
        "{lines:?}"
    );
    assert!(!lines
        .iter()
        .any(|line| line.contains("waiting for final response")));
}

#[test]
fn root_assistant_stream_reuses_one_block_and_nested_worker_output_stays_internal() {
    let final_answer = "Root answer complete.";
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = Arc::new(Mutex::new(release_rx));
    let sender_release_rx = Arc::clone(&release_rx);
    let mut app = App::with_agent_sender(
        "tui-root-stream",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(move |_, _, _| {
            sender_release_rx
                .lock()
                .expect("release receiver should lock")
                .recv_timeout(Duration::from_secs(5))
                .expect("test should release blocked sender");
            Ok(agent_reply(final_answer))
        }),
    );

    app.handle_event(AppEvent::Text("delegate and answer".to_string()));
    app.handle_event(AppEvent::Submit);
    app.handle_stream_update(AgentStreamUpdate::Events(vec![
        FlueEvent::from_value(serde_json::json!({
            "type":"text_delta",
            "eventIndex":50,
            "timestamp":"2026-07-11T18:35:00Z",
            "session":"task:default:worker-1",
            "parentSession":"default",
            "text":"CHILD_RAW_OUTPUT"
        })),
        FlueEvent::from_value(serde_json::json!({
            "type":"message_end",
            "eventIndex":51,
            "timestamp":"2026-07-11T18:35:01Z",
            "session":"task:default:worker-1",
            "parentSession":"default",
            "message":{"role":"assistant","content":[{"type":"text","text":"CHILD_FINAL_OUTPUT"}]}
        })),
    ]));
    let nested_output_visible = app
        .transcript_lines()
        .iter()
        .any(|line| line.contains("CHILD_RAW_OUTPUT") || line.contains("CHILD_FINAL_OUTPUT"));

    app.handle_stream_update(AgentStreamUpdate::Events(vec![
        FlueEvent::from_value(serde_json::json!({
            "type":"text_delta",
            "eventIndex":5,
            "timestamp":"2026-07-11T18:37:02Z",
            "session":"default",
            "text":"Root answer "
        })),
        FlueEvent::from_value(serde_json::json!({
            "type":"text_delta",
            "eventIndex":6,
            "timestamp":"2026-07-11T18:37:03Z",
            "session":"default",
            "text":"streaming."
        })),
    ]));
    let live_root_count = app
        .transcript_lines()
        .iter()
        .filter(|line| line.as_str() == "assistant: Root answer streaming.")
        .count();

    app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
        serde_json::json!({
            "type":"message_end",
            "eventIndex":21,
            "timestamp":"2026-07-11T18:37:09Z",
            "session":"default",
            "message":{"role":"assistant","content":[{"type":"text","text":final_answer}]}
        }),
    )]));
    assert_eq!(
        app.transcript_lines()
            .iter()
            .filter(|line| line.as_str() == "assistant: Root answer complete.")
            .count(),
        1,
        "{:?}",
        app.transcript_lines()
    );
    assert!(!app
        .transcript_lines()
        .iter()
        .any(|line| line.contains("Root answer streaming.")));

    release_tx.send(()).expect("pending sender should release");
    wait_for_agent(&mut app);
    assert!(
        !nested_output_visible,
        "nested worker output reached the chat"
    );
    assert_eq!(live_root_count, 1, "{:?}", app.transcript_lines());
    assert_eq!(
        app.transcript_lines()
            .iter()
            .filter(|line| line.as_str() == "assistant: Root answer complete.")
            .count(),
        1,
        "{:?}",
        app.transcript_lines()
    );
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
        "tui-existing-1",
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
fn initial_transcript_is_clean_preflight_shell() {
    let app = App::new_for_test();
    let transcript = app.transcript_lines().join("\n");

    assert!(transcript.contains("system: SIM-ONE Alpha Ratatui TUI"));
    assert!(transcript.contains("preflight:"));
    assert!(!transcript.contains("context 01"));
    assert!(!transcript.contains("scroll test row"));
    assert!(!transcript.contains("PgUp/PgDown scroll this transcript"));
}

#[test]
fn startup_preflight_creates_fresh_session_before_sending_one_greeting_prompt() {
    let prompts = Arc::new(Mutex::new(Vec::<(String, String, AgentPromptOrigin)>::new()));
    let sent_prompts = Arc::clone(&prompts);
    let creator_calls = Arc::new(AtomicUsize::new(0));
    let recorded_creator_calls = Arc::clone(&creator_calls);
    let mut app = App::with_agent_request_sender_and_lifecycle(
        "",
        "http://127.0.0.1:3940 started:false",
        "http://127.0.0.1:3940",
        Arc::new(move |_, session_id, prompt, origin| {
            sent_prompts
                .lock()
                .expect("prompt recorder should lock")
                .push((session_id.clone(), prompt, origin));
            Ok(AgentReply {
                text: "Hello Daniel, I'm Ollie. All systems are go.".to_string(),
                submission_id: None,
                stream_offset: None,
                session_id: Some("tui-startup-1".to_string()),
                session_title: None,
                command_name: None,
                session_created: Some(false),
            })
        }),
        Arc::new(move |_| {
            recorded_creator_calls.fetch_add(1, Ordering::SeqCst);
            Ok(SessionLifecycleReply {
                id: "tui-startup-1".to_string(),
                title: None,
                created: true,
            })
        }),
        Arc::new(|_, _| panic!("default startup must not call the session resumer")),
    );

    app.start_startup_preflight(false);
    wait_for_startup(&mut app);

    assert_eq!(creator_calls.load(Ordering::SeqCst), 1);
    assert_eq!(app.session_id(), "tui-startup-1");
    let prompts = prompts.lock().expect("prompt recorder should lock");
    assert_eq!(prompts.len(), 1);
    assert_eq!(prompts[0].0, "tui-startup-1");
    assert!(prompts[0].1.contains("greeting-preflight"));
    assert_eq!(prompts[0].2, AgentPromptOrigin::StartupPreflight);
    assert!(prompts[0].1.contains("Daniel T Sasser II"));
    assert!(prompts[0].1.contains("all systems go"));
    assert!(prompts[0].1.contains("status = \"all systems go\""));
    assert!(prompts[0].1.contains("sessionId = \"tui-startup-1\""));
    assert!(!prompts[0].1.trim_start().starts_with('/'));

    let transcript = app.transcript_lines().join("\n");
    assert!(transcript.contains("preflight: gateway ready"));
    assert!(transcript.contains("preflight: created fresh TUI session tui-startup-1"));
    assert!(transcript.contains("preflight: event stream attach deferred"));
    assert!(transcript.contains("preflight: all systems go"));
    assert!(transcript.contains("assistant: Hello Daniel, I'm Ollie."));
    assert!(!transcript.contains("resolving active TUI session"));
    assert!(!transcript.contains("assistant: /session"));
    assert!(!transcript.contains("primary"));
    assert_eq!(app.agent_status(), "ready");
    assert!(app.startup_succeeded());
    assert!(app.status_text().contains("session: tui-startup-1"));
    assert!(!app.status_text().contains("automatic SIM-ONE"));
}

#[test]
fn startup_preflight_fails_when_lifecycle_creation_returns_no_session_id() {
    let calls = Arc::new(AtomicUsize::new(0));
    let sender_calls = Arc::clone(&calls);
    let mut app = App::with_agent_sender_and_lifecycle(
        "",
        "http://127.0.0.1:3940 started:false",
        "http://127.0.0.1:3940",
        Arc::new(move |_, _, _| {
            sender_calls.fetch_add(1, Ordering::SeqCst);
            Ok(agent_reply("must not send greeting"))
        }),
        Arc::new(|_| {
            Ok(SessionLifecycleReply {
                id: " ".to_string(),
                title: None,
                created: true,
            })
        }),
        Arc::new(|_, _| panic!("default startup must not call the session resumer")),
    );

    app.start_startup_preflight(false);
    wait_for_startup(&mut app);

    assert_eq!(app.session_id(), "");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let transcript = app.transcript_lines().join("\n");
    assert!(transcript.contains("error: Gateway returned an empty TUI session id."));
    assert!(transcript.contains("preflight: startup preflight failed"));
    assert!(!transcript.contains("preflight: all systems go"));
    assert!(!app.startup_succeeded());
}

#[test]
fn startup_preflight_reports_lifecycle_and_greeting_failures() {
    let mut lifecycle_failure = App::with_agent_sender_and_lifecycle(
        "",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(|_, _, _| panic!("failed lifecycle must not send greeting")),
        Arc::new(|_| Err("session service unavailable".to_string())),
        Arc::new(|_, _| panic!("default startup must not call the session resumer")),
    );
    lifecycle_failure.start_startup_preflight(false);
    wait_for_startup(&mut lifecycle_failure);
    let transcript = lifecycle_failure.transcript_lines().join("\n");
    assert!(transcript.contains("error: session service unavailable"));
    assert!(transcript.contains("preflight: startup preflight failed"));
    assert!(!lifecycle_failure.startup_succeeded());
    lifecycle_failure.handle_event(AppEvent::Text("must stay blocked".to_string()));
    lifecycle_failure.handle_event(AppEvent::Submit);
    assert_eq!(lifecycle_failure.prompt(), "must stay blocked");
    assert!(!lifecycle_failure
        .transcript_lines()
        .iter()
        .any(|line| line.contains("you: must stay blocked")));

    let mut greeting_failure = App::with_agent_sender_and_lifecycle(
        "",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(|_, _, _| Err("greeting failed".to_string())),
        Arc::new(|_| {
            Ok(SessionLifecycleReply {
                id: "tui-greeting-failure".to_string(),
                title: None,
                created: true,
            })
        }),
        Arc::new(|_, _| panic!("default startup must not call the session resumer")),
    );
    greeting_failure.start_startup_preflight(false);
    wait_for_startup(&mut greeting_failure);
    let transcript = greeting_failure.transcript_lines().join("\n");
    assert!(transcript.contains("error: greeting failed"));
    assert!(transcript.contains("preflight: startup preflight failed"));
    assert!(!greeting_failure.startup_succeeded());
}

#[test]
fn explicit_startup_resume_validates_and_restores_title_without_greeting() {
    let sender_calls = Arc::new(AtomicUsize::new(0));
    let recorded_sender_calls = Arc::clone(&sender_calls);
    let resume_calls = Arc::new(Mutex::new(Vec::<String>::new()));
    let recorded_resume_calls = Arc::clone(&resume_calls);
    let mut app = App::with_agent_sender_and_lifecycle(
        "",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(move |_, _, _| {
            recorded_sender_calls.fetch_add(1, Ordering::SeqCst);
            Ok(agent_reply("must not greet"))
        }),
        Arc::new(|_| panic!("explicit resume must not create a session")),
        Arc::new(move |_, session_id| {
            recorded_resume_calls
                .lock()
                .expect("resume recorder should lock")
                .push(session_id);
            Ok(SessionLifecycleReply {
                id: "tui-existing-1".to_string(),
                title: Some("Release Work".to_string()),
                created: false,
            })
        }),
    );

    app.start_explicit_resume("tui-existing-1".to_string(), false);
    wait_for_startup(&mut app);

    assert_eq!(
        resume_calls
            .lock()
            .expect("resume recorder should lock")
            .as_slice(),
        ["tui-existing-1"]
    );
    assert_eq!(sender_calls.load(Ordering::SeqCst), 0);
    assert_eq!(app.session_id(), "tui-existing-1");
    assert_eq!(app.session_title(), Some("Release Work"));
    assert_eq!(
        app.transcript_header_title(),
        "SIM-ONE Alpha - Release Work"
    );
    assert!(app.startup_succeeded());
    let transcript = app.transcript_lines().join("\n");
    assert!(transcript.contains("preflight: resumed TUI session tui-existing-1"));
    assert!(!transcript.contains("greeting-preflight"));
}

#[test]
fn explicit_resume_locks_input_until_history_and_snapshot_offset_are_installed() {
    let sender_calls = Arc::new(AtomicUsize::new(0));
    let recorded_sender_calls = Arc::clone(&sender_calls);
    let history_calls = Arc::new(AtomicUsize::new(0));
    let recorded_history_calls = Arc::clone(&history_calls);
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = Arc::new(Mutex::new(release_rx));
    let history_release = Arc::clone(&release_rx);
    let mut app = App::with_agent_sender_lifecycle_and_history(
        "",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(move |_, _, _| {
            recorded_sender_calls.fetch_add(1, Ordering::SeqCst);
            Ok(agent_reply("must not send while history is loading"))
        }),
        Arc::new(|_| panic!("explicit resume must not create a session")),
        Arc::new(|_, selector| {
            assert_eq!(selector, "Release Work");
            Ok(SessionLifecycleReply {
                id: "tui-history-1".to_string(),
                title: Some("Release Work".to_string()),
                created: false,
            })
        }),
        Arc::new(move |_, session_id, limit, before| {
            recorded_history_calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(session_id, "tui-history-1");
            assert_eq!(limit, 50);
            assert_eq!(before, None);
            history_release
                .lock()
                .expect("history release should lock")
                .recv()
                .expect("history load should be released");
            Ok(history_page(
                "tui-history-1",
                "0000000000000000_0000000000000042",
                false,
                None,
                vec![history_exchange("submission-history")],
            ))
        }),
    );

    app.start_explicit_resume("Release Work".to_string(), false);
    wait_until(Duration::from_secs(2), || {
        app.poll_agent();
        history_calls.load(Ordering::SeqCst) == 1
    });

    assert_eq!(app.session_id(), "tui-history-1");
    assert_eq!(app.session_title(), Some("Release Work"));
    assert!(!app.startup_complete());
    assert!(app.is_agent_pending());
    app.handle_event(AppEvent::Text("must stay locked".to_string()));
    app.handle_event(AppEvent::Submit);
    assert_eq!(app.prompt(), "must stay locked");
    assert_eq!(sender_calls.load(Ordering::SeqCst), 0);

    release_tx
        .send(())
        .expect("history load should be released");
    wait_for_startup(&mut app);

    assert!(app.startup_succeeded());
    assert_eq!(app.loaded_history_exchanges().len(), 1);
    assert_eq!(
        app.stream_start_offset(),
        "0000000000000000_0000000000000042"
    );
    assert_eq!(sender_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn explicit_resume_history_failure_stops_startup_without_greeting() {
    let sender_calls = Arc::new(AtomicUsize::new(0));
    let recorded_sender_calls = Arc::clone(&sender_calls);
    let mut app = App::with_agent_sender_lifecycle_and_history(
        "",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(move |_, _, _| {
            recorded_sender_calls.fetch_add(1, Ordering::SeqCst);
            Ok(agent_reply("must not greet"))
        }),
        Arc::new(|_| panic!("explicit resume must not create a session")),
        Arc::new(|_, _| {
            Ok(SessionLifecycleReply {
                id: "tui-history-failed".to_string(),
                title: Some("Failed History".to_string()),
                created: false,
            })
        }),
        Arc::new(|_, _, _, _| Err("history unavailable".to_string())),
    );

    app.start_explicit_resume("tui-history-failed".to_string(), false);
    wait_for_startup(&mut app);

    assert!(!app.startup_succeeded());
    assert_eq!(sender_calls.load(Ordering::SeqCst), 0);
    let transcript = app.transcript_lines().join("\n");
    assert!(transcript.contains("error: Could not load session history."));
    assert!(transcript.contains("preflight: startup preflight failed"));
}

#[test]
fn fresh_startup_uses_the_fresh_stream_tail_and_never_loads_history() {
    let history_calls = Arc::new(AtomicUsize::new(0));
    let recorded_history_calls = Arc::clone(&history_calls);
    let mut app = App::with_agent_sender_lifecycle_and_history(
        "",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(|_, _, _| Ok(agent_reply("Fresh greeting"))),
        Arc::new(|_| {
            Ok(SessionLifecycleReply {
                id: "tui-fresh-history".to_string(),
                title: None,
                created: true,
            })
        }),
        Arc::new(|_, _| panic!("fresh startup must not resume")),
        Arc::new(move |_, _, _, _| {
            recorded_history_calls.fetch_add(1, Ordering::SeqCst);
            panic!("fresh startup must not load transcript history")
        }),
    );

    app.start_startup_preflight(false);
    wait_for_startup(&mut app);

    assert!(app.startup_succeeded());
    assert_eq!(history_calls.load(Ordering::SeqCst), 0);
    assert_eq!(app.stream_start_offset(), "now");
}

#[test]
fn scrolling_to_loaded_history_top_requests_one_older_page_and_prepends_it() {
    let calls = Arc::new(Mutex::new(Vec::<Option<String>>::new()));
    let recorded_calls = Arc::clone(&calls);
    let mut app = App::with_agent_sender_lifecycle_and_history(
        "",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(|_, _, _| panic!("resume must not greet")),
        Arc::new(|_| panic!("resume must not create")),
        Arc::new(|_, _| {
            Ok(SessionLifecycleReply {
                id: "tui-paged-history".to_string(),
                title: None,
                created: false,
            })
        }),
        Arc::new(move |_, _, _, before| {
            recorded_calls
                .lock()
                .expect("history calls should lock")
                .push(before.clone());
            if before.is_none() {
                Ok(history_page(
                    "tui-paged-history",
                    "0000000000000000_0000000000000042",
                    true,
                    Some("older-cursor"),
                    vec![history_exchange("submission-new")],
                ))
            } else {
                assert_eq!(before.as_deref(), Some("older-cursor"));
                Ok(history_page(
                    "tui-paged-history",
                    "0000000000000000_0000000000000042",
                    false,
                    None,
                    vec![history_exchange("submission-old")],
                ))
            }
        }),
    );

    app.start_explicit_resume("tui-paged-history".to_string(), false);
    wait_for_startup(&mut app);
    app.scroll_page_up();
    app.scroll_page_up();
    wait_for_agent(&mut app);

    assert_eq!(
        calls.lock().expect("history calls should lock").as_slice(),
        [None, Some("older-cursor".to_string())]
    );
    assert_eq!(
        app.loaded_history_exchanges()
            .iter()
            .map(|exchange| exchange.id.as_str())
            .collect::<Vec<_>>(),
        ["submission-old", "submission-new"]
    );
}

#[test]
fn older_history_failure_preserves_loaded_history_and_keeps_startup_usable() {
    let calls = Arc::new(AtomicUsize::new(0));
    let recorded_calls = Arc::clone(&calls);
    let mut app = App::with_agent_sender_lifecycle_and_history(
        "",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(|_, _, _| panic!("resume must not greet")),
        Arc::new(|_| panic!("resume must not create")),
        Arc::new(|_, _| {
            Ok(SessionLifecycleReply {
                id: "tui-history-page-error".to_string(),
                title: None,
                created: false,
            })
        }),
        Arc::new(move |_, _, _, before| {
            recorded_calls.fetch_add(1, Ordering::SeqCst);
            if before.is_none() {
                Ok(history_page(
                    "tui-history-page-error",
                    "0000000000000000_0000000000000042",
                    true,
                    Some("older-cursor"),
                    vec![history_exchange("submission-loaded")],
                ))
            } else {
                Err("private older page failure details".to_string())
            }
        }),
    );

    app.start_explicit_resume("tui-history-page-error".to_string(), false);
    wait_for_startup(&mut app);
    app.scroll_page_up();
    wait_for_agent(&mut app);

    assert!(app.startup_succeeded());
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(app.loaded_history_exchanges().len(), 1);
    let transcript = app.transcript_lines().join("\n");
    assert!(transcript.contains("error: Could not load older session history."));
    assert!(!transcript.contains("private older page failure details"));
}

#[test]
fn explicit_resume_renders_sanitized_snapshot_as_the_canonical_transcript() {
    let mut app = App::with_agent_sender_lifecycle_and_history(
        "",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(|_, _, _| panic!("resume must not generate another greeting")),
        Arc::new(|_| panic!("resume must not create")),
        Arc::new(|_, _| {
            Ok(SessionLifecycleReply {
                id: "tui-render-history".to_string(),
                title: Some("Restored Work".to_string()),
                created: false,
            })
        }),
        Arc::new(|_, _, _, _| {
            Ok(history_page(
                "tui-render-history",
                "0000000000000000_0000000000000042",
                false,
                None,
                vec![
                    transcript_exchange(
                        "saved-greeting",
                        Some((
                            "INTERNAL_STARTUP_SENTINEL",
                            TranscriptPromptVisibility::Internal,
                        )),
                        Vec::new(),
                        Some("Hello Daniel. Saved greeting."),
                    ),
                    transcript_exchange(
                        "saved-user-turn",
                        Some((
                            "Show the release\nand the remaining risks.",
                            TranscriptPromptVisibility::User,
                        )),
                        vec![
                            transcript_activity(
                                "saved-user-turn:operation:root",
                                TranscriptActivityKind::Operation,
                                "orchestrate",
                                TranscriptActivityStatus::Completed,
                                Some(5_900),
                            ),
                            transcript_activity(
                                "saved-user-turn:tool:docs",
                                TranscriptActivityKind::Tool,
                                "load_protocols",
                                TranscriptActivityStatus::Completed,
                                Some(13),
                            ),
                        ],
                        Some("Saved **final** response.\nSecond line."),
                    ),
                ],
            ))
        }),
    );

    app.start_explicit_resume("Restored Work".to_string(), false);
    wait_for_startup(&mut app);

    let lines = app.transcript_lines();
    let transcript = lines.join("\n");
    assert!(!transcript.contains("INTERNAL_STARTUP_SENTINEL"));
    assert_eq!(
        lines
            .iter()
            .filter(|line| line.as_str() == "assistant: Hello Daniel. Saved greeting.")
            .count(),
        1
    );
    assert!(transcript.contains("you: Show the release\n  and the remaining risks."));
    assert!(transcript.contains("operation: orchestrate completed in 5.9s"));
    assert!(transcript.contains("tool: load_protocols completed in 13ms"));
    assert!(transcript.contains("assistant: Saved **final** response.\n  Second line."));
    let prompt = lines
        .iter()
        .position(|line| line == "you: Show the release")
        .expect("saved prompt should render");
    let operation = lines
        .iter()
        .position(|line| line == "operation: orchestrate completed in 5.9s")
        .expect("saved operation should render");
    let final_response = lines
        .iter()
        .position(|line| line == "assistant: Saved **final** response.")
        .expect("saved final should render");
    assert!(prompt < operation && operation < final_response);
}

#[test]
fn older_history_prepend_preserves_the_exact_visible_source_row() {
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = Arc::new(Mutex::new(release_rx));
    let older_release = Arc::clone(&release_rx);
    let calls = Arc::new(AtomicUsize::new(0));
    let loader_calls = Arc::clone(&calls);
    let mut app = App::with_agent_sender_lifecycle_and_history(
        "",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(|_, _, _| panic!("resume must not greet")),
        Arc::new(|_| panic!("resume must not create")),
        Arc::new(|_, _| {
            Ok(SessionLifecycleReply {
                id: "tui-anchor-history".to_string(),
                title: None,
                created: false,
            })
        }),
        Arc::new(move |_, _, _, before| {
            let call = loader_calls.fetch_add(1, Ordering::SeqCst);
            if call == 0 {
                return Ok(history_page(
                    "tui-anchor-history",
                    "0000000000000000_0000000000000042",
                    true,
                    Some("older-cursor"),
                    vec![transcript_exchange(
                        "newer",
                        Some((
                            "VISIBLE_ANCHOR alpha bravo charlie delta",
                            TranscriptPromptVisibility::User,
                        )),
                        Vec::new(),
                        Some("newer final"),
                    )],
                ));
            }
            assert_eq!(before.as_deref(), Some("older-cursor"));
            older_release
                .lock()
                .expect("older release should lock")
                .recv_timeout(Duration::from_secs(5))
                .expect("older page should be released");
            Ok(history_page(
                "tui-anchor-history",
                "0000000000000000_0000000000000042",
                false,
                None,
                vec![transcript_exchange(
                    "older",
                    Some((
                        "OLDER_HISTORY alpha bravo charlie delta",
                        TranscriptPromptVisibility::User,
                    )),
                    Vec::new(),
                    Some("older final"),
                )],
            ))
        }),
    );

    app.start_explicit_resume("tui-anchor-history".to_string(), false);
    wait_for_startup(&mut app);
    app.set_transcript_viewport_size(3, 18);
    app.jump_to_tail();
    while app
        .transcript_rendered_lines()
        .get(app.transcript_scroll())
        .is_none_or(|line| !line.contains("VISIBLE_ANCHOR"))
    {
        app.scroll_line_up();
        if calls.load(Ordering::SeqCst) > 1 {
            break;
        }
    }
    let anchor_before = app
        .transcript_rendered_lines()
        .get(app.transcript_scroll())
        .cloned()
        .expect("anchor row should be visible");
    assert!(!anchor_before.contains("OLDER_HISTORY"), "{anchor_before}");
    wait_until(Duration::from_secs(2), || calls.load(Ordering::SeqCst) == 2);

    release_tx.send(()).expect("older page should be released");
    wait_for_agent(&mut app);

    let anchor_after = app
        .transcript_rendered_lines()
        .get(app.transcript_scroll())
        .cloned()
        .expect("same anchor row should remain visible");
    assert_eq!(anchor_after, anchor_before);
    assert!(!app.follow_tail());
    assert!(app
        .transcript_lines()
        .iter()
        .any(|line| line.contains("OLDER_HISTORY")));
}

#[test]
fn replayed_old_final_cannot_settle_a_new_pending_prompt() {
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = Arc::new(Mutex::new(release_rx));
    let sender_release = Arc::clone(&release_rx);
    let mut app = App::with_agent_sender_lifecycle_and_history(
        "",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(move |_, _, _| {
            sender_release
                .lock()
                .expect("sender release should lock")
                .recv_timeout(Duration::from_secs(5))
                .expect("new response should be released");
            Ok(agent_reply("new authoritative final"))
        }),
        Arc::new(|_| panic!("resume must not create")),
        Arc::new(|_, _| {
            Ok(SessionLifecycleReply {
                id: "tui-replay-history".to_string(),
                title: None,
                created: false,
            })
        }),
        Arc::new(|_, _, _, _| {
            Ok(history_page(
                "tui-replay-history",
                "0000000000000000_0000000000000042",
                false,
                None,
                vec![transcript_exchange(
                    "old-submission",
                    Some(("old prompt", TranscriptPromptVisibility::User)),
                    Vec::new(),
                    Some("old authoritative final"),
                )],
            ))
        }),
    );

    app.start_explicit_resume("tui-replay-history".to_string(), false);
    wait_for_startup(&mut app);
    app.handle_event(AppEvent::Text("new prompt".to_string()));
    app.handle_event(AppEvent::Submit);
    app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
        serde_json::json!({
            "type":"message_end",
            "submissionId":"old-submission",
            "eventIndex":99,
            "message":{"role":"assistant","content":"STALE_REPLAY_FINAL"}
        }),
    )]));

    let after_replay = app.transcript_lines().join("\n");
    assert!(after_replay.contains("old authoritative final"));
    assert!(!after_replay.contains("STALE_REPLAY_FINAL"));
    assert!(after_replay.contains("waiting for final response"));
    assert!(app.is_agent_pending());

    app.handle_stream_update(AgentStreamUpdate::Events(vec![
        FlueEvent::from_value(serde_json::json!({
            "type":"text_delta",
            "submissionId":"new-submission",
            "eventIndex":1,
            "text":"new streamed "
        })),
        FlueEvent::from_value(serde_json::json!({
            "type":"message_end",
            "submissionId":"new-submission",
            "eventIndex":2,
            "message":{"role":"assistant","content":"new streamed final"}
        })),
    ]));
    assert!(app
        .transcript_lines()
        .iter()
        .any(|line| line == "assistant: new streamed final"));

    release_tx
        .send(())
        .expect("new response should be released");
    wait_for_agent(&mut app);
    let final_transcript = app.transcript_lines().join("\n");
    assert!(final_transcript.contains("old authoritative final"));
    assert!(final_transcript.contains("assistant: new authoritative final"));
    assert_eq!(
        final_transcript
            .lines()
            .filter(|line| line.starts_with("assistant: new authoritative final"))
            .count(),
        1
    );
}

#[test]
fn explicit_startup_resume_accepts_a_name_resolved_canonical_id_without_greeting() {
    let sender_calls = Arc::new(AtomicUsize::new(0));
    let recorded_sender_calls = Arc::clone(&sender_calls);
    let mut app = App::with_agent_sender_and_lifecycle(
        "",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(move |_, _, _| {
            recorded_sender_calls.fetch_add(1, Ordering::SeqCst);
            Ok(agent_reply("must not greet"))
        }),
        Arc::new(|_| panic!("explicit resume must not create a session through the client")),
        Arc::new(|_, selector| {
            assert_eq!(selector, "Release Work");
            Ok(SessionLifecycleReply {
                id: "tui-existing-by-name".to_string(),
                title: Some("Release Work".to_string()),
                created: false,
            })
        }),
    );

    app.start_explicit_resume("Release Work".to_string(), false);
    wait_for_startup(&mut app);

    assert!(app.startup_succeeded());
    assert_eq!(app.session_id(), "tui-existing-by-name");
    assert_eq!(app.session_title(), Some("Release Work"));
    assert_eq!(sender_calls.load(Ordering::SeqCst), 0);
    let transcript = app.transcript_lines().join("\n");
    assert!(transcript.contains("preflight: resumed TUI session tui-existing-by-name"));
    assert!(!transcript.contains("greeting-preflight"));
}

#[test]
fn explicit_startup_missing_session_uses_fresh_session_and_greeting() {
    let prompts = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
    let sent_prompts = Arc::clone(&prompts);
    let mut app = App::with_agent_sender_and_lifecycle(
        "",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(move |_, session_id, prompt| {
            sent_prompts
                .lock()
                .expect("prompt recorder should lock")
                .push((session_id, prompt));
            Ok(AgentReply {
                text: "Fresh fallback greeting".to_string(),
                submission_id: None,
                stream_offset: None,
                session_id: Some("tui-fresh-fallback".to_string()),
                session_title: None,
                command_name: None,
                session_created: Some(false),
            })
        }),
        Arc::new(|_| panic!("fallback is returned by the resume lifecycle request")),
        Arc::new(|_, selector| {
            assert_eq!(selector, "missing-session");
            Ok(SessionLifecycleReply {
                id: "tui-fresh-fallback".to_string(),
                title: None,
                created: true,
            })
        }),
    );

    app.start_explicit_resume("missing-session".to_string(), false);
    wait_for_startup(&mut app);

    assert!(app.startup_succeeded());
    assert_eq!(app.session_id(), "tui-fresh-fallback");
    let prompts = prompts.lock().expect("prompt recorder should lock");
    assert_eq!(prompts.len(), 1);
    assert_eq!(prompts[0].0, "tui-fresh-fallback");
    assert!(prompts[0].1.contains("greeting-preflight"));
    let transcript = app.transcript_lines().join("\n");
    assert!(transcript.contains(
        "preflight: session missing-session was not found; created fresh TUI session tui-fresh-fallback"
    ));
    assert!(transcript.contains("assistant: Fresh fallback greeting"));
    assert!(!transcript.contains("preflight: startup preflight failed"));
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
        "tui-existing-1",
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
    assert!(!app
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

    let first_stream_line = app
        .transcript_lines()
        .iter()
        .position(|line| line == "thinking: first")
        .expect("first thinking activity should render");

    app.handle_stream_update(AgentStreamUpdate::Events(vec![
        FlueEvent::from_value(serde_json::json!({
            "type":"turn_start",
            "eventIndex":1,
            "timestamp":"2026-07-03T00:01:00Z"
        })),
        FlueEvent::from_value(serde_json::json!({
            "type":"thinking_delta",
            "eventIndex":2,
            "timestamp":"2026-07-03T00:01:01Z",
            "text":"second"
        })),
    ]));

    let lines = app.transcript_lines();
    assert_eq!(lines[first_stream_line], "thinking: first");
    assert_eq!(
        lines
            .iter()
            .filter(|line| line.as_str() == "thinking: first")
            .count(),
        1
    );
    let second_stream_line = lines
        .iter()
        .position(|line| line == "thinking: second")
        .expect("second thinking activity should render");
    assert!(first_stream_line < second_stream_line);
    assert!(!lines.iter().any(|line| line.starts_with("turn:")));
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
fn max_scroll_counts_wrapped_rows_for_narrow_transcript_width() {
    let mut app = App::new_for_test();
    app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
        serde_json::json!({
            "type":"thinking_delta",
            "eventIndex":10,
            "text":"alpha bravo charlie delta"
        }),
    )]));

    app.set_transcript_viewport_size(3, 12);
    app.jump_to_tail();

    assert!(app
        .transcript_rendered_lines()
        .iter()
        .all(|line| line.chars().count() <= 12));
    assert!(app.max_scroll() > app.transcript_lines().len().saturating_sub(3));
    assert_eq!(app.transcript_scroll(), app.max_scroll());
}

#[test]
fn transcript_does_not_split_a_word_longer_than_the_viewport() {
    let mut app = App::new_for_test();
    app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
        serde_json::json!({
            "type":"log",
            "eventIndex":12,
            "text":"abcdefghij12345"
        }),
    )]));

    app.set_transcript_viewport_size(4, 5);
    let rendered = app.transcript_rendered_lines();

    assert!(
        rendered.iter().any(|line| line == "abcdefghij12345"),
        "{rendered:?}"
    );
    assert!(!rendered.iter().any(|line| line == "abcde"), "{rendered:?}");
}

#[test]
fn transcript_wraps_before_a_word_that_does_not_fit() {
    let mut app = App::new_for_test();
    app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
        serde_json::json!({
            "type":"log",
            "eventIndex":11,
            "text":"alpha bravo"
        }),
    )]));

    app.set_transcript_viewport_size(4, 12);
    let rendered = app.transcript_rendered_lines();

    assert!(
        rendered.iter().any(|line| line == "log: alpha"),
        "{rendered:?}"
    );
    assert!(rendered.iter().any(|line| line == "bravo"), "{rendered:?}");
    assert!(
        !rendered.iter().any(|line| line == "log: alpha b"),
        "{rendered:?}"
    );
}

#[test]
fn max_scroll_uses_exact_prewrapped_transcript_rows() {
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

    let height = 4;
    let width = 20;
    app.set_transcript_viewport_size(height, width);
    let rendered_lines = app.transcript_rendered_lines();

    assert!(rendered_lines.len() > app.transcript_lines().len());
    assert!(rendered_lines
        .iter()
        .all(|line| line.chars().count() <= width));
    assert_eq!(app.transcript_rendered_row_count(), rendered_lines.len());
    assert_eq!(
        app.max_scroll(),
        rendered_lines.len().saturating_sub(height)
    );
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
fn prompt_arrows_move_across_explicit_lines_and_preserve_preferred_column() {
    let mut app = App::new_for_test();
    app.set_prompt_viewport_width(40);
    app.handle_event(AppEvent::Text("abcdef\nx\nuvwxyz".to_string()));
    app.handle_event(AppEvent::MovePromptStart);
    for _ in 0..5 {
        app.handle_event(AppEvent::MovePromptRight);
    }

    app.handle_event(AppEvent::NavigateDown);
    assert_eq!(&app.prompt()[..app.prompt_cursor()], "abcdef\nx");
    app.handle_event(AppEvent::NavigateDown);
    assert_eq!(&app.prompt()[..app.prompt_cursor()], "abcdef\nx\nuvwxy");
    app.handle_event(AppEvent::NavigateUp);
    assert_eq!(&app.prompt()[..app.prompt_cursor()], "abcdef\nx");
    app.handle_event(AppEvent::NavigateUp);
    assert_eq!(&app.prompt()[..app.prompt_cursor()], "abcde");
}

#[test]
fn prompt_arrows_follow_wrapped_rows_and_unicode_display_columns() {
    let mut app = App::new_for_test();
    app.set_prompt_viewport_width(10);
    app.handle_event(AppEvent::Text("alpha bravo charlie".to_string()));
    app.handle_event(AppEvent::MovePromptStart);
    for _ in 0..3 {
        app.handle_event(AppEvent::MovePromptRight);
    }

    app.handle_event(AppEvent::NavigateDown);
    assert_eq!(&app.prompt()[..app.prompt_cursor()], "alpha bra");
    app.handle_event(AppEvent::NavigateDown);
    assert_eq!(&app.prompt()[..app.prompt_cursor()], "alpha bravo cha");

    app.handle_event(AppEvent::ClearPrompt);
    app.set_prompt_viewport_width(20);
    app.handle_event(AppEvent::Text("界界\nabcdef".to_string()));
    app.handle_event(AppEvent::MovePromptStart);
    app.handle_event(AppEvent::MovePromptRight);
    app.handle_event(AppEvent::NavigateDown);
    assert_eq!(&app.prompt()[..app.prompt_cursor()], "界界\nab");
}

#[test]
fn prompt_arrows_do_not_steal_transcript_page_or_mouse_scrolling() {
    let mut app = App::new_for_test();
    for index in 0..20 {
        app.handle_stream_update(AgentStreamUpdate::Events(vec![FlueEvent::from_value(
            serde_json::json!({
                "type":"log",
                "eventIndex":700 + index,
                "text":format!("history row {index}")
            }),
        )]));
    }
    app.set_transcript_viewport_size(4, 80);
    app.jump_to_tail();
    let tail = app.transcript_scroll();
    app.handle_event(AppEvent::Text("line one\nline two".to_string()));

    app.handle_event(AppEvent::NavigateUp);
    assert_eq!(app.transcript_scroll(), tail);
    app.handle_event(AppEvent::ScrollPageUp);
    assert!(app.transcript_scroll() < tail);
    let page_scroll = app.transcript_scroll();
    app.handle_event(AppEvent::ScrollLineUp);
    assert_eq!(app.transcript_scroll(), page_scroll.saturating_sub(1));
}

#[test]
fn rename_reply_updates_status_title_without_changing_session_id() {
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

    assert_eq!(app.session_id(), "tui-existing-1");
    assert_eq!(app.session_title(), Some("Release Work"));
    assert_eq!(
        app.transcript_header_title(),
        "SIM-ONE Alpha - Release Work"
    );
    assert!(
        app.status_text().contains("session: Release Work"),
        "{}",
        app.status_text()
    );
    assert!(!app.status_text().contains("Release Work ("));
}

#[test]
fn fresh_and_unnamed_sessions_keep_the_product_only_header() {
    let unresolved = App::new_for_test();
    assert_eq!(unresolved.transcript_header_title(), "SIM-ONE Alpha");
    assert!(
        unresolved
            .status_text()
            .starts_with("SIM-ONE Alpha | session: resolving |"),
        "{}",
        unresolved.status_text()
    );

    let unnamed = App::with_session("tui-existing-1", "test gateway", "http://127.0.0.1:3940");
    assert_eq!(unnamed.transcript_header_title(), "SIM-ONE Alpha");
    assert!(
        unnamed
            .status_text()
            .starts_with("SIM-ONE Alpha | session: tui-existing-1 |"),
        "{}",
        unnamed.status_text()
    );
}

#[test]
fn resume_reply_restores_explicit_name_in_header_and_existing_status_field() {
    let mut app = App::with_agent_sender(
        "tui-current-1",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(|_, _, _| {
            Ok(AgentReply {
                text: "Resumed session tui-named-1.".to_string(),
                submission_id: None,
                stream_offset: None,
                session_id: Some("tui-named-1".to_string()),
                session_title: Some("Release Work".to_string()),
                command_name: Some("resume".to_string()),
                session_created: Some(false),
            })
        }),
    );
    app.handle_event(AppEvent::Text("/resume tui-named-1".to_string()));
    app.handle_event(AppEvent::Submit);
    wait_for_agent(&mut app);

    assert_eq!(app.session_id(), "tui-named-1");
    assert_eq!(
        app.transcript_header_title(),
        "SIM-ONE Alpha - Release Work"
    );
    assert!(
        app.status_text()
            .starts_with("SIM-ONE Alpha | session: Release Work |"),
        "{}",
        app.status_text()
    );
}

#[test]
fn slash_command_palette_filters_navigates_and_inserts_without_submitting() {
    let calls = Arc::new(AtomicUsize::new(0));
    let sender_calls = Arc::clone(&calls);
    let mut app = App::with_agent_sender(
        "tui-existing-1",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(move |_, _, _| {
            sender_calls.fetch_add(1, Ordering::SeqCst);
            Ok(agent_reply("should not submit"))
        }),
    );

    app.handle_event(AppEvent::Text("/".to_string()));
    assert!(app.command_palette_open());
    assert_eq!(app.command_palette_items().len(), 9);
    assert_eq!(
        app.selected_command().map(|item| item.usage),
        Some("/new [title]")
    );

    app.handle_event(AppEvent::NavigateDown);
    app.handle_event(AppEvent::NavigateDown);
    assert_eq!(
        app.selected_command().map(|item| item.usage),
        Some("/resume <session-id-or-name>")
    );
    app.handle_event(AppEvent::Submit);

    assert_eq!(app.prompt(), "/resume ");
    assert!(!app.command_palette_open());
    assert_eq!(calls.load(Ordering::SeqCst), 0);

    app.handle_event(AppEvent::ClearPrompt);
    app.handle_event(AppEvent::Text("/res".to_string()));
    let filtered = app.command_palette_items();
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].usage, "/resume <session-id-or-name>");
}

#[test]
fn command_palette_cancel_dismisses_before_escape_quits() {
    let mut app = App::new_for_test();
    app.handle_event(AppEvent::Text("/".to_string()));

    app.handle_event(AppEvent::Cancel);
    assert!(!app.command_palette_open());
    assert!(!app.should_quit());

    app.handle_event(AppEvent::Cancel);
    assert!(app.should_quit());
}

#[test]
fn trailing_backslash_enter_inserts_newline_without_submitting() {
    let calls = Arc::new(AtomicUsize::new(0));
    let sender_calls = Arc::clone(&calls);
    let mut app = App::with_agent_sender(
        "tui-existing-1",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(move |_, _, _| {
            sender_calls.fetch_add(1, Ordering::SeqCst);
            Ok(agent_reply("should not submit"))
        }),
    );

    app.handle_event(AppEvent::Text("first line\\".to_string()));
    app.handle_event(AppEvent::Submit);

    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(app.prompt(), "first line\n");
    assert_eq!(app.prompt_cursor(), app.prompt().len());
    assert!(!app.is_agent_pending());
}

#[test]
fn doubled_trailing_backslash_submits_as_literal_text() {
    let submitted = Arc::new(Mutex::new(Vec::new()));
    let sender_submitted = Arc::clone(&submitted);
    let mut app = App::with_agent_sender(
        "tui-existing-1",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(move |_, _, prompt| {
            sender_submitted
                .lock()
                .expect("submitted prompts should lock")
                .push(prompt);
            Ok(agent_reply("literal received"))
        }),
    );

    app.handle_event(AppEvent::Text(r"literal\\".to_string()));
    app.handle_event(AppEvent::Submit);
    wait_for_agent(&mut app);

    assert_eq!(
        submitted
            .lock()
            .expect("submitted prompts should lock")
            .as_slice(),
        [r"literal\\"]
    );
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
    let mut app = App::with_session("tui-existing-1", "test gateway", "http://127.0.0.1:3940");

    app.handle_event(AppEvent::Text("/exit".to_string()));
    app.handle_event(AppEvent::Submit);

    assert!(app.should_quit());
    assert_eq!(app.prompt(), "");
    assert_eq!(app.exit_session_id(), Some("tui-existing-1"));
}

#[test]
fn slash_session_renders_current_session_without_calling_agent() {
    let calls = Arc::new(AtomicUsize::new(0));
    let sender_calls = Arc::clone(&calls);
    let mut app = App::with_agent_sender(
        "tui-existing-1",
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
        .any(|line| line == "system: current session tui-existing-1"));
}

#[test]
fn slash_help_renders_command_reference_without_calling_agent() {
    let calls = Arc::new(AtomicUsize::new(0));
    let sender_calls = Arc::clone(&calls);
    let mut app = App::with_agent_sender(
        "tui-existing-1",
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
        "/clear",
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
        "tui-existing-1",
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
        "tui-existing-1",
        "test gateway",
        "http://127.0.0.1:3940",
        Arc::new(|_, _, _| {
            Ok(AgentReply {
                text: "Started new session tui-new-1.".to_string(),
                submission_id: None,
                stream_offset: None,
                session_id: Some("tui-new-1".to_string()),
                session_title: None,
                command_name: Some("new".to_string()),
                session_created: Some(true),
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

fn wait_for_startup(app: &mut App) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while (!app.startup_complete() || app.is_agent_pending()) && Instant::now() < deadline {
        app.poll_agent();
        thread::sleep(Duration::from_millis(10));
    }
    app.poll_agent();
    assert!(app.startup_complete(), "startup did not settle");
    assert!(
        !app.is_agent_pending(),
        "startup agent response did not settle"
    );
}

fn wait_until(mut timeout: Duration, mut condition: impl FnMut() -> bool) {
    let interval = Duration::from_millis(10);
    while timeout > Duration::ZERO {
        if condition() {
            return;
        }
        thread::sleep(interval);
        timeout = timeout.saturating_sub(interval);
    }
    assert!(condition(), "condition did not become true");
}

fn history_page(
    session_id: &str,
    next_offset: &str,
    has_older: bool,
    before: Option<&str>,
    exchanges: Vec<TranscriptExchange>,
) -> TranscriptPage {
    TranscriptPage {
        session: TranscriptSession {
            id: session_id.to_string(),
            title: None,
        },
        exchanges,
        stream: TranscriptStreamCursor {
            next_offset: next_offset.to_string(),
            up_to_date: true,
        },
        page: TranscriptPageInfo {
            limit: 50,
            has_older,
            before: before.map(str::to_string),
        },
    }
}

fn history_exchange(submission_id: &str) -> TranscriptExchange {
    TranscriptExchange {
        id: submission_id.to_string(),
        submission_id: submission_id.to_string(),
        prompt: None,
        activities: Vec::new(),
        assistant: None,
        status: TranscriptActivityStatus::Completed,
    }
}

fn transcript_exchange(
    submission_id: &str,
    prompt: Option<(&str, TranscriptPromptVisibility)>,
    activities: Vec<TranscriptActivity>,
    assistant: Option<&str>,
) -> TranscriptExchange {
    TranscriptExchange {
        id: submission_id.to_string(),
        submission_id: submission_id.to_string(),
        prompt: prompt.map(|(text, visibility)| TranscriptPrompt {
            id: format!("{submission_id}:prompt"),
            text: text.to_string(),
            received_at: "2026-07-23T10:00:00Z".to_string(),
            visibility,
        }),
        activities,
        assistant: assistant.map(|text| TranscriptAssistantMessage {
            id: format!("{submission_id}:assistant"),
            text: text.to_string(),
            completed_at: "2026-07-23T10:00:10Z".to_string(),
        }),
        status: TranscriptActivityStatus::Completed,
    }
}

fn transcript_activity(
    id: &str,
    kind: TranscriptActivityKind,
    name: &str,
    status: TranscriptActivityStatus,
    duration_ms: Option<u64>,
) -> TranscriptActivity {
    TranscriptActivity {
        id: id.to_string(),
        kind,
        name: name.to_string(),
        status,
        started_at: Some("2026-07-23T10:00:01Z".to_string()),
        completed_at: Some("2026-07-23T10:00:09Z".to_string()),
        duration_ms,
        preview: None,
        error: None,
    }
}

fn agent_reply(text: impl Into<String>) -> AgentReply {
    AgentReply {
        text: text.into(),
        submission_id: None,
        stream_offset: None,
        session_id: None,
        session_title: None,
        command_name: None,
        session_created: None,
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
        "tui-existing-1",
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
