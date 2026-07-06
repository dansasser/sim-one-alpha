use sim_one_ratatui_tui::flue::events::FlueEvent;
use sim_one_ratatui_tui::flue::reducer::{DisplayRowKind, EventTranscript, TurnState};

#[test]
fn reduces_user_and_assistant_message_end_events() {
    let mut transcript = EventTranscript::default();

    transcript.apply_events(&[
        event(1, serde_json::json!({"type":"message_end","message":{"role":"user","content":"hello"}})),
        event(2, serde_json::json!({"type":"message_end","message":{"role":"assistant","content":"hi there"}})),
    ]);

    assert_eq!(transcript.rows()[0].kind, DisplayRowKind::User);
    assert_eq!(transcript.rows()[0].text, "you: hello");
    assert_eq!(transcript.rows()[1].kind, DisplayRowKind::Assistant);
    assert_eq!(transcript.rows()[1].text, "assistant: hi there");
    assert_eq!(transcript.current_turn().state, TurnState::Completed);
}

#[test]
fn reduces_text_delta_then_authoritative_final_message() {
    let mut transcript = EventTranscript::default();

    transcript.apply_events(&[
        event(1, serde_json::json!({"type":"text_delta","text":"partial "})),
        event(2, serde_json::json!({"type":"text_delta","text":"answer"})),
        event(3, serde_json::json!({"type":"message_end","message":{"role":"assistant","content":"final answer"}})),
    ]);

    assert!(transcript
        .rows()
        .iter()
        .any(|row| row.text == "assistant: partial answer"));
    assert!(transcript
        .rows()
        .iter()
        .any(|row| row.text == "assistant: final answer"));
}

#[test]
fn reduces_thinking_lifecycle_as_progress_row() {
    let mut transcript = EventTranscript::default();

    transcript.apply_events(&[
        event(1, serde_json::json!({"type":"thinking_start"})),
        event(
            2,
            serde_json::json!({"type":"thinking_delta","text":"checking tools"}),
        ),
        event(3, serde_json::json!({"type":"thinking_end"})),
    ]);

    let thinking = transcript
        .rows()
        .iter()
        .find(|row| row.kind == DisplayRowKind::Thinking)
        .expect("thinking row should exist");
    assert_eq!(thinking.text, "thinking: checking tools");
    assert_eq!(transcript.current_turn().state, TurnState::WaitingForFinal);
}

#[test]
fn reduces_tool_success_and_error() {
    let mut success = EventTranscript::default();
    success.apply_events(&[
        event(1, serde_json::json!({"type":"tool_start","toolCallId":"abc","toolName":"list_capabilities"})),
        event(2, serde_json::json!({"type":"tool","toolCallId":"abc","toolName":"list_capabilities"})),
    ]);
    assert!(success
        .rows()
        .iter()
        .any(|row| row.text == "tool: list_capabilities completed"));

    let mut failure = EventTranscript::default();
    failure.apply_events(&[
        event(1, serde_json::json!({"type":"tool_start","toolCallId":"abc","toolName":"list_capabilities"})),
        event(2, serde_json::json!({"type":"tool","toolCallId":"abc","toolName":"list_capabilities","error":"boom"})),
    ]);
    assert!(failure.rows().iter().any(
        |row| row.text == "tool: list_capabilities failed" && row.kind == DisplayRowKind::Error
    ));
    assert_eq!(failure.current_turn().state, TurnState::Failed);
}

#[test]
fn reduces_task_success_and_error() {
    let mut success = EventTranscript::default();
    success.apply_events(&[
        event(
            1,
            serde_json::json!({"type":"task_start","taskId":"task-1","taskName":"researcher"}),
        ),
        event(
            2,
            serde_json::json!({"type":"task","taskId":"task-1","taskName":"researcher"}),
        ),
    ]);
    assert!(success
        .rows()
        .iter()
        .any(|row| row.text == "task: researcher completed"));

    let mut failure = EventTranscript::default();
    failure.apply_events(&[
        event(1, serde_json::json!({"type":"task_start","taskId":"task-1","taskName":"researcher"})),
        event(2, serde_json::json!({"type":"task","taskId":"task-1","taskName":"researcher","error":true})),
    ]);
    assert!(failure
        .rows()
        .iter()
        .any(|row| row.text == "task: researcher failed" && row.kind == DisplayRowKind::Error));
    assert_eq!(failure.current_turn().state, TurnState::Failed);
}

#[test]
fn replayed_events_do_not_duplicate_rows() {
    let mut transcript = EventTranscript::default();
    let batch = vec![
        event(1, serde_json::json!({"type":"thinking_delta","text":"one"})),
        event(
            2,
            serde_json::json!({"type":"tool_start","toolCallId":"a","toolName":"lookup"}),
        ),
    ];

    transcript.apply_events(&batch);
    transcript.apply_events(&batch);

    assert_eq!(transcript.rows().len(), 2);
}

