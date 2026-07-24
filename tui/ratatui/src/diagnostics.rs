use std::fs::{create_dir_all, metadata, remove_file, rename, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

const DEFAULT_MAX_BYTES: u64 = 1_048_576;
const DEFAULT_ROTATIONS: usize = 3;
const LOG_FILE_NAME: &str = "sim-one-ratatui.jsonl";

static DIAGNOSTICS: OnceLock<Mutex<DiagnosticWriter>> = OnceLock::new();

pub fn init() {
    let override_path = std::env::var_os("SIM_ONE_TUI_LOG_PATH").map(PathBuf::from);
    let executable = std::env::current_exe().ok();
    let current_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let path = resolve_log_path(
        override_path.as_deref(),
        executable.as_deref(),
        &current_dir,
    );
    let _ = DIAGNOSTICS.set(Mutex::new(DiagnosticWriter::with_limits(
        path,
        DEFAULT_MAX_BYTES,
        DEFAULT_ROTATIONS,
    )));
}

pub fn launch_started(session_explicit: bool, selector: &str) {
    record(
        "launch.started",
        json!({
            "sessionMode": if session_explicit { "explicit" } else { "fresh" },
            "selectorKind": selector_kind(selector),
        }),
    );
}

pub fn gateway_ready(port: Option<u16>, process: &str) {
    record(
        "gateway.ready",
        json!({
            "port": port,
            "process": process,
        }),
    );
}

pub fn gateway_failed(error: &str) {
    record(
        "gateway.failed",
        json!({ "category": failure_category(error) }),
    );
}

pub fn session_lifecycle_started(mode: &str, selector: Option<&str>) {
    record(
        "session.lifecycle.started",
        json!({
            "mode": mode,
            "selectorKind": selector.map(selector_kind).unwrap_or("none"),
        }),
    );
}

pub fn session_lifecycle_completed(outcome: &str, selector: Option<&str>, session_id: &str) {
    record(
        "session.lifecycle.completed",
        json!({
            "outcome": outcome,
            "selectorKind": selector.map(selector_kind).unwrap_or("none"),
            "sessionId": session_id,
        }),
    );
}

pub fn session_lifecycle_failed(phase: &str, error: &str) {
    record(
        "session.lifecycle.failed",
        json!({
            "phase": phase,
            "category": failure_category(error),
        }),
    );
}

pub fn history_load_started() {
    record("history.load.started", json!({}));
}

pub fn history_load_completed(
    exchange_count: usize,
    activity_count: usize,
    elapsed_ms: u128,
    has_older: bool,
) {
    record(
        "history.load.completed",
        json!({
            "exchangeCount": exchange_count,
            "activityCount": activity_count,
            "elapsedMs": elapsed_ms,
            "hasOlder": has_older,
        }),
    );
}

pub fn history_load_failed(error: &str, elapsed_ms: u128) {
    record(
        "history.load.failed",
        json!({
            "category": failure_category(error),
            "elapsedMs": elapsed_ms,
        }),
    );
}

pub fn stream_attach_started(mode: &str) {
    record("stream.attach.started", json!({ "mode": mode }));
}

pub fn prompt_request_completed(succeeded: bool, elapsed_ms: u128) {
    record(
        "prompt.request.completed",
        json!({
            "outcome": if succeeded { "success" } else { "error" },
            "elapsedMs": elapsed_ms,
        }),
    );
}

pub fn prompt_response_applied(elapsed_ms: u128) {
    record(
        "prompt.response.applied",
        json!({ "elapsedMs": elapsed_ms }),
    );
}

pub fn history_page_prepended(exchange_count: usize, elapsed_ms: u128, has_older: bool) {
    record(
        "history.page.prepended",
        json!({
            "exchangeCount": exchange_count,
            "elapsedMs": elapsed_ms,
            "hasOlder": has_older,
        }),
    );
}

pub fn ctrl_c(action: &str, selected_chars: usize) {
    record(
        "input.ctrl_c",
        json!({
            "action": action,
            "selectedChars": selected_chars,
        }),
    );
}

pub fn clipboard_failed(error: &std::io::Error) {
    record(
        "clipboard.failed",
        json!({ "category": format!("{:?}", error.kind()).to_lowercase() }),
    );
}

pub fn application_exited(session_id: Option<&str>) {
    record("application.exited", json!({ "sessionId": session_id }));
}

fn record(event: &str, fields: Value) {
    let Some(diagnostics) = DIAGNOSTICS.get() else {
        return;
    };
    if let Ok(mut writer) = diagnostics.lock() {
        writer.record(event, fields);
    }
}

fn resolve_log_path(
    override_path: Option<&Path>,
    executable: Option<&Path>,
    current_dir: &Path,
) -> PathBuf {
    if let Some(path) = override_path {
        return path.to_path_buf();
    }

    if let Some(gorombo_dir) = executable
        .and_then(Path::parent)
        .and_then(Path::parent)
        .filter(|path| path.file_name().is_some_and(|name| name == ".gorombo"))
    {
        return gorombo_dir.join("logs").join(LOG_FILE_NAME);
    }

    current_dir
        .join(".gorombo")
        .join("logs")
        .join(LOG_FILE_NAME)
}

fn selector_kind(selector: &str) -> &'static str {
    let selector = selector.trim();
    if selector.is_empty() {
        "none"
    } else if selector.starts_with("tui-") {
        "id"
    } else {
        "name"
    }
}

