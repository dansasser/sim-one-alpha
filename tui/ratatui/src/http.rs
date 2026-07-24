use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpEndpoint {
    pub base_url: String,
    pub host: String,
    pub port: u16,
}

impl HttpEndpoint {
    pub fn parse(base_url: &str) -> Result<Self, String> {
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

pub fn connect_tcp(
    endpoint: &HttpEndpoint,
    connect_timeout: Duration,
    read_timeout: Duration,
    write_timeout: Duration,
) -> Result<TcpStream, String> {
    let addresses = (endpoint.host.as_str(), endpoint.port)
        .to_socket_addrs()
        .map_err(|error| {
            format!(
                "Could not resolve gateway at {}: {error}",
                endpoint.base_url
            )
        })?
        .collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err(format!(
            "Could not resolve gateway at {}: no addresses",
            endpoint.base_url
        ));
    }

    let mut last_error = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, connect_timeout) {
            Ok(stream) => {
                stream
                    .set_read_timeout(Some(read_timeout))
                    .map_err(|error| {
                        format!("Could not configure gateway read timeout: {error}")
                    })?;
                stream
                    .set_write_timeout(Some(write_timeout))
                    .map_err(|error| {
                        format!("Could not configure gateway write timeout: {error}")
                    })?;
                return Ok(stream);
            }
            Err(error) => last_error = Some(error),
        }
    }

    Err(format!(
        "Could not connect to gateway at {}: {}",
        endpoint.base_url,
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "no usable address".to_string())
    ))
}

pub fn read_http_head(stream: &mut TcpStream, context: &str) -> Result<(String, Vec<u8>), String> {
    let mut response = Vec::new();
    let mut buffer = [0; 1024];
    loop {
        let size = stream
            .read(&mut buffer)
            .map_err(|error| format!("Could not read {context} headers: {error}"))?;
        if size == 0 {
            return Err(format!("{context} ended before HTTP headers completed."));
        }
        response.extend_from_slice(&buffer[..size]);
        if let Some(index) = find_header_end(&response) {
            let head = String::from_utf8_lossy(&response[..index]).to_string();
            let body = response[index + 4..].to_vec();
            return Ok((head, body));
        }
    }
}

pub fn read_http_response(stream: &mut TcpStream, context: &str) -> Result<HttpResponse, String> {
    let (head, initial_body) = read_http_head(stream, context)?;
    let status = parse_status_code(&head, context)?;
    let body = if matches!(status, 100..=199 | 204 | 304) {
        Vec::new()
    } else if has_chunked_encoding(&head) {
        read_chunked_http_body(stream, initial_body, context)?
    } else if let Some(length) = header_value(&head, "content-length") {
        let expected = length.parse::<usize>().map_err(|error| {
            format!("{context} response had an invalid Content-Length: {error}")
        })?;
        read_fixed_http_body(stream, initial_body, expected, context)?
    } else {
        let mut body = initial_body;
        stream
            .read_to_end(&mut body)
            .map_err(|error| format!("Could not read {context} response body: {error}"))?;
        body
    };

    Ok(HttpResponse { head, status, body })
}

fn read_fixed_http_body(
    stream: &mut TcpStream,
    mut body: Vec<u8>,
    expected: usize,
    context: &str,
) -> Result<Vec<u8>, String> {
    body.truncate(expected);
    while body.len() < expected {
        let remaining = expected - body.len();
        let mut buffer = [0; 8_192];
        let read_size = remaining.min(buffer.len());
        let size = stream
            .read(&mut buffer[..read_size])
            .map_err(|error| format!("Could not read {context} response body: {error}"))?;
        if size == 0 {
            return Err(format!(
                "{context} response ended after {} of {expected} body bytes.",
                body.len()
            ));
        }
        body.extend_from_slice(&buffer[..size]);
    }
    Ok(body)
}

fn read_chunked_http_body(
    stream: &mut TcpStream,
    initial_body: Vec<u8>,
    context: &str,
) -> Result<Vec<u8>, String> {
    let mut decoder = ChunkedBodyDecoder::new(context);
    let mut body = decoder.push(&initial_body)?;
    let mut buffer = [0; 8_192];
    while !decoder.is_finished() {
        let size = stream
            .read(&mut buffer)
            .map_err(|error| format!("Could not read {context} response body: {error}"))?;
        if size == 0 {
            return Err(format!("{context} ended before the final chunk."));
        }
        body.extend(decoder.push(&buffer[..size])?);
    }
    Ok(body)
}

pub fn parse_http_response(response: &[u8], context: &str) -> Result<HttpResponse, String> {
    let header_end = find_header_end(response)
        .ok_or_else(|| format!("{context} returned a malformed HTTP response."))?;
    let head = String::from_utf8_lossy(&response[..header_end]).to_string();
    let status = parse_status_code(&head, context)?;
    let body = decode_http_body(&head, &response[header_end + 4..], context)?;

    Ok(HttpResponse { head, status, body })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub head: String,
    pub status: u16,
    pub body: Vec<u8>,
}

