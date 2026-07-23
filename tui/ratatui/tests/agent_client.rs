use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::thread;

use sim_one_ratatui_tui::agent::{
    create_chat_session, list_chat_sessions, resume_chat_session, send_agent_prompt,
    send_agent_prompt_reply, AgentPromptOrigin,
};

#[test]
fn posts_prompt_to_tui_chat_event_endpoint_and_extracts_text() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("test server should bind");
    let port = listener
        .local_addr()
        .expect("test server should have address")
        .port();
    let (tx, rx) = mpsc::channel();

    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("client should connect");
        let request = read_http_request(&mut stream);
        tx.send(request).expect("request should be reported");

        let body = r#"{"result":{"text":"real agent response"}}"#;
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .expect("response should be writable");
    });

    let response = send_agent_prompt(
        &format!("http://127.0.0.1:{port}"),
        "session with spaces",
        "hello agent",
    )
    .expect("agent prompt should return response text");

    assert_eq!(response, "real agent response");
    let request = rx.recv().expect("request should be captured");
    assert!(request.starts_with("POST /api/chat/events HTTP/1.1"));
    let body = request_body_json(&request);
    assert_eq!(
        body.get("connector").and_then(|value| value.as_str()),
        Some("tui")
    );
    assert_eq!(
        body.get("text").and_then(|value| value.as_str()),
        Some("hello agent")
    );
    assert_eq!(
        body.get("actorId").and_then(|value| value.as_str()),
        Some("local-tui")
    );
    assert_eq!(
        body.get("actorDisplayName")
            .and_then(|value| value.as_str()),
        Some("Local TUI")
    );
    assert_eq!(
        body.get("conversationId").and_then(|value| value.as_str()),
        Some("local-tui")
    );
    assert_eq!(
        body.get("threadId").and_then(|value| value.as_str()),
        Some("local-tui")
    );
    assert_eq!(
        body.get("session").and_then(|value| value.as_str()),
        Some("session with spaces")
    );
    assert_eq!(body.get("workflow"), None);
}

#[test]
fn extracts_submission_correlation_metadata_from_agent_response() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("test server should bind");
    let port = listener
        .local_addr()
        .expect("test server should have address")
        .port();

    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("client should connect");
        let _ = read_http_request(&mut stream);
        let body = r#"{"result":{"text":"correlated response"},"submission":{"id":"submission-42"},"offset":"0000000000000000_0000000000000042"}"#;
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .expect("response should be writable");
    });

    let response = send_agent_prompt_reply(
        &format!("http://127.0.0.1:{port}"),
        "tui-correlation",
        "correlate this",
        AgentPromptOrigin::User,
    )
    .expect("agent prompt should return correlation metadata");

    assert_eq!(response.text, "correlated response");
    assert_eq!(response.submission_id.as_deref(), Some("submission-42"));
    assert_eq!(
        response.stream_offset.as_deref(),
        Some("0000000000000000_0000000000000042")
    );
}

#[test]
fn tags_only_startup_preflight_prompts_with_the_internal_workflow() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("test server should bind");
    let port = listener
        .local_addr()
        .expect("test server should have address")
        .port();
    let (tx, rx) = mpsc::channel();

    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("client should connect");
        let request = read_http_request(&mut stream);
        tx.send(request).expect("request should be reported");

        let body = r#"{"result":{"text":"startup greeting"}}"#;
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .expect("response should be writable");
    });

    let prompt = "Use greeting-preflight with status = \"all systems go\".";
    let response = send_agent_prompt_reply(
        &format!("http://127.0.0.1:{port}"),
        "tui-startup-1",
        prompt,
        AgentPromptOrigin::StartupPreflight,
    )
    .expect("startup prompt should return response metadata");

    assert_eq!(response.text, "startup greeting");
    let body = request_body_json(&rx.recv().expect("request should be captured"));
    assert_eq!(
        body.get("text").and_then(|value| value.as_str()),
        Some(prompt)
    );
    assert_eq!(
        body.get("workflow").and_then(|value| value.as_str()),
        Some("tui.startup-preflight")
    );
}

