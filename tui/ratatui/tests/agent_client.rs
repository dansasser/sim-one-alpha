use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::thread;

use sim_one_ratatui_tui::agent::send_agent_prompt;

#[test]
fn posts_prompt_to_flue_agent_endpoint_and_extracts_text() {
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
    assert!(request
        .starts_with("POST /agents/orchestrator/session%20with%20spaces?wait=result HTTP/1.1"));
    assert!(request.contains(r#""message":"hello agent""#));
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
        "primary",
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
        .expect("request should include content-length");

    while bytes.len() < header_end + content_length {
        let read = stream.read(&mut buffer).expect("body should be readable");
        assert!(read > 0, "request ended before body");
        bytes.extend_from_slice(&buffer[..read]);
    }

    String::from_utf8(bytes).expect("request should be utf8")
}