pub fn decode_http_body(head: &str, body: &[u8], context: &str) -> Result<Vec<u8>, String> {
    if has_chunked_encoding(head) {
        decode_chunked_body(body, context)
    } else {
        Ok(body.to_vec())
    }
}

pub fn parse_status_code(head: &str, context: &str) -> Result<u16, String> {
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| format!("{context} response did not include an HTTP status."))?;
    status
        .parse::<u16>()
        .map_err(|error| format!("{context} response had an invalid status code: {error}"))
}

pub fn header_value<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        if key.trim().eq_ignore_ascii_case(name) {
            Some(value.trim())
        } else {
            None
        }
    })
}

pub fn has_chunked_encoding(head: &str) -> bool {
    head.lines().any(|line| {
        line.to_ascii_lowercase().starts_with("transfer-encoding:")
            && line.to_ascii_lowercase().contains("chunked")
    })
}

pub fn decode_chunked_body(body: &[u8], context: &str) -> Result<Vec<u8>, String> {
    let mut decoder = ChunkedBodyDecoder::new(context);
    let decoded = decoder.push(body)?;
    if !decoder.is_finished() {
        return Err(format!("{context} ended before the final chunk."));
    }
    Ok(decoded)
}

pub struct ChunkedBodyDecoder {
    buffer: Vec<u8>,
    finished: bool,
    context: String,
}

impl ChunkedBodyDecoder {
    pub fn new(context: &str) -> Self {
        Self {
            buffer: Vec::new(),
            finished: false,
            context: context.to_string(),
        }
    }

    pub fn is_finished(&self) -> bool {
        self.finished
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<u8>, String> {
        if self.finished {
            return Ok(Vec::new());
        }

        self.buffer.extend_from_slice(bytes);
        let mut decoded = Vec::new();

        while let Some(size_end) = find_crlf(&self.buffer) {
            let size_line = String::from_utf8_lossy(&self.buffer[..size_end]);
            let size_hex = size_line.split(';').next().unwrap_or(&size_line).trim();
            let size = usize::from_str_radix(size_hex, 16)
                .map_err(|error| format!("{} had an invalid chunk size: {error}", self.context))?;
            let data_start = size_end + 2;
            let data_end = data_start + size;
            let chunk_end = data_end + 2;
            if self.buffer.len() < chunk_end {
                break;
            }
            if &self.buffer[data_end..chunk_end] != b"\r\n" {
                return Err(format!(
                    "{} had a malformed chunk terminator.",
                    self.context
                ));
            }
            if size == 0 {
                self.buffer.drain(..chunk_end);
                self.finished = true;
                break;
            }

            decoded.extend_from_slice(&self.buffer[data_start..data_end]);
            self.buffer.drain(..chunk_end);
        }

        Ok(decoded)
    }
}

pub fn percent_encode(value: &str) -> String {
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

pub fn write_http_request(
    stream: &mut TcpStream,
    request: &str,
    context: &str,
) -> Result<(), String> {
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("Could not send {context} request: {error}"))
}

fn find_header_end(response: &[u8]) -> Option<usize> {
    response.windows(4).position(|window| window == b"\r\n\r\n")
}

fn find_crlf(value: &[u8]) -> Option<usize> {
    value.windows(2).position(|window| window == b"\r\n")
}

#[cfg(test)]
mod tests {
    use super::read_http_response;
    use std::io::Write;
    use std::net::{TcpListener, TcpStream};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn body_forbidden_statuses_ignore_framing_and_an_open_socket() {
        for status in ["103 Early Hints", "204 No Content", "304 Not Modified"] {
            assert_body_forbidden_status(status);
        }
    }

    fn assert_body_forbidden_status(status: &str) {
        let listener =
            TcpListener::bind(("127.0.0.1", 0)).expect("test server should bind locally");
        let address = listener
            .local_addr()
            .expect("test server address should resolve");
        let response_head =
            format!("HTTP/1.1 {status}\r\nContent-Length: 12\r\nConnection: keep-alive\r\n\r\n");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("test server should accept");
            stream
                .write_all(response_head.as_bytes())
                .expect("test response should write");
            thread::sleep(Duration::from_millis(200));
        });

        let mut stream = TcpStream::connect(address).expect("test client should connect");
        stream
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("test client timeout should configure");
        let response = read_http_response(&mut stream, "bodyless test")
            .expect("bodyless response should read");

        assert_eq!(
            response.status,
            status
                .split_once(' ')
                .and_then(|(code, _)| code.parse::<u16>().ok())
                .expect("test status should contain a numeric code")
        );
        assert!(response.body.is_empty());
        server.join().expect("test server should finish");
    }
}
