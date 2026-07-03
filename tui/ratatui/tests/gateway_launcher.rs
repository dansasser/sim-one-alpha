use std::fs::{create_dir_all, write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Command;

use sim_one_ratatui_tui::gateway::{
    read_gateway_port_from_config, resolve_env_path, resolve_node_executable, resolve_server_path,
    GatewayOptions,
};

#[test]
fn reads_gateway_port_from_config_json() {
    let root = temp_path("port-config");
    create_dir_all(&root).expect("temp dir should be created");
    let config_path = root.join("gorombo.config.json");
    write(&config_path, r#"{"gateway":{"port":3977}}"#).expect("config should be writable");

    assert_eq!(read_gateway_port_from_config(&config_path), Some(3977));
}

#[test]
fn server_path_prefers_explicit_option_over_candidates() {
    let explicit = PathBuf::from("/tmp/custom-server.mjs");
    let options = GatewayOptions {
        server_path: Some(explicit.clone()),
        ..GatewayOptions::default()
    };

    assert_eq!(
        resolve_server_path(&options).expect("server path should resolve"),
        explicit
    );
}

#[test]
fn env_path_prefers_explicit_option_over_candidates() {
    let explicit = PathBuf::from("/tmp/custom.env");
    let options = GatewayOptions {
        env_path: Some(explicit.clone()),
        ..GatewayOptions::default()
    };

    assert_eq!(resolve_env_path(&options), explicit);
}

#[test]
fn resolves_node_executable_that_supports_runtime_server() {
    let node_path = resolve_node_executable().expect("Node 22+ should resolve for product launch");
    let output = Command::new(node_path)
        .arg("-p")
        .arg("process.versions.node")
        .output()
        .expect("resolved node should run");

    assert!(
        output.status.success(),
        "resolved node should report version"
    );
    let version = String::from_utf8_lossy(&output.stdout);
    let mut parts = version.trim().split('.');
    let major = parts
        .next()
        .expect("node version should have a major version")
        .parse::<u64>()
        .expect("node major version should parse");
    let minor = parts
        .next()
        .expect("node version should have a minor version")
        .parse::<u64>()
        .expect("node minor version should parse");
    assert!(
        major > 22 || (major == 22 && minor >= 18),
        "resolved node must support the packaged server runtime; got {}",
        version.trim()
    );
}

#[test]
fn built_binary_accepts_smoke_startup_flag() {
    let output = Command::new(env!("CARGO_BIN_EXE_sim-one-ratatui-tui"))
        .arg("--smoke-startup")
        .arg("--server-path")
        .arg("/tmp/sim-one-ratatui-missing-server.mjs")
        .arg("--port")
        .arg(free_port().to_string())
        .output()
        .expect("built binary should run");

    assert!(
        !output.status.success(),
        "missing server path should fail the product startup smoke"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("Agent package not found"),
        "stderr should explain missing server artifact, got: {stderr}"
    );
}

#[test]
fn built_binary_silences_child_logs_after_gateway_is_healthy() {
    let root = temp_path("post-health-logs");
    create_dir_all(&root).expect("temp dir should be created");
    let server_path = root.join("server.mjs");
    write(
        &server_path,
        r#"
import http from 'node:http';

const port = Number(process.env.PORT);
console.error('startup-visible');

const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
    return;
  }

  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('missing');
});

process.on('SIGTERM', () => {
  console.error('shutdown-noise');
  setTimeout(() => process.exit(0), 25);
});

server.listen(port, '127.0.0.1');
"#,
    )
    .expect("test server should be writable");

    let output = Command::new(env!("CARGO_BIN_EXE_sim-one-ratatui-tui"))
        .arg("--smoke-startup")
        .arg("--server-path")
        .arg(&server_path)
        .arg("--env-path")
        .arg(root.join("missing.env"))
        .arg("--port")
        .arg(free_port().to_string())
        .output()
        .expect("built binary should run");

    assert!(
        output.status.success(),
        "fake server should satisfy product startup smoke, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("startup-visible"),
        "startup stderr should still be forwarded before the TUI starts, got: {stderr}"
    );
    assert!(
        !stderr.contains("shutdown-noise"),
        "post-health child stderr should be drained without reaching the terminal, got: {stderr}"
    );
}

fn free_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0))
        .expect("free port should be allocatable")
        .local_addr()
        .expect("local addr should be readable")
        .port()
}

fn temp_path(name: &str) -> PathBuf {
    let unique = format!(
        "sim-one-ratatui-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time should be monotonic enough")
            .as_nanos()
    );
    std::env::temp_dir().join(unique)
}
