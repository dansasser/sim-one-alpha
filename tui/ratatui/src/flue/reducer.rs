use std::collections::{BTreeMap, BTreeSet};

use super::events::FlueEvent;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EventTranscript {
    rows: Vec<DisplayRow>,
    row_index: BTreeMap<String, usize>,
    seen_events: BTreeSet<String>,
    current_turn: CurrentTurn,
}

impl EventTranscript {
    pub fn apply_events(&mut self, events: &[FlueEvent]) {
        for event in events {
            self.apply_event(event);
        }
    }

    pub fn apply_event(&mut self, event: &FlueEvent) {
        let event_id = stable_event_id(event);
        if !self.seen_events.insert(event_id) {
            return;
        }

        match event.event_type.as_str() {
            "turn_start" => {
                self.current_turn.state = TurnState::ModelActive;
                self.current_turn.activity = Some("model turn".to_string());
                self.upsert_row(
                    "turn-current",
                    DisplayRowKind::Progress,
                    "turn: model active",
                );
            }
            "turn" => {
                let text = if event_has_error(&event.value) {
                    "turn: failed"
                } else {
                    "turn: completed"
                };
                self.current_turn.state = if event_has_error(&event.value) {
                    TurnState::Failed
                } else {
                    TurnState::Completed
                };
                self.current_turn.activity = Some(text.to_string());
                self.upsert_row("turn-current", DisplayRowKind::Progress, text);
            }
            "thinking_start" => {
                self.current_turn.state = TurnState::Thinking;
                self.current_turn.activity = Some("thinking".to_string());
                self.upsert_row(
                    "thinking-current",
                    DisplayRowKind::Thinking,
                    "thinking: started",
                );
            }
            "thinking_delta" => {
                self.current_turn.state = TurnState::Thinking;
                let text = extract_text(&event.value).unwrap_or_else(|| "thinking".to_string());
                self.current_turn.activity = Some("thinking".to_string());
                self.upsert_row(
                    "thinking-current",
                    DisplayRowKind::Thinking,
                    &format!("thinking: {text}"),
                );
            }
            "thinking_end" => {
                self.current_turn.state = TurnState::WaitingForFinal;
                self.current_turn.activity = Some("waiting for final response".to_string());
                if !self.has_row("thinking-current") {
                    self.upsert_row(
                        "thinking-current",
                        DisplayRowKind::Thinking,
                        "thinking: done",
                    );
                }
            }
            "text_delta" => {
                self.current_turn.state = TurnState::ModelActive;
                let text = extract_text(&event.value).unwrap_or_default();
                self.current_turn.activity = Some("assistant text".to_string());
                self.append_row_text(
                    "assistant-stream",
                    DisplayRowKind::Assistant,
                    "assistant: ",
                    &text,
                );
            }
            "message_end" => {
                let role = extract_role(&event.value).unwrap_or("assistant");
                let text = extract_text(&event.value).unwrap_or_default();
                let kind = if role == "user" {
                    DisplayRowKind::User
                } else {
                    DisplayRowKind::Assistant
                };
                let speaker = if role == "user" { "you" } else { "assistant" };
                let id = format!(
                    "message-{}",
                    event
                        .event_index
                        .map(|index| index.to_string())
                        .unwrap_or_else(|| self.rows.len().to_string())
                );
                self.upsert_row(&id, kind, &format!("{speaker}: {text}"));
                self.current_turn.state = TurnState::Completed;
                self.current_turn.activity = Some("message complete".to_string());
            }
            "tool_start" => {
                let name = extract_name(&event.value).unwrap_or_else(|| "tool".to_string());
                let id =
                    event_tool_id(event).unwrap_or_else(|| format!("tool-{}", self.rows.len()));
                self.current_turn.state = TurnState::ToolRunning;
                self.current_turn.activity = Some(format!("tool: {name}"));
                self.upsert_row(&id, DisplayRowKind::Tool, &format!("tool: {name} running"));
            }
            "tool" => {
                let name = extract_name(&event.value).unwrap_or_else(|| "tool".to_string());
                let id =
                    event_tool_id(event).unwrap_or_else(|| format!("tool-{}", self.rows.len()));
                let status = if event_has_error(&event.value) {
                    "failed"
                } else {
                    "completed"
                };
                self.current_turn.state = if event_has_error(&event.value) {
                    TurnState::Failed
                } else {
                    TurnState::WaitingForFinal
                };
                self.current_turn.activity = Some(format!("tool: {name} {status}"));
                self.upsert_row(&id, DisplayRowKind::Tool, &format!("tool: {name} {status}"));
            }
            "task_start" => {
                let name = extract_name(&event.value).unwrap_or_else(|| "task".to_string());
                let id =
                    event_task_id(event).unwrap_or_else(|| format!("task-{}", self.rows.len()));
                self.current_turn.state = TurnState::TaskRunning;
                self.current_turn.activity = Some(format!("task: {name}"));
                self.upsert_row(&id, DisplayRowKind::Task, &format!("task: {name} running"));
            }
            "task" => {
                let name = extract_name(&event.value).unwrap_or_else(|| "task".to_string());
                let id =
                    event_task_id(event).unwrap_or_else(|| format!("task-{}", self.rows.len()));
                let status = if event_has_error(&event.value) {
                    "failed"
                } else {
                    "completed"
                };
                self.current_turn.state = if event_has_error(&event.value) {
                    TurnState::Failed
                } else {
                    TurnState::WaitingForFinal
                };
                self.current_turn.activity = Some(format!("task: {name} {status}"));
                self.upsert_row(&id, DisplayRowKind::Task, &format!("task: {name} {status}"));
            }
            "operation_start" => {
                let name = extract_name(&event.value).unwrap_or_else(|| "operation".to_string());
                self.current_turn.state = TurnState::ModelActive;
                self.current_turn.activity = Some(format!("operation: {name}"));
                self.upsert_row(
                    "operation-current",
                    DisplayRowKind::Progress,
                    &format!("operation: {name} running"),
                );
            }
            "operation" => {
                let name = extract_name(&event.value).unwrap_or_else(|| "operation".to_string());
                let status = if event_has_error(&event.value) {
                    "failed"
                } else {
                    "completed"
                };
                self.current_turn.activity = Some(format!("operation: {name} {status}"));
                self.upsert_row(
                    "operation-current",
                    DisplayRowKind::Progress,
                    &format!("operation: {name} {status}"),
                );
            }
            "log" => {
                if let Some(text) = extract_text(&event.value) {
                    let id = format!(
                        "log-{}",
                        event
                            .event_index
                            .map(|index| index.to_string())
                            .unwrap_or_else(|| self.rows.len().to_string())
                    );
                    self.upsert_row(&id, DisplayRowKind::Log, &format!("log: {text}"));
                }
            }
            "submission_settled" => {
                let status = extract_string(&event.value, &["outcome", "status"])
                    .unwrap_or_else(|| "settled".to_string());
                self.upsert_row(
                    "submission-settled",
                    DisplayRowKind::Progress,
                    &format!("submission: {status}"),
                );
            }
            _ => {}
        }
    }

