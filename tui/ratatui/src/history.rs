use std::io::Read;
use std::time::Duration;

use serde::Deserialize;

use crate::http::{
    connect_tcp, parse_http_response, percent_encode, write_http_request, HttpEndpoint,
};

const HISTORY_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HISTORY_READ_TIMEOUT: Duration = Duration::from_secs(10);
const HISTORY_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const LOCAL_TUI_SCOPE_ID: &str = "local-tui";
const MAX_ERROR_BODY_CHARS: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPage {
    pub session: TranscriptSession,
    pub exchanges: Vec<TranscriptExchange>,
    pub stream: TranscriptStreamCursor,
    pub page: TranscriptPageInfo,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSession {
    pub id: String,
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptExchange {
    pub id: String,
    pub submission_id: String,
    pub prompt: Option<TranscriptPrompt>,
    #[serde(default)]
    pub activities: Vec<TranscriptActivity>,
    pub assistant: Option<TranscriptAssistantMessage>,
    pub status: TranscriptActivityStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPrompt {
    pub id: String,
    pub text: String,
    pub received_at: String,
    pub visibility: TranscriptPromptVisibility,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptActivity {
    pub id: String,
    pub kind: TranscriptActivityKind,
    pub name: String,
    pub status: TranscriptActivityStatus,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub duration_ms: Option<u64>,
    pub preview: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptAssistantMessage {
    pub id: String,
    pub text: String,
    pub completed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptStreamCursor {
    pub next_offset: String,
    pub up_to_date: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPageInfo {
    pub limit: usize,
    pub has_older: bool,
    pub before: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptPromptVisibility {
    User,
    Internal,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptActivityKind {
    Operation,
    Thinking,
    Tool,
    Task,
    Log,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptActivityStatus {
    Running,
    Completed,
    Failed,
    #[serde(other)]
    Unknown,
}

pub fn load_chat_transcript(
    base_url: &str,
    session_id: &str,
    limit: usize,
    before: Option<&str>,
) -> Result<TranscriptPage, String> {
    let endpoint = HttpEndpoint::parse(base_url)?;
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err("Session id is required for transcript history.".to_string());
    }
    let limit = limit.clamp(1, 100);
    let mut path = format!(
        "/api/chat/sessions/{}/transcript?connector=tui&actorId={scope}&conversationId={scope}&threadId={scope}&limit={limit}",
        percent_encode(session_id),
        scope = LOCAL_TUI_SCOPE_ID,
    );
    if let Some(before) = before.map(str::trim).filter(|value| !value.is_empty()) {
        path.push_str("&before=");
        path.push_str(&percent_encode(before));
    }

    let mut stream = connect_tcp(
        &endpoint,
        HISTORY_CONNECT_TIMEOUT,
        HISTORY_READ_TIMEOUT,
        HISTORY_WRITE_TIMEOUT,
    )?;
    let request = format!(
        "GET {path} HTTP/1.1\r\n\
Host: {host}:{port}\r\n\
Accept: application/json\r\n\
Connection: close\r\n\
\r\n",
        host = endpoint.host,
        port = endpoint.port,
    );
    write_http_request(&mut stream, &request, "transcript history")?;

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|error| format!("Could not read gateway transcript response: {error}"))?;
    parse_transcript_response(&response)
}

fn parse_transcript_response(response: &[u8]) -> Result<TranscriptPage, String> {
    let response = parse_http_response(response, "Gateway")?;
    let body = String::from_utf8(response.body)
        .map_err(|error| format!("Gateway returned a non-UTF-8 transcript body: {error}"))?;
    if !(200..300).contains(&response.status) {
        return Err(format!(
            "Gateway returned HTTP {} for transcript history: {}",
            response.status,
            bounded_body(&body),
        ));
    }

    serde_json::from_str(&body)
        .map_err(|error| format!("Gateway returned invalid transcript JSON: {error}"))
}

fn bounded_body(body: &str) -> String {
    body.trim().chars().take(MAX_ERROR_BODY_CHARS).collect()
}
