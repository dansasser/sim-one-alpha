use std::collections::BTreeMap;
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crate::agent::send_agent_prompt;
use crate::flue::reducer::{DisplayRow, EventTranscript};
use crate::flue::stream::{spawn_agent_stream, AgentStreamHandle, AgentStreamUpdate};

pub const SCROLL_PAGE_LINES: usize = 8;
const PLACEHOLDER_CONTEXT_LINES: usize = 24;
const SPINNER_FRAMES: [&str; 4] = ["|", "/", "-", "\\"];

pub type AgentSender =
    Arc<dyn Fn(String, String, String) -> Result<String, String> + Send + Sync + 'static>;
pub type Clock = Arc<dyn Fn() -> Instant + Send + Sync + 'static>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppEvent {
    Text(String),
    Backspace,
    Delete,
    Submit,
    MovePromptLeft,
    MovePromptRight,
    MovePromptWordLeft,
    MovePromptWordRight,
    MovePromptStart,
    MovePromptEnd,
    DeletePromptWordLeft,
    ClearPrompt,
    ScrollLineUp,
    ScrollLineDown,
    ScrollPageUp,
    ScrollPageDown,
    JumpToTail,
    Quit,
}

pub struct App {
    prompt: String,
    prompt_cursor: usize,
    transcript_lines: Vec<String>,
    transcript_scroll: usize,
    follow_tail: bool,
    should_quit: bool,
    session_id: String,
    gateway_status: String,
    base_url: String,
    agent_status: String,
    agent_sender: AgentSender,
    clock: Clock,
    pending_response: Option<PendingResponse>,
    stream_handle: Option<AgentStreamHandle>,
    stream_status: StreamStatus,
    last_stream_event: Option<String>,
    event_transcript: EventTranscript,
    event_row_lines: BTreeMap<String, usize>,
    transcript_viewport_height: usize,
}

#[derive(Debug)]
struct PendingResponse {
    receiver: Receiver<AgentResponse>,
    transcript_line: usize,
    started_at: Instant,
    spinner_frame: usize,
    duplicate_submit_notice: bool,
}

#[derive(Debug)]
struct AgentResponse {
    result: Result<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum StreamStatus {
    NotAttached,
    Connecting,
    Live,
    Idle,
    Reconnecting,
    Failed,
}

impl App {
    pub fn new(gateway_status: impl Into<String>, base_url: impl Into<String>) -> Self {
        Self::with_session("primary", gateway_status, base_url)
    }

    pub fn new_for_test() -> Self {
        Self::with_agent_sender(
            "primary",
            "offline placeholder",
            "http://127.0.0.1:3940",
            Arc::new(|_, _, prompt| Ok(format!("test response to {prompt}"))),
        )
    }

    pub fn with_session(
        session_id: impl Into<String>,
        gateway_status: impl Into<String>,
        base_url: impl Into<String>,
    ) -> Self {
        Self::with_agent_sender(
            session_id,
            gateway_status,
            base_url,
            Arc::new(|base_url, session_id, prompt| {
                send_agent_prompt(&base_url, &session_id, &prompt)
            }),
        )
    }

    pub fn with_agent_sender(
        session_id: impl Into<String>,
        gateway_status: impl Into<String>,
        base_url: impl Into<String>,
        agent_sender: AgentSender,
    ) -> Self {
        Self::with_agent_sender_and_clock(
            session_id,
            gateway_status,
            base_url,
            agent_sender,
            Arc::new(Instant::now),
        )
    }

    pub fn with_agent_sender_and_clock(
        session_id: impl Into<String>,
        gateway_status: impl Into<String>,
        base_url: impl Into<String>,
        agent_sender: AgentSender,
        clock: Clock,
    ) -> Self {
        let mut app = Self {
            prompt: String::new(),
            prompt_cursor: 0,
            transcript_lines: initial_transcript(),
            transcript_scroll: 0,
            follow_tail: true,
            should_quit: false,
            session_id: session_id.into(),
            gateway_status: gateway_status.into(),
            base_url: base_url.into(),
            agent_status: "ready".to_string(),
            agent_sender,
            clock,
            pending_response: None,
            stream_handle: None,
            stream_status: StreamStatus::NotAttached,
            last_stream_event: None,
            event_transcript: EventTranscript::default(),
            event_row_lines: BTreeMap::new(),
            transcript_viewport_height: SCROLL_PAGE_LINES,
        };
        app.jump_to_tail();
        app
    }

