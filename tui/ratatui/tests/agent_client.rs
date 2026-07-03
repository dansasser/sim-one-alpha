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
