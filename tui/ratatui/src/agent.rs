use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

pub fn send_agent_prompt(base_url: &str, session_id: &str, prompt: &str) -> Result<String, String> {
    let endpoint = AgentEndpoint::parse(base_url)?;
    let path = format!(
        "/agents/orchestrator/{}?wait=result",
        percent_encode_path_segment(session_id)
    );
    let body = serde_json::json!({ "message": prompt }).to_string();

    let mut stream = TcpStream::connect((endpoint.host.as_str(), endpoint.port))
        .map_err(|error| format!("Could not connect to gateway at {base_url}: {error}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(240)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));

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

    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("Could not send prompt to gateway: {error}"))?;

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|error| format!("Could not read gateway response: {error}"))?;

    parse_agent_response(&response)
}

fn parse_agent_response(response: &[u8]) -> Result<String, String> {
    let response = String::from_utf8_lossy(response);
    let (head, body) = response.split_once("\r\n\r\n").ok_or_else(|| {
        format!(
            "Gateway returned a malformed HTTP response: {}",
            response.chars().take(500).collect::<String>()
        )
    })?;
    let status = parse_status_code(head)?;
    let body = if has_chunked_encoding(head) {
        decode_chunked_body(body)?
    } else {
        body.to_string()
    };

    if !(200..300).contains(&status) {
        return Err(format!(
            "Gateway returned HTTP {status}: {}",
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

fn parse_status_code(head: &str) -> Result<u16, String> {
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| "Gateway response did not include an HTTP status.".to_string())?;
    status
        .parse::<u16>()
        .map_err(|error| format!("Gateway response had an invalid status code: {error}"))
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
            .ok_or_else(|| "Chunked gateway response ended before a chunk size.".to_string())?;
        let size_hex = size_line.split(';').next().unwrap_or(size_line).trim();
        let size = usize::from_str_radix(size_hex, 16)
            .map_err(|error| format!("Gateway response had an invalid chunk size: {error}"))?;
        if size == 0 {
            return Ok(decoded);
        }
        if after_size.len() < size + 2 {
            return Err("Chunked gateway response ended inside a chunk.".to_string());
        }
        decoded.push_str(&after_size[..size]);
        rest = &after_size[size + 2..];
    }
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
struct AgentEndpoint {
    host: String,
    port: u16,
}

impl AgentEndpoint {
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

        Ok(Self { host, port })
    }
}
