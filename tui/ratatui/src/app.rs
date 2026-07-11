use std::collections::BTreeMap;
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use ratatui::text::Span;

use crate::agent::{list_chat_sessions, send_agent_prompt_reply, AgentReply, SessionSummary};
use crate::flue::events::FlueEvent;
use crate::flue::reducer::{extract_role, extract_text, DisplayRow, EventTranscript};
use crate::flue::stream::{spawn_agent_stream, AgentStreamHandle, AgentStreamUpdate};
use crate::markdown::render_markdown;
use crate::text_wrap::display_width;
use crate::text_wrap::wrap_words;

pub const SCROLL_PAGE_LINES: usize = 8;
const SPINNER_FRAMES: [&str; 4] = ["|", "/", "-", "\\"];
const UNRESOLVED_SESSION_LABEL: &str = "resolving";
const TRANSCRIPT_TAIL_MARGIN_ROWS: usize = 1;

pub type AgentSender =
    Arc<dyn Fn(String, String, String) -> Result<AgentReply, String> + Send + Sync + 'static>;
pub type SessionLister =
    Arc<dyn Fn(String, usize) -> Result<Vec<SessionSummary>, String> + Send + Sync + 'static>;
pub type Clock = Arc<dyn Fn() -> Instant + Send + Sync + 'static>;

const TUI_COMMAND_HELP: &str = "/new [title]\n/clear [title]\n/resume <session-id>\n/sessions [limit]\n/session\n/rename <title>\n/compact\n/help\n/exit";

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptRowKind {
    User,
    Assistant,
    Thinking,
    Tool,
    Task,
    Operation,
    Progress,
    Log,
    Error,
    System,
    Preflight,
    Other,
}