    pub fn rows(&self) -> &[DisplayRow] {
        &self.rows
    }

    pub fn current_turn(&self) -> &CurrentTurn {
        &self.current_turn
    }

    fn has_row(&self, id: &str) -> bool {
        self.row_index.contains_key(id)
    }

    fn upsert_row(&mut self, id: &str, kind: DisplayRowKind, text: &str) {
        if let Some(index) = self.row_index.get(id).copied() {
            self.rows[index].text = text.to_string();
            self.rows[index].kind = kind;
            return;
        }

        self.row_index.insert(id.to_string(), self.rows.len());
        self.rows.push(DisplayRow {
            id: id.to_string(),
            kind,
            text: text.to_string(),
        });
    }

    fn append_row_text(&mut self, id: &str, kind: DisplayRowKind, prefix: &str, text: &str) {
        if let Some(index) = self.row_index.get(id).copied() {
            self.rows[index].text.push_str(text);
            return;
        }

        self.row_index.insert(id.to_string(), self.rows.len());
        self.rows.push(DisplayRow {
            id: id.to_string(),
            kind,
            text: format!("{prefix}{text}"),
        });
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayRow {
    pub id: String,
    pub kind: DisplayRowKind,
    pub text: String,
}

impl DisplayRow {
    pub fn is_activity(&self) -> bool {
        matches!(
            self.kind,
            DisplayRowKind::Thinking
                | DisplayRowKind::Tool
                | DisplayRowKind::Task
                | DisplayRowKind::Progress
                | DisplayRowKind::Log
                | DisplayRowKind::Error
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisplayRowKind {
    User,
    Assistant,
    Thinking,
    Tool,
    Task,
    Progress,
    Log,
    Error,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CurrentTurn {
    pub state: TurnState,
    pub activity: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TurnState {
    #[default]
    Ready,
    Thinking,
    ModelActive,
    ToolRunning,
    TaskRunning,
    WaitingForFinal,
    Completed,
    Failed,
}

fn stable_event_id(event: &FlueEvent) -> String {
    if let Some(index) = event.event_index {
        return format!("index:{index}");
    }

    format!(
        "{}:{}:{}",
        event.event_type,
        event.timestamp.as_deref().unwrap_or(""),
        event.value
    )
}

fn event_tool_id(event: &FlueEvent) -> Option<String> {
    extract_string(&event.value, &["toolCallId", "callId", "id"]).map(|id| format!("tool-{id}"))
}

fn event_task_id(event: &FlueEvent) -> Option<String> {
    extract_string(&event.value, &["taskId", "id"]).map(|id| format!("task-{id}"))
}

fn extract_role(value: &serde_json::Value) -> Option<&str> {
    value
        .pointer("/message/role")
        .and_then(|role| role.as_str())
        .or_else(|| value.get("role").and_then(|role| role.as_str()))
}

fn extract_name(value: &serde_json::Value) -> Option<String> {
    extract_string(
        value,
        &[
            "toolName",
            "taskName",
            "operation",
            "operationName",
            "name",
            "tool.name",
            "task.name",
        ],
    )
}

fn extract_text(value: &serde_json::Value) -> Option<String> {
    extract_string(
        value,
        &[
            "text",
            "delta",
            "message.text",
            "message.content",
            "message.content.0.text",
            "content",
            "summary",
            "message",
            "error.message",
        ],
    )
}

fn extract_string(value: &serde_json::Value, paths: &[&str]) -> Option<String> {
    for path in paths {
        if let Some(found) = value_at_dotted_path(value, path).and_then(value_as_string) {
            return Some(found);
        }
    }
    None
}

fn value_at_dotted_path<'a>(
    value: &'a serde_json::Value,
    path: &str,
) -> Option<&'a serde_json::Value> {
    let mut current = value;
    for part in path.split('.') {
        if let Ok(index) = part.parse::<usize>() {
            current = current.get(index)?;
        } else {
            current = current.get(part)?;
        }
    }
    Some(current)
}

fn value_as_string(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Number(number) => Some(number.to_string()),
        serde_json::Value::Bool(boolean) => Some(boolean.to_string()),
        _ => None,
    }
}

fn event_has_error(value: &serde_json::Value) -> bool {
    match value.get("error") {
        Some(serde_json::Value::Bool(value)) => *value,
        Some(serde_json::Value::Null) | None => false,
        Some(_) => true,
    }
}
