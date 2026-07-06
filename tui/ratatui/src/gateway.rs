use std::env;
use std::fmt;
use std::fs::read_to_string;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread::{self, sleep, JoinHandle};
use std::time::{Duration, Instant};

use crate::http::parse_status_code;

const MIN_NODE_MAJOR: u64 = 22;
const MIN_NODE_MINOR: u64 = 18;

#[derive(Debug, Clone, Default)]
pub struct GatewayOptions {
    pub port: Option<u16>,
    pub server_path: Option<PathBuf>,
    pub env_path: Option<PathBuf>,
}

pub struct GatewayHandle {
    pub started: bool,
    pub port: u16,
    pub base_url: String,
    child: Option<Child>,
    log_drain: Option<ServerLogDrain>,
}

impl fmt::Debug for GatewayHandle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GatewayHandle")
            .field("started", &self.started)
            .field("port", &self.port)
            .field("base_url", &self.base_url)
            .finish_non_exhaustive()
    }
}

impl GatewayHandle {
    pub fn cleanup(&mut self) {
        if let Some(mut child) = self.child.take() {
            stop_server(&mut child);
        }
        if let Some(log_drain) = self.log_drain.take() {
            log_drain.join();
        }
    }
}

impl Drop for GatewayHandle {
    fn drop(&mut self) {
        self.cleanup();
    }
}

pub fn ensure_server_running(options: &GatewayOptions) -> Result<GatewayHandle, String> {
    let port = options.port.or_else(read_gateway_port).unwrap_or(3000);
    let base_url = format!("http://127.0.0.1:{port}");

    if check_health(port) {
        return Ok(GatewayHandle {
            started: false,
            port,
            base_url,
            child: None,
            log_drain: None,
        });
    }

    let server_path = resolve_server_path(options)?;
    if !server_path.exists() {
        return Err(format!(
            "Agent package not found at {}. Run 'sim-one install' first.",
            server_path.display()
        ));
    }

    let env_path = resolve_env_path(options);
    let mut server = start_server(&server_path, &env_path, port)?;
    if let Err(error) = wait_for_health(port, &mut server.child) {
        stop_server(&mut server.child);
        server.log_drain.join();
        return Err(error);
    }
    server.log_drain.disable_forwarding();

    Ok(GatewayHandle {
        started: true,
        port,
        base_url,
        child: Some(server.child),
        log_drain: Some(server.log_drain),
    })
}

pub fn resolve_server_path(options: &GatewayOptions) -> Result<PathBuf, String> {
    if let Some(path) = &options.server_path {
        return Ok(path.clone());
    }

    if let Ok(path) = env::var("SIM_ONE_SERVER_PATH") {
        return Ok(PathBuf::from(path));
    }

    let exe_dir = env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf));

    if let Some(dir) = exe_dir {
        let sibling = dir.join("..").join("sim-one-alpha").join("server.mjs");
        if sibling.exists() {
            return Ok(sibling);
        }

        let dev = env::current_dir()
            .map_err(|error| format!("Could not read current directory: {error}"))?
            .join(".gorombo")
            .join("sim-one-alpha")
            .join("server.mjs");
        if dev.exists() {
            return Ok(dev);
        }

        return Ok(sibling);
    }

    Ok(env::current_dir()
        .map_err(|error| format!("Could not read current directory: {error}"))?
        .join(".gorombo")
        .join("sim-one-alpha")
        .join("server.mjs"))
}

pub fn resolve_env_path(options: &GatewayOptions) -> PathBuf {
    if let Some(path) = &options.env_path {
        return path.clone();
    }

    if let Ok(path) = env::var("SIM_ONE_ENV_PATH") {
        return PathBuf::from(path);
    }

    for home in home_dir_candidates() {
        let prod_env = home.join(".gorombo").join(".env");
        if prod_env.exists() {
            return prod_env;
        }
    }

    env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".env")
}

pub fn read_gateway_port_from_config(path: &Path) -> Option<u16> {
    let value: serde_json::Value = serde_json::from_str(&read_to_string(path).ok()?).ok()?;
    let port = value.get("gateway")?.get("port")?.as_u64()?;
    u16::try_from(port).ok().filter(|port| *port != 0)
}

