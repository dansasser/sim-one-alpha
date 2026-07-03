use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use sim_one_ratatui_tui::app::{App, AppEvent, Clock, SCROLL_PAGE_LINES};

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
            Ok(format!("done: {prompt}"))
        }),
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
