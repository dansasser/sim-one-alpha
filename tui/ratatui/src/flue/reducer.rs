use std::collections::{BTreeMap, BTreeSet, VecDeque};

use super::events::FlueEvent;

const EPHEMERAL_ROW_IDS: [&str; 4] = [
    "assistant-stream",
    "thinking-current",
    "turn-current",
    "operation-current",
];

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EventTranscript {
    rows: Vec<DisplayRow>,
    row_index: BTreeMap<String, usize>,
    seen_events: BTreeSet<String>,
    current_turn: CurrentTurn,
    turn_sequence: u64,
    fallback_tool_sequence: u64,
    fallback_task_sequence: u64,
    active_fallback_tools: BTreeMap<String, VecDeque<String>>,
    active_fallback_tasks: BTreeMap<String, VecDeque<String>>,
}

impl EventTranscript {
    pub fn apply_events(&mut self, events: &[FlueEvent]) {
        for event in events {
            self.apply_event(event);
        }
    }

    pub fn apply_event(&mut self, event: &FlueEvent) {
        if event.is_nested() {
            return;
        }
        if let Some(event_id) = stable_event_id(event) {
            if !self.seen_events.insert(event_id) {
                return;
            }
        }

        match event.event_type.as_str() {
            "turn_start" => {
                self.retire_ephemeral_rows();
                self.turn_sequence = self.turn_sequence.saturating_add(1);
                self.active_fallback_tools.clear();
                self.active_fallback_tasks.clear();
                self.current_turn.state = TurnState::ModelActive;
                self.current_turn.activity = Some("model turn".to_string());
                let id = self.ephemeral_row_id("turn-current");
                self.upsert_row(&id, DisplayRowKind::Progress, "turn: model active");
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
                let id = self.ephemeral_row_id("turn-current");
                self.upsert_row(
                    &id,
                    if event_has_error(&event.value) {
                        DisplayRowKind::Error
                    } else {
                        DisplayRowKind::Progress
                    },
                    text,
                );
            }
            "thinking_start" => {
                self.current_turn.state = TurnState::Thinking;
                self.current_turn.activity = Some("thinking".to_string());
                let id = self.ephemeral_row_id("thinking-current");
                self.upsert_row(&id, DisplayRowKind::Thinking, "thinking: started");
            }
            "thinking_delta" => {
                self.current_turn.state = TurnState::Thinking;
                let text = extract_text(&event.value).unwrap_or_else(|| "thinking".to_string());
                self.current_turn.activity = Some("thinking".to_string());
                let id = self.ephemeral_row_id("thinking-current");
                self.upsert_row(&id, DisplayRowKind::Thinking, &format!("thinking: {text}"));
            }
            "thinking_end" => {
                self.current_turn.state = TurnState::WaitingForFinal;
                self.current_turn.activity = Some("waiting for final response".to_string());
                let id = self.ephemeral_row_id("thinking-current");
                if !self.has_row(&id) {
                    self.upsert_row(&id, DisplayRowKind::Thinking, "thinking: done");
                }
            }
            "text_delta" => {
                self.current_turn.state = TurnState::ModelActive;
                let text = extract_text(&event.value).unwrap_or_default();
                self.current_turn.activity = Some("assistant text".to_string());
                let id = self.ephemeral_row_id("assistant-stream");
                self.append_row_text(&id, DisplayRowKind::Assistant, "assistant: ", &text);
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
                let id = event_tool_id(event).unwrap_or_else(|| self.start_fallback_tool_id(&name));
                self.current_turn.state = TurnState::ToolRunning;
                self.current_turn.activity = Some(format!("tool: {name}"));
                self.upsert_row(&id, DisplayRowKind::Tool, &format!("tool: {name} running"));
            }
            "tool" => {
                let name = extract_name(&event.value).unwrap_or_else(|| "tool".to_string());
                let id =
                    event_tool_id(event).unwrap_or_else(|| self.complete_fallback_tool_id(&name));
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
                self.upsert_row(
                    &id,
                    if event_has_error(&event.value) {
                        DisplayRowKind::Error
                    } else {
                        DisplayRowKind::Tool
                    },
                    &format!("tool: {name} {status}"),
                );
            }
            "task_start" => {
                let name = extract_name(&event.value).unwrap_or_else(|| "task".to_string());
                let id = event_task_id(event).unwrap_or_else(|| self.start_fallback_task_id(&name));
                self.current_turn.state = TurnState::TaskRunning;
                self.current_turn.activity = Some(format!("task: {name}"));
                self.upsert_row(&id, DisplayRowKind::Task, &format!("task: {name} running"));
            }
            "task" => {
                let name = extract_name(&event.value).unwrap_or_else(|| "task".to_string());
                let id =
                    event_task_id(event).unwrap_or_else(|| self.complete_fallback_task_id(&name));
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
                self.upsert_row(
                    &id,
                    if event_has_error(&event.value) {
                        DisplayRowKind::Error
                    } else {
                        DisplayRowKind::Task
                    },
                    &format!("task: {name} {status}"),
                );
            }
            "operation_start" => {
                let name = extract_name(&event.value).unwrap_or_else(|| "operation".to_string());
                self.current_turn.state = TurnState::ModelActive;
                self.current_turn.activity = Some(format!("operation: {name}"));
                let id = self.ephemeral_row_id("operation-current");
                self.upsert_row(
                    &id,
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
                let id = self.ephemeral_row_id("operation-current");
                self.upsert_row(
                    &id,
                    if event_has_error(&event.value) {
                        DisplayRowKind::Error
                    } else {
                        DisplayRowKind::Progress
                    },
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

    pub fn current_assistant_stream_text(&self) -> Option<&str> {
        let id = self.ephemeral_row_id("assistant-stream");
        let index = self.row_index.get(&id).copied()?;
        self.rows.get(index)?.text.strip_prefix("assistant: ")
    }

    fn has_row(&self, id: &str) -> bool {
        self.row_index.contains_key(id)
    }

    fn retire_ephemeral_rows(&mut self) {
        for id in EPHEMERAL_ROW_IDS {
            self.row_index.remove(&self.ephemeral_row_id(id));
        }
    }

    fn ephemeral_row_id(&self, id: &str) -> String {
        if self.turn_sequence == 0 {
            id.to_string()
        } else {
            format!("{id}-{}", self.turn_sequence)
        }
    }

    fn start_fallback_tool_id(&mut self, name: &str) -> String {
        self.fallback_tool_sequence = self.fallback_tool_sequence.saturating_add(1);
        let id = fallback_row_id(
            "tool",
            self.turn_sequence,
            self.fallback_tool_sequence,
            name,
        );
        self.active_fallback_tools
            .entry(name.to_string())
            .or_default()
            .push_back(id.clone());
        id
    }

    fn complete_fallback_tool_id(&mut self, name: &str) -> String {
        if let Some(id) = pop_active_fallback_id(&mut self.active_fallback_tools, name) {
            return id;
        }

        self.fallback_tool_sequence = self.fallback_tool_sequence.saturating_add(1);
        fallback_row_id(
            "tool",
            self.turn_sequence,
            self.fallback_tool_sequence,
            name,
        )
    }

    fn start_fallback_task_id(&mut self, name: &str) -> String {
        self.fallback_task_sequence = self.fallback_task_sequence.saturating_add(1);
        let id = fallback_row_id(
            "task",
            self.turn_sequence,
            self.fallback_task_sequence,
            name,
        );
        self.active_fallback_tasks
            .entry(name.to_string())
            .or_default()
            .push_back(id.clone());
        id
    }

    fn complete_fallback_task_id(&mut self, name: &str) -> String {
        if let Some(id) = pop_active_fallback_id(&mut self.active_fallback_tasks, name) {
            return id;
        }

        self.fallback_task_sequence = self.fallback_task_sequence.saturating_add(1);
        fallback_row_id(
            "task",
            self.turn_sequence,
            self.fallback_task_sequence,
            name,
        )
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

fn stable_event_id(event: &FlueEvent) -> Option<String> {
    event.event_index.map(|index| {
        format!(
            "index:{index}:{}:{}",
            event.timestamp.as_deref().unwrap_or(""),
            event.event_type
        )
    })
}

fn event_tool_id(event: &FlueEvent) -> Option<String> {
    extract_string(&event.value, &["toolCallId", "callId", "id"]).map(|id| format!("tool-{id}"))
}

fn event_task_id(event: &FlueEvent) -> Option<String> {
    extract_string(&event.value, &["taskId", "id"]).map(|id| format!("task-{id}"))
}

fn pop_active_fallback_id(
    active_ids: &mut BTreeMap<String, VecDeque<String>>,
    name: &str,
) -> Option<String> {
    let id = active_ids.get_mut(name).and_then(|ids| ids.pop_front());
    if active_ids.get(name).is_some_and(VecDeque::is_empty) {
        active_ids.remove(name);
    }
    id
}

fn fallback_row_id(kind: &str, turn_sequence: u64, sequence: u64, name: &str) -> String {
    let mut key = String::new();
    for char in name.chars() {
        if char.is_ascii_alphanumeric() {
            key.push(char.to_ascii_lowercase());
        } else if !key.ends_with('-') {
            key.push('-');
        }
    }
    let key = key.trim_matches('-');
    if key.is_empty() {
        format!("{kind}-fallback-{turn_sequence}-{sequence}-unnamed")
    } else {
        format!("{kind}-fallback-{turn_sequence}-{sequence}-{key}")
    }
}

pub(crate) fn extract_role(value: &serde_json::Value) -> Option<&str> {
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

pub(crate) fn extract_text(value: &serde_json::Value) -> Option<String> {
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
    if value.get("isError").and_then(|value| value.as_bool()) == Some(true) {
        return true;
    }

    match value.get("error") {
        Some(serde_json::Value::Bool(value)) => *value,
        Some(serde_json::Value::Null) | None => false,
        Some(_) => true,
    }
}
