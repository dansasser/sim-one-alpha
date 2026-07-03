use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use sim_one_ratatui_tui::app::{App, AppEvent, SCROLL_PAGE_LINES};

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
        Arc::new(|_, session, prompt| Ok(format!("session={session}; prompt={prompt}"))),
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

fn wait_for_agent(app: &mut App) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while app.is_agent_pending() && Instant::now() < deadline {
        app.poll_agent();
        thread::sleep(Duration::from_millis(10));
    }
    app.poll_agent();
    assert!(!app.is_agent_pending(), "agent response did not settle");
}
