use std::io::{ErrorKind, Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use super::events::{FlueEvent, StreamControl};

const STREAM_READ_TIMEOUT: Duration = Duration::from_secs(5);
const STREAM_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const RECONNECT_DELAY: Duration = Duration::from_secs(1);

#[derive(Debug)]
pub struct AgentStreamHandle {
    pub receiver: Receiver<AgentStreamUpdate>,
    cancel: Arc<AtomicBool>,
}

impl AgentStreamHandle {
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

impl Drop for AgentStreamHandle {
    fn drop(&mut self) {
        self.cancel();
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum AgentStreamUpdate {
    Connecting,
    Events(Vec<FlueEvent>),
    Control(StreamControl),
    Idle,
    Reconnecting(String),
    Failed(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct CatchUpBatch {
    pub events: Vec<FlueEvent>,
    pub next_offset: Option<String>,
    pub up_to_date: bool,
    pub stream_closed: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SseFrame {
    Events(Vec<FlueEvent>),
    Control(StreamControl),
    Unknown { event: String, data: String },
}

#[derive(Debug, Default)]
pub struct SseParser {
    buffer: String,
}

impl SseParser {
    pub fn push_str(&mut self, chunk: &str) -> Result<Vec<SseFrame>, String> {
        self.buffer.push_str(chunk);
        let mut frames = Vec::new();

        loop {
            let Some((end, delimiter_len)) = find_sse_delimiter(&self.buffer) else {
                break;
            };
            let raw = self.buffer[..end].to_string();
            self.buffer.drain(..end + delimiter_len);
            if let Some(frame) = parse_sse_frame(&raw)? {
                frames.push(frame);
            }
        }

        Ok(frames)
    }
}

pub fn spawn_agent_stream(base_url: String, session_id: String) -> AgentStreamHandle {
    let (tx, receiver) = mpsc::channel();
    let cancel = Arc::new(AtomicBool::new(false));
    let thread_cancel = Arc::clone(&cancel);

    thread::spawn(move || {
        run_agent_stream(base_url, session_id, tx, thread_cancel);
    });

    AgentStreamHandle { receiver, cancel }
}

fn run_agent_stream(
    base_url: String,
    session_id: String,
    tx: Sender<AgentStreamUpdate>,
    cancel: Arc<AtomicBool>,
) {
    let mut offset = "-1".to_string();

    while !cancel.load(Ordering::Relaxed) {
        let _ = tx.send(AgentStreamUpdate::Connecting);

        match read_catch_up_events(&base_url, &session_id, &offset) {
            Ok(batch) => {
                if !batch.events.is_empty() {
                    let _ = tx.send(AgentStreamUpdate::Events(batch.events));
                }
                if let Some(next_offset) = batch.next_offset {
                    offset = next_offset;
                } else if offset == "-1" {
                    offset = "now".to_string();
                }
                if batch.up_to_date {
                    let _ = tx.send(AgentStreamUpdate::Idle);
                }
            }
            Err(error) if error.contains("HTTP 404") => {
                let _ = tx.send(AgentStreamUpdate::Idle);
                sleep_or_cancel(&cancel, RECONNECT_DELAY);
                continue;
            }
            Err(error) => {
                let _ = tx.send(AgentStreamUpdate::Reconnecting(error));
                sleep_or_cancel(&cancel, RECONNECT_DELAY);
                continue;
            }
        }

        if cancel.load(Ordering::Relaxed) {
            break;
        }

        match read_sse_events(&base_url, &session_id, &offset, &tx, &cancel) {
            Ok(Some(next_offset)) => offset = next_offset,
            Ok(None) => {}
            Err(error) => {
                let _ = tx.send(AgentStreamUpdate::Reconnecting(error));
                sleep_or_cancel(&cancel, RECONNECT_DELAY);
            }
        }
    }
}

fn sleep_or_cancel(cancel: &Arc<AtomicBool>, duration: Duration) {
    let mut slept = Duration::ZERO;
    while slept < duration && !cancel.load(Ordering::Relaxed) {
        thread::sleep(Duration::from_millis(100));
        slept += Duration::from_millis(100);
    }
}

pub fn read_catch_up_events(
    base_url: &str,
    session_id: &str,
    offset: &str,
) -> Result<CatchUpBatch, String> {
    let endpoint = StreamEndpoint::parse(base_url)?;
    let path = format!(
        "/agents/orchestrator/{}?offset={}",
        percent_encode_path_segment(session_id),
        percent_encode_query_value(offset)
    );
    let response = send_http_request(&endpoint, &path)?;
    parse_catch_up_response(&response)
}

fn read_sse_events(
    base_url: &str,
    session_id: &str,
    offset: &str,
    tx: &Sender<AgentStreamUpdate>,
    cancel: &Arc<AtomicBool>,
) -> Result<Option<String>, String> {
    let endpoint = StreamEndpoint::parse(base_url)?;
    let path = format!(
        "/agents/orchestrator/{}?offset={}&live=sse",
        percent_encode_path_segment(session_id),
        percent_encode_query_value(offset)
    );
    let mut stream = open_http_stream(&endpoint, &path)?;
    let (head, initial_body) = read_http_head(&mut stream)?;
    let status = parse_status_code(&head)?;
    if status == 404 {
        let _ = tx.send(AgentStreamUpdate::Idle);
        return Ok(None);
    }
    if !(200..300).contains(&status) {
        return Err(format!("Flue stream returned HTTP {status}"));
    }

    let mut parser = SseParser::default();
    let mut next_offset = None;
    if !initial_body.is_empty() {
        apply_sse_frames(
            parser.push_str(&String::from_utf8_lossy(&initial_body))?,
            tx,
            &mut next_offset,
        );
    }

    let mut buffer = [0; 8192];
    while !cancel.load(Ordering::Relaxed) {
        match stream.read(&mut buffer) {
            Ok(0) => return Ok(next_offset),
            Ok(size) => {
                let frames = parser.push_str(&String::from_utf8_lossy(&buffer[..size]))?;
                apply_sse_frames(frames, tx, &mut next_offset);
            }
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                let _ = tx.send(AgentStreamUpdate::Idle);
            }
            Err(error) => return Err(format!("Could not read Flue stream: {error}")),
        }
    }

    Ok(next_offset)
}

fn apply_sse_frames(
    frames: Vec<SseFrame>,
    tx: &Sender<AgentStreamUpdate>,
    next_offset: &mut Option<String>,
) {
    for frame in frames {
        match frame {
            SseFrame::Events(events) => {
                let _ = tx.send(AgentStreamUpdate::Events(events));
            }
            SseFrame::Control(control) => {
                if let Some(offset) = &control.stream_next_offset {
                    *next_offset = Some(offset.clone());
                }
                let _ = tx.send(AgentStreamUpdate::Control(control));
            }
            SseFrame::Unknown { .. } => {}
        }
    }
}

pub fn parse_catch_up_response(response: &[u8]) -> Result<CatchUpBatch, String> {
    let response = String::from_utf8_lossy(response);
    let (head, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "Flue stream returned a malformed HTTP response.".to_string())?;
    let status = parse_status_code(head)?;
    let body = if has_chunked_encoding(head) {
        decode_chunked_body(body)?
    } else {
        body.to_string()
    };

    if !(200..300).contains(&status) {
        return Err(format!(
            "Flue stream returned HTTP {status}: {}",
            body.trim().chars().take(500).collect::<String>()
        ));
    }

    let values: Vec<serde_json::Value> = serde_json::from_str(&body)
        .map_err(|error| format!("Flue catch-up response had invalid JSON: {error}"))?;
    Ok(CatchUpBatch {
        events: values.into_iter().map(FlueEvent::from_value).collect(),
        next_offset: header_value(head, "stream-next-offset").map(str::to_string),
        up_to_date: header_value(head, "stream-up-to-date")
            .map(|value| value.eq_ignore_ascii_case("true"))
            .unwrap_or(false),
        stream_closed: header_value(head, "stream-closed")
            .map(|value| value.eq_ignore_ascii_case("true"))
            .unwrap_or(false),
    })
}

pub fn parse_sse_frame(raw: &str) -> Result<Option<SseFrame>, String> {
    let mut event = String::new();
    let mut data_lines = Vec::new();
    let mut saw_non_comment = false;

    for line in raw.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        if line.starts_with(':') {
            continue;
        }
        saw_non_comment = true;
        if let Some(value) = line.strip_prefix("event:") {
            event = value.trim_start().to_string();
        } else if let Some(value) = line.strip_prefix("data:") {
            data_lines.push(value.trim_start().to_string());
        }
    }

    if !saw_non_comment {
        return Ok(None);
    }

    let data = data_lines.join("\n");
    match event.as_str() {
        "data" => {
            let values: Vec<serde_json::Value> = serde_json::from_str(&data)
                .map_err(|error| format!("Flue SSE data frame had invalid JSON: {error}"))?;
            Ok(Some(SseFrame::Events(
                values.into_iter().map(FlueEvent::from_value).collect(),
            )))
        }
        "control" => {
            let value: serde_json::Value = serde_json::from_str(&data)
                .map_err(|error| format!("Flue SSE control frame had invalid JSON: {error}"))?;
            Ok(Some(SseFrame::Control(StreamControl::from_value(&value))))
        }
        _ => Ok(Some(SseFrame::Unknown { event, data })),
    }
}

fn send_http_request(endpoint: &StreamEndpoint, path: &str) -> Result<Vec<u8>, String> {
    let mut stream = open_http_stream(endpoint, path)?;
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|error| format!("Could not read Flue stream response: {error}"))?;
    Ok(response)
}

fn open_http_stream(endpoint: &StreamEndpoint, path: &str) -> Result<TcpStream, String> {
    let mut stream =
        TcpStream::connect((endpoint.host.as_str(), endpoint.port)).map_err(|error| {
            format!(
                "Could not connect to gateway at {}: {error}",
                endpoint.base_url
            )
        })?;
    let _ = stream.set_read_timeout(Some(STREAM_READ_TIMEOUT));
    let _ = stream.set_write_timeout(Some(STREAM_WRITE_TIMEOUT));
    let request = format!(
        "GET {path} HTTP/1.1\r\n\
Host: {host}:{port}\r\n\
Accept: text/event-stream, application/json\r\n\
Connection: close\r\n\
\r\n",
        host = endpoint.host,
        port = endpoint.port,
    );

    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("Could not send Flue stream request: {error}"))?;
    Ok(stream)
}

fn read_http_head(stream: &mut TcpStream) -> Result<(String, Vec<u8>), String> {
    let mut response = Vec::new();
    let mut buffer = [0; 1024];
    loop {
        let size = stream
            .read(&mut buffer)
            .map_err(|error| format!("Could not read Flue stream headers: {error}"))?;
        if size == 0 {
            return Err("Flue stream ended before HTTP headers completed.".to_string());
        }
        response.extend_from_slice(&buffer[..size]);
        if let Some(index) = find_header_end(&response) {
            let head = String::from_utf8_lossy(&response[..index]).to_string();
            let body = response[index + 4..].to_vec();
            return Ok((head, body));
        }
    }
}

fn find_header_end(response: &[u8]) -> Option<usize> {
    response.windows(4).position(|window| window == b"\r\n\r\n")
}

fn parse_status_code(head: &str) -> Result<u16, String> {
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| "Flue stream response did not include an HTTP status.".to_string())?;
    status
        .parse::<u16>()
        .map_err(|error| format!("Flue stream response had an invalid status code: {error}"))
}

fn header_value<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        if key.trim().eq_ignore_ascii_case(name) {
            Some(value.trim())
        } else {
            None
        }
    })
}