    pub fn handle_event(&mut self, event: AppEvent) {
        match event {
            AppEvent::Text(text) => self.insert_prompt_text(&text),
            AppEvent::Backspace => self.backspace_prompt(),
            AppEvent::Delete => self.delete_prompt_char(),
            AppEvent::Submit => self.submit_prompt(),
            AppEvent::MovePromptLeft => self.move_prompt_left(),
            AppEvent::MovePromptRight => self.move_prompt_right(),
            AppEvent::MovePromptWordLeft => self.move_prompt_word_left(),
            AppEvent::MovePromptWordRight => self.move_prompt_word_right(),
            AppEvent::MovePromptStart => self.prompt_cursor = 0,
            AppEvent::MovePromptEnd => self.prompt_cursor = self.prompt.len(),
            AppEvent::DeletePromptWordLeft => self.delete_prompt_word_left(),
            AppEvent::ClearPrompt => {
                self.prompt.clear();
                self.prompt_cursor = 0;
            }
            AppEvent::ScrollLineUp => self.scroll_lines_up(1),
            AppEvent::ScrollLineDown => self.scroll_lines_down(1),
            AppEvent::ScrollPageUp => self.scroll_page_up(),
            AppEvent::ScrollPageDown => self.scroll_page_down(),
            AppEvent::JumpToTail => self.jump_to_tail(),
            AppEvent::Quit => self.should_quit = true,
        }
    }

    pub fn tick(&mut self) {
        if let Some(pending) = &mut self.pending_response {
            pending.spinner_frame = (pending.spinner_frame + 1) % SPINNER_FRAMES.len();
        }
        self.update_pending_transcript_line();
    }

    pub fn start_stream(&mut self) {
        if self.stream_handle.is_some() {
            return;
        }
        self.stream_status = StreamStatus::Connecting;
        self.stream_handle = Some(spawn_agent_stream(
            self.base_url.clone(),
            self.session_id.clone(),
        ));
    }

    pub fn poll_stream(&mut self) {
        let mut updates = Vec::new();
        if let Some(handle) = &self.stream_handle {
            while let Ok(update) = handle.receiver.try_recv() {
                updates.push(update);
            }
        }

        for update in updates {
            self.handle_stream_update(update);
        }
    }

    pub fn handle_stream_update(&mut self, update: AgentStreamUpdate) {
        match update {
            AgentStreamUpdate::Connecting => self.stream_status = StreamStatus::Connecting,
            AgentStreamUpdate::Events(events) => {
                self.stream_status = StreamStatus::Live;
                if let Some(event) = events.last() {
                    self.last_stream_event = Some(event.event_type.clone());
                }
                self.event_transcript.apply_events(&events);
                self.sync_event_transcript_rows();
            }
            AgentStreamUpdate::Control(control) => {
                if control.up_to_date {
                    self.stream_status = StreamStatus::Idle;
                } else {
                    self.stream_status = StreamStatus::Live;
                }
            }
            AgentStreamUpdate::Idle => self.stream_status = StreamStatus::Idle,
            AgentStreamUpdate::Reconnecting(error) => {
                self.stream_status = StreamStatus::Reconnecting;
                self.last_stream_event = Some(format!("reconnect: {error}"));
            }
            AgentStreamUpdate::Failed(error) => {
                self.stream_status = StreamStatus::Failed;
                self.last_stream_event = Some(format!("failed: {error}"));
            }
        }
    }

    pub fn poll_agent(&mut self) {
        let Some(pending) = &self.pending_response else {
            return;
        };

        match pending.receiver.try_recv() {
            Ok(response) => {
                let transcript_line = pending.transcript_line;
                self.pending_response = None;
                self.agent_status = "ready".to_string();
                match response.result {
                    Ok(text) => {
                        self.replace_transcript_line_with_speaker_text(
                            transcript_line,
                            "assistant",
                            text.trim(),
                        );
                    }
                    Err(error) => {
                        self.replace_transcript_line_with_speaker_text(
                            transcript_line,
                            "error",
                            error.trim(),
                        );
                    }
                }
                self.after_transcript_changed();
            }
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => {
                let transcript_line = pending.transcript_line;
                self.pending_response = None;
                self.agent_status = "error".to_string();
                self.replace_transcript_line_with_speaker_text(
                    transcript_line,
                    "error",
                    "Agent response channel disconnected.",
                );
                self.after_transcript_changed();
            }
        }
    }

