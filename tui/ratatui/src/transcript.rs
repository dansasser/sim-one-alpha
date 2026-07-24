use std::collections::{BTreeMap, BTreeSet, VecDeque};

use crate::flue::events::FlueEvent;
use crate::history::{
    TranscriptActivity, TranscriptActivityKind, TranscriptActivityStatus,
    TranscriptAssistantMessage, TranscriptExchange, TranscriptPrompt, TranscriptPromptVisibility,
};

const MAX_THINKING_PREVIEW_CHARS: usize = 500;
const MAX_LOG_PREVIEW_CHARS: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptLineKind {
    User,
    Assistant,
    Thinking,
    Tool,
    Task,
    Operation,
    Log,
    Error,
    System,
    Preflight,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptLine {
    pub id: String,
    pub text: String,
    pub kind: TranscriptLineKind,
    pub is_streaming: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptNotice {
    pub id: String,
    pub speaker: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TranscriptBlock {
    Notice(String),
    Exchange(String),
}

#[derive(Debug, Clone, Default)]
pub struct TranscriptDocument {
    notices: Vec<TranscriptNotice>,
    notice_index: BTreeMap<String, usize>,
    exchanges: Vec<TranscriptExchange>,
    exchange_index: BTreeMap<String, usize>,
    submission_index: BTreeMap<String, usize>,
    blocks: Vec<TranscriptBlock>,
    snapshot_submissions: BTreeSet<String>,
    resumable_snapshot_submissions: BTreeSet<String>,
    seen_events: BTreeSet<String>,
    streaming_text: BTreeMap<String, String>,
    pending_text: BTreeMap<String, String>,
    notice_sequence: u64,
    pending_sequence: u64,
    fallback_sequence: BTreeMap<String, u64>,
    active_fallbacks: BTreeMap<String, VecDeque<String>>,
}

impl TranscriptDocument {
    pub fn install_snapshot(&mut self, exchanges: Vec<TranscriptExchange>) -> usize {
        self.append_snapshot(exchanges)
    }

    pub fn prepend_snapshot(&mut self, exchanges: Vec<TranscriptExchange>) -> usize {
        let mut inserted_exchanges = Vec::new();
        let mut inserted_ids = Vec::new();
        for exchange in exchanges {
            if self.contains_exchange(&exchange.id, &exchange.submission_id) {
                continue;
            }
            self.track_snapshot_submission(&exchange);
            inserted_ids.push(exchange.id.clone());
            inserted_exchanges.push(exchange);
        }
        if inserted_ids.is_empty() {
            return 0;
        }

        let insert_at = self
            .blocks
            .iter()
            .position(|block| matches!(block, TranscriptBlock::Exchange(_)))
            .unwrap_or(self.blocks.len());
        self.blocks.splice(
            insert_at..insert_at,
            inserted_ids.iter().cloned().map(TranscriptBlock::Exchange),
        );
        self.exchanges.splice(0..0, inserted_exchanges);
        self.rebuild_exchange_indexes();
        inserted_ids.len()
    }

    pub fn push_notice(&mut self, speaker: &str, text: &str) -> String {
        self.notice_sequence = self.notice_sequence.saturating_add(1);
        let id = format!("notice:{}", self.notice_sequence);
        self.notice_index.insert(id.clone(), self.notices.len());
        self.notices.push(TranscriptNotice {
            id: id.clone(),
            speaker: speaker.to_string(),
            text: text.to_string(),
        });
        self.blocks.push(TranscriptBlock::Notice(id.clone()));
        id
    }

    pub fn update_notice(&mut self, id: &str, speaker: &str, text: &str) -> bool {
        let Some(index) = self.notice_index.get(id).copied() else {
            return false;
        };
        let Some(notice) = self.notices.get_mut(index) else {
            return false;
        };
        notice.speaker = speaker.to_string();
        notice.text = text.to_string();
        true
    }

    pub fn begin_exchange(
        &mut self,
        prompt: Option<String>,
        visibility: TranscriptPromptVisibility,
    ) -> String {
        self.pending_sequence = self.pending_sequence.saturating_add(1);
        let id = format!("pending:{}", self.pending_sequence);
        let exchange = TranscriptExchange {
            id: id.clone(),
            submission_id: id.clone(),
            prompt: prompt.map(|text| TranscriptPrompt {
                id: format!("{id}:prompt"),
                text,
                received_at: String::new(),
                visibility,
            }),
            activities: Vec::new(),
            assistant: None,
            status: TranscriptActivityStatus::Running,
        };
        self.blocks.push(TranscriptBlock::Exchange(id.clone()));
        self.exchanges.push(exchange);
        self.rebuild_exchange_indexes();
        id
    }

    pub fn bind_exchange(&mut self, exchange_id: &str, submission_id: &str) -> Option<String> {
        let submission_id = submission_id.trim();
        if submission_id.is_empty() {
            return None;
        }
        let source_index = self.exchange_index.get(exchange_id).copied()?;

        if let Some(target_index) = self.submission_index.get(submission_id).copied() {
            if target_index == source_index {
                return self
                    .exchanges
                    .get(source_index)
                    .map(|exchange| exchange.id.clone());
            }
            return self.merge_exchange_into(source_index, target_index);
        }

        let new_id = format!("exchange:{submission_id}");
        let old_id = self.exchanges[source_index].id.clone();
        let old_submission = self.exchanges[source_index].submission_id.clone();
        self.exchanges[source_index].id = new_id.clone();
        self.exchanges[source_index].submission_id = submission_id.to_string();
        for block in &mut self.blocks {
            if matches!(block, TranscriptBlock::Exchange(id) if id == &old_id) {
                *block = TranscriptBlock::Exchange(new_id.clone());
            }
        }
        if let Some(text) = self.streaming_text.remove(&old_submission) {
            self.streaming_text.insert(submission_id.to_string(), text);
        }
        if let Some(text) = self.pending_text.remove(&old_id) {
            self.pending_text.insert(new_id.clone(), text);
        }
        self.rebuild_exchange_indexes();
        Some(new_id)
    }

    pub fn set_pending_text(&mut self, exchange_id: &str, text: impl Into<String>) -> bool {
        if !self.exchange_index.contains_key(exchange_id) {
            return false;
        }
        self.pending_text
            .insert(exchange_id.to_string(), text.into());
        true
    }

    pub fn clear_pending_text(&mut self, exchange_id: &str) {
        self.pending_text.remove(exchange_id);
    }

    pub fn set_assistant(
        &mut self,
        exchange_id: &str,
        message_id: Option<String>,
        text: &str,
        completed_at: Option<String>,
    ) -> bool {
        let Some(index) = self.exchange_index.get(exchange_id).copied() else {
            return false;
        };
        let text = text.trim();
        if text.is_empty() {
            return false;
        }
        let exchange = &mut self.exchanges[index];
        exchange.assistant = Some(TranscriptAssistantMessage {
            id: message_id.unwrap_or_else(|| format!("{}:assistant:http", exchange.id)),
            text: text.to_string(),
            completed_at: completed_at.unwrap_or_default(),
        });
        exchange.status = TranscriptActivityStatus::Completed;
        self.streaming_text.remove(&exchange.submission_id);
        self.pending_text.remove(exchange_id);
        true
    }

    pub fn contains_submission(&self, submission_id: &str) -> bool {
        self.submission_index.contains_key(submission_id)
    }

    pub fn exchange_id_for_submission(&self, submission_id: &str) -> Option<&str> {
        let index = self.submission_index.get(submission_id)?;
        self.exchanges
            .get(*index)
            .map(|exchange| exchange.id.as_str())
    }

    pub fn apply_events(&mut self, events: &[FlueEvent]) {
        for event in events {
            self.apply_event(event);
        }
    }

    pub fn apply_event(&mut self, event: &FlueEvent) {
        if event.is_nested() {
            return;
        }
        let Some(submission_id) = event_submission_id(event) else {
            return;
        };
        if self.snapshot_submissions.contains(&submission_id) {
            return;
        }
        if let Some(identity) = stable_event_identity(event, &submission_id) {
            if !self.seen_events.insert(identity) {
                return;
            }
        }

        let exchange_id = self.ensure_live_exchange(&submission_id);
        let event_type = event.event_type.as_str();
        match event_type {
            "operation_start" | "operation" => {
                let name = extract_name(&event.value, "operation");
                let activity_id =
                    self.activity_id(event, &submission_id, "operation", &name, event_type);
                let terminal = event_type == "operation";
                self.upsert_activity(
                    &exchange_id,
                    TranscriptActivity {
                        id: activity_id,
                        kind: TranscriptActivityKind::Operation,
                        name,
                        status: terminal_status(event, terminal),
                        started_at: (!terminal).then(|| event.timestamp.clone()).flatten(),
                        completed_at: terminal.then(|| event.timestamp.clone()).flatten(),
                        duration_ms: terminal.then(|| event_duration_ms(event)).flatten(),
                        preview: None,
                        error: event_has_error(event).then(|| "Operation failed.".to_string()),
                    },
                );
                if terminal {
                    self.set_exchange_terminal_status(&exchange_id, event_has_error(event));
                }
            }
            "thinking_start" | "thinking_delta" | "thinking_end" => {
                let activity_id = format!(
                    "thinking:{submission_id}:{}",
                    event_turn_id(event).unwrap_or("current")
                );
                let current = self
                    .activity(&exchange_id, &activity_id)
                    .cloned()
                    .unwrap_or(TranscriptActivity {
                        id: activity_id.clone(),
                        kind: TranscriptActivityKind::Thinking,
                        name: "thinking".to_string(),
                        status: TranscriptActivityStatus::Running,
                        started_at: event.timestamp.clone(),
                        completed_at: None,
                        duration_ms: None,
                        preview: None,
                        error: None,
                    });
                let event_text = extract_event_text(event).unwrap_or_default();
                let preview = match event_type {
                    "thinking_delta" => bounded_text(
                        &format!("{}{}", current.preview.unwrap_or_default(), event_text),
                        MAX_THINKING_PREVIEW_CHARS,
                    ),
                    _ if !event_text.is_empty() => {
                        bounded_text(&event_text, MAX_THINKING_PREVIEW_CHARS)
                    }
                    _ => current.preview.unwrap_or_default(),
                };
                self.upsert_activity(
                    &exchange_id,
                    TranscriptActivity {
                        id: activity_id,
                        kind: TranscriptActivityKind::Thinking,
                        name: "thinking".to_string(),
                        status: if event_type == "thinking_end" {
                            TranscriptActivityStatus::Completed
                        } else {
                            TranscriptActivityStatus::Running
                        },
                        started_at: current.started_at.or_else(|| event.timestamp.clone()),
                        completed_at: (event_type == "thinking_end")
                            .then(|| event.timestamp.clone())
                            .flatten(),
                        duration_ms: (event_type == "thinking_end")
                            .then(|| event_duration_ms(event))
                            .flatten(),
                        preview: (!preview.is_empty()).then_some(preview),
                        error: None,
                    },
                );
            }
            "tool_start" | "tool" => {
                let name = extract_name(&event.value, "tool");
                let activity_id =
                    self.activity_id(event, &submission_id, "tool", &name, event_type);
                let terminal = event_type == "tool";
                self.upsert_activity(
                    &exchange_id,
                    TranscriptActivity {
                        id: activity_id,
                        kind: TranscriptActivityKind::Tool,
                        name,
                        status: terminal_status(event, terminal),
                        started_at: (!terminal).then(|| event.timestamp.clone()).flatten(),
                        completed_at: terminal.then(|| event.timestamp.clone()).flatten(),
                        duration_ms: terminal.then(|| event_duration_ms(event)).flatten(),
                        preview: None,
                        error: (terminal && event_has_error(event))
                            .then(|| "Tool failed.".to_string()),
                    },
                );
                if terminal && event_has_error(event) {
                    self.set_exchange_terminal_status(&exchange_id, true);
                }
            }
            "task_start" | "task" => {
                let name = extract_name(&event.value, "task");
                let activity_id =
                    self.activity_id(event, &submission_id, "task", &name, event_type);
                let terminal = event_type == "task";
                self.upsert_activity(
                    &exchange_id,
                    TranscriptActivity {
                        id: activity_id,
                        kind: TranscriptActivityKind::Task,
                        name,
                        status: terminal_status(event, terminal),
                        started_at: (!terminal).then(|| event.timestamp.clone()).flatten(),
                        completed_at: terminal.then(|| event.timestamp.clone()).flatten(),
                        duration_ms: terminal.then(|| event_duration_ms(event)).flatten(),
                        preview: None,
                        error: (terminal && event_has_error(event))
                            .then(|| "Task failed.".to_string()),
                    },
                );
                if terminal && event_has_error(event) {
                    self.set_exchange_terminal_status(&exchange_id, true);
                }
            }
            "log" => {
                let Some(text) = extract_event_text(event)
                    .map(|text| bounded_text(&text, MAX_LOG_PREVIEW_CHARS))
                    .filter(|text| !text.trim().is_empty())
                else {
                    return;
                };
                let id = format!(
                    "log:{submission_id}:{}",
                    event
                        .event_index
                        .map(|index| index.to_string())
                        .unwrap_or_else(|| self.next_fallback_sequence(&submission_id).to_string())
                );
                self.upsert_activity(
                    &exchange_id,
                    TranscriptActivity {
                        id,
                        kind: TranscriptActivityKind::Log,
                        name: "log".to_string(),
                        status: if event_has_error(event) {
                            TranscriptActivityStatus::Failed
                        } else {
                            TranscriptActivityStatus::Completed
                        },
                        started_at: None,
                        completed_at: event.timestamp.clone(),
                        duration_ms: event_duration_ms(event),
                        preview: Some(text),
                        error: event_has_error(event)
                            .then(|| "Log event reported an error.".to_string()),
                    },
                );
            }
            "text_delta" => {
                if let Some(text) = extract_event_text(event) {
                    self.streaming_text
                        .entry(submission_id.clone())
                        .or_default()
                        .push_str(&text);
                }
            }
            "message_end" => {
                if extract_role(&event.value) != Some("assistant")
                    || message_text(&event.value)
                        .as_deref()
                        .is_none_or(|text| text.trim().is_empty())
                {
                    return;
                }
                let text = message_text(&event.value).unwrap_or_default();
                let turn = event_turn_id(event).unwrap_or("root");
                let event_position = event
                    .event_index
                    .map(|index| index.to_string())
                    .unwrap_or_else(|| self.next_fallback_sequence(&submission_id).to_string());
                let _ = self.set_assistant(
                    &exchange_id,
                    Some(format!("assistant:{submission_id}:{turn}:{event_position}")),
                    &text,
                    event.timestamp.clone(),
                );
            }
            "turn" => {
                self.set_exchange_terminal_status(&exchange_id, event_has_error(event));
            }
            _ => {}
        }
        let exchange_is_terminal = self.exchange(&exchange_id).is_some_and(|exchange| {
            matches!(
                exchange.status,
                TranscriptActivityStatus::Completed | TranscriptActivityStatus::Failed
            )
        });
        if self.resumable_snapshot_submissions.contains(&submission_id) && exchange_is_terminal {
            self.resumable_snapshot_submissions.remove(&submission_id);
            self.snapshot_submissions.insert(submission_id);
        }
    }

    pub fn lines(&self) -> Vec<TranscriptLine> {
        let mut lines = Vec::new();
        for block in &self.blocks {
            match block {
                TranscriptBlock::Notice(id) => {
                    let Some(notice) = self.notice(id) else {
                        continue;
                    };
                    append_speaker_lines(
                        &mut lines,
                        &notice.id,
                        &notice.speaker,
                        &notice.text,
                        notice_kind(&notice.speaker),
                        false,
                    );
                }
                TranscriptBlock::Exchange(id) => {
                    let Some(exchange) = self.exchange(id) else {
                        continue;
                    };
                    self.append_exchange_lines(exchange, &mut lines);
                }
            }
        }
        lines
    }

    pub fn exchanges(&self) -> &[TranscriptExchange] {
        &self.exchanges
    }

    pub fn first_exchange_line_id(&self) -> Option<String> {
        let exchange_id = self.blocks.iter().find_map(|block| match block {
            TranscriptBlock::Exchange(id) => Some(id),
            TranscriptBlock::Notice(_) => None,
        })?;
        let exchange = self.exchange(exchange_id)?;
        let mut lines = Vec::new();
        self.append_exchange_lines(exchange, &mut lines);
        lines.first().map(|line| line.id.clone())
    }

    fn append_snapshot(&mut self, exchanges: Vec<TranscriptExchange>) -> usize {
        let mut inserted = 0;
        for exchange in exchanges {
            if self.contains_exchange(&exchange.id, &exchange.submission_id) {
                continue;
            }
            self.track_snapshot_submission(&exchange);
            self.blocks
                .push(TranscriptBlock::Exchange(exchange.id.clone()));
            self.exchanges.push(exchange);
            inserted += 1;
        }
        self.rebuild_exchange_indexes();
        inserted
    }

    fn contains_exchange(&self, id: &str, submission_id: &str) -> bool {
        self.exchange_index.contains_key(id) || self.submission_index.contains_key(submission_id)
    }

    fn track_snapshot_submission(&mut self, exchange: &TranscriptExchange) {
        if matches!(
            exchange.status,
            TranscriptActivityStatus::Completed | TranscriptActivityStatus::Failed
        ) {
            self.snapshot_submissions
                .insert(exchange.submission_id.clone());
        } else {
            self.resumable_snapshot_submissions
                .insert(exchange.submission_id.clone());
        }
    }

    fn ensure_live_exchange(&mut self, submission_id: &str) -> String {
        if let Some(index) = self.submission_index.get(submission_id).copied() {
            return self.exchanges[index].id.clone();
        }
        let id = format!("exchange:{submission_id}");
        self.exchanges.push(TranscriptExchange {
            id: id.clone(),
            submission_id: submission_id.to_string(),
            prompt: None,
            activities: Vec::new(),
            assistant: None,
            status: TranscriptActivityStatus::Running,
        });
        self.blocks.push(TranscriptBlock::Exchange(id.clone()));
        self.rebuild_exchange_indexes();
        id
    }

    fn merge_exchange_into(&mut self, source_index: usize, target_index: usize) -> Option<String> {
        let source = self.exchanges.get(source_index)?.clone();
        let target_id = self.exchanges.get(target_index)?.id.clone();
        if self.exchanges[target_index].prompt.is_none() {
            self.exchanges[target_index].prompt = source.prompt;
        }
        let source_id = source.id;
        self.blocks
            .retain(|block| !matches!(block, TranscriptBlock::Exchange(id) if id == &source_id));
        self.exchanges.remove(source_index);
        self.pending_text.remove(&source_id);
        self.rebuild_exchange_indexes();
        Some(target_id)
    }

    fn rebuild_exchange_indexes(&mut self) {
        self.exchange_index.clear();
        self.submission_index.clear();
        for (index, exchange) in self.exchanges.iter().enumerate() {
            self.exchange_index.insert(exchange.id.clone(), index);
            self.submission_index
                .insert(exchange.submission_id.clone(), index);
        }
    }

    fn exchange(&self, id: &str) -> Option<&TranscriptExchange> {
        self.exchange_index
            .get(id)
            .and_then(|index| self.exchanges.get(*index))
    }

    fn notice(&self, id: &str) -> Option<&TranscriptNotice> {
        self.notice_index
            .get(id)
            .and_then(|index| self.notices.get(*index))
    }

    fn append_exchange_lines(
        &self,
        exchange: &TranscriptExchange,
        lines: &mut Vec<TranscriptLine>,
    ) {
        if let Some(prompt) = exchange
            .prompt
            .as_ref()
            .filter(|prompt| prompt.visibility == TranscriptPromptVisibility::User)
            .filter(|prompt| !prompt.text.trim().is_empty())
        {
            append_speaker_lines(
                lines,
                &prompt.id,
                "you",
                &prompt.text,
                TranscriptLineKind::User,
                false,
            );
        }

        for activity in &exchange.activities {
            let (kind, text) = format_activity(activity);
            append_plain_lines(lines, &activity.id, &text, kind, false);
        }

        if let Some(assistant) = exchange
            .assistant
            .as_ref()
            .filter(|assistant| !assistant.text.trim().is_empty())
        {
            append_speaker_lines(
                lines,
                &assistant.id,
                "assistant",
                &assistant.text,
                TranscriptLineKind::Assistant,
                false,
            );
            return;
        }

        if let Some(text) = self
            .streaming_text
            .get(&exchange.submission_id)
            .filter(|text| !text.is_empty())
        {
            append_speaker_lines(
                lines,
                &format!("{}:stream", exchange.id),
                "assistant",
                text,
                TranscriptLineKind::Assistant,
                true,
            );
            return;
        }

        if let Some(text) = self
            .pending_text
            .get(&exchange.id)
            .filter(|text| !text.is_empty())
        {
            append_plain_lines(
                lines,
                &format!("{}:pending", exchange.id),
                text,
                TranscriptLineKind::Assistant,
                true,
            );
        }
    }

    fn activity(&self, exchange_id: &str, activity_id: &str) -> Option<&TranscriptActivity> {
        self.exchange(exchange_id)?
            .activities
            .iter()
            .find(|activity| activity.id == activity_id)
    }

    fn upsert_activity(&mut self, exchange_id: &str, activity: TranscriptActivity) {
        let Some(index) = self.exchange_index.get(exchange_id).copied() else {
            return;
        };
        let activities = &mut self.exchanges[index].activities;
        if let Some(existing) = activities
            .iter_mut()
            .find(|existing| existing.id == activity.id)
        {
            let started_at = activity
                .started_at
                .clone()
                .or_else(|| existing.started_at.clone());
            *existing = activity;
            existing.started_at = started_at;
        } else {
            activities.push(activity);
        }
    }

    fn set_exchange_terminal_status(&mut self, exchange_id: &str, failed: bool) {
        let Some(index) = self.exchange_index.get(exchange_id).copied() else {
            return;
        };
        if failed {
            self.exchanges[index].status = TranscriptActivityStatus::Failed;
        } else if self.exchanges[index].status != TranscriptActivityStatus::Failed {
            self.exchanges[index].status = TranscriptActivityStatus::Completed;
        }
    }

    fn activity_id(
        &mut self,
        event: &FlueEvent,
        submission_id: &str,
        kind: &str,
        name: &str,
        event_type: &str,
    ) -> String {
        let stable = match kind {
            "operation" => extract_string(&event.value, &["operationId"]),
            "tool" => extract_string(&event.value, &["toolCallId", "callId"]),
            "task" => extract_string(&event.value, &["taskId"]),
            _ => None,
        };
        if let Some(stable) = stable {
            return format!("{kind}:{submission_id}:{stable}");
        }

        let terminal = event_type == kind;
        let active_key = format!("{submission_id}\0{kind}\0{name}");
        if terminal {
            if let Some(id) = self
                .active_fallbacks
                .get_mut(&active_key)
                .and_then(VecDeque::pop_front)
            {
                if self
                    .active_fallbacks
                    .get(&active_key)
                    .is_some_and(VecDeque::is_empty)
                {
                    self.active_fallbacks.remove(&active_key);
                }
                return id;
            }
        }

        let sequence = self.next_fallback_sequence(submission_id);
        let id = format!("{kind}:{submission_id}:fallback:{sequence}");
        if !terminal {
            self.active_fallbacks
                .entry(active_key)
                .or_default()
                .push_back(id.clone());
        }
        id
    }

    fn next_fallback_sequence(&mut self, submission_id: &str) -> u64 {
        let sequence = self
            .fallback_sequence
            .entry(submission_id.to_string())
            .or_default();
        *sequence = sequence.saturating_add(1);
        *sequence
    }
}

pub fn format_event_duration(duration_ms: u64) -> String {
    if duration_ms < 1_000 {
        return format!("{duration_ms}ms");
    }
    if duration_ms < 60_000 {
        let seconds = duration_ms as f64 / 1_000.0;
        if duration_ms.is_multiple_of(1_000) {
            return format!("{}s", duration_ms / 1_000);
        }
        return format!("{seconds:.1}s");
    }

    let total_seconds = duration_ms / 1_000;
    if total_seconds < 3_600 {
        return format!("{}m {:02}s", total_seconds / 60, total_seconds % 60);
    }
    format!(
        "{}h {:02}m",
        total_seconds / 3_600,
        (total_seconds % 3_600) / 60
    )
}

fn format_activity(activity: &TranscriptActivity) -> (TranscriptLineKind, String) {
    let failed = activity.status == TranscriptActivityStatus::Failed;
    let kind = if failed {
        TranscriptLineKind::Error
    } else {
        match activity.kind {
            TranscriptActivityKind::Operation => TranscriptLineKind::Operation,
            TranscriptActivityKind::Thinking => TranscriptLineKind::Thinking,
            TranscriptActivityKind::Tool => TranscriptLineKind::Tool,
            TranscriptActivityKind::Task => TranscriptLineKind::Task,
            TranscriptActivityKind::Log => TranscriptLineKind::Log,
            TranscriptActivityKind::Unknown => TranscriptLineKind::Other,
        }
    };

    if activity.kind == TranscriptActivityKind::Thinking {
        let preview = activity.preview.as_deref().unwrap_or_default().trim();
        return (
            kind,
            if preview.is_empty() {
                match activity.status {
                    TranscriptActivityStatus::Running => "thinking: started".to_string(),
                    TranscriptActivityStatus::Completed => "thinking: done".to_string(),
                    TranscriptActivityStatus::Failed => "thinking: failed".to_string(),
                    TranscriptActivityStatus::Unknown => "thinking: status unknown".to_string(),
                }
            } else {
                format!("thinking: {preview}")
            },
        );
    }

    if activity.kind == TranscriptActivityKind::Log {
        return (
            kind,
            format!(
                "log: {}",
                activity
                    .preview
                    .as_deref()
                    .or(activity.error.as_deref())
                    .unwrap_or(&activity.name)
            ),
        );
    }

    let prefix = match activity.kind {
        TranscriptActivityKind::Operation => "operation",
        TranscriptActivityKind::Tool => "tool",
        TranscriptActivityKind::Task => "task",
        TranscriptActivityKind::Thinking | TranscriptActivityKind::Log => unreachable!(),
        TranscriptActivityKind::Unknown => "activity",
    };
    let status = match activity.status {
        TranscriptActivityStatus::Running => "running",
        TranscriptActivityStatus::Completed => "completed",
        TranscriptActivityStatus::Failed => "failed",
        TranscriptActivityStatus::Unknown => "status unknown",
    };
    let duration = activity
        .duration_ms
        .map(format_event_duration)
        .map(|duration| format!(" in {duration}"))
        .unwrap_or_default();
    (
        kind,
        format!("{prefix}: {} {status}{duration}", activity.name),
    )
}

fn append_speaker_lines(
    lines: &mut Vec<TranscriptLine>,
    id: &str,
    speaker: &str,
    text: &str,
    kind: TranscriptLineKind,
    is_streaming: bool,
) {
    let mut split = text.lines();
    let first = split.next().unwrap_or_default();
    lines.push(TranscriptLine {
        id: format!("{id}:0"),
        text: if first.is_empty() {
            format!("{speaker}:")
        } else {
            format!("{speaker}: {first}")
        },
        kind,
        is_streaming,
    });
    for (index, line) in split.enumerate() {
        lines.push(TranscriptLine {
            id: format!("{id}:{}", index + 1),
            text: format!("  {line}"),
            kind,
            is_streaming,
        });
    }
}

fn append_plain_lines(
    lines: &mut Vec<TranscriptLine>,
    id: &str,
    text: &str,
    kind: TranscriptLineKind,
    is_streaming: bool,
) {
    for (index, line) in text.lines().enumerate() {
        lines.push(TranscriptLine {
            id: format!("{id}:{index}"),
            text: line.to_string(),
            kind,
            is_streaming,
        });
    }
}

fn notice_kind(speaker: &str) -> TranscriptLineKind {
    match speaker {
        "system" => TranscriptLineKind::System,
        "preflight" => TranscriptLineKind::Preflight,
        "error" => TranscriptLineKind::Error,
        "assistant" => TranscriptLineKind::Assistant,
        "you" => TranscriptLineKind::User,
        _ => TranscriptLineKind::Other,
    }
}

fn event_submission_id(event: &FlueEvent) -> Option<String> {
    extract_string(&event.value, &["submissionId", "submission.id"])
}

fn event_turn_id(event: &FlueEvent) -> Option<&str> {
    event
        .value
        .get("turnId")
        .and_then(serde_json::Value::as_str)
}

fn event_duration_ms(event: &FlueEvent) -> Option<u64> {
    event
        .value
        .get("durationMs")
        .and_then(serde_json::Value::as_u64)
}

fn event_has_error(event: &FlueEvent) -> bool {
    if event
        .value
        .get("isError")
        .and_then(serde_json::Value::as_bool)
        == Some(true)
    {
        return true;
    }
    !matches!(
        event.value.get("error"),
        None | Some(serde_json::Value::Null) | Some(serde_json::Value::Bool(false))
    )
}

fn terminal_status(event: &FlueEvent, terminal: bool) -> TranscriptActivityStatus {
    if !terminal {
        TranscriptActivityStatus::Running
    } else if event_has_error(event) {
        TranscriptActivityStatus::Failed
    } else {
        TranscriptActivityStatus::Completed
    }
}

fn stable_event_identity(event: &FlueEvent, submission_id: &str) -> Option<String> {
    event.event_index.map(|index| {
        format!(
            "{submission_id}\0{index}\0{}\0{}",
            event.event_type,
            event.timestamp.as_deref().unwrap_or_default()
        )
    })
}

fn extract_role(value: &serde_json::Value) -> Option<&str> {
    value
        .pointer("/message/role")
        .and_then(serde_json::Value::as_str)
        .or_else(|| value.get("role").and_then(serde_json::Value::as_str))
}

fn message_text(value: &serde_json::Value) -> Option<String> {
    let content = value
        .pointer("/message/content")
        .or_else(|| value.get("text"))?;
    match content {
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Array(parts) => {
            let text = parts
                .iter()
                .filter_map(|part| {
                    (part.get("type").and_then(serde_json::Value::as_str) == Some("text"))
                        .then(|| part.get("text").and_then(serde_json::Value::as_str))
                        .flatten()
                })
                .collect::<String>();
            (!text.is_empty()).then_some(text)
        }
        _ => None,
    }
}

fn extract_event_text(event: &FlueEvent) -> Option<String> {
    for path in ["text", "delta", "content", "message", "summary"] {
        if let Some(text) = event.value.get(path).and_then(serde_json::Value::as_str) {
            return Some(text.to_string());
        }
    }
    None
}

fn extract_name(value: &serde_json::Value, fallback: &str) -> String {
    extract_string(
        value,
        &[
            "operationKind",
            "operationName",
            "toolName",
            "taskName",
            "name",
        ],
    )
    .unwrap_or_else(|| fallback.to_string())
}

fn extract_string(value: &serde_json::Value, paths: &[&str]) -> Option<String> {
    for path in paths {
        let mut current = value;
        let mut found = true;
        for part in path.split('.') {
            let Some(next) = current.get(part) else {
                found = false;
                break;
            };
            current = next;
        }
        if found {
            if let Some(text) = current
                .as_str()
                .map(str::trim)
                .filter(|text| !text.is_empty())
            {
                return Some(text.to_string());
            }
        }
    }
    None
}

fn bounded_text(value: &str, limit: usize) -> String {
    let characters = value.chars().collect::<Vec<_>>();
    if characters.len() <= limit {
        return value.to_string();
    }
    let keep = limit.saturating_sub(3);
    format!("{}...", characters[..keep].iter().collect::<String>())
}