impl TranscriptRowKind {
    pub fn prefix(self) -> Option<&'static str> {
        match self {
            Self::Assistant => Some("assistant:"),
            Self::Thinking => Some("thinking:"),
            Self::Tool => Some("tool:"),
            Self::Task => Some("task:"),
            Self::Operation => Some("operation:"),
            Self::Progress => Some("turn:"),
            Self::Log => Some("log:"),
            Self::Error => Some("error:"),
            Self::System => Some("system:"),
            Self::Preflight => Some("preflight:"),
            Self::User | Self::Other => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedTranscriptRow {
    pub text: String,
    pub kind: TranscriptRowKind,
    pub is_streaming: bool,
    pub styled_spans: Option<Vec<Span<'static>>>,
}

pub struct App {
    prompt: String,
    prompt_cursor: usize,
    transcript_lines: Vec<String>,
    transcript_scroll: usize,
    follow_tail: bool,
    should_quit: bool,
    exit_session_id: Option<String>,
    session_id: String,
    gateway_status: String,
    base_url: String,
    agent_status: String,
    agent_sender: AgentSender,
    session_lister: SessionLister,
    clock: Clock,
    pending_response: Option<PendingResponse>,
    stream_handle: Option<AgentStreamHandle>,
    stream_status: StreamStatus,
    last_stream_event: Option<String>,
    event_transcript: EventTranscript,
    event_row_lines: BTreeMap<String, usize>,
    final_response_range: Option<(usize, usize)>,
    response_is_streaming: bool,
    transcript_viewport_height: usize,
    transcript_viewport_width: usize,
    startup_phase: StartupPhase,
    startup_attach_stream: bool,
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
    result: Result<AgentReply, String>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StartupPhase {
    Idle,
    CreatingSession,
    Greeting,
    Complete,
    Failed,
}

impl App {
    pub fn new(gateway_status: impl Into<String>, base_url: impl Into<String>) -> Self {
        Self::with_session("", gateway_status, base_url)
    }

    pub fn new_for_test() -> Self {
        Self::with_agent_sender(
            "",
            "offline placeholder",
            "http://127.0.0.1:3940",
            Arc::new(|_, _, prompt| Ok(agent_reply(format!("test response to {prompt}")))),
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
                send_agent_prompt_reply(&base_url, &session_id, &prompt)
            }),
        )
    }

    pub fn with_agent_sender(
        session_id: impl Into<String>,
        gateway_status: impl Into<String>,
        base_url: impl Into<String>,
        agent_sender: AgentSender,
    ) -> Self {
        Self::with_agent_sender_and_session_lister(
            session_id,
            gateway_status,
            base_url,
            agent_sender,
            Arc::new(|base_url, limit| list_chat_sessions(&base_url, limit)),
        )
    }

    pub fn with_agent_sender_and_session_lister(
        session_id: impl Into<String>,
        gateway_status: impl Into<String>,
        base_url: impl Into<String>,
        agent_sender: AgentSender,
        session_lister: SessionLister,
    ) -> Self {
        Self::with_agent_sender_and_clock(
            session_id,
            gateway_status,
            base_url,
            agent_sender,
            session_lister,
            Arc::new(Instant::now),
        )
    }

    pub fn with_agent_sender_and_clock(
        session_id: impl Into<String>,
        gateway_status: impl Into<String>,
        base_url: impl Into<String>,
        agent_sender: AgentSender,
        session_lister: SessionLister,
        clock: Clock,
    ) -> Self {
        let mut app = Self {
            prompt: String::new(),
            prompt_cursor: 0,
            transcript_lines: initial_transcript(),
            transcript_scroll: 0,
            follow_tail: true,
            should_quit: false,
            exit_session_id: None,
            session_id: session_id.into(),
            gateway_status: gateway_status.into(),
            base_url: base_url.into(),
            agent_status: "ready".to_string(),
            agent_sender,
            session_lister,
            clock,
            pending_response: None,
            stream_handle: None,
            stream_status: StreamStatus::NotAttached,
            last_stream_event: None,
            event_transcript: EventTranscript::default(),
            event_row_lines: BTreeMap::new(),
            final_response_range: None,
            response_is_streaming: false,
            transcript_viewport_height: SCROLL_PAGE_LINES,
            transcript_viewport_width: 80,
            startup_phase: StartupPhase::Idle,
            startup_attach_stream: false,
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

    pub fn start_startup_preflight(&mut self, attach_stream: bool) {
        if self.pending_response.is_some() || self.startup_phase != StartupPhase::Idle {
            return;
        }

        self.startup_phase = StartupPhase::CreatingSession;
        self.startup_attach_stream = attach_stream;
        self.agent_status = "preflight".to_string();
        self.final_response_range = None;
        self.response_is_streaming = false;
        self.push_speaker_text(
            "preflight",
            &format!("gateway ready ({})", self.gateway_status),
        );
        self.push_speaker_text("preflight", "resolving active TUI session");
        self.submit_internal_prompt("/session".to_string());
    }

    pub fn startup_complete(&self) -> bool {
        matches!(
            self.startup_phase,
            StartupPhase::Complete | StartupPhase::Failed
        )
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
                let final_message = self
                    .pending_response
                    .as_ref()
                    .and_then(|_| final_assistant_message(&events));
                let has_root_text_delta = self.pending_response.is_some()
                    && events
                        .iter()
                        .any(|event| event.event_type == "text_delta" && !event.is_nested());
                self.event_transcript.apply_events(&events);
                let stream_preview = if final_message.is_none() && has_root_text_delta {
                    self.event_transcript
                        .current_assistant_stream_text()
                        .map(str::to_string)
                } else {
                    None
                };
                self.sync_event_transcript_rows();
                if let Some(final_message) = final_message {
                    self.settle_pending_stream_response(&final_message);
                } else if let Some(stream_preview) = stream_preview {
                    self.settle_pending_stream_preview(&stream_preview);
                }
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
                self.response_is_streaming = false;
                self.agent_status = "ready".to_string();
                match response.result {
                    Ok(reply) => {
                        let session_id = reply.session_id.clone();
                        let reply_for_startup = reply.clone();
                        self.settle_pending_response_line(
                            transcript_line,
                            "assistant",
                            reply.text.trim(),
                        );
                        if let Some(session_id) = session_id {
                            self.switch_session(session_id);
                        }
                        self.continue_startup_after_agent_reply(&reply_for_startup);
                    }
                    Err(error) => {
                        self.settle_pending_response_line(transcript_line, "error", error.trim());
                        self.fail_startup();
                    }
                }
                self.after_transcript_changed();
            }
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => {
                let transcript_line = pending.transcript_line;
                self.pending_response = None;
                self.response_is_streaming = false;
                self.agent_status = "error".to_string();
                self.settle_pending_response_line(
                    transcript_line,
                    "error",
                    "Agent response channel disconnected.",
                );
                self.fail_startup();
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

    pub fn exit_session_id(&self) -> Option<&str> {
        self.exit_session_id.as_deref()
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    fn session_label(&self) -> &str {
        if self.session_id.trim().is_empty() {
            UNRESOLVED_SESSION_LABEL
        } else {
            &self.session_id
        }
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
            format!("session: {}", self.session_label()),
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
        self.transcript_rendered_row_count()
            .saturating_sub(self.transcript_viewport_height.max(1))
    }

    pub fn set_transcript_viewport_height(&mut self, height: usize) {
        self.set_transcript_viewport_size(height, self.transcript_viewport_width);
    }

    pub fn set_transcript_viewport_size(&mut self, height: usize, width: usize) {
        let height = height.max(1);
        let width = width.max(1);
        if self.transcript_viewport_height == height && self.transcript_viewport_width == width {
            return;
        }

        self.transcript_viewport_height = height;
        self.transcript_viewport_width = width;
        if self.follow_tail {
            self.jump_to_tail();
        } else {
            self.transcript_scroll = self.transcript_scroll.min(self.max_scroll());
        }
    }

    pub fn transcript_rendered_row_count(&self) -> usize {
        self.transcript_rendered_rows().len()
    }

    pub fn transcript_rendered_lines(&self) -> Vec<String> {
        self.transcript_rendered_rows()
            .into_iter()
            .map(|row| row.text)
            .collect()
    }

    pub fn transcript_rendered_rows(&self) -> Vec<RenderedTranscriptRow> {
        let streaming_range = if self.response_is_streaming {
            self.final_response_range
        } else {
            None
        };
        let mut rows = wrap_transcript_rows(
            &self.transcript_lines,
            self.transcript_viewport_width,
            streaming_range,
        );
        rows.extend(std::iter::repeat_n(
            RenderedTranscriptRow {
                text: String::new(),
                kind: TranscriptRowKind::Other,
                is_streaming: false,
                styled_spans: None,
            },
            TRANSCRIPT_TAIL_MARGIN_ROWS,
        ));
        rows
    }

    pub(crate) fn sync_transcript_scroll_for_render(&mut self, rendered_row_count: usize) -> usize {
        let max_scroll = rendered_row_count.saturating_sub(self.transcript_viewport_height.max(1));
        if self.follow_tail {
            self.transcript_scroll = max_scroll;
        } else {
            self.transcript_scroll = self.transcript_scroll.min(max_scroll);
        }
        max_scroll
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
        if self.insert_newline_after_slash() {
            return;
        }

        let prompt = self.prompt.trim().to_string();
        if !prompt.is_empty() && self.pending_response.is_none() {
            self.final_response_range = None;
            self.response_is_streaming = false;
        }

        if self.handle_local_slash_command(&prompt) {
            self.prompt.clear();
            self.prompt_cursor = 0;
            self.after_transcript_changed();
            return;
        }

        if let Some(pending) = &mut self.pending_response {
            pending.duplicate_submit_notice = true;
            self.agent_status = "busy".to_string();
            self.update_pending_transcript_line();
            return;
        }

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
        self.jump_to_tail();
    }

    fn submit_internal_prompt(&mut self, prompt: String) {
        if self.pending_response.is_some() {
            return;
        }

        let transcript_line = self.transcript_lines.len();
        self.agent_status = "thinking".to_string();

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
        self.jump_to_tail();
    }

    fn insert_newline_after_slash(&mut self) -> bool {
        let Some(previous) = previous_char_boundary(&self.prompt, self.prompt_cursor) else {
            return false;
        };
        if &self.prompt[previous..self.prompt_cursor] != "/" {
            return false;
        }

        self.prompt
            .replace_range(previous..self.prompt_cursor, "\n");
        self.prompt_cursor = previous + 1;
        true
    }

    fn handle_local_slash_command(&mut self, prompt: &str) -> bool {
        match prompt {
            "/exit" => {
                if !self.session_id.trim().is_empty() {
                    self.exit_session_id = Some(self.session_id.clone());
                }
                self.should_quit = true;
                true
            }
            "/session" => {
                self.push_speaker_text(
                    "system",
                    &format!("current session {}", self.session_label()),
                );
                true
            }
            "/help" => {
                self.push_speaker_text("system", TUI_COMMAND_HELP);
                true
            }
            command if command == "/sessions" || command.starts_with("/sessions ") => {
                self.render_recent_sessions(command);
                true
            }
            _ => false,
        }
    }

    fn render_recent_sessions(&mut self, command: &str) {
        let limit = parse_sessions_limit(command);
        match (self.session_lister)(self.base_url.clone(), limit) {
            Ok(sessions) => {
                self.push_speaker_text("system", "recent sessions");
                if sessions.is_empty() {
                    self.push_speaker_text("system", "no recent sessions");
                    return;
                }
                for session in sessions {
                    let title = session.title.as_deref().unwrap_or("(untitled)");
                    self.push_speaker_text(
                        "system",
                        &format!(
                            "{} | {} | {} | {}",
                            session.id, session.origin, title, session.updated_at
                        ),
                    );
                }
            }
            Err(error) => {
                self.push_speaker_text("error", &error);
            }
        }
    }

    fn switch_session(&mut self, session_id: String) {
        if self.session_id == session_id {
            return;
        }

        let had_stream = if let Some(handle) = self.stream_handle.take() {
            handle.cancel();
            true
        } else {
            false
        };

        self.session_id = session_id;
        self.event_transcript = EventTranscript::default();
        self.event_row_lines.clear();
        self.final_response_range = None;
        self.response_is_streaming = false;
        self.last_stream_event = None;
        if had_stream {
            self.stream_status = StreamStatus::Connecting;
            self.start_stream();
        } else {
            self.stream_status = StreamStatus::NotAttached;
        }
        self.push_speaker_text("system", &format!("active session {}", self.session_id));
    }

    fn continue_startup_after_agent_reply(&mut self, reply: &AgentReply) {
        match self.startup_phase {
            StartupPhase::CreatingSession => {
                if reply.command_name.as_deref() != Some("session")
                    || self.session_id.trim().is_empty()
                {
                    self.fail_startup();
                    return;
                }

                self.push_speaker_text(
                    "preflight",
                    &format!("active TUI session {}", self.session_id),
                );
                if self.startup_attach_stream {
                    self.start_stream();
                    self.push_speaker_text("preflight", "event stream attached");
                } else {
                    self.push_speaker_text("preflight", "event stream attach deferred");
                }
                self.push_speaker_text("preflight", "all systems go");
                self.startup_phase = StartupPhase::Greeting;
                self.submit_internal_prompt(self.startup_greeting_prompt());
            }
            StartupPhase::Greeting => {
                self.startup_phase = StartupPhase::Complete;
            }
            _ => {}
        }
    }

    fn fail_startup(&mut self) {
        if matches!(
            self.startup_phase,
            StartupPhase::CreatingSession | StartupPhase::Greeting
        ) {
            self.startup_phase = StartupPhase::Failed;
            self.push_speaker_text("preflight", "startup preflight failed");
        }
    }

    fn startup_greeting_prompt(&self) -> String {
        format!(
            "This is an automatic SIM-ONE Alpha local Ratatui TUI startup event.\n\n\
Use the `greeting-preflight` Flue skill before answering. This startup event is equivalent to `/greeting preflight`, but it is sent as a normal agent message so it can reach the orchestrator skill system instead of the pre-LLM slash-command parser.\n\n\
Preflight report:\n\
- gateway: {gateway}\n\
- session: {session}\n\
- stream: {stream}\n\
- status: all systems go\n\n\
Skill input variables:\n\
- status = \"all systems go\"\n\
- userName = \"Daniel T Sasser II\"\n\
- connector = \"Ratatui TUI\"\n\
- sessionId = \"{session}\"\n\n\
Use the workspace identity and user context already loaded for this agent. Greet Daniel T Sasser II by name, introduce yourself by your workspace identity, briefly say that startup preflight completed and all systems go, then stop. Keep it concise.",
            gateway = self.gateway_status,
            session = self.session_id,
            stream = self.stream_status(),
        )
    }

    fn push_speaker_text(&mut self, speaker: &str, text: &str) {
        self.transcript_lines.extend(speaker_lines(speaker, text));
    }

    fn settle_pending_response_line(&mut self, line_index: usize, speaker: &str, text: &str) {
        let existing_range = self.final_response_range.take();
        let replacement = speaker_lines(speaker, text);
        let replacement_len = replacement.len();

        if let Some((range_start, range_len)) = existing_range.filter(|(range_start, range_len)| {
            *range_len > 0
                && *range_start < self.transcript_lines.len()
                && line_index >= *range_start
                && line_index < range_start.saturating_add(*range_len)
        }) {
            let range_end = range_start
                .saturating_add(range_len)
                .min(self.transcript_lines.len());
            self.transcript_lines
                .splice(range_start..range_end, replacement);
            self.reindex_event_rows_after_splice(
                range_start,
                range_end.saturating_sub(range_start),
                replacement_len,
            );
            self.final_response_range = Some((range_start, replacement_len));
            return;
        }

        if line_index + 1 == self.transcript_lines.len() {
            self.transcript_lines
                .splice(line_index..=line_index, replacement);
            self.reindex_event_rows_after_splice(line_index, 1, replacement_len);
            self.final_response_range = Some((line_index, replacement_len));
            return;
        }

        if line_index < self.transcript_lines.len() {
            self.transcript_lines.remove(line_index);
            self.reindex_event_rows_after_splice(line_index, 1, 0);
        }
        let final_start = self.transcript_lines.len();
        self.transcript_lines.extend(replacement);
        self.final_response_range = Some((final_start, replacement_len));
    }

    fn settle_pending_stream_response(&mut self, text: &str) {
        let Some(line_index) = self
            .pending_response
            .as_ref()
            .map(|pending| pending.transcript_line)
        else {
            return;
        };

        self.settle_pending_response_line(line_index, "assistant", text.trim());
        self.response_is_streaming = false;
        if let (Some(pending), Some((final_start, _))) =
            (&mut self.pending_response, self.final_response_range)
        {
            pending.transcript_line = final_start;
        }
        self.agent_status = "finalizing".to_string();
        self.after_transcript_changed();
    }

    fn settle_pending_stream_preview(&mut self, text: &str) {
        let Some(line_index) = self
            .pending_response
            .as_ref()
            .map(|pending| pending.transcript_line)
        else {
            return;
        };

        self.settle_pending_response_line(line_index, "assistant", text);
        self.response_is_streaming = true;
        if let (Some(pending), Some((response_start, _))) =
            (&mut self.pending_response, self.final_response_range)
        {
            pending.transcript_line = response_start;
        }
        self.agent_status = "responding".to_string();
        self.after_transcript_changed();
    }

    fn after_transcript_changed(&mut self) {
        if self.follow_tail {
            self.jump_to_tail();
        }
    }

    fn update_pending_transcript_line(&mut self) {
        if self.final_response_range.is_some() {
            return;
        }
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

        let index = self
            .final_response_range
            .map(|(start, _)| start)
            .unwrap_or(self.transcript_lines.len());
        self.transcript_lines.insert(index, row.text.clone());
        self.reindex_event_rows_after_splice(index, 0, 1);
        self.event_row_lines.insert(row.id.clone(), index);
    }

    fn reindex_event_rows_after_splice(&mut self, start: usize, removed: usize, inserted: usize) {
        self.reindex_final_response_after_splice(start, removed, inserted);
        self.reindex_pending_response_after_splice(start, removed, inserted);
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

    fn reindex_pending_response_after_splice(
        &mut self,
        start: usize,
        removed: usize,
        inserted: usize,
    ) {
        let Some(pending) = &mut self.pending_response else {
            return;
        };
        if removed == inserted {
            return;
        }

        let removed_end = start.saturating_add(removed);
        if inserted > removed {
            let delta = inserted - removed;
            if pending.transcript_line >= removed_end {
                pending.transcript_line = pending.transcript_line.saturating_add(delta);
            } else if pending.transcript_line >= start {
                pending.transcript_line = start;
            }
        } else {
            let delta = removed - inserted;
            if pending.transcript_line >= removed_end {
                pending.transcript_line = pending.transcript_line.saturating_sub(delta);
            } else if pending.transcript_line >= start {
                pending.transcript_line = start;
            }
        }
    }

    fn reindex_final_response_after_splice(
        &mut self,
        start: usize,
        removed: usize,
        inserted: usize,
    ) {
        let Some((range_start, range_len)) = self.final_response_range else {
            return;
        };
        if removed == inserted {
            return;
        }

        let removed_end = start.saturating_add(removed);
        if inserted > removed {
            let delta = inserted - removed;
            if range_start >= removed_end {
                self.final_response_range = Some((range_start.saturating_add(delta), range_len));
            } else if range_start >= start {
                self.final_response_range = None;
            }
        } else {
            let delta = removed - inserted;
            if range_start >= removed_end {
                self.final_response_range = Some((range_start.saturating_sub(delta), range_len));
            } else if range_start >= start {
                self.final_response_range = None;
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
    vec![
        "system: SIM-ONE Alpha Ratatui TUI".to_string(),
        "preflight: waiting for gateway startup result".to_string(),
    ]
}

fn wrap_transcript_rows(
    lines: &[String],
    width: usize,
    streaming_range: Option<(usize, usize)>,
) -> Vec<RenderedTranscriptRow> {
    let mut wrapped = Vec::new();
    let mut previous_kind = TranscriptRowKind::Other;
    let mut line_index = 0;

    while line_index < lines.len() {
        let line = &lines[line_index];
        let kind = transcript_row_kind(line, previous_kind);
        if kind != TranscriptRowKind::Other {
            previous_kind = kind;
        }

        if kind == TranscriptRowKind::Assistant && line.starts_with("assistant:") {
            let block_end = assistant_block_end(lines, line_index);
            let markdown = assistant_markdown_block(lines, line_index, block_end);
            let is_streaming = range_intersects(streaming_range, line_index, block_end);
            let prefix = TranscriptRowKind::Assistant
                .prefix()
                .expect("assistant rows have a prefix");
            let first_width = width.saturating_sub(display_width(prefix) + 1).max(1);
            for (markdown_index, markdown_row) in render_markdown(&markdown, first_width, width)
                .into_iter()
                .enumerate()
            {
                if markdown_index == 0 {
                    let mut spans = Vec::with_capacity(markdown_row.spans.len() + 1);
                    spans.push(Span::raw(" "));
                    spans.extend(markdown_row.spans);
                    wrapped.push(RenderedTranscriptRow {
                        text: format!("{prefix} {}", markdown_row.text),
                        kind,
                        is_streaming,
                        styled_spans: Some(spans),
                    });
                } else {
                    wrapped.push(RenderedTranscriptRow {
                        text: markdown_row.text,
                        kind,
                        is_streaming,
                        styled_spans: Some(markdown_row.spans),
                    });
                }
            }
            line_index = block_end;
            continue;
        }

        let is_streaming = range_intersects(streaming_range, line_index, line_index + 1);
        wrapped.extend(
            wrap_words(line, width)
                .into_iter()
                .map(|row| RenderedTranscriptRow {
                    text: row.text,
                    kind,
                    is_streaming,
                    styled_spans: None,
                }),
        );
        line_index += 1;
    }

    wrapped
}

fn assistant_block_end(lines: &[String], start: usize) -> usize {
    let mut end = start + 1;
    while end < lines.len() && lines[end].starts_with("  ") {
        end += 1;
    }
    end
}

fn assistant_markdown_block(lines: &[String], start: usize, end: usize) -> String {
    let first = lines[start]
        .strip_prefix("assistant:")
        .expect("assistant block starts with assistant prefix")
        .strip_prefix(' ')
        .unwrap_or_default();
    std::iter::once(first)
        .chain(
            lines[start + 1..end]
                .iter()
                .map(|line| line.strip_prefix("  ").unwrap_or(line)),
        )
        .collect::<Vec<_>>()
        .join("\n")
}

fn range_intersects(streaming_range: Option<(usize, usize)>, start: usize, end: usize) -> bool {
    streaming_range.is_some_and(|(range_start, len)| {
        let range_end = range_start.saturating_add(len);
        start < range_end && range_start < end
    })
}

fn transcript_row_kind(line: &str, previous: TranscriptRowKind) -> TranscriptRowKind {
    if line.starts_with("you:") {
        TranscriptRowKind::User
    } else if line.starts_with("assistant:") {
        TranscriptRowKind::Assistant
    } else if line.starts_with("thinking:") {
        TranscriptRowKind::Thinking
    } else if line.starts_with("tool:") {
        TranscriptRowKind::Tool
    } else if line.starts_with("task:") {
        TranscriptRowKind::Task
    } else if line.starts_with("operation:") {
        TranscriptRowKind::Operation
    } else if line.starts_with("turn:") {
        TranscriptRowKind::Progress
    } else if line.starts_with("log:") {
        TranscriptRowKind::Log
    } else if line.starts_with("error:") {
        TranscriptRowKind::Error
    } else if line.starts_with("system:") {
        TranscriptRowKind::System
    } else if line.starts_with("preflight:") {
        TranscriptRowKind::Preflight
    } else if line.starts_with("  ") {
        previous
    } else {
        TranscriptRowKind::Other
    }
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

fn final_assistant_message(events: &[FlueEvent]) -> Option<String> {
    events.iter().rev().find_map(|event| {
        if event.event_type != "message_end"
            || extract_role(&event.value).unwrap_or("assistant") != "assistant"
            || event.is_nested()
        {
            return None;
        }
        extract_text(&event.value).filter(|text| !text.trim().is_empty())
    })
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

fn parse_sessions_limit(command: &str) -> usize {
    command
        .strip_prefix("/sessions")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<usize>().ok())
        .map(|value| value.clamp(1, 50))
        .unwrap_or(10)
}

fn agent_reply(text: impl Into<String>) -> AgentReply {
    AgentReply {
        text: text.into(),
        session_id: None,
        command_name: None,
        session_created: None,
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