    pub fn prompt(&self) -> &str {
        &self.prompt
    }

    pub fn prompt_cursor(&self) -> usize {
        self.prompt_cursor
    }

    pub fn prompt_cursor_chars(&self) -> usize {
        self.prompt[..self.prompt_cursor].chars().count()
    }

    pub fn transcript_lines(&self) -> &[String] {
        &self.transcript_lines
    }

    pub fn transcript_scroll(&self) -> usize {
        self.transcript_scroll
    }

    pub fn follow_tail(&self) -> bool {
        self.follow_tail
    }

    pub fn should_quit(&self) -> bool {
        self.should_quit
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn gateway_status(&self) -> &str {
        &self.gateway_status
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn agent_status(&self) -> &str {
        &self.agent_status
    }

    pub fn stream_status(&self) -> &'static str {
        self.stream_status.as_str()
    }

    pub fn last_stream_event(&self) -> Option<&str> {
        self.last_stream_event.as_deref()
    }

    pub fn status_text(&self) -> String {
        let mut parts = vec![
            "SIM-ONE Alpha".to_string(),
            format!("session: {}", self.session_id),
            format!("gateway: {}", self.gateway_status),
            format!("stream: {}", self.stream_status()),
        ];

        if let Some(pending) = &self.pending_response {
            parts.push(format!("agent: thinking {}", pending.spinner_frame_text()));
            parts.push(format!(
                "turn: {}",
                format_duration(pending.elapsed((self.clock)()))
            ));
            if pending.duplicate_submit_notice {
                parts.push("input locked: waiting for current response".to_string());
            }
        } else {
            parts.push(format!("agent: {}", self.agent_status));
        }

        if let Some(event_type) = &self.last_stream_event {
            parts.push(format!("last: {event_type}"));
        }
        parts.push(format!("messages: {}", self.transcript_lines.len()));
        parts.push(format!(
            "tail: {}",
            if self.follow_tail { "live" } else { "scrolled" }
        ));
        parts.join(" | ")
    }

    pub fn is_agent_pending(&self) -> bool {
        self.pending_response.is_some()
    }

    pub fn max_scroll(&self) -> usize {
        self.transcript_lines
            .len()
            .saturating_sub(self.transcript_viewport_height.max(1))
    }

    pub fn set_transcript_viewport_height(&mut self, height: usize) {
        let height = height.max(1);
        if self.transcript_viewport_height == height {
            return;
        }

        self.transcript_viewport_height = height;
        if self.follow_tail {
            self.jump_to_tail();
        } else {
            self.transcript_scroll = self.transcript_scroll.min(self.max_scroll());
        }
    }

    pub fn scroll_page_up(&mut self) {
        self.scroll_lines_up(SCROLL_PAGE_LINES);
    }

    pub fn scroll_page_down(&mut self) {
        self.scroll_lines_down(SCROLL_PAGE_LINES);
    }

    pub fn scroll_line_up(&mut self) {
        self.scroll_lines_up(1);
    }

    pub fn scroll_line_down(&mut self) {
        self.scroll_lines_down(1);
    }

    pub fn jump_to_tail(&mut self) {
        self.transcript_scroll = self.max_scroll();
        self.follow_tail = true;
    }

    fn insert_prompt_text(&mut self, text: &str) {
        self.prompt.insert_str(self.prompt_cursor, text);
        self.prompt_cursor += text.len();
    }

    fn backspace_prompt(&mut self) {
        let Some(previous) = previous_char_boundary(&self.prompt, self.prompt_cursor) else {
            return;
        };
        self.prompt.drain(previous..self.prompt_cursor);
        self.prompt_cursor = previous;
    }

    fn delete_prompt_char(&mut self) {
        let Some(next) = next_char_boundary(&self.prompt, self.prompt_cursor) else {
            return;
        };
        self.prompt.drain(self.prompt_cursor..next);
    }

    fn move_prompt_left(&mut self) {
        if let Some(previous) = previous_char_boundary(&self.prompt, self.prompt_cursor) {
            self.prompt_cursor = previous;
        }
    }

    fn move_prompt_right(&mut self) {
        if let Some(next) = next_char_boundary(&self.prompt, self.prompt_cursor) {
            self.prompt_cursor = next;
        }
    }

    fn move_prompt_word_left(&mut self) {
        self.prompt_cursor = previous_word_boundary(&self.prompt, self.prompt_cursor);
    }

    fn move_prompt_word_right(&mut self) {
        self.prompt_cursor = next_word_boundary(&self.prompt, self.prompt_cursor);
    }

    fn delete_prompt_word_left(&mut self) {
        let start = previous_word_boundary(&self.prompt, self.prompt_cursor);
        self.prompt.drain(start..self.prompt_cursor);
        self.prompt_cursor = start;
    }

    fn scroll_lines_up(&mut self, amount: usize) {
        self.transcript_scroll = self.transcript_scroll.saturating_sub(amount);
        self.follow_tail = false;
    }

    fn scroll_lines_down(&mut self, amount: usize) {
        self.transcript_scroll = self
            .transcript_scroll
            .saturating_add(amount)
            .min(self.max_scroll());
        self.follow_tail = self.transcript_scroll == self.max_scroll();
    }

    fn submit_prompt(&mut self) {
        if let Some(pending) = &mut self.pending_response {
            pending.duplicate_submit_notice = true;
            self.agent_status = "busy".to_string();
            self.update_pending_transcript_line();
            return;
        }

        let prompt = self.prompt.trim().to_string();
        if prompt.is_empty() {
            self.prompt.clear();
            self.prompt_cursor = 0;
            return;
        }

        self.transcript_lines.push(String::new());
        self.push_speaker_text("you", &prompt);
        let transcript_line = self.transcript_lines.len();
        self.prompt.clear();
        self.prompt_cursor = 0;
        self.agent_status = "thinking".to_string();
        self.jump_to_tail();

        let base_url = self.base_url.clone();
        let session_id = self.session_id.clone();
        let sender = Arc::clone(&self.agent_sender);
        let started_at = (self.clock)();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let result = sender(base_url, session_id, prompt);
            let _ = tx.send(AgentResponse { result });
        });
        let pending = PendingResponse {
            receiver: rx,
            transcript_line,
            started_at,
            spinner_frame: 0,
            duplicate_submit_notice: false,
        };
        self.transcript_lines
            .push(pending_transcript_line(&pending, started_at));
        self.pending_response = Some(pending);
    }

