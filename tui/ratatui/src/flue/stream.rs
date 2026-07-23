use std::fmt;
use std::io::{ErrorKind, Read};
use std::net::{Shutdown, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use super::events::{FlueEvent, StreamControl};
use crate::http::{
    connect_tcp, decode_http_body, has_chunked_encoding, header_value, parse_status_code,
    read_http_head, write_http_request, ChunkedBodyDecoder, HttpEndpoint,
};

const STREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamError {
    HttpStatus { status: u16, body: String },
    Message(String),
}

impl StreamError {
    fn message(message: impl Into<String>) -> Self {
        Self::Message(message.into())
    }
}

impl fmt::Display for StreamError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::HttpStatus { status, body } => {
                write!(formatter, "Flue stream returned HTTP {status}: {body}")
            }
            Self::Message(message) => formatter.write_str(message),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum SseFrame {
    Events(Vec<FlueEvent>),
    Control(StreamControl),
    Unknown { event: String, data: String },
}

#[derive(Debug, Default)]
pub struct SseParser {
    buffer: Vec<u8>,
}

impl SseParser {
    pub fn push_str(&mut self, chunk: &str) -> Result<Vec<SseFrame>, String> {
        self.push_bytes(chunk.as_bytes())
    }

    pub fn push_bytes(&mut self, chunk: &[u8]) -> Result<Vec<SseFrame>, String> {
        self.buffer.extend_from_slice(chunk);
        let mut frames = Vec::new();

        while let Some((end, delimiter_len)) = find_sse_delimiter(&self.buffer) {
            let raw = String::from_utf8(self.buffer[..end].to_vec())
                .map_err(|error| format!("Flue SSE frame was not valid UTF-8: {error}"))?;
            self.buffer.drain(..end + delimiter_len);
            if let Some(frame) = parse_sse_frame(&raw)? {
                frames.push(frame);
            }
        }

        Ok(frames)
    }
}

pub fn spawn_agent_stream(
    base_url: String,
    session_id: String,
    initial_offset: String,
) -> AgentStreamHandle {
    let (tx, receiver) = mpsc::channel();
    let cancel = Arc::new(AtomicBool::new(false));
    let thread_cancel = Arc::clone(&cancel);

    thread::spawn(move || {
        run_agent_stream(base_url, session_id, initial_offset, tx, thread_cancel);
    });

    AgentStreamHandle { receiver, cancel }
}

fn run_agent_stream(
    base_url: String,
    session_id: String,
    initial_offset: String,
    tx: Sender<AgentStreamUpdate>,
    cancel: Arc<AtomicBool>,
) {
    let mut offset = initial_offset;

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
            Err(StreamError::HttpStatus { status: 404, .. }) => {
                let _ = tx.send(AgentStreamUpdate::Idle);
                sleep_or_cancel(&cancel, RECONNECT_DELAY);
                continue;
            }
            Err(error) => {
                let _ = tx.send(AgentStreamUpdate::Reconnecting(error.to_string()));
                sleep_or_cancel(&cancel, RECONNECT_DELAY);
                continue;
            }
        }

        if cancel.load(Ordering::Relaxed) {
            break;
        }

        match read_sse_events(&base_url, &session_id, &offset, &tx, &cancel) {
            Ok(Some(next_offset)) => {
                offset = next_offset;
            }
            Ok(None) => {}
            Err(error) => {
                let _ = tx.send(AgentStreamUpdate::Reconnecting(error.to_string()));
            }
        }
        sleep_or_cancel(&cancel, RECONNECT_DELAY);
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
) -> Result<CatchUpBatch, StreamError> {
    let endpoint = HttpEndpoint::parse(base_url).map_err(StreamError::message)?;
    let path = format!(
        "/agents/orchestrator/{}?offset={}",
        percent_encode_path_segment(session_id),
        percent_encode_query_value(offset)
    );
    let response = send_http_request(&endpoint, &path, true).map_err(StreamError::message)?;
    parse_catch_up_response(&response)
}

fn read_sse_events(
    base_url: &str,
    session_id: &str,
    offset: &str,
    tx: &Sender<AgentStreamUpdate>,
    cancel: &Arc<AtomicBool>,
) -> Result<Option<String>, StreamError> {
    let endpoint = HttpEndpoint::parse(base_url).map_err(StreamError::message)?;
    let path = format!(
        "/agents/orchestrator/{}?offset={}&live=sse",
        percent_encode_path_segment(session_id),
        percent_encode_query_value(offset)
    );
    let mut stream = open_http_stream(&endpoint, &path, false).map_err(StreamError::message)?;
    let (head, initial_body) =
        read_http_head(&mut stream, "Flue stream").map_err(StreamError::message)?;
    let status = parse_status_code(&head, "Flue stream").map_err(StreamError::message)?;
    if status == 404 {
        let _ = tx.send(AgentStreamUpdate::Idle);
        return Ok(None);
    }
    if !(200..300).contains(&status) {
        return Err(StreamError::HttpStatus {
            status,
            body: String::new(),
        });
    }

    let mut parser = SseParser::default();
    let mut chunked = if has_chunked_encoding(&head) {
        Some(ChunkedBodyDecoder::new("Chunked Flue SSE response"))
    } else {
        None
    };
    let mut next_offset = None;
    feed_sse_bytes(
        &initial_body,
        &mut chunked,
        &mut parser,
        tx,
        &mut next_offset,
    )
    .map_err(StreamError::message)?;

    let mut buffer = [0; 8192];
    while !cancel.load(Ordering::Relaxed) {
        match stream.read(&mut buffer) {
            Ok(0) => return Ok(next_offset),
            Ok(size) => {
                feed_sse_bytes(
                    &buffer[..size],
                    &mut chunked,
                    &mut parser,
                    tx,
                    &mut next_offset,
                )
                .map_err(StreamError::message)?;
            }
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                let _ = tx.send(AgentStreamUpdate::Idle);
            }
            Err(error) => {
                return Err(StreamError::message(format!(
                    "Could not read Flue stream: {error}"
                )))
            }
        }
    }

    Ok(next_offset)
}

