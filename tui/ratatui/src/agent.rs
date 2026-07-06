use std::io::Read;
use std::time::Duration;

use crate::http::{
    connect_tcp, parse_http_response, percent_encode, write_http_request, HttpEndpoint,
};

const AGENT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const AGENT_READ_TIMEOUT: Duration = Duration::from_secs(240);
const AGENT_WRITE_TIMEOUT: Duration = Duration::from_secs(10);

pub fn send_agent_prompt(base_url: &str, session_id: &str, prompt: &str) -> Result<String, String> {
    let endpoint = HttpEndpoint::parse(base_url)?;
    let path = format!(
        "/agents/orchestrator/{}?wait=result",
        percent_encode_path_segment(session_id)
    );
    let body = serde_json::json!({ "message": prompt }).to_string();

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

fn parse_agent_response(response: &[u8]) -> Result<String, String> {
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
    extract_agent_text(&json).ok_or_else(|| {
        format!(
            "Gateway response did not contain assistant text: {}",
            body.trim().chars().take(500).collect::<String>()
        )
    })
}

fn extract_agent_text(value: &serde_json::Value) -> Option<String> {
    value
        .get("text")
        .and_then(|text| text.as_str())
        .or_else(|| value.get("result")?.get("text")?.as_str())
        .or_else(|| value.get("result")?.as_str())
        .map(str::to_string)
}

fn percent_encode_path_segment(value: &str) -> String {
    percent_encode(value)
}