    fn push_speaker_text(&mut self, speaker: &str, text: &str) {
        self.transcript_lines.extend(speaker_lines(speaker, text));
    }

    fn replace_transcript_line_with_speaker_text(
        &mut self,
        line_index: usize,
        speaker: &str,
        text: &str,
    ) {
        let replacement = speaker_lines(speaker, text);
        let inserted = replacement.len();
        self.transcript_lines
            .splice(line_index..=line_index, replacement);
        self.reindex_event_rows_after_splice(line_index, 1, inserted);
    }

    fn after_transcript_changed(&mut self) {
        if self.follow_tail {
            self.jump_to_tail();
        }
    }

    fn update_pending_transcript_line(&mut self) {
        let Some(pending) = &self.pending_response else {
            return;
        };
        let now = (self.clock)();
        if let Some(line) = self.transcript_lines.get_mut(pending.transcript_line) {
            *line = pending_transcript_line(pending, now);
        }
    }

    fn sync_event_transcript_rows(&mut self) {
        let rows = self
            .event_transcript
            .rows()
            .iter()
            .filter(|row| row.is_activity())
            .cloned()
            .collect::<Vec<_>>();
        for row in rows {
            self.sync_event_transcript_row(&row);
        }
        self.after_transcript_changed();
    }

    fn sync_event_transcript_row(&mut self, row: &DisplayRow) {
        if let Some(index) = self.event_row_lines.get(&row.id).copied() {
            if let Some(line) = self.transcript_lines.get_mut(index) {
                *line = row.text.clone();
                return;
            }
        }

        let index = self.transcript_lines.len();
        self.transcript_lines.push(row.text.clone());
        self.event_row_lines.insert(row.id.clone(), index);
    }

    fn reindex_event_rows_after_splice(&mut self, start: usize, removed: usize, inserted: usize) {
        if removed == inserted {
            return;
        }

        let removed_end = start.saturating_add(removed);
        if inserted > removed {
            let delta = inserted - removed;
            for index in self.event_row_lines.values_mut() {
                if *index >= removed_end {
                    *index = index.saturating_add(delta);
                } else if *index >= start {
                    *index = start;
                }
            }
        } else {
            let delta = removed - inserted;
            for index in self.event_row_lines.values_mut() {
                if *index >= removed_end {
                    *index = index.saturating_sub(delta);
                } else if *index >= start {
                    *index = start;
                }
            }
        }
    }
}