#[test]
fn unknown_events_do_not_crash_or_add_rows() {
    let mut transcript = EventTranscript::default();

    transcript.apply_event(&event(
        1,
        serde_json::json!({"type":"future_event","payload":true}),
    ));

    assert!(transcript.rows().is_empty());
    assert_eq!(transcript.current_turn().state, TurnState::Ready);
}

#[test]
fn unindexed_identical_events_are_processed_as_separate_occurrences() {
    let mut transcript = EventTranscript::default();

    transcript.apply_events(&[
        FlueEvent::from_value(serde_json::json!({"type":"message_end","message":{"role":"assistant","content":"same"}})),
        FlueEvent::from_value(serde_json::json!({"type":"message_end","message":{"role":"assistant","content":"same"}})),
    ]);

    let assistant_rows = transcript
        .rows()
        .iter()
        .filter(|row| row.text == "assistant: same")
        .count();
    assert_eq!(assistant_rows, 2);
}

#[test]
fn second_turn_recreates_ephemeral_stream_rows_in_order() {
    let mut transcript = EventTranscript::default();

    transcript.apply_events(&[
        event(1, serde_json::json!({"type":"turn_start","timestamp":"2026-07-03T00:00:00Z"})),
        event(2, serde_json::json!({"type":"text_delta","timestamp":"2026-07-03T00:00:01Z","text":"first"})),
        event(3, serde_json::json!({"type":"turn","timestamp":"2026-07-03T00:00:02Z"})),
        event(1, serde_json::json!({"type":"turn_start","timestamp":"2026-07-03T00:01:00Z"})),
        event(2, serde_json::json!({"type":"text_delta","timestamp":"2026-07-03T00:01:01Z","text":"second"})),
    ]);

    let rows = transcript.rows();
    let first_stream = rows
        .iter()
        .position(|row| row.text == "assistant: first")
        .expect("first turn stream row should remain");
    let second_turn = rows
        .iter()
        .position(|row| row.text == "turn: model active")
        .expect("second turn row should be inserted");
    let second_stream = rows
        .iter()
        .position(|row| row.text == "assistant: second")
        .expect("second turn stream row should be inserted");

    assert!(first_stream < second_turn);
    assert!(second_turn < second_stream);
    assert_eq!(transcript.current_turn().state, TurnState::ModelActive);
}

#[test]
fn tool_without_tool_call_id_reuses_name_based_fallback_row() {
    let mut transcript = EventTranscript::default();

    transcript.apply_events(&[
        event(
            1,
            serde_json::json!({"type":"tool_start","toolName":"lookup docs"}),
        ),
        event(
            2,
            serde_json::json!({"type":"thinking_delta","text":"between"}),
        ),
        event(
            3,
            serde_json::json!({"type":"tool","toolName":"lookup docs"}),
        ),
    ]);

    let tool_rows = transcript
        .rows()
        .iter()
        .filter(|row| row.text.starts_with("tool: lookup docs"))
        .collect::<Vec<_>>();
    assert_eq!(tool_rows.len(), 1);
    assert_eq!(tool_rows[0].text, "tool: lookup docs completed");
}

#[test]
fn is_error_marks_tool_task_turn_and_operation_failures() {
    let mut transcript = EventTranscript::default();

    transcript.apply_events(&[
        event(
            1,
            serde_json::json!({"type":"tool","toolName":"lookup","isError":true}),
        ),
        event(
            2,
            serde_json::json!({"type":"task","taskName":"research","isError":true}),
        ),
        event(
            3,
            serde_json::json!({"type":"operation","operationName":"plan","isError":true}),
        ),
        event(4, serde_json::json!({"type":"turn","isError":true})),
    ]);

    assert!(transcript
        .rows()
        .iter()
        .any(|row| row.text == "tool: lookup failed" && row.kind == DisplayRowKind::Error));
    assert!(transcript
        .rows()
        .iter()
        .any(|row| row.text == "task: research failed" && row.kind == DisplayRowKind::Error));
    assert!(transcript
        .rows()
        .iter()
        .any(|row| row.text == "operation: plan failed" && row.kind == DisplayRowKind::Error));
    assert!(transcript
        .rows()
        .iter()
        .any(|row| row.text == "turn: failed" && row.kind == DisplayRowKind::Error));
    assert_eq!(transcript.current_turn().state, TurnState::Failed);
}

fn event(index: u64, value: serde_json::Value) -> FlueEvent {
    let mut value = value;
    value["eventIndex"] = serde_json::json!(index);
    FlueEvent::from_value(value)
}
