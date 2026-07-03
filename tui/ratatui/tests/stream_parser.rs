use sim_one_ratatui_tui::flue::stream::{
    parse_catch_up_response, parse_sse_frame, SseFrame, SseParser,
};

#[test]
fn parses_catch_up_json_array_and_stream_headers() {
    let response = concat!(
        "HTTP/1.1 200 OK\r\n",
        "Stream-Next-Offset: 0000000000000000_0000000000000002\r\n",
        "Stream-Up-To-Date: true\r\n",
        "Stream-Closed: false\r\n",
        "\r\n",
        r#"[{"type":"message_end","eventIndex":2,"timestamp":"2026-07-03T00:00:00Z"}]"#
    );

    let batch = parse_catch_up_response(response.as_bytes()).expect("catch-up should parse");

    assert_eq!(batch.events.len(), 1);
    assert_eq!(batch.events[0].event_type, "message_end");
    assert_eq!(batch.events[0].event_index, Some(2));
    assert_eq!(
        batch.next_offset.as_deref(),
        Some("0000000000000000_0000000000000002")
    );
    assert!(batch.up_to_date);
    assert!(!batch.stream_closed);
}

#[test]
fn parses_sse_data_frame_with_event_array() {
    let frame = parse_sse_frame(
        "event: data\n\
data: [{\"type\":\"thinking_delta\",\"eventIndex\":4},{\"type\":\"tool_start\"}]\n",
    )
    .expect("sse frame should parse")
    .expect("data frame should produce output");

    match frame {
        SseFrame::Events(events) => {
            assert_eq!(events.len(), 2);
            assert_eq!(events[0].event_type, "thinking_delta");
            assert_eq!(events[0].event_index, Some(4));
            assert_eq!(events[1].event_type, "tool_start");
        }
        other => panic!("expected events frame, got {other:?}"),
    }
}

#[test]
fn parses_sse_control_frame() {
    let frame = parse_sse_frame(
        "event: control\n\
data: {\"streamNextOffset\":\"0000000000000000_0000000000000005\",\"upToDate\":true,\"streamClosed\":false}\n",
    )
    .expect("control frame should parse")
    .expect("control frame should produce output");

    match frame {
        SseFrame::Control(control) => {
            assert_eq!(
                control.stream_next_offset.as_deref(),
                Some("0000000000000000_0000000000000005")
            );
            assert!(control.up_to_date);
            assert!(!control.stream_closed);
        }
        other => panic!("expected control frame, got {other:?}"),
    }
}

#[test]
fn ignores_sse_heartbeat_comments() {
    let mut parser = SseParser::default();
    let frames = parser
        .push_str(": heartbeat\n\n")
        .expect("heartbeat should parse");

    assert!(frames.is_empty());
}

#[test]
fn parses_split_sse_frames_incrementally() {
    let mut parser = SseParser::default();

    assert!(parser
        .push_str("event: data\n")
        .expect("partial frame should parse")
        .is_empty());
    let frames = parser
        .push_str("data: [{\"type\":\"text_delta\"}]\n\n")
        .expect("completed frame should parse");

    assert_eq!(frames.len(), 1);
    match &frames[0] {
        SseFrame::Events(events) => assert_eq!(events[0].event_type, "text_delta"),
        other => panic!("expected events frame, got {other:?}"),
    }
}

#[test]
fn rejects_malformed_sse_json_without_panicking() {
    let error = parse_sse_frame("event: data\ndata: not-json\n")
        .expect_err("malformed data frame should fail");

    assert!(error.contains("invalid JSON"), "{error}");
}
