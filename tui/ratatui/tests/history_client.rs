use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::mpsc;
use std::thread;

use sim_one_ratatui_tui::history::{
    load_chat_transcript, TranscriptActivityKind, TranscriptActivityStatus,
    TranscriptPromptVisibility,
};

#[test]
fn loads_the_typed_transcript_contract_with_optional_and_future_fields() {
    let body = r#"{
        "session":{"id":"tui/resumed session","title":"Release café 👋"},
        "exchanges":[{
            "id":"submission-greeting",
            "submissionId":"submission-greeting",
            "prompt":{
                "id":"prompt-greeting",
                "text":"internal\nstartup",
                "receivedAt":"2026-07-20T19:08:05.000Z",
                "visibility":"internal"
            },
            "activities":[{
                "id":"submission-greeting:tool:protocols",
                "kind":"tool",
                "name":"load_protocols",
                "status":"completed",
                "durationMs":13,
                "futureActivityField":true
            },{
                "id":"submission-greeting:future:1",
                "kind":"future_activity",
                "name":"future",
                "status":"running"
            }],
            "assistant":{
                "id":"submission-greeting:message:4",
                "text":"Hi **Daniel**.\n\nReady 👋",
                "completedAt":"2026-07-20T19:08:06.000Z"
            },
            "status":"completed",
            "futureExchangeField":{"ignored":true}
        },{
            "id":"submission-failed",
            "submissionId":"submission-failed",
            "activities":[{
                "id":"submission-failed:operation:op-1",
                "kind":"operation",
                "name":"prompt",
                "status":"failed",
                "error":"Operation failed."
            }],
            "status":"failed"
        }],
        "stream":{
            "nextOffset":"0000000000000000_0000000000000034",
            "upToDate":true
        },
        "page":{
            "limit":50,
            "hasOlder":true,
            "before":"cursor / + = 👋"
        },
        "futureTopLevelField":"ignored"
    }"#;
    let (base_url, request) = serve_once(200, body);

    let page = load_chat_transcript(
        &base_url,
        "tui/resumed session",
        50,
        Some("cursor / + = 👋"),
    )
    .expect("valid history response should parse");

    assert_eq!(page.session.id, "tui/resumed session");
    assert_eq!(page.session.title.as_deref(), Some("Release café 👋"));
    assert_eq!(page.exchanges.len(), 2);
    assert_eq!(
        page.exchanges[0]
            .prompt
            .as_ref()
            .expect("internal prompt should parse")
            .visibility,
        TranscriptPromptVisibility::Internal
    );
    assert_eq!(
        page.exchanges[0]
            .assistant
            .as_ref()
            .expect("assistant should parse")
            .text,
        "Hi **Daniel**.\n\nReady 👋"
    );
    assert_eq!(
        page.exchanges[0].activities[0].kind,
        TranscriptActivityKind::Tool
    );
    assert_eq!(
        page.exchanges[0].activities[1].kind,
        TranscriptActivityKind::Unknown
    );
    assert_eq!(page.exchanges[1].status, TranscriptActivityStatus::Failed);
    assert_eq!(page.stream.next_offset, "0000000000000000_0000000000000034");
    assert!(page.stream.up_to_date);
    assert_eq!(page.page.limit, 50);
    assert!(page.page.has_older);
    assert_eq!(page.page.before.as_deref(), Some("cursor / + = 👋"));

    let request = request.recv().expect("request should be captured");
    assert!(request.starts_with("GET /api/chat/sessions/tui%2Fresumed%20session/transcript?"));
    assert!(request.contains("connector=tui"));
    assert!(request.contains("actorId=local-tui"));
    assert!(request.contains("conversationId=local-tui"));
    assert!(request.contains("threadId=local-tui"));
    assert!(request.contains("limit=50"));
    assert!(request.contains("before=cursor%20%2F%20%2B%20%3D%20%F0%9F%91%8B"));
}

#[test]
fn accepts_missing_optional_fields() {
    let body = r#"{
        "session":{"id":"tui-minimal"},
        "exchanges":[{
            "id":"submission-minimal",
            "submissionId":"submission-minimal",
            "activities":[],
            "status":"running"
        }],
        "stream":{"nextOffset":"-1","upToDate":true},
        "page":{"limit":25,"hasOlder":false}
    }"#;
    let (base_url, _) = serve_once(200, body);

    let page = load_chat_transcript(&base_url, "tui-minimal", 25, None)
        .expect("optional fields should not be required");

    assert_eq!(page.session.title, None);
    assert_eq!(page.exchanges[0].prompt, None);
    assert_eq!(page.exchanges[0].assistant, None);
    assert_eq!(page.page.before, None);
}

#[test]
fn rejects_malformed_or_incomplete_history_and_non_success_status() {
    for (status, body, expected) in [
        (200, "not-json", "invalid transcript JSON"),
        (
            200,
            r#"{"session":{"id":"tui-1"},"exchanges":[]}"#,
            "invalid transcript JSON",
        ),
        (403, r#"{"error":"denied"}"#, "HTTP 403"),
    ] {
        let (base_url, _) = serve_once(status, body);
        let error = load_chat_transcript(&base_url, "tui-1", 50, None)
            .expect_err("invalid history response should fail");
        assert!(error.contains(expected), "unexpected error: {error}");
    }
}

fn serve_once(status: u16, body: &str) -> (String, mpsc::Receiver<String>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("test server should bind");
    let port = listener
        .local_addr()
        .expect("test server should have address")
        .port();
    let body = body.to_string();
    let (tx, rx) = mpsc::channel();

    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("client should connect");
        let request = read_http_request(&mut stream);
        let _ = tx.send(request);
        write!(
            stream,
            "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .expect("response should be writable");
    });

    (format!("http://127.0.0.1:{port}"), rx)
}

fn read_http_request(stream: &mut TcpStream) -> String {
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(2)))
        .expect("read timeout should be configurable");
    let mut request = Vec::new();
    let mut buffer = [0; 1024];
    loop {
        let size = stream
            .read(&mut buffer)
            .expect("request should be readable");
        if size == 0 {
            break;
        }
        request.extend_from_slice(&buffer[..size]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let _ = stream.shutdown(Shutdown::Read);
    String::from_utf8(request).expect("request should be UTF-8")
}