fn failure_category(error: &str) -> &'static str {
    let error = error.to_ascii_lowercase();
    if error.contains("http 403") || error.contains("forbidden") {
        "forbidden"
    } else if error.contains("http 409") || error.contains("ambiguous") {
        "ambiguous"
    } else if error.contains("http 404") || error.contains("does not exist") {
        "not_found"
    } else if error.contains("timed out") || error.contains("timeout") {
        "timeout"
    } else if error.contains("exited unexpectedly") {
        "process_exit"
    } else if error.contains("node.js") || error.contains("node runtime") {
        "node_runtime"
    } else if error.contains("not found") || error.contains("missing") {
        "missing_artifact"
    } else if error.contains("disconnect") {
        "disconnected"
    } else {
        "other"
    }
}

struct DiagnosticWriter {
    path: PathBuf,
    max_bytes: u64,
    rotations: usize,
    launch_id: String,
    started_at: Instant,
}

impl DiagnosticWriter {
    fn with_limits(path: PathBuf, max_bytes: u64, rotations: usize) -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        Self {
            path,
            max_bytes,
            rotations,
            launch_id: format!("{timestamp}-{}", std::process::id()),
            started_at: Instant::now(),
        }
    }

    fn record(&mut self, event: &str, fields: Value) {
        let mut entry = Map::new();
        entry.insert("timestampMs".to_string(), json!(unix_timestamp_ms()));
        entry.insert("launchId".to_string(), json!(self.launch_id));
        entry.insert("pid".to_string(), json!(std::process::id()));
        entry.insert(
            "elapsedMs".to_string(),
            json!(self.started_at.elapsed().as_millis()),
        );
        entry.insert("event".to_string(), json!(event));
        if let Value::Object(fields) = fields {
            entry.extend(fields);
        }

        let Ok(mut line) = serde_json::to_vec(&entry) else {
            return;
        };
        line.push(b'\n');
        if self.prepare_for_write(line.len() as u64).is_err() {
            return;
        }
        let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
        else {
            return;
        };
        let _ = file.write_all(&line);
    }

    fn prepare_for_write(&self, incoming_bytes: u64) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            create_dir_all(parent)?;
        }
        let current_bytes = metadata(&self.path).map(|value| value.len()).unwrap_or(0);
        if current_bytes > 0 && current_bytes.saturating_add(incoming_bytes) > self.max_bytes {
            self.rotate()?;
        }
        Ok(())
    }

    fn rotate(&self) -> std::io::Result<()> {
        if self.rotations == 0 {
            if self.path.exists() {
                remove_file(&self.path)?;
            }
            return Ok(());
        }

        for index in (1..=self.rotations).rev() {
            let source = if index == 1 {
                self.path.clone()
            } else {
                rotated_path(&self.path, index - 1)
            };
            let destination = rotated_path(&self.path, index);
            if destination.exists() {
                remove_file(&destination)?;
            }
            if source.exists() {
                rename(source, destination)?;
            }
        }
        Ok(())
    }
}

fn rotated_path(path: &Path, index: usize) -> PathBuf {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("log");
    path.with_extension(format!("{extension}.{index}"))
}

fn unix_timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use std::fs::{read_to_string, remove_dir_all};
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use serde_json::json;

    use super::{resolve_log_path, selector_kind, DiagnosticWriter};

    #[test]
    fn packaged_log_path_uses_the_runtime_gorombo_directory() {
        let path = resolve_log_path(
            None,
            Some(Path::new(
                "/home/dan/.gorombo/sim-one-ratatui/sim-one-ratatui-tui",
            )),
            Path::new("/tmp/arbitrary-launch-directory"),
        );

        assert_eq!(
            path,
            PathBuf::from("/home/dan/.gorombo/logs/sim-one-ratatui.jsonl")
        );
    }

    #[test]
    fn diagnostics_rotate_without_recording_a_named_selector() {
        let root = temp_path("rotation");
        let path = root.join("sim-one-ratatui.jsonl");
        let mut writer = DiagnosticWriter::with_limits(path.clone(), 180, 2);

        for index in 0..8 {
            writer.record(
                "session.lifecycle.completed",
                json!({
                    "outcome": "name_resolved",
                    "selectorKind": selector_kind("Private Session Name"),
                    "sessionId": format!("tui-{index}"),
                }),
            );
        }

        let current = read_to_string(&path).expect("current diagnostic log should exist");
        let rotated = read_to_string(path.with_extension("jsonl.1"))
            .expect("first rotated diagnostic log should exist");
        assert!(!current.contains("Private Session Name"));
        assert!(!rotated.contains("Private Session Name"));
        assert!(path.with_extension("jsonl.2").exists());
        assert!(!path.with_extension("jsonl.3").exists());

        remove_dir_all(root).expect("diagnostic test directory should clean up");
    }

    fn temp_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "sim-one-ratatui-diagnostics-{label}-{}-{nonce}",
            std::process::id()
        ))
    }
}