fn feed_sse_bytes(
    bytes: &[u8],
    chunked: &mut Option<ChunkedBodyDecoder>,
    parser: &mut SseParser,
    tx: &Sender<AgentStreamUpdate>,
    next_offset: &mut Option<String>,
) -> Result<(), String> {
    if bytes.is_empty() {
        return Ok(());
    }

    let decoded = if let Some(decoder) = chunked {
        decoder.push(bytes)?
    } else {
        bytes.to_vec()
    };
    if decoded.is_empty() {
        return Ok(());
    }
    let frames = parser.push_bytes(&decoded)?;
    apply_sse_frames(frames, tx, next_offset);
    Ok(())
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

pub fn parse_catch_up_response(response: &[u8]) -> Result<CatchUpBatch, StreamError> {
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| StreamError::message("Flue stream returned a malformed HTTP response."))?;
    let head = String::from_utf8_lossy(&response[..header_end]).to_string();
    let status = parse_status_code(&head, "Flue stream").map_err(StreamError::message)?;
    let body = decode_http_body(
        &head,
        &response[header_end + 4..],
        "Chunked Flue stream response",
    )
    .map_err(StreamError::message)?;
    let body = String::from_utf8(body).map_err(|error| {
        StreamError::message(format!("Flue stream body was not UTF-8: {error}"))
    })?;

    if !(200..300).contains(&status) {
        return Err(StreamError::HttpStatus {
            status,
            body: body.trim().chars().take(500).collect::<String>(),
        });
    }

    let values: Vec<serde_json::Value> = serde_json::from_str(&body).map_err(|error| {
        StreamError::message(format!("Flue catch-up response had invalid JSON: {error}"))
    })?;
    Ok(CatchUpBatch {
        events: values.into_iter().map(FlueEvent::from_value).collect(),
        next_offset: header_value(&head, "stream-next-offset").map(str::to_string),
        up_to_date: header_value(&head, "stream-up-to-date")
            .map(|value| value.eq_ignore_ascii_case("true"))
            .unwrap_or(false),
        stream_closed: header_value(&head, "stream-closed")
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

fn send_http_request(
    endpoint: &HttpEndpoint,
    path: &str,
    connection_close: bool,
) -> Result<Vec<u8>, String> {
    let mut stream = open_http_stream(endpoint, path, connection_close)?;
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|error| format!("Could not read Flue stream response: {error}"))?;
    Ok(response)
}

fn open_http_stream(
    endpoint: &HttpEndpoint,
    path: &str,
    connection_close: bool,
) -> Result<TcpStream, String> {
    let mut stream = connect_tcp(
        endpoint,
        STREAM_CONNECT_TIMEOUT,
        STREAM_READ_TIMEOUT,
        STREAM_WRITE_TIMEOUT,
    )?;
    let connection_header = if connection_close {
        "Connection: close\r\n"
    } else {
        ""
    };
    let request = format!(
        "GET {path} HTTP/1.1\r\n\
Host: {host}:{port}\r\n\
Accept: text/event-stream, application/json\r\n\
{connection_header}\
\r\n",
        host = endpoint.host,
        port = endpoint.port,
    );

    write_http_request(&mut stream, &request, "Flue stream")?;
    if connection_close {
        let _ = stream.shutdown(Shutdown::Write);
    }
    Ok(stream)
}

fn find_sse_delimiter(value: &[u8]) -> Option<(usize, usize)> {
    [
        b"\r\n\r\n".as_slice(),
        b"\n\n".as_slice(),
        b"\r\r".as_slice(),
    ]
    .iter()
    .filter_map(|delimiter| {
        value
            .windows(delimiter.len())
            .position(|window| window == *delimiter)
            .map(|index| (index, delimiter.len()))
    })
    .min_by_key(|(index, _)| *index)
}

fn percent_encode_path_segment(value: &str) -> String {
    percent_encode(value)
}

fn percent_encode_query_value(value: &str) -> String {
    percent_encode(value)
}

fn percent_encode(value: &str) -> String {
    crate::http::percent_encode(value)
}
