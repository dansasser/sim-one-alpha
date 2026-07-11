use std::io::Read;
use std::time::Duration;

use crate::http::{connect_tcp, parse_http_response, write_http_request, HttpEndpoint};

const AGENT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const AGENT_READ_TIMEOUT: Duration = Duration::from_secs(240);
const AGENT_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const LOCAL_TUI_SCOPE_ID: &str = "local-tui";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentReply {
    pub text: String,
    pub session_id: Option<String>,
    pub session_title: Option<String>,
    pub command_name: Option<String>,
    pub session_created: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSummary {
    pub id: String,
    pub origin: String,
    pub title: Option<String>,
    pub updated_at: String,
}

pub fn send_agent_prompt(base_url: &str, session_id: &str, prompt: &str) -> Result<String, String> {
    send_agent_prompt_reply(base_url, session_id, prompt).map(|reply| reply.text)
}

pub fn send_agent_prompt_reply(
    base_url: &str,
    session_id: &str,
    prompt: &str,
) -> Result<AgentReply, String> {
    let endpoint = HttpEndpoint::parse(base_url)?;
    let path = "/api/chat/events";
    let mut body = serde_json::json!({
        "connector": "tui",
        "text": prompt,
        "actorId": LOCAL_TUI_SCOPE_ID,
        "actorDisplayName": "Local TUI",
        "conversationId": LOCAL_TUI_SCOPE_ID,
        "threadId": LOCAL_TUI_SCOPE_ID,
    });
    if !session_id.trim().is_empty() {
        body["session"] = serde_json::Value::String(session_id.to_string());
    }
    let body = body.to_string();

    let mut stream = connect_tcp(
        &endpoint,
        AGENT_CONNECT_TIMEOUT,
        AGENT_READ_TIMEOUT,
        AGENT_WRITE_TIMEOUT,
    )?;

    let request = format!(
        "POST {path} HTTP/1.1\r\n\
Host: {host}:{port}\r\n\
Content-Type: application/json\r\n\
Content-Length: {length}\r\n\
Connection: close\r\n\
\r\n\
{body}",
        host = endpoint.host,
        port = endpoint.port,
        length = body.len(),
    );

    write_http_request(&mut stream, &request, "prompt")?;

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|error| format!("Could not read gateway response: {error}"))?;

    parse_agent_response(&response)
}

pub fn list_chat_sessions(base_url: &str, limit: usize) -> Result<Vec<SessionSummary>, String> {
    let endpoint = HttpEndpoint::parse(base_url)?;
    let limit = limit.clamp(1, 50);
    let path = format!("/api/chat/sessions?limit={limit}");

    let mut stream = connect_tcp(
        &endpoint,
        AGENT_CONNECT_TIMEOUT,
        Duration::from_secs(10),
        AGENT_WRITE_TIMEOUT,
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

    write_http_request(&mut stream, &request, "session list")?;

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|error| format!("Could not read gateway session list response: {error}"))?;

    parse_session_list_response(&response)
}

fn parse_agent_response(response: &[u8]) -> Result<AgentReply, String> {
    let response = parse_http_response(response, "Gateway")?;
    let body = String::from_utf8(response.body)
        .map_err(|error| format!("Gateway returned a non-UTF-8 response body: {error}"))?;

    if !(200..300).contains(&response.status) {
        return Err(format!(
            "Gateway returned HTTP {}: {}",
            response.status,
            body.trim().chars().take(500).collect::<String>()
        ));
    }

    let json: serde_json::Value = serde_json::from_str(&body)
        .map_err(|error| format!("Gateway returned invalid JSON: {error}"))?;
    extract_agent_reply(&json).ok_or_else(|| {
        format!(
            "Gateway response did not contain assistant text: {}",
            body.trim().chars().take(500).collect::<String>()
        )
    })
}

fn extract_agent_reply(value: &serde_json::Value) -> Option<AgentReply> {
    let text = value
        .get("text")
        .and_then(|text| text.as_str())
        .or_else(|| value.get("result")?.get("text")?.as_str())
        .or_else(|| value.get("result")?.as_str())
        .map(str::to_string)?;

    let session_id = value
        .get("session")
        .and_then(|session| session.get("id"))
        .and_then(|id| id.as_str())
        .map(str::to_string);
    let session_title = value
        .get("session")
        .and_then(|session| session.get("title"))
        .and_then(|title| title.as_str())
        .map(str::to_string);

    let command_name = value
        .get("result")
        .and_then(|result| result.get("command"))
        .and_then(|command| command.get("name"))
        .and_then(|name| name.as_str())
        .map(str::to_string);
    let session_created = value
        .get("session")
        .and_then(|session| session.get("created"))
        .and_then(|created| created.as_bool());

    Some(AgentReply {
        text,
        session_id,
        session_title,
        command_name,
        session_created,
    })
}

fn parse_session_list_response(response: &[u8]) -> Result<Vec<SessionSummary>, String> {
    let response = parse_http_response(response, "Gateway")?;
    let body = String::from_utf8(response.body)
        .map_err(|error| format!("Gateway returned a non-UTF-8 session list body: {error}"))?;

    if !(200..300).contains(&response.status) {
        return Err(format!(
            "Gateway returned HTTP {} for session list: {}",
            response.status,
            body.trim().chars().take(500).collect::<String>()
        ));
    }

    let json: serde_json::Value = serde_json::from_str(&body)
        .map_err(|error| format!("Gateway returned invalid session list JSON: {error}"))?;
    let sessions = json
        .get("sessions")
        .and_then(|sessions| sessions.as_array())
        .ok_or_else(|| {
            format!(
                "Gateway session list did not contain sessions: {}",
                body.trim().chars().take(500).collect::<String>()
            )
        })?;

    Ok(sessions
        .iter()
        .filter_map(extract_session_summary)
        .collect())
}

fn extract_session_summary(value: &serde_json::Value) -> Option<SessionSummary> {
    let id = value
        .get("sessionId")
        .or_else(|| value.get("session_id"))
        .and_then(|id| id.as_str())?
        .to_string();
    let origin = value
        .get("origin")
        .and_then(|origin| origin.as_str())
        .unwrap_or("unknown")
        .to_string();
    let title = value
        .get("title")
        .and_then(|title| title.as_str())
        .map(str::to_string);
    let updated_at = value
        .get("updatedAt")
        .or_else(|| value.get("updated_at"))
        .and_then(|updated_at| updated_at.as_str())
        .unwrap_or("")
        .to_string();

    Some(SessionSummary {
        id,
        origin,
        title,
        updated_at,
    })
}