impl PendingResponse {
    fn elapsed(&self, now: Instant) -> Duration {
        now.checked_duration_since(self.started_at)
            .unwrap_or(Duration::ZERO)
    }

    fn spinner_frame_text(&self) -> &'static str {
        SPINNER_FRAMES[self.spinner_frame % SPINNER_FRAMES.len()]
    }
}

impl StreamStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::NotAttached => "not attached",
            Self::Connecting => "connecting",
            Self::Live => "live",
            Self::Idle => "idle",
            Self::Reconnecting => "reconnecting",
            Self::Failed => "failed",
        }
    }
}

impl Drop for App {
    fn drop(&mut self) {
        if let Some(handle) = &self.stream_handle {
            handle.cancel();
        }
    }
}

impl Default for App {
    fn default() -> Self {
        Self::new("offline placeholder", "http://127.0.0.1:3940")
    }
}

fn initial_transcript() -> Vec<String> {
    let mut lines = vec![
        "system: SIM-ONE Alpha Ratatui TUI".to_string(),
        "assistant: Connected to the local SIM-ONE Alpha gateway. Type a prompt and press Enter.".to_string(),
        "assistant: The top pane is the transcript/context viewport. The bottom pane is status plus editable prompt input.".to_string(),
        String::new(),
    ];

    for index in 1..=PLACEHOLDER_CONTEXT_LINES {
        lines.push(format!(
            "context {index:02}: scroll test row; prompt input remains active."
        ));
    }

    lines.push(String::new());
    lines.push("assistant: PgUp/PgDown scroll this transcript. Left/Right, Ctrl+Left/Ctrl+Right, Home/End edit the prompt.".to_string());
    lines
}

fn speaker_lines(speaker: &str, text: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut split = text.lines();
    if let Some(first) = split.next() {
        lines.push(format!("{speaker}: {first}"));
    } else {
        lines.push(format!("{speaker}:"));
    }

    for line in split {
        lines.push(format!("  {line}"));
    }

    lines
}

fn pending_transcript_line(pending: &PendingResponse, now: Instant) -> String {
    let mut line = format!(
        "assistant: {} thinking {} / waiting for final response",
        pending.spinner_frame_text(),
        format_duration(pending.elapsed(now))
    );
    if pending.duplicate_submit_notice {
        line.push_str(" / input locked until this response finishes");
    }
    line
}

fn format_duration(duration: Duration) -> String {
    let total_seconds = duration.as_secs();
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;

    if hours > 0 {
        format!("{hours:02}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes:02}:{seconds:02}")
    }
}

fn previous_char_boundary(value: &str, cursor: usize) -> Option<usize> {
    if cursor == 0 {
        return None;
    }
    value[..cursor]
        .char_indices()
        .last()
        .map(|(index, _)| index)
}

fn next_char_boundary(value: &str, cursor: usize) -> Option<usize> {
    if cursor >= value.len() {
        return None;
    }
    value[cursor..]
        .chars()
        .next()
        .map(|ch| cursor + ch.len_utf8())
}

fn previous_word_boundary(value: &str, cursor: usize) -> usize {
    let mut position = cursor;

    while let Some((previous, ch)) = previous_char(value, position) {
        if ch.is_whitespace() {
            position = previous;
        } else {
            break;
        }
    }

    while let Some((previous, ch)) = previous_char(value, position) {
        if !ch.is_whitespace() {
            position = previous;
        } else {
            break;
        }
    }

    position
}

fn next_word_boundary(value: &str, cursor: usize) -> usize {
    let mut position = cursor;

    while let Some((next, ch)) = next_char(value, position) {
        if !ch.is_whitespace() {
            position = next;
        } else {
            break;
        }
    }

    while let Some((next, ch)) = next_char(value, position) {
        if ch.is_whitespace() {
            position = next;
        } else {
            break;
        }
    }

    position
}

fn previous_char(value: &str, cursor: usize) -> Option<(usize, char)> {
    if cursor == 0 {
        return None;
    }
    value[..cursor].char_indices().last()
}

fn next_char(value: &str, cursor: usize) -> Option<(usize, char)> {
    if cursor >= value.len() {
        return None;
    }
    value[cursor..]
        .char_indices()
        .next()
        .map(|(offset, ch)| (cursor + offset + ch.len_utf8(), ch))
}
