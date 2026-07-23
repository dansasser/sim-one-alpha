use sim_one_ratatui_tui::flue::events::FlueEvent;
use sim_one_ratatui_tui::flue::reducer::{DisplayRowKind, EventTranscript, TurnState};
use sim_one_ratatui_tui::history::{
    TranscriptActivity, TranscriptActivityKind, TranscriptActivityStatus,
    TranscriptAssistantMessage, TranscriptExchange, TranscriptPrompt, TranscriptPromptVisibility,
};
use sim_one_ratatui_tui::transcript::{
    format_event_duration, TranscriptDocument, TranscriptLineKind,
};

#[test]
fn event_duration_format_is_stable_across_millisecond_to_hour_ranges() {
    assert_eq!(format_event_duration(13), "13ms");
    assert_eq!(format_event_duration(5_900), "5.9s");
    assert_eq!(format_event_duration(72_000), "1m 12s");
    assert_eq!(format_event_duration(3_720_000), "1h 02m");
}

#[test]
fn transcript_document_renders_snapshot_prompt_activity_and_final_in_order() {
    let mut document = TranscriptDocument::default();
    document.install_snapshot(vec![TranscriptExchange {
        id: "submission:snapshot".to_string(),
        submission_id: "snapshot".to_string(),
        prompt: Some(TranscriptPrompt {
            id: "prompt:snapshot".to_string(),
            text: "Summarize the release\nand include risks.".to_string(),
            received_at: "2026-07-23T10:00:00Z".to_string(),
            visibility: TranscriptPromptVisibility::User,
        }),
        activities: vec![TranscriptActivity {
            id: "snapshot:operation:root".to_string(),
            kind: TranscriptActivityKind::Operation,
            name: "orchestrate".to_string(),
            status: TranscriptActivityStatus::Completed,
            started_at: Some("2026-07-23T10:00:01Z".to_string()),
            completed_at: Some("2026-07-23T10:00:07Z".to_string()),
            duration_ms: Some(5_900),
            preview: None,
            error: None,
        }],
        assistant: Some(TranscriptAssistantMessage {
            id: "snapshot:message:9".to_string(),
            text: "Release summary\n\n- Risk one".to_string(),
            completed_at: "2026-07-23T10:00:08Z".to_string(),
        }),
        status: TranscriptActivityStatus::Completed,
    }]);

    let lines = document.lines();
    let texts = lines
        .iter()
        .map(|line| line.text.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        texts,
        [
            "you: Summarize the release",
            "  and include risks.",
            "operation: orchestrate completed in 5.9s",
            "assistant: Release summary",
            "  ",
            "  - Risk one",
        ]
    );
    assert_eq!(lines[2].kind, TranscriptLineKind::Operation);
    assert_eq!(lines[3].kind, TranscriptLineKind::Assistant);
}

#[test]
fn transcript_document_hides_internal_prompt_but_keeps_its_greeting() {
    let mut document = TranscriptDocument::default();
    document.install_snapshot(vec![TranscriptExchange {
        id: "submission:greeting".to_string(),
        submission_id: "greeting".to_string(),
        prompt: Some(TranscriptPrompt {
            id: "prompt:greeting".to_string(),
            text: "INTERNAL_STARTUP_SENTINEL".to_string(),
            received_at: "2026-07-23T10:00:00Z".to_string(),
            visibility: TranscriptPromptVisibility::Internal,
        }),
        activities: Vec::new(),
        assistant: Some(TranscriptAssistantMessage {
            id: "greeting:message:4".to_string(),
            text: "Hello Daniel. All systems go.".to_string(),
            completed_at: "2026-07-23T10:00:02Z".to_string(),
        }),
        status: TranscriptActivityStatus::Completed,
    }]);

    let transcript = document
        .lines()
        .into_iter()
        .map(|line| line.text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!transcript.contains("INTERNAL_STARTUP_SENTINEL"));
    assert!(transcript.contains("assistant: Hello Daniel. All systems go."));
}

#[test]
fn transcript_document_updates_live_activities_in_place_with_durations() {
    let mut document = TranscriptDocument::default();
    let events = [
        event_for(
            "live-a",
            1,
            serde_json::json!({
                "type":"operation_start",
                "operationId":"root",
                "operationKind":"orchestrate"
            }),
        ),
        event_for(
            "live-a",
            2,
            serde_json::json!({
                "type":"tool_start",
                "toolCallId":"docs",
                "toolName":"load_protocols"
            }),
        ),
        event_for(
            "live-a",
            3,
            serde_json::json!({
                "type":"tool",
                "toolCallId":"docs",
                "toolName":"load_protocols",
                "durationMs":13
            }),
        ),
        event_for(
            "live-a",
            4,
            serde_json::json!({
                "type":"operation",
                "operationId":"root",
                "operationKind":"orchestrate",
                "durationMs":72_000
            }),
        ),
    ];

    document.apply_events(&events);
    document.apply_events(&events);

    let lines = document.lines();
    assert_eq!(
        lines
            .iter()
            .filter(|line| line.text.starts_with("tool: load_protocols"))
            .count(),
        1
    );
    assert!(lines
        .iter()
        .any(|line| line.text == "tool: load_protocols completed in 13ms"));
    assert!(lines
        .iter()
        .any(|line| line.text == "operation: orchestrate completed in 1m 12s"));
}

