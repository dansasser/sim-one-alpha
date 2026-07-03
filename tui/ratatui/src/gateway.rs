use std::env;
use std::fs::read_to_string;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

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
    let mut command = Command::new(env::var("SIM_ONE_NODE").unwrap_or_else(|_| "node".to_string()));
    if env_path.exists() {
        command.arg(format!("--env-file={}", env_path.display()));
    }
    command.arg(server_path);
    command.env("PORT", port.to_string());
    command.stdin(Stdio::null());
    command.stdout(Stdio::null());
    command.stderr(Stdio::null());
    command
        .spawn()
        .map_err(|error| format!("Failed to start server: {error}"))
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
    let _ = child.kill();
    let _ = child.wait();
}
