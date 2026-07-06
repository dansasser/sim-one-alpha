use std::fs::{create_dir_all, read_to_string, remove_dir_all, write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Command;

#[cfg(unix)]
use std::os::fd::AsRawFd;

use sim_one_ratatui_tui::gateway::{
    read_gateway_port_from_config, resolve_env_path, resolve_node_executable, resolve_server_cwd,
    resolve_server_path, GatewayOptions,
};

#[test]
fn reads_gateway_port_from_config_json() {
    let root = TestTempDir::new("port-config");
    let config_path = root.path().join("gorombo.config.json");
    write(&config_path, r#"{"gateway":{"port":3977}}"#).expect("config should be writable");

    assert_eq!(read_gateway_port_from_config(&config_path), Some(3977));
}

#[test]
fn ignores_zero_gateway_port_from_config_json() {
    let root = TestTempDir::new("zero-port-config");
    let config_path = root.path().join("gorombo.config.json");
    write(&config_path, r#"{"gateway":{"port":0}}"#).expect("config should be writable");

    assert_eq!(read_gateway_port_from_config(&config_path), None);
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
fn server_cwd_uses_owner_of_packaged_gorombo_runtime_tree() {
    let root = TestTempDir::new("server-cwd");
    let server_dir = root.path().join(".gorombo").join("sim-one-alpha");
    create_dir_all(&server_dir).expect("packaged server dir should be creatable");
    let server_path = server_dir.join("server.mjs");
    write(&server_path, "").expect("test server should be writable");

    let resolved = resolve_server_cwd(&server_path).expect("server cwd should resolve");
    assert_eq!(
        resolved,
        root.path()
            .canonicalize()
            .expect("temp root should canonicalize")
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
        .arg("9")
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
fn built_binary_rejects_port_zero_at_parse_time() {
    let output = Command::new(env!("CARGO_BIN_EXE_sim-one-ratatui-tui"))
        .arg("--smoke-startup")
        .arg("--port")
        .arg("0")
        .output()
        .expect("built binary should run");

    assert!(!output.status.success(), "port zero should fail");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("--port must be between 1 and 65535"),
        "stderr should explain invalid port, got: {stderr}"
    );
}

#[test]
fn built_binary_launches_packaged_server_from_runtime_root_when_called_elsewhere() {
    let runtime_root = TestTempDir::new("packaged-cwd");
    let launch_dir = TestTempDir::new("launch-cwd");
    let server_dir = runtime_root.path().join(".gorombo").join("sim-one-alpha");
    create_dir_all(&server_dir).expect("packaged server dir should be creatable");
    let server_path = server_dir.join("server.mjs");
    let cwd_marker = runtime_root.path().join("server-cwd.txt");
    write(
        &server_path,
        r#"
import { writeFileSync } from 'node:fs';
import http from 'node:http';

const port = Number(process.env.PORT);
const listenFd = Number(process.env.SIM_ONE_TEST_LISTEN_FD || 0);
writeFileSync(process.env.SIM_ONE_TEST_CWD_MARKER, process.cwd());

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
  setTimeout(() => process.exit(0), 25);
});

if (listenFd) {
  server.listen({ fd: listenFd });
} else {
  server.listen(port, '127.0.0.1');
}
"#,
    )
    .expect("test server should be writable");

    let reserved_port = ReservedPort::new();
    let output = Command::new(env!("CARGO_BIN_EXE_sim-one-ratatui-tui"))
        .current_dir(launch_dir.path())
        .arg("--smoke-startup")
        .arg("--server-path")
        .arg(&server_path)
        .arg("--env-path")
        .arg(runtime_root.path().join("missing.env"))
        .arg("--port")
        .arg(reserved_port.port().to_string())
        .env("SIM_ONE_TEST_LISTEN_FD", reserved_port.raw_fd().to_string())
        .env("SIM_ONE_TEST_CWD_MARKER", &cwd_marker)
        .output()
        .expect("built binary should run");

    assert!(
        output.status.success(),
        "fake packaged server should satisfy product startup smoke, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let observed_cwd = read_to_string(&cwd_marker).expect("server should write cwd marker");
    let expected_cwd = runtime_root
        .path()
        .canonicalize()
        .expect("runtime root should canonicalize")
        .display()
        .to_string();
    assert_eq!(observed_cwd, expected_cwd);
}

#[test]
fn built_binary_silences_child_logs_after_gateway_is_healthy() {
    let root = TestTempDir::new("post-health-logs");
    let server_path = root.path().join("server.mjs");
    write(
        &server_path,
        r#"
import http from 'node:http';

	const port = Number(process.env.PORT);
	const listenFd = Number(process.env.SIM_ONE_TEST_LISTEN_FD || 0);
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

	if (listenFd) {
	  server.listen({ fd: listenFd });
	} else {
	  server.listen(port, '127.0.0.1');
	}
	"#,
    )
    .expect("test server should be writable");

    let reserved_port = ReservedPort::new();
    let output = Command::new(env!("CARGO_BIN_EXE_sim-one-ratatui-tui"))
        .arg("--smoke-startup")
        .arg("--server-path")
        .arg(&server_path)
        .arg("--env-path")
        .arg(root.path().join("missing.env"))
        .arg("--port")
        .arg(reserved_port.port().to_string())
        .env("SIM_ONE_TEST_LISTEN_FD", reserved_port.raw_fd().to_string())
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

struct TestTempDir {
    path: PathBuf,
}

impl TestTempDir {
    fn new(name: &str) -> Self {
        let unique = format!(
            "sim-one-ratatui-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should be monotonic enough")
                .as_nanos()
        );
        let path = std::env::temp_dir().join(unique);
        create_dir_all(&path).expect("temp dir should be created");
        Self { path }
    }

    fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl Drop for TestTempDir {
    fn drop(&mut self) {
        let _ = remove_dir_all(&self.path);
    }
}

#[cfg(unix)]
struct ReservedPort {
    listener: TcpListener,
}

#[cfg(unix)]
impl ReservedPort {
    fn new() -> Self {
        let listener =
            TcpListener::bind(("127.0.0.1", 0)).expect("reserved port should be allocatable");
        make_inheritable(listener.as_raw_fd());
        Self { listener }
    }

    fn port(&self) -> u16 {
        self.listener
            .local_addr()
            .expect("local addr should be readable")
            .port()
    }

    fn raw_fd(&self) -> i32 {
        self.listener.as_raw_fd()
    }
}

#[cfg(not(unix))]
struct ReservedPort {
    port: u16,
}

#[cfg(not(unix))]
impl ReservedPort {
    fn new() -> Self {
        let listener =
            TcpListener::bind(("127.0.0.1", 0)).expect("reserved port should be allocatable");
        let port = listener
            .local_addr()
            .expect("local addr should be readable")
            .port();
        drop(listener);
        Self { port }
    }

    fn port(&self) -> u16 {
        self.port
    }

    fn raw_fd(&self) -> i32 {
        0
    }
}

#[cfg(unix)]
fn make_inheritable(fd: i32) {
    const F_GETFD: i32 = 1;
    const F_SETFD: i32 = 2;
    const FD_CLOEXEC: i32 = 1;

    unsafe extern "C" {
        fn fcntl(fd: i32, cmd: i32, ...) -> i32;
    }

    let flags = unsafe { fcntl(fd, F_GETFD) };
    assert!(flags >= 0, "fcntl(F_GETFD) failed");
    let result = unsafe { fcntl(fd, F_SETFD, flags & !FD_CLOEXEC) };
    assert!(result >= 0, "fcntl(F_SETFD) failed");
}