#[test]
fn transcript_document_scopes_repeated_event_indexes_to_submission() {
    let mut document = TranscriptDocument::default();
    document.apply_events(&[
        event_for(
            "submission-a",
            1,
            serde_json::json!({
                "type":"message_end",
                "message":{"role":"assistant","content":"first answer"}
            }),
        ),
        event_for(
            "submission-b",
            1,
            serde_json::json!({
                "type":"message_end",
                "message":{"role":"assistant","content":"second answer"}
            }),
        ),
    ]);

    let transcript = document
        .lines()
        .into_iter()
        .map(|line| line.text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(transcript.contains("assistant: first answer"));
    assert!(transcript.contains("assistant: second answer"));
    assert_eq!(document.exchanges().len(), 2);
}

#[test]
fn transcript_document_rejects_nested_empty_and_tool_result_messages() {
    let mut document = TranscriptDocument::default();
    document.apply_events(&[
        event_for(
            "root",
            1,
            serde_json::json!({
                "type":"message_end",
                "parentSession":"worker-1",
                "message":{"role":"assistant","content":"NESTED_SENTINEL"}
            }),
        ),
        event_for(
            "root",
            2,
            serde_json::json!({
                "type":"message_end",
                "message":{"role":"assistant","content":"   "}
            }),
        ),
        event_for(
            "root",
            3,
            serde_json::json!({
                "type":"message_end",
                "message":{"role":"toolResult","content":"TOOL_RESULT_SENTINEL"}
            }),
        ),
        event_for(
            "root",
            4,
            serde_json::json!({
                "type":"message_end",
                "message":{"role":"assistant","content":"visible root final"}
            }),
        ),
    ]);

    let transcript = document
        .lines()
        .into_iter()
        .map(|line| line.text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!transcript.contains("NESTED_SENTINEL"));
    assert!(!transcript.contains("TOOL_RESULT_SENTINEL"));
    assert_eq!(
        transcript
            .lines()
            .filter(|line| line.starts_with("assistant:"))
            .count(),
        1
    );
    assert!(transcript.contains("assistant: visible root final"));
}

#[test]
fn completed_snapshot_exchange_is_immutable_under_replayed_live_events() {
    let mut document = TranscriptDocument::default();
    document.install_snapshot(vec![TranscriptExchange {
        id: "snapshot-final".to_string(),
        submission_id: "snapshot-final".to_string(),
        prompt: None,
        activities: Vec::new(),
        assistant: Some(TranscriptAssistantMessage {
            id: "snapshot-final:message:1".to_string(),
            text: "authoritative saved answer".to_string(),
            completed_at: "2026-07-23T10:00:00Z".to_string(),
        }),
        status: TranscriptActivityStatus::Completed,
    }]);

    document.apply_event(&event_for(
        "snapshot-final",
        99,
        serde_json::json!({
            "type":"message_end",
            "message":{"role":"assistant","content":"STALE_REPLAY"}
        }),
    ));

    let transcript = document
        .lines()
        .into_iter()
        .map(|line| line.text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(transcript.contains("authoritative saved answer"));
    assert!(!transcript.contains("STALE_REPLAY"));
}

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
fn nested_worker_text_delta_does_not_enter_the_root_assistant_stream() {
    let mut transcript = EventTranscript::default();

    transcript.apply_events(&[
        event(
            1,
            serde_json::json!({
                "type":"text_delta",
                "text":"CHILD_RAW_OUTPUT",
                "session":"task:default:worker-1",
                "parentSession":"default"
            }),
        ),
        event(
            2,
            serde_json::json!({"type":"text_delta","text":"root answer","session":"default"}),
        ),
    ]);

    assert_eq!(
        transcript.current_assistant_stream_text(),
        Some("root answer")
    );
    assert!(!transcript
        .rows()
        .iter()
        .any(|row| row.text.contains("CHILD_RAW_OUTPUT")));
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
fn tool_without_tool_call_id_does_not_rewrite_same_name_history_across_turns() {
    let mut transcript = EventTranscript::default();

    transcript.apply_events(&[
        event(1, serde_json::json!({"type":"turn_start","timestamp":"2026-07-03T00:00:00Z"})),
        event(
            2,
            serde_json::json!({"type":"tool_start","toolName":"lookup docs"}),
        ),
        event(3, serde_json::json!({"type":"tool","toolName":"lookup docs"})),
        event(1, serde_json::json!({"type":"turn_start","timestamp":"2026-07-03T00:01:00Z"})),
        event(
            2,
            serde_json::json!({"type":"tool_start","toolName":"lookup docs","timestamp":"2026-07-03T00:01:01Z"}),
        ),
        event(
            3,
            serde_json::json!({"type":"tool","toolName":"lookup docs","timestamp":"2026-07-03T00:01:02Z"}),
        ),
    ]);

    let completed_tools = transcript
        .rows()
        .iter()
        .filter(|row| row.text == "tool: lookup docs completed")
        .count();
    assert_eq!(completed_tools, 2);
}

#[test]
fn unindexed_same_name_tasks_keep_separate_occurrences() {
    let mut transcript = EventTranscript::default();

    transcript.apply_events(&[
        event(
            1,
            serde_json::json!({"type":"task_start","taskName":"research"}),
        ),
        event(
            2,
            serde_json::json!({"type":"task_start","taskName":"research"}),
        ),
        event(3, serde_json::json!({"type":"task","taskName":"research"})),
        event(4, serde_json::json!({"type":"task","taskName":"research"})),
    ]);

    let task_rows = transcript
        .rows()
        .iter()
        .filter(|row| row.text == "task: research completed")
        .collect::<Vec<_>>();
    assert_eq!(task_rows.len(), 2);
    assert!(task_rows.iter().all(|row| row.kind == DisplayRowKind::Task));
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

fn event_for(submission_id: &str, index: u64, value: serde_json::Value) -> FlueEvent {
    let mut value = value;
    value["submissionId"] = serde_json::json!(submission_id);
    value["eventIndex"] = serde_json::json!(index);
    value["timestamp"] = serde_json::json!(format!("2026-07-23T10:00:{index:02}Z"));
    FlueEvent::from_value(value)
}