#[test]
fn creates_fresh_tui_session_through_lifecycle_endpoint() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("test server should bind");
    let port = listener
        .local_addr()
        .expect("test server should have address")
        .port();
    let (tx, rx) = mpsc::channel();

    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("client should connect");
        let request = read_http_request(&mut stream);
        tx.send(request).expect("request should be reported");

        let body = r#"{"session":{"id":"tui-123","surface":"tui","created":true}}"#;
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .expect("response should be writable");
    });

    let response = create_chat_session(&format!("http://127.0.0.1:{port}"))
        .expect("fresh session creation should return metadata");

    assert_eq!(response.id, "tui-123");
    assert_eq!(response.title, None);
    assert!(response.created);
    let request = rx.recv().expect("request should be captured");
    assert!(request.starts_with("POST /api/chat/sessions HTTP/1.1"));
    let body = request_body_json(&request);
    assert_eq!(
        body,
        serde_json::json!({
            "connector": "tui",
            "actorId": "local-tui",
            "conversationId": "local-tui",
            "threadId": "local-tui"
        })
    );
}

#[test]
fn resumes_owned_tui_session_and_preserves_utf8_title() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("test server should bind");
    let port = listener
        .local_addr()
        .expect("test server should have address")
        .port();
    let (tx, rx) = mpsc::channel();

    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("client should connect");
        let request = read_http_request(&mut stream);
        tx.send(request).expect("request should be reported");

        let body = r#"{"session":{"id":"tui/owned session","surface":"tui","created":false,"title":"Renamed café 👋"}}"#;
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .expect("response should be writable");
    });

    let response = resume_chat_session(&format!("http://127.0.0.1:{port}"), "tui/owned session")
        .expect("owned session resume should return metadata");

    assert_eq!(response.id, "tui/owned session");
    assert_eq!(response.title.as_deref(), Some("Renamed café 👋"));
    assert!(!response.created);
    let request = rx.recv().expect("request should be captured");
    assert!(request.starts_with("POST /api/chat/sessions/tui%2Fowned%20session/resume HTTP/1.1"));
    assert_eq!(
        request_body_json(&request),
        serde_json::json!({
            "connector": "tui",
            "actorId": "local-tui",
            "conversationId": "local-tui",
            "threadId": "local-tui"
        })
    );
}

#[test]
fn scopes_tui_session_list_to_the_local_identity() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("test server should bind");
    let port = listener
        .local_addr()
        .expect("test server should have address")
        .port();
    let (tx, rx) = mpsc::channel();

    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("client should connect");
        let request = read_http_request(&mut stream);
        tx.send(request).expect("request should be reported");
        let body = r#"{"sessions":[]}"#;
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .expect("response should be writable");
    });

    let sessions = list_chat_sessions(&format!("http://127.0.0.1:{port}"), 12)
        .expect("scoped session list should parse");
    assert!(sessions.is_empty());
    let request = rx.recv().expect("request should be captured");
    assert!(request.starts_with(
        "GET /api/chat/sessions?connector=tui&actorId=local-tui&conversationId=local-tui&threadId=local-tui&limit=12 HTTP/1.1"
    ));
}

#[test]
fn lifecycle_client_rejects_denied_invalid_and_missing_metadata_responses() {
    for (status, body, expected) in [
        (403, r#"{"error":"denied"}"#, "HTTP 403"),
        (200, "not json", "invalid JSON"),
        (200, r#"{"session":{"created":true}}"#, "session metadata"),
    ] {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("test server should bind");
        let port = listener
            .local_addr()
            .expect("test server should have address")
            .port();

        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("client should connect");
            let _ = read_http_request(&mut stream);
            write!(
                stream,
                "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("response should be writable");
        });

        let error = create_chat_session(&format!("http://127.0.0.1:{port}"))
            .expect_err("invalid lifecycle response should fail");
        assert!(error.contains(expected), "unexpected error: {error}");
    }
}

#[test]
fn decodes_chunked_lifecycle_response_before_utf8_conversion() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("test server should bind");
    let port = listener
        .local_addr()
        .expect("test server should have address")
        .port();

    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("client should connect");
        let _ = read_http_request(&mut stream);
        let body =
            r#"{"session":{"id":"tui-unicode","surface":"tui","created":true,"title":"Hello 👋"}}"#;
        let split = body
            .as_bytes()
            .windows(4)
            .position(|window| window == "👋".as_bytes())
            .expect("emoji should be present")
            + 2;
        write!(
            stream,
            "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n",
            split
        )
        .expect("response headers should be writable");
        stream
            .write_all(&body.as_bytes()[..split])
            .expect("first chunk should be writable");
        write!(stream, "\r\n{:x}\r\n", body.len() - split)
            .expect("second chunk header should be writable");
        stream
            .write_all(&body.as_bytes()[split..])
            .expect("second chunk should be writable");
        write!(stream, "\r\n0\r\n\r\n").expect("final chunk should be writable");
    });

    let response = create_chat_session(&format!("http://127.0.0.1:{port}"))
        .expect("chunked lifecycle response should parse");
    assert_eq!(response.id, "tui-unicode");
    assert_eq!(response.title.as_deref(), Some("Hello 👋"));
}

