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
fn enter_submits_prompt_to_placeholder_transcript_and_returns_to_tail() {
    let mut app = App::new_for_test();
    app.handle_event(AppEvent::Text("ship the tui".to_string()));
    app.scroll_page_up();

    app.handle_event(AppEvent::Submit);

    assert_eq!(app.prompt(), "");
    assert!(app
        .transcript_lines()
        .iter()
        .any(|line| line.contains("you: ship the tui")));
    assert!(app.follow_tail());
    assert_eq!(app.transcript_scroll(), app.max_scroll());
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