fn read_gateway_port() -> Option<u16> {
    let mut candidates = Vec::new();
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(
                dir.join("..")
                    .join("sim-one-alpha")
                    .join("gorombo.config.json"),
            );
        }
    }
    if let Ok(cwd) = env::current_dir() {
        candidates.push(
            cwd.join(".gorombo")
                .join("sim-one-alpha")
                .join("gorombo.config.json"),
        );
        candidates.push(
            cwd.join("src")
                .join("core")
                .join("config")
                .join("gorombo.config.json"),
        );
    }

    candidates
        .iter()
        .find_map(|path| read_gateway_port_from_config(path))
}

fn start_server(server_path: &Path, env_path: &Path, port: u16) -> Result<StartedServer, String> {
    let server_cwd = resolve_server_cwd(server_path)?;
    let server_arg = server_path
        .canonicalize()
        .unwrap_or_else(|_| server_path.to_path_buf());
    let mut command = Command::new(resolve_node_executable()?);
    if env_path.exists() {
        let env_arg = env_path
            .canonicalize()
            .unwrap_or_else(|_| env_path.to_path_buf());
        command.arg(format!("--env-file={}", env_arg.display()));
    }
    command.arg(server_arg);
    command.env("PORT", port.to_string());
    command.current_dir(server_cwd);
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start server: {error}"))?;
    let log_drain = ServerLogDrain::from_child(&mut child);
    Ok(StartedServer { child, log_drain })
}

pub fn resolve_server_cwd(server_path: &Path) -> Result<PathBuf, String> {
    let normalized = server_path
        .canonicalize()
        .unwrap_or_else(|_| server_path.to_path_buf());

    if let Some(server_dir) = normalized.parent() {
        let is_packaged_server =
            server_dir.file_name().and_then(|name| name.to_str()) == Some("sim-one-alpha");
        if is_packaged_server {
            if let Some(gorombo_dir) = server_dir.parent() {
                let is_gorombo_runtime =
                    gorombo_dir.file_name().and_then(|name| name.to_str()) == Some(".gorombo");
                if is_gorombo_runtime {
                    if let Some(runtime_root) = gorombo_dir.parent() {
                        return Ok(runtime_root.to_path_buf());
                    }
                }
            }
        }
    }

    env::current_dir().map_err(|error| format!("Could not read current directory: {error}"))
}

struct StartedServer {
    child: Child,
    log_drain: ServerLogDrain,
}

struct ServerLogDrain {
    forward: Arc<AtomicBool>,
    handles: Vec<JoinHandle<()>>,
}

impl ServerLogDrain {
    fn from_child(child: &mut Child) -> Self {
        let forward = Arc::new(AtomicBool::new(true));
        let mut handles = Vec::new();

        if let Some(stdout) = child.stdout.take() {
            handles.push(spawn_log_drain(
                stdout,
                Arc::clone(&forward),
                LogStream::Stdout,
            ));
        }
        if let Some(stderr) = child.stderr.take() {
            handles.push(spawn_log_drain(
                stderr,
                Arc::clone(&forward),
                LogStream::Stderr,
            ));
        }

        Self { forward, handles }
    }

    fn disable_forwarding(&self) {
        self.forward.store(false, Ordering::Relaxed);
    }

    fn join(self) {
        for handle in self.handles {
            let _ = handle.join();
        }
    }
}

#[derive(Clone, Copy)]
enum LogStream {
    Stdout,
    Stderr,
}

fn spawn_log_drain<R>(mut reader: R, forward: Arc<AtomicBool>, stream: LogStream) -> JoinHandle<()>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut buffer = [0; 8192];
        loop {
            let size = match reader.read(&mut buffer) {
                Ok(0) => return,
                Ok(size) => size,
                Err(_) => return,
            };

            if !forward.load(Ordering::Relaxed) {
                continue;
            }

            match stream {
                LogStream::Stdout => {
                    let mut stdout = std::io::stdout().lock();
                    let _ = stdout.write_all(&buffer[..size]);
                    let _ = stdout.flush();
                }
                LogStream::Stderr => {
                    let mut stderr = std::io::stderr().lock();
                    let _ = stderr.write_all(&buffer[..size]);
                    let _ = stderr.flush();
                }
            }
        }
    })
}

