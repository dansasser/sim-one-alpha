use std::env;
use std::fs::read_to_string;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

const MIN_NODE_MAJOR: u64 = 22;
const MIN_NODE_MINOR: u64 = 18;

#[derive(Debug, Clone, Default)]
pub struct GatewayOptions {
    pub port: Option<u16>,
    pub server_path: Option<PathBuf>,
    pub env_path: Option<PathBuf>,
}

#[derive(Debug)]
pub struct GatewayHandle {
    pub started: bool,
    pub port: u16,
    pub base_url: String,
    child: Option<Child>,
}

impl GatewayHandle {
    pub fn cleanup(&mut self) {
        if let Some(mut child) = self.child.take() {
            stop_server(&mut child);
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
    let mut child = start_server(&server_path, &env_path, port)?;
    if let Err(error) = wait_for_health(port, &mut child) {
        stop_server(&mut child);
        return Err(error);
    }

    Ok(GatewayHandle {
        started: true,
        port,
        base_url,
        child: Some(child),
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

    if let Ok(home) = env::var("HOME") {
        let prod_env = PathBuf::from(home).join(".gorombo").join(".env");
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
    u16::try_from(port).ok()
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
        candidates.push(cwd.join("src").join("config").join("gorombo.config.json"));
    }

    candidates
        .iter()
        .find_map(|path| read_gateway_port_from_config(path))
}

fn start_server(server_path: &Path, env_path: &Path, port: u16) -> Result<Child, String> {
    let mut command = Command::new(resolve_node_executable()?);
    if env_path.exists() {
        command.arg(format!("--env-file={}", env_path.display()));
    }
    command.arg(server_path);
    command.env("PORT", port.to_string());
    command.stdin(Stdio::null());
    command.stdout(Stdio::inherit());
    command.stderr(Stdio::inherit());
    command
        .spawn()
        .map_err(|error| format!("Failed to start server: {error}"))
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
    stream.read_to_string(&mut response).is_ok() && response.starts_with("HTTP/1.1 200")
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
    let _ = Command::new("kill")
        .arg("-TERM")
        .arg(child.id().to_string())
        .status();
}

#[cfg(not(unix))]
fn request_shutdown(child: &mut Child) {
    let _ = child.kill();
}