#[test]
fn extracts_command_session_metadata_from_chat_event_response() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("test server should bind");
    let port = listener
        .local_addr()
        .expect("test server should have address")
        .port();

    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("client should connect");
        let _ = read_http_request(&mut stream);

        let body = r#"{"result":{"text":"Started new session tui-123.","command":{"name":"new","handled":true}},"session":{"id":"tui-123","surface":"tui","created":true,"title":"Demo"}}"#;
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .expect("response should be writable");
    });

    let response = send_agent_prompt_reply(
        &format!("http://127.0.0.1:{port}"),
        "tui-existing-1",
        "/new Demo",
        AgentPromptOrigin::User,
    )
    .expect("agent prompt should return response metadata");

    assert_eq!(response.text, "Started new session tui-123.");
    assert_eq!(response.session_id.as_deref(), Some("tui-123"));
    assert_eq!(response.session_title.as_deref(), Some("Demo"));
    assert_eq!(response.command_name.as_deref(), Some("new"));
    assert_eq!(response.session_created, Some(true));
}

#[test]
fn decodes_chunked_agent_response_before_utf8_conversion() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("test server should bind");
    let port = listener
        .local_addr()
        .expect("test server should have address")
        .port();

    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("client should connect");
        let _ = read_http_request(&mut stream);

        let body = r#"{"result":{"text":"real response 👋"}}"#;
        let split = body
            .as_bytes()
            .windows(4)
            .position(|window| window == "👋".as_bytes())
            .expect("emoji should be present")
            + 2;
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n",
            split
        )
        .expect("response headers should be writable");
        stream
            .write_all(&body.as_bytes()[..split])
            .expect("first chunk should be writable");
        write!(stream, "\r\n{:x}\r\n", body.len() - split)
            .expect("second chunk header should be writable");
        stream
            .write_all(&body.as_bytes()[split..])
            .expect("second chunk should be writable");
        write!(stream, "\r\n0\r\n\r\n").expect("final chunk should be writable");
    });

    let response = send_agent_prompt(
        &format!("http://127.0.0.1:{port}"),
        "tui-existing-1",
        "hello agent",
    )
    .expect("agent prompt should decode chunked response");

    assert_eq!(response, "real response 👋");
}

fn read_http_request(stream: &mut impl Read) -> String {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 1024];
    loop {
        let read = stream
            .read(&mut buffer)
            .expect("request should be readable");
        assert!(read > 0, "request ended before headers");
        bytes.extend_from_slice(&buffer[..read]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }

    let header_end = bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("header end should exist")
        + 4;
    let headers = String::from_utf8_lossy(&bytes[..header_end]);
    let content_length = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length").then(|| {
                value
                    .trim()
                    .parse::<usize>()
                    .expect("content length should parse")
            })
        })
        .unwrap_or(0);

    while bytes.len() < header_end + content_length {
        let read = stream.read(&mut buffer).expect("body should be readable");
        assert!(read > 0, "request ended before body");
        bytes.extend_from_slice(&buffer[..read]);
    }

    String::from_utf8(bytes).expect("request should be utf8")
}

fn request_body_json(request: &str) -> serde_json::Value {
    let body = request
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .expect("request should contain a body");
    serde_json::from_str(body).expect("request body should be json")
}