fn has_chunked_encoding(head: &str) -> bool {
    head.lines().any(|line| {
        line.to_ascii_lowercase().starts_with("transfer-encoding:")
            && line.to_ascii_lowercase().contains("chunked")
    })
}

fn decode_chunked_body(body: &str) -> Result<String, String> {
    let mut rest = body;
    let mut decoded = String::new();

    loop {
        let (size_line, after_size) = rest
            .split_once("\r\n")
            .ok_or_else(|| "Chunked Flue stream response ended before a chunk size.".to_string())?;
        let size_hex = size_line.split(';').next().unwrap_or(size_line).trim();
        let size = usize::from_str_radix(size_hex, 16)
            .map_err(|error| format!("Flue stream response had an invalid chunk size: {error}"))?;
        if size == 0 {
            return Ok(decoded);
        }
        if after_size.len() < size + 2 {
            return Err("Chunked Flue stream response ended inside a chunk.".to_string());
        }
        decoded.push_str(&after_size[..size]);
        rest = &after_size[size + 2..];
    }
}

fn find_sse_delimiter(value: &str) -> Option<(usize, usize)> {
    ["\r\n\r\n", "\n\n", "\r\r"]
        .iter()
        .filter_map(|delimiter| value.find(delimiter).map(|index| (index, delimiter.len())))
        .min_by_key(|(index, _)| *index)
}

fn percent_encode_path_segment(value: &str) -> String {
    percent_encode(value)
}

fn percent_encode_query_value(value: &str) -> String {
    percent_encode(value)
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StreamEndpoint {
    base_url: String,
    host: String,
    port: u16,
}

impl StreamEndpoint {
    fn parse(base_url: &str) -> Result<Self, String> {
        let without_scheme = base_url
            .strip_prefix("http://")
            .ok_or_else(|| format!("Only http:// gateway URLs are supported, got {base_url}"))?;
        let authority = without_scheme
            .split('/')
            .next()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("Gateway URL is missing a host: {base_url}"))?;
        let (host, port) = if let Some((host, port)) = authority.rsplit_once(':') {
            let parsed = port
                .parse::<u16>()
                .map_err(|error| format!("Gateway URL has an invalid port: {error}"))?;
            (host.to_string(), parsed)
        } else {
            (authority.to_string(), 80)
        };

        Ok(Self {
            base_url: base_url.to_string(),
            host,
            port,
        })
    }
}