pub fn resolve_node_executable() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();

    if let Ok(path) = env::var("SIM_ONE_NODE") {
        candidates.push(PathBuf::from(path));
    }

    if let Ok(path) = env::var("PATH") {
        for dir in env::split_paths(&path) {
            candidates.push(dir.join(if cfg!(windows) { "node.exe" } else { "node" }));
        }
    }

    for nvm_root in nvm_roots() {
        collect_nvm_node_candidates(&nvm_root, &mut candidates);
    }

    let mut checked = Vec::new();
    for candidate in dedupe_paths(candidates) {
        if !candidate.exists() {
            continue;
        }

        match read_node_version(&candidate) {
            Some(version) if version.is_supported() => return Ok(candidate),
            Some(version) => checked.push(format!("{} ({})", candidate.display(), version)),
            None => checked.push(format!("{} (version unreadable)", candidate.display())),
        }
    }

    Err(format!(
        "SIM-ONE Alpha requires Node >= {MIN_NODE_MAJOR}.{MIN_NODE_MINOR}. \
         Set SIM_ONE_NODE to a Node 22 executable or put Node 22 on PATH. Checked: {}",
        if checked.is_empty() {
            "none".to_string()
        } else {
            checked.join(", ")
        }
    ))
}

fn nvm_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(path) = env::var("NVM_DIR") {
        roots.push(PathBuf::from(path));
    }
    if let Ok(home) = env::var("HOME") {
        roots.push(PathBuf::from(home).join(".nvm"));
    }
    roots.push(PathBuf::from("/root/.nvm"));
    dedupe_paths(roots)
}

fn collect_nvm_node_candidates(root: &Path, candidates: &mut Vec<PathBuf>) {
    let versions_dir = root.join("versions").join("node");
    let Ok(entries) = std::fs::read_dir(versions_dir) else {
        return;
    };

    let mut entries = entries
        .flatten()
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| right.cmp(left));

    for version_dir in entries {
        candidates.push(version_dir.join("bin").join(if cfg!(windows) {
            "node.exe"
        } else {
            "node"
        }));
    }
}

fn read_node_version(node_path: &Path) -> Option<NodeVersion> {
    let output = Command::new(node_path)
        .arg("-p")
        .arg("process.versions.node")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8(output.stdout).ok()?;
    NodeVersion::parse(stdout.trim())
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut unique = Vec::new();
    for path in paths {
        if !unique.iter().any(|existing| existing == &path) {
            unique.push(path);
        }
    }
    unique
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NodeVersion {
    major: u64,
    minor: u64,
    patch: u64,
}

impl NodeVersion {
    fn parse(value: &str) -> Option<Self> {
        let mut parts = value.trim_start_matches('v').split('.');
        Some(Self {
            major: parts.next()?.parse().ok()?,
            minor: parts.next()?.parse().ok()?,
            patch: parts.next().unwrap_or("0").parse().ok()?,
        })
    }

    fn is_supported(&self) -> bool {
        self.major > MIN_NODE_MAJOR
            || (self.major == MIN_NODE_MAJOR && self.minor >= MIN_NODE_MINOR)
    }
}

impl std::fmt::Display for NodeVersion {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "v{}.{}.{}", self.major, self.minor, self.patch)
    }
}

fn wait_for_health(port: u16, child: &mut Child) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(format!(
                    "Server exited unexpectedly with status {status} before becoming healthy."
                ));
            }
            Ok(None) => {}
            Err(error) => return Err(format!("Could not inspect server child: {error}")),
        }

        if check_health(port) {
            return Ok(());
        }
        sleep(Duration::from_millis(500));
    }

    Err("Server did not become healthy within 120s.".to_string())
}

fn check_health(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let _ = stream.shutdown(Shutdown::Write);

    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }
    let Some((head, _)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    parse_status_code(head, "Gateway health")
        .map(|status| (200..300).contains(&status))
        .unwrap_or(false)
}

fn stop_server(child: &mut Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }

    request_shutdown(child);
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        sleep(Duration::from_millis(100));
    }

    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(unix)]
fn request_shutdown(child: &mut Child) {
    const SIGTERM: i32 = 15;
    unsafe extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }

    let result = unsafe { kill(child.id() as i32, SIGTERM) };
    if result != 0 {
        eprintln!(
            "Failed to request server shutdown with SIGTERM: {}",
            std::io::Error::last_os_error()
        );
    }
}

#[cfg(not(unix))]
fn request_shutdown(child: &mut Child) {
    let _ = child.kill();
}

fn home_dir_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(home) = env::var("HOME") {
        candidates.push(PathBuf::from(home));
    }
    if let Ok(home) = env::var("USERPROFILE") {
        candidates.push(PathBuf::from(home));
    }
    if let Ok(user) = env::var("USER") {
        if user == "root" {
            candidates.push(PathBuf::from("/root"));
        } else {
            candidates.push(PathBuf::from("/home").join(user));
        }
    }
    candidates.push(PathBuf::from("/root"));
    dedupe_paths(candidates)
}
