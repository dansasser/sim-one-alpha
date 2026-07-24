use std::collections::BTreeMap;
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crossterm::event::{MouseButton, MouseEvent, MouseEventKind};
use ratatui::layout::Rect;
use ratatui::text::Span;

use crate::agent::{
    create_chat_session, list_chat_sessions, resume_chat_session, send_agent_prompt_reply,
    AgentPromptOrigin, AgentReply, SessionLifecycleReply, SessionSummary,
};
use crate::diagnostics;
use crate::flue::events::FlueEvent;
use crate::flue::stream::{spawn_agent_stream, AgentStreamHandle, AgentStreamUpdate};
use crate::history::{
    load_chat_transcript, TranscriptExchange, TranscriptPage, TranscriptPageInfo,
    TranscriptPromptVisibility, TranscriptSession, TranscriptStreamCursor,
};
use crate::markdown::render_markdown;
use crate::text_wrap::{
    display_width, display_width_between, next_grapheme_boundary, previous_grapheme_boundary,
    wrap_words, WrappedLine,
};
use crate::transcript::{TranscriptDocument, TranscriptLineKind};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

pub const SCROLL_PAGE_LINES: usize = 8;
const SPINNER_FRAMES: [&str; 4] = ["|", "/", "-", "\\"];
const UNRESOLVED_SESSION_LABEL: &str = "resolving";
const TRANSCRIPT_TAIL_MARGIN_ROWS: usize = 1;

pub type AgentSender =
    Arc<dyn Fn(String, String, String) -> Result<AgentReply, String> + Send + Sync + 'static>;
pub type AgentRequestSender = Arc<
    dyn Fn(String, String, String, AgentPromptOrigin) -> Result<AgentReply, String>
        + Send
        + Sync
        + 'static,
>;
pub type SessionLister =
    Arc<dyn Fn(String, usize) -> Result<Vec<SessionSummary>, String> + Send + Sync + 'static>;
pub type SessionCreator =
    Arc<dyn Fn(String) -> Result<SessionLifecycleReply, String> + Send + Sync + 'static>;
pub type SessionResumer =
    Arc<dyn Fn(String, String) -> Result<SessionLifecycleReply, String> + Send + Sync + 'static>;
pub type HistoryLoader = Arc<
    dyn Fn(String, String, usize, Option<String>) -> Result<TranscriptPage, String>
        + Send
        + Sync
        + 'static,
>;
pub type Clock = Arc<dyn Fn() -> Instant + Send + Sync + 'static>;

fn ignore_prompt_origin(agent_sender: AgentSender) -> AgentRequestSender {
    Arc::new(move |base_url, session_id, prompt, _| agent_sender(base_url, session_id, prompt))
}

fn empty_history_loader() -> HistoryLoader {
    Arc::new(|_, session_id, limit, _| {
        Ok(TranscriptPage {
            session: TranscriptSession {
                id: session_id,
                title: None,
            },
            exchanges: Vec::new(),
            stream: TranscriptStreamCursor {
                next_offset: "-1".to_string(),
                up_to_date: true,
            },
            page: TranscriptPageInfo {
                limit,
                has_older: false,
                before: None,
            },
        })
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlashCommand {
    pub command: &'static str,
    pub usage: &'static str,
    pub description: &'static str,
    pub insertion: &'static str,
}

const TUI_COMMANDS: [SlashCommand; 9] = [
    SlashCommand {
        command: "/new",
        usage: "/new [title]",
        description: "Start a new session",
        insertion: "/new ",
    },
    SlashCommand {
        command: "/clear",
        usage: "/clear [title]",
        description: "Clear and start a new session",
        insertion: "/clear ",
    },
    SlashCommand {
        command: "/resume",
        usage: "/resume <session-id-or-name>",
        description: "Resume a durable session",
        insertion: "/resume ",
    },
    SlashCommand {
        command: "/sessions",
        usage: "/sessions [limit]",
        description: "List recent sessions",
        insertion: "/sessions ",
    },
    SlashCommand {
        command: "/session",
        usage: "/session",
        description: "Show the active session",
        insertion: "/session",
    },
    SlashCommand {
        command: "/rename",
        usage: "/rename <title>",
        description: "Rename the active session",
        insertion: "/rename ",
    },
    SlashCommand {
        command: "/compact",
        usage: "/compact",
        description: "Compact the active session",
        insertion: "/compact",
    },
    SlashCommand {
        command: "/help",
        usage: "/help",
        description: "Show command help",
        insertion: "/help",
    },
    SlashCommand {
        command: "/exit",
        usage: "/exit",
        description: "Exit and print the session id",
        insertion: "/exit",
    },
];

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
    NavigateUp,
    NavigateDown,
    MovePromptStart,
    MovePromptEnd,
    DeletePromptWordLeft,
    CutPromptSelection,
    ClearPrompt,
    SelectCommand,
    Cancel,
    ScrollLineUp,
    ScrollLineDown,
    ScrollPageUp,
    ScrollPageDown,
    JumpToTail,
    Mouse(MouseEvent),
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
    pub selection_range: Option<(usize, usize)>,
    source: Option<TranscriptSourceSpan>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TranscriptSourceSpan {
    id: String,
    line: usize,
    text: String,
    start_char: usize,
    end_char: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct TranscriptTextPosition {
    line: usize,
    char_index: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TranscriptTextCell {
    start: TranscriptTextPosition,
    end: TranscriptTextPosition,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TranscriptSelection {
    origin: TranscriptTextCell,
    active: TranscriptTextCell,
    origin_screen: (u16, u16),
    dragged: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PromptSelection {
    origin_start: usize,
    origin_end: usize,
    active_start: usize,
    active_end: usize,
    origin_screen: (u16, u16),
    dragged: bool,
}

impl PromptSelection {
    fn range(self) -> (usize, usize) {
        if self.origin_start <= self.active_start {
            (self.origin_start, self.active_end)
        } else {
            (self.active_start, self.origin_end)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PromptMouseRegion {
    pub area: Rect,
    pub view_start: usize,
    pub width: usize,
    pub visible_rows: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandPaletteMouseRegion {
    pub area: Rect,
    pub start: usize,
    pub item_count: usize,
}

impl TranscriptSelection {
    fn range(self) -> (TranscriptTextPosition, TranscriptTextPosition) {
        if self.active.start >= self.origin.start {
            (self.origin.start, self.active.end)
        } else {
            (self.active.start, self.origin.end)
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MouseRegions {
    pub transcript_text: Option<Rect>,
    pub transcript_scrollbar: Option<Rect>,
    pub status: Option<Rect>,
    pub prompt: Option<PromptMouseRegion>,
    pub command_palette: Option<CommandPaletteMouseRegion>,
}

pub struct App {
    prompt: String,
    prompt_cursor: usize,
    prompt_vertical_column: Option<usize>,
    prompt_viewport_width: usize,
    prompt_viewport_height: usize,
    prompt_scroll: usize,
    prompt_follow_cursor: bool,
    prompt_selection: Option<PromptSelection>,
    command_palette_selected: usize,
    command_palette_dismissed: bool,
    transcript_document: TranscriptDocument,
    transcript_lines: Vec<String>,
    transcript_line_ids: Vec<String>,
    transcript_line_kinds: Vec<TranscriptRowKind>,
    transcript_line_streaming: Vec<bool>,
    transcript_render_cache: Vec<RenderedTranscriptRow>,
    transcript_scroll: usize,
    follow_tail: bool,
    should_quit: bool,
    exit_session_id: Option<String>,
    session_id: String,
    session_title: Option<String>,
    gateway_status: String,
    base_url: String,
    agent_status: String,
    agent_sender: AgentRequestSender,
    session_lister: SessionLister,
    session_creator: SessionCreator,
    session_resumer: SessionResumer,
    history_loader: HistoryLoader,
    clock: Clock,
    pending_response: Option<PendingResponse>,
    pending_session_lifecycle: Option<PendingSessionLifecycle>,
    pending_history: Option<PendingHistory>,
    pending_session_switch_notice: Option<String>,
    pending_session_switch_attach_stream: bool,
    history_before: Option<String>,
    history_has_older: bool,
    stream_handle: Option<AgentStreamHandle>,
    stream_start_offset: String,
    stream_status: StreamStatus,
    last_stream_event: Option<String>,
    legacy_submission_sequence: u64,
    legacy_submission_id: Option<String>,
    transcript_viewport_height: usize,
    transcript_viewport_width: usize,
    mouse_regions: MouseRegions,
    transcript_selection: Option<TranscriptSelection>,
    clipboard_text: Option<String>,
    scrollbar_dragging: bool,
    palette_pressed: Option<usize>,
    startup_phase: StartupPhase,
    startup_attach_stream: bool,
}

#[derive(Debug)]
struct PendingResponse {
    receiver: Receiver<AgentResponse>,
    exchange_id: String,
    expected_submission_id: Option<String>,
    started_at: Instant,
    spinner_frame: usize,
    duplicate_submit_notice: bool,
}

#[derive(Debug)]
struct AgentResponse {
    result: Result<AgentReply, String>,
}

#[derive(Debug)]
struct PendingSessionLifecycle {
    receiver: Receiver<SessionLifecycleResponse>,
    requested_session_id: Option<String>,
}

#[derive(Debug)]
struct SessionLifecycleResponse {
    result: Result<SessionLifecycleReply, String>,
}

#[derive(Debug)]
struct PendingHistory {
    receiver: Receiver<HistoryResponse>,
    started_at: Instant,
    kind: HistoryRequestKind,
}

#[derive(Debug)]
struct HistoryResponse {
    result: Result<TranscriptPage, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HistoryRequestKind {
    Startup,
    Older,
    SessionSwitch,
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
    ResumingSession,
    LoadingHistory,
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
        Self::with_agent_request_sender(
            session_id,
            gateway_status,
            base_url,
            Arc::new(|base_url, session_id, prompt, origin| {
                send_agent_prompt_reply(&base_url, &session_id, &prompt, origin)
            }),
        )
    }

    fn with_agent_request_sender(
        session_id: impl Into<String>,
        gateway_status: impl Into<String>,
        base_url: impl Into<String>,
        agent_sender: AgentRequestSender,
    ) -> Self {
        Self::with_dependencies(
            session_id,
            gateway_status,
            base_url,
            agent_sender,
            Arc::new(|base_url, limit| list_chat_sessions(&base_url, limit)),
            Arc::new(Instant::now),
            Arc::new(|base_url| create_chat_session(&base_url)),
            Arc::new(|base_url, session_id| resume_chat_session(&base_url, &session_id)),
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

    pub fn with_agent_sender_and_lifecycle(
        session_id: impl Into<String>,
        gateway_status: impl Into<String>,
        base_url: impl Into<String>,
        agent_sender: AgentSender,
        session_creator: SessionCreator,
        session_resumer: SessionResumer,
    ) -> Self {
        Self::with_dependencies_and_history(
            session_id,
            gateway_status,
            base_url,
            ignore_prompt_origin(agent_sender),
            Arc::new(|base_url, limit| list_chat_sessions(&base_url, limit)),
            Arc::new(Instant::now),
            session_creator,
            session_resumer,
            empty_history_loader(),
        )
    }

    pub fn with_agent_sender_lifecycle_and_history(
        session_id: impl Into<String>,
        gateway_status: impl Into<String>,
        base_url: impl Into<String>,
        agent_sender: AgentSender,
        session_creator: SessionCreator,
        session_resumer: SessionResumer,
        history_loader: HistoryLoader,
    ) -> Self {
        Self::with_dependencies_and_history(
            session_id,
            gateway_status,
            base_url,
            ignore_prompt_origin(agent_sender),
            Arc::new(|base_url, limit| list_chat_sessions(&base_url, limit)),
            Arc::new(Instant::now),
            session_creator,
            session_resumer,
            history_loader,
        )
    }

    pub fn with_agent_request_sender_and_lifecycle(
        session_id: impl Into<String>,
        gateway_status: impl Into<String>,
        base_url: impl Into<String>,
        agent_sender: AgentRequestSender,
        session_creator: SessionCreator,
        session_resumer: SessionResumer,
    ) -> Self {
        Self::with_dependencies_and_history(
            session_id,
            gateway_status,
            base_url,
            agent_sender,
            Arc::new(|base_url, limit| list_chat_sessions(&base_url, limit)),
            Arc::new(Instant::now),
            session_creator,
            session_resumer,
            empty_history_loader(),
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
        Self::with_dependencies(
            session_id,
            gateway_status,
            base_url,
            ignore_prompt_origin(agent_sender),
            session_lister,
            clock,
            Arc::new(|base_url| create_chat_session(&base_url)),
            Arc::new(|base_url, session_id| resume_chat_session(&base_url, &session_id)),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn with_dependencies(
        session_id: impl Into<String>,
        gateway_status: impl Into<String>,
        base_url: impl Into<String>,
        agent_sender: AgentRequestSender,
        session_lister: SessionLister,
        clock: Clock,
        session_creator: SessionCreator,
        session_resumer: SessionResumer,
    ) -> Self {
        Self::with_dependencies_and_history(
            session_id,
            gateway_status,
            base_url,
            agent_sender,
            session_lister,
            clock,
            session_creator,
            session_resumer,
            Arc::new(|base_url, session_id, limit, before| {
                load_chat_transcript(&base_url, &session_id, limit, before.as_deref())
            }),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn with_dependencies_and_history(
        session_id: impl Into<String>,
        gateway_status: impl Into<String>,
        base_url: impl Into<String>,
        agent_sender: AgentRequestSender,
        session_lister: SessionLister,
        clock: Clock,
        session_creator: SessionCreator,
        session_resumer: SessionResumer,
        history_loader: HistoryLoader,
    ) -> Self {
        let mut transcript_document = TranscriptDocument::default();
        transcript_document.push_notice("system", "SIM-ONE Alpha Ratatui TUI");
        transcript_document.push_notice("preflight", "waiting for gateway startup result");
        let initial_lines = transcript_document.lines();
        let mut app = Self {
            prompt: String::new(),
            prompt_cursor: 0,
            prompt_vertical_column: None,
            prompt_viewport_width: 80,
            prompt_viewport_height: 2,
            prompt_scroll: 0,
            prompt_follow_cursor: true,
            prompt_selection: None,
            command_palette_selected: 0,
            command_palette_dismissed: false,
            transcript_document,
            transcript_lines: initial_lines.iter().map(|line| line.text.clone()).collect(),
            transcript_line_ids: initial_lines.iter().map(|line| line.id.clone()).collect(),
            transcript_line_kinds: initial_lines
                .iter()
                .map(|line| transcript_row_kind_from_document(line.kind))
                .collect(),
            transcript_line_streaming: initial_lines.iter().map(|line| line.is_streaming).collect(),
            transcript_render_cache: Vec::new(),
            transcript_scroll: 0,
            follow_tail: true,
            should_quit: false,
            exit_session_id: None,
            session_id: session_id.into(),
            session_title: None,
            gateway_status: gateway_status.into(),
            base_url: base_url.into(),
            agent_status: "ready".to_string(),
            agent_sender,
            session_lister,
            session_creator,
            session_resumer,
            history_loader,
            clock,
            pending_response: None,
            pending_session_lifecycle: None,
            pending_history: None,
            pending_session_switch_notice: None,
            pending_session_switch_attach_stream: false,
            history_before: None,
            history_has_older: false,
            stream_handle: None,
            stream_start_offset: "-1".to_string(),
            stream_status: StreamStatus::NotAttached,
            last_stream_event: None,
            legacy_submission_sequence: 0,
            legacy_submission_id: None,
            transcript_viewport_height: SCROLL_PAGE_LINES,
            transcript_viewport_width: 80,
            mouse_regions: MouseRegions::default(),
            transcript_selection: None,
            clipboard_text: None,
            scrollbar_dragging: false,
            palette_pressed: None,
            startup_phase: StartupPhase::Idle,
            startup_attach_stream: false,
        };
        app.rebuild_transcript_render_cache();
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
            AppEvent::NavigateUp => self.navigate_up(),
            AppEvent::NavigateDown => self.navigate_down(),
            AppEvent::MovePromptStart => {
                self.prompt_cursor = 0;
                self.prompt_vertical_column = None;
                self.prompt_selection = None;
                self.prompt_follow_cursor = true;
            }
            AppEvent::MovePromptEnd => {
                self.prompt_cursor = self.prompt.len();
                self.prompt_vertical_column = None;
                self.prompt_selection = None;
                self.prompt_follow_cursor = true;
            }
            AppEvent::DeletePromptWordLeft => self.delete_prompt_word_left(),
            AppEvent::CutPromptSelection => self.cut_prompt_selection(),
            AppEvent::ClearPrompt => {
                self.prompt.clear();
                self.prompt_cursor = 0;
                self.prompt_vertical_column = None;
                self.prompt_selection = None;
                self.prompt_scroll = 0;
                self.prompt_follow_cursor = true;
                self.reset_command_palette();
            }
            AppEvent::SelectCommand => {
                self.select_command();
            }
            AppEvent::Cancel => self.cancel_or_quit(),
            AppEvent::ScrollLineUp => self.scroll_lines_up(1),
            AppEvent::ScrollLineDown => self.scroll_lines_down(1),
            AppEvent::ScrollPageUp => self.scroll_page_up(),
            AppEvent::ScrollPageDown => self.scroll_page_down(),
            AppEvent::JumpToTail => self.jump_to_tail(),
            AppEvent::Mouse(mouse) => self.handle_mouse(mouse),
            AppEvent::Quit => self.copy_selection_or_quit(),
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
            self.stream_start_offset.clone(),
        ));
    }

    pub fn start_startup_preflight(&mut self, attach_stream: bool) {
        if self.pending_response.is_some()
            || self.pending_session_lifecycle.is_some()
            || self.startup_phase != StartupPhase::Idle
        {
            return;
        }

        self.startup_phase = StartupPhase::CreatingSession;
        diagnostics::session_lifecycle_started("fresh", None);
        self.startup_attach_stream = attach_stream;
        self.agent_status = "preflight".to_string();
        self.push_speaker_text(
            "preflight",
            &format!("gateway ready ({})", self.gateway_status),
        );
        self.push_speaker_text("preflight", "creating fresh TUI session");

        let base_url = self.base_url.clone();
        let creator = Arc::clone(&self.session_creator);
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let result = creator(base_url);
            let _ = tx.send(SessionLifecycleResponse { result });
        });
        self.pending_session_lifecycle = Some(PendingSessionLifecycle {
            receiver: rx,
            requested_session_id: None,
        });
        self.jump_to_tail();
    }

    pub fn start_explicit_resume(&mut self, session_id: String, attach_stream: bool) {
        if self.pending_response.is_some()
            || self.pending_session_lifecycle.is_some()
            || self.startup_phase != StartupPhase::Idle
        {
            return;
        }

        let session_id = session_id.trim().to_string();
        diagnostics::session_lifecycle_started("explicit", Some(&session_id));
        self.startup_phase = StartupPhase::ResumingSession;
        self.startup_attach_stream = attach_stream;
        self.agent_status = "preflight".to_string();
        self.push_speaker_text(
            "preflight",
            &format!("gateway ready ({})", self.gateway_status),
        );
        self.push_speaker_text("preflight", &format!("validating TUI session {session_id}"));

        let base_url = self.base_url.clone();
        let requested_session_id = session_id.clone();
        let resumer = Arc::clone(&self.session_resumer);
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let result = resumer(base_url, session_id);
            let _ = tx.send(SessionLifecycleResponse { result });
        });
        self.pending_session_lifecycle = Some(PendingSessionLifecycle {
            receiver: rx,
            requested_session_id: Some(requested_session_id),
        });
        self.jump_to_tail();
    }

    pub fn startup_complete(&self) -> bool {
        matches!(
            self.startup_phase,
            StartupPhase::Complete | StartupPhase::Failed
        )
    }

    pub fn startup_succeeded(&self) -> bool {
        self.startup_phase == StartupPhase::Complete
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
                let events = self.correlate_stream_events(events);
                let pending_submission = self.pending_response.as_ref().map(|pending| {
                    pending
                        .expected_submission_id
                        .as_deref()
                        .unwrap_or(&pending.exchange_id)
                        .to_string()
                });
                let pending_has_final =
                    pending_submission.as_deref().is_some_and(|submission_id| {
                        events.iter().any(|event| {
                            event_submission_id(event) == Some(submission_id)
                                && is_root_assistant_final(event)
                        })
                    });
                let pending_has_text = pending_submission.as_deref().is_some_and(|submission_id| {
                    events.iter().any(|event| {
                        event_submission_id(event) == Some(submission_id)
                            && event.event_type == "text_delta"
                            && !event.is_nested()
                    })
                });
                self.transcript_document.apply_events(&events);
                self.rebuild_transcript_cache();
                if pending_has_final {
                    self.agent_status = "finalizing".to_string();
                } else if pending_has_text {
                    self.agent_status = "responding".to_string();
                }
                self.after_transcript_changed();
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

    fn poll_session_lifecycle(&mut self) {
        let Some(pending) = &self.pending_session_lifecycle else {
            return;
        };
        let requested_session_id = pending.requested_session_id.clone();
        let received = pending.receiver.try_recv();

        match received {
            Ok(response) => {
                self.pending_session_lifecycle = None;
                match response.result {
                    Ok(reply) => {
                        if let Err(error) =
                            self.complete_session_lifecycle(reply, requested_session_id.as_deref())
                        {
                            diagnostics::session_lifecycle_failed("completion", &error);
                            self.agent_status = "error".to_string();
                            self.push_speaker_text("error", &error);
                            self.fail_startup();
                        }
                    }
                    Err(error) => {
                        diagnostics::session_lifecycle_failed("request", &error);
                        self.agent_status = "error".to_string();
                        self.push_speaker_text("error", error.trim());
                        self.fail_startup();
                    }
                }
                self.after_transcript_changed();
            }
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => {
                self.pending_session_lifecycle = None;
                self.agent_status = "error".to_string();
                self.push_speaker_text("error", "Session lifecycle response channel disconnected.");
                diagnostics::session_lifecycle_failed(
                    "request",
                    "Session lifecycle response channel disconnected.",
                );
                self.fail_startup();
                self.after_transcript_changed();
            }
        }
    }

    fn poll_history(&mut self) {
        let Some(pending) = &self.pending_history else {
            return;
        };
        let received = pending.receiver.try_recv();
        let elapsed_ms = pending.started_at.elapsed().as_millis();
        let kind = pending.kind;

        match received {
            Ok(response) => {
                self.pending_history = None;
                match response.result {
                    Ok(page) => {
                        if page.session.id != self.session_id {
                            let error = "Transcript history did not match the active session.";
                            diagnostics::history_load_failed(error, elapsed_ms);
                            self.agent_status = "error".to_string();
                            self.handle_history_failure(kind);
                        } else {
                            self.install_history_page(page, kind, elapsed_ms);
                        }
                    }
                    Err(error) => {
                        diagnostics::history_load_failed(&error, elapsed_ms);
                        self.handle_history_failure(kind);
                    }
                }
                self.after_transcript_changed();
            }
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => {
                self.pending_history = None;
                let error = "Transcript history response channel disconnected.";
                diagnostics::history_load_failed(error, elapsed_ms);
                self.handle_history_failure(kind);
                self.after_transcript_changed();
            }
        }
    }

    fn install_history_page(
        &mut self,
        page: TranscriptPage,
        kind: HistoryRequestKind,
        elapsed_ms: u128,
    ) {
        let exchange_count = page.exchanges.len();
        let activity_count = page
            .exchanges
            .iter()
            .map(|exchange| exchange.activities.len())
            .sum();
        self.history_before = page.page.before;
        self.history_has_older = page.page.has_older;

        match kind {
            HistoryRequestKind::Startup => {
                diagnostics::history_load_completed(
                    exchange_count,
                    activity_count,
                    elapsed_ms,
                    self.history_has_older,
                );
                self.transcript_document.install_snapshot(page.exchanges);
                self.rebuild_transcript_cache();
                self.stream_start_offset = page.stream.next_offset;
                self.attach_startup_stream();
                self.push_speaker_text("preflight", "all systems go");
                self.startup_phase = StartupPhase::Complete;
                self.agent_status = "ready".to_string();
            }
            HistoryRequestKind::Older => {
                let anchor = self
                    .transcript_rendered_rows()
                    .get(self.transcript_scroll)
                    .and_then(|row| row.source.as_ref())
                    .map(|source| (source.id.clone(), source.start_char));
                let old_source_lines = self.transcript_lines.len();
                let added_count = self.transcript_document.prepend_snapshot(page.exchanges);
                self.rebuild_transcript_cache();
                let inserted_source_lines =
                    self.transcript_lines.len().saturating_sub(old_source_lines);
                if !self.follow_tail {
                    if let Some((anchor_id, anchor_start)) = anchor {
                        self.transcript_scroll = self
                            .transcript_rendered_rows()
                            .iter()
                            .position(|row| {
                                row.source.as_ref().is_some_and(|source| {
                                    source.id == anchor_id && source.start_char == anchor_start
                                })
                            })
                            .unwrap_or(self.transcript_scroll)
                            .min(self.max_scroll());
                    }
                }
                self.shift_transcript_selection_lines(inserted_source_lines);
                diagnostics::history_page_prepended(
                    added_count,
                    elapsed_ms,
                    self.history_has_older,
                );
            }
            HistoryRequestKind::SessionSwitch => {
                diagnostics::history_load_completed(
                    exchange_count,
                    activity_count,
                    elapsed_ms,
                    self.history_has_older,
                );
                self.transcript_document.install_snapshot(page.exchanges);
                self.rebuild_transcript_cache();
                self.stream_start_offset = page.stream.next_offset;
                if self.pending_session_switch_attach_stream {
                    self.start_stream();
                }
                self.pending_session_switch_attach_stream = false;
                if let Some(notice) = self.pending_session_switch_notice.take() {
                    self.push_speaker_text("system", &notice);
                }
                self.agent_status = "ready".to_string();
            }
        }
    }

    fn handle_history_failure(&mut self, kind: HistoryRequestKind) {
        match kind {
            HistoryRequestKind::Startup => {
                self.agent_status = "error".to_string();
                self.push_speaker_text("error", "Could not load session history.");
                self.fail_startup();
            }
            HistoryRequestKind::Older => {
                self.push_speaker_text("error", "Could not load older session history.");
            }
            HistoryRequestKind::SessionSwitch => {
                self.pending_session_switch_attach_stream = false;
                self.pending_session_switch_notice = None;
                self.agent_status = "error".to_string();
                self.push_speaker_text("error", "Could not load resumed session history.");
            }
        }
    }

    pub fn poll_agent(&mut self) {
        self.poll_session_lifecycle();
        self.poll_history();
        let Some(pending) = &self.pending_response else {
            return;
        };
        let exchange_id = pending.exchange_id.clone();
        let received = pending.receiver.try_recv();

        match received {
            Ok(response) => {
                diagnostics::prompt_response_applied(pending.started_at.elapsed().as_millis());
                self.pending_response = None;
                self.agent_status = "ready".to_string();
                match response.result {
                    Ok(reply) => {
                        if self.handle_command_session_switch(&reply) {
                            self.continue_startup_after_agent_reply(&reply);
                            self.after_transcript_changed();
                            return;
                        }
                        let session_id = reply.session_id.clone();
                        let explicit_session_title = matches!(
                            reply.command_name.as_deref(),
                            Some("rename" | "new" | "clear" | "resume" | "session")
                        )
                        .then(|| clean_session_title(reply.session_title.clone()))
                        .flatten();
                        let reply_for_startup = reply.clone();
                        let response_exchange_id = reply
                            .submission_id
                            .as_deref()
                            .and_then(|submission_id| {
                                self.transcript_document
                                    .bind_exchange(&exchange_id, submission_id)
                            })
                            .unwrap_or(exchange_id);
                        self.transcript_document
                            .clear_pending_text(&response_exchange_id);
                        let _ = self.transcript_document.set_assistant(
                            &response_exchange_id,
                            reply
                                .submission_id
                                .as_ref()
                                .map(|submission_id| format!("assistant:{submission_id}:http")),
                            reply.text.trim(),
                            None,
                        );
                        self.rebuild_transcript_cache();
                        if let Some(session_id) = session_id {
                            let session_changed = self.session_id != session_id;
                            self.switch_session(session_id);
                            if explicit_session_title.is_some() {
                                self.session_title = explicit_session_title;
                            } else if session_changed {
                                self.session_title = None;
                            }
                        }
                        self.continue_startup_after_agent_reply(&reply_for_startup);
                    }
                    Err(error) => {
                        self.settle_pending_error(&exchange_id, error.trim());
                        self.fail_startup();
                    }
                }
                self.after_transcript_changed();
            }
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => {
                self.pending_response = None;
                self.agent_status = "error".to_string();
                self.settle_pending_error(&exchange_id, "Agent response channel disconnected.");
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

    pub fn set_prompt_viewport_width(&mut self, width: usize) {
        let width = width.max(1);
        if self.prompt_viewport_width != width {
            self.prompt_viewport_width = width;
            self.prompt_vertical_column = None;
            self.prompt_follow_cursor = true;
        }
    }

    pub fn sync_prompt_view_for_render(
        &mut self,
        row_count: usize,
        cursor_row: usize,
        visible_rows: usize,
    ) -> usize {
        self.prompt_viewport_height = visible_rows.max(1);
        let max_start = row_count.saturating_sub(self.prompt_viewport_height);
        if self.prompt_follow_cursor {
            self.prompt_scroll = cursor_row
                .saturating_sub(self.prompt_viewport_height.saturating_sub(1))
                .min(max_start);
        } else {
            self.prompt_scroll = self.prompt_scroll.min(max_start);
        }
        self.prompt_scroll
    }

    pub fn prompt_scroll(&self) -> usize {
        self.prompt_scroll
    }

    pub fn prompt_selection_text(&self) -> Option<String> {
        let selection = self
            .prompt_selection
            .filter(|selection| selection.dragged)?;
        let (start, end) = selection.range();
        (start < end).then(|| self.prompt[start..end].to_string())
    }

    pub fn prompt_selection_chars(&self) -> Option<(usize, usize)> {
        let selection = self
            .prompt_selection
            .filter(|selection| selection.dragged)?;
        let (start, end) = selection.range();
        Some((
            self.prompt[..start].chars().count(),
            self.prompt[..end].chars().count(),
        ))
    }

    pub fn command_palette_open(&self) -> bool {
        !self.command_palette_dismissed
            && self.prompt.starts_with('/')
            && !self.prompt.chars().any(char::is_whitespace)
    }

    pub fn command_palette_items(&self) -> Vec<SlashCommand> {
        if !self.command_palette_open() {
            return Vec::new();
        }
        let mut items = TUI_COMMANDS
            .iter()
            .copied()
            .filter(|item| item.command.starts_with(&self.prompt))
            .collect::<Vec<_>>();
        items.sort_by_key(|item| item.command != self.prompt);
        items
    }

    pub fn command_palette_selected(&self) -> usize {
        self.command_palette_selected
    }

    pub fn selected_command(&self) -> Option<SlashCommand> {
        self.command_palette_items()
            .get(self.command_palette_selected)
            .copied()
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

    pub fn session_title(&self) -> Option<&str> {
        self.session_title.as_deref()
    }

    pub fn transcript_header_title(&self) -> String {
        self.session_title.as_deref().map_or_else(
            || "SIM-ONE Alpha".to_string(),
            |title| format!("SIM-ONE Alpha - {title}"),
        )
    }

    fn session_label(&self) -> &str {
        if self.session_id.trim().is_empty() {
            UNRESOLVED_SESSION_LABEL
        } else {
            &self.session_id
        }
    }

    fn status_session_label(&self) -> String {
        self.session_title
            .as_deref()
            .unwrap_or_else(|| self.session_label())
            .to_string()
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
            format!("session: {}", self.status_session_label()),
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
            || self.pending_session_lifecycle.is_some()
            || self.pending_history.is_some()
    }

    pub fn loaded_history_exchanges(&self) -> &[TranscriptExchange] {
        self.transcript_document.exchanges()
    }

    pub fn stream_start_offset(&self) -> &str {
        &self.stream_start_offset
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
        if self.transcript_viewport_width != width {
            self.transcript_viewport_width = width;
            self.rebuild_transcript_render_cache();
        }
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
        let mut rows = self.transcript_render_cache.clone();
        rows.extend(std::iter::repeat_n(
            RenderedTranscriptRow {
                text: String::new(),
                kind: TranscriptRowKind::Other,
                is_streaming: false,
                styled_spans: None,
                selection_range: None,
                source: None,
            },
            TRANSCRIPT_TAIL_MARGIN_ROWS,
        ));
        if let Some(selection) = self
            .transcript_selection
            .filter(|selection| selection.dragged)
        {
            let range = selection.range();
            for row in &mut rows {
                row.selection_range = selection_range_for_row(row.source.as_ref(), range);
            }
        }
        rows
    }

    pub fn set_mouse_regions(&mut self, regions: MouseRegions) {
        self.mouse_regions = regions;
    }

    pub fn set_prompt_mouse_region(&mut self, region: PromptMouseRegion) {
        self.mouse_regions.prompt = Some(region);
    }

    pub fn set_command_palette_mouse_region(&mut self, region: Option<CommandPaletteMouseRegion>) {
        self.mouse_regions.command_palette = region;
    }

    pub fn transcript_selection_text(&self) -> Option<String> {
        let selection = self
            .transcript_selection
            .filter(|selection| selection.dragged)?;
        selected_transcript_text(&self.transcript_rendered_rows(), selection.range())
    }

    pub fn take_clipboard_text(&mut self) -> Option<String> {
        self.clipboard_text.take()
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
        self.delete_prompt_selection();
        self.prompt.insert_str(self.prompt_cursor, text);
        self.prompt_cursor += text.len();
        self.prompt_vertical_column = None;
        self.prompt_follow_cursor = true;
        self.reset_command_palette();
    }

    fn backspace_prompt(&mut self) {
        if self.delete_prompt_selection().is_some() {
            self.prompt_follow_cursor = true;
            self.reset_command_palette();
            return;
        }
        let Some(previous) = previous_char_boundary(&self.prompt, self.prompt_cursor) else {
            return;
        };
        self.prompt.drain(previous..self.prompt_cursor);
        self.prompt_cursor = previous;
        self.prompt_vertical_column = None;
        self.prompt_follow_cursor = true;
        self.reset_command_palette();
    }

    fn delete_prompt_char(&mut self) {
        if self.delete_prompt_selection().is_some() {
            self.prompt_follow_cursor = true;
            self.reset_command_palette();
            return;
        }
        let Some(next) = next_char_boundary(&self.prompt, self.prompt_cursor) else {
            return;
        };
        self.prompt.drain(self.prompt_cursor..next);
        self.prompt_vertical_column = None;
        self.prompt_follow_cursor = true;
        self.reset_command_palette();
    }

    fn move_prompt_left(&mut self) {
        if let Some(selection) = self
            .prompt_selection
            .take()
            .filter(|selection| selection.dragged)
        {
            self.prompt_cursor = selection.range().0;
            self.prompt_vertical_column = None;
            self.prompt_follow_cursor = true;
            return;
        }
        if let Some(previous) = previous_char_boundary(&self.prompt, self.prompt_cursor) {
            self.prompt_cursor = previous;
            self.prompt_vertical_column = None;
            self.prompt_follow_cursor = true;
        }
    }

    fn move_prompt_right(&mut self) {
        if let Some(selection) = self
            .prompt_selection
            .take()
            .filter(|selection| selection.dragged)
        {
            self.prompt_cursor = selection.range().1;
            self.prompt_vertical_column = None;
            self.prompt_follow_cursor = true;
            return;
        }
        if let Some(next) = next_char_boundary(&self.prompt, self.prompt_cursor) {
            self.prompt_cursor = next;
            self.prompt_vertical_column = None;
            self.prompt_follow_cursor = true;
        }
    }

    fn move_prompt_word_left(&mut self) {
        self.prompt_selection = None;
        self.prompt_cursor = previous_word_boundary(&self.prompt, self.prompt_cursor);
        self.prompt_vertical_column = None;
        self.prompt_follow_cursor = true;
    }

    fn move_prompt_word_right(&mut self) {
        self.prompt_selection = None;
        self.prompt_cursor = next_word_boundary(&self.prompt, self.prompt_cursor);
        self.prompt_vertical_column = None;
        self.prompt_follow_cursor = true;
    }

    fn delete_prompt_word_left(&mut self) {
        if self.delete_prompt_selection().is_some() {
            self.prompt_follow_cursor = true;
            self.reset_command_palette();
            return;
        }
        let start = previous_word_boundary(&self.prompt, self.prompt_cursor);
        self.prompt.drain(start..self.prompt_cursor);
        self.prompt_cursor = start;
        self.prompt_vertical_column = None;
        self.prompt_follow_cursor = true;
        self.reset_command_palette();
    }

    fn delete_prompt_selection(&mut self) -> Option<String> {
        let selection = self
            .prompt_selection
            .take()
            .filter(|selection| selection.dragged)?;
        let (start, end) = selection.range();
        if start >= end {
            return None;
        }
        let removed = self.prompt[start..end].to_string();
        self.prompt.drain(start..end);
        self.prompt_cursor = start;
        self.prompt_vertical_column = None;
        Some(removed)
    }

    fn cut_prompt_selection(&mut self) {
        if let Some(text) = self.delete_prompt_selection() {
            self.clipboard_text = Some(text);
            self.prompt_follow_cursor = true;
            self.reset_command_palette();
        }
    }

    fn copy_selection_or_quit(&mut self) {
        if let Some(text) = self.prompt_selection_text() {
            diagnostics::ctrl_c("copy_prompt", text.chars().count());
            self.clipboard_text = Some(text);
        } else if let Some(text) = self.transcript_selection_text() {
            diagnostics::ctrl_c("copy_transcript", text.chars().count());
            self.clipboard_text = Some(text);
        } else {
            diagnostics::ctrl_c("exit", 0);
            self.should_quit = true;
        }
    }

    fn scroll_lines_up(&mut self, amount: usize) {
        let requested_scroll = self.transcript_scroll.saturating_sub(amount);
        self.follow_tail = false;
        let first_exchange_row = self
            .transcript_document
            .first_exchange_line_id()
            .and_then(|line_id| {
                self.transcript_rendered_rows().iter().rposition(|row| {
                    row.source
                        .as_ref()
                        .is_some_and(|source| source.id == line_id)
                })
            })
            .unwrap_or(0);
        if self.history_has_older && requested_scroll <= first_exchange_row {
            self.transcript_scroll = first_exchange_row;
            self.request_older_history_page();
        } else {
            self.transcript_scroll = requested_scroll;
        }
    }

    fn scroll_lines_down(&mut self, amount: usize) {
        self.transcript_scroll = self
            .transcript_scroll
            .saturating_add(amount)
            .min(self.max_scroll());
        self.follow_tail = self.transcript_scroll == self.max_scroll();
    }

    fn handle_mouse(&mut self, mouse: MouseEvent) {
        if self.handle_command_palette_mouse(mouse) {
            return;
        }

        match mouse.kind {
            MouseEventKind::ScrollUp if self.mouse_over_prompt(mouse.column, mouse.row) => {
                self.scroll_prompt_up();
            }
            MouseEventKind::ScrollDown if self.mouse_over_prompt(mouse.column, mouse.row) => {
                self.scroll_prompt_down();
            }
            MouseEventKind::ScrollUp if self.mouse_over_transcript(mouse.column, mouse.row) => {
                self.scroll_lines_up(1);
            }
            MouseEventKind::ScrollDown if self.mouse_over_transcript(mouse.column, mouse.row) => {
                self.scroll_lines_down(1);
            }
            MouseEventKind::Down(MouseButton::Left)
                if self.mouse_over_scrollbar(mouse.column, mouse.row) =>
            {
                self.scrollbar_dragging = true;
                self.transcript_selection = None;
                self.prompt_selection = None;
                self.set_transcript_scroll_from_mouse(mouse.row);
            }
            MouseEventKind::Drag(MouseButton::Left) if self.scrollbar_dragging => {
                self.set_transcript_scroll_from_mouse(mouse.row);
            }
            MouseEventKind::Up(MouseButton::Left) if self.scrollbar_dragging => {
                self.set_transcript_scroll_from_mouse(mouse.row);
                self.scrollbar_dragging = false;
            }
            MouseEventKind::Down(MouseButton::Left)
                if self.mouse_over_prompt(mouse.column, mouse.row) =>
            {
                self.begin_prompt_selection(mouse.column, mouse.row);
            }
            MouseEventKind::Drag(MouseButton::Left) if self.prompt_selection.is_some() => {
                self.update_prompt_selection(mouse.column, mouse.row, true);
            }
            MouseEventKind::Up(MouseButton::Left) if self.prompt_selection.is_some() => {
                self.update_prompt_selection(mouse.column, mouse.row, false);
                if self
                    .prompt_selection
                    .is_some_and(|selection| selection.dragged)
                {
                    self.clipboard_text = self.prompt_selection_text();
                } else {
                    self.prompt_selection = None;
                }
            }
            MouseEventKind::Down(MouseButton::Left)
                if self.mouse_over_transcript_text(mouse.column, mouse.row) =>
            {
                self.begin_transcript_selection(mouse.column, mouse.row);
            }
            MouseEventKind::Drag(MouseButton::Left) if self.transcript_selection.is_some() => {
                self.update_transcript_selection(mouse.column, mouse.row, true);
            }
            MouseEventKind::Up(MouseButton::Left) if self.transcript_selection.is_some() => {
                self.update_transcript_selection(mouse.column, mouse.row, false);
                if self
                    .transcript_selection
                    .is_some_and(|selection| selection.dragged)
                {
                    self.clipboard_text = self.transcript_selection_text();
                } else {
                    self.transcript_selection = None;
                }
            }
            MouseEventKind::Down(MouseButton::Left) => {
                self.transcript_selection = None;
                self.prompt_selection = None;
            }
            _ => {}
        }
    }

    fn handle_command_palette_mouse(&mut self, mouse: MouseEvent) -> bool {
        if !self.command_palette_open() {
            self.palette_pressed = None;
            return false;
        }
        let item = self.command_palette_item_at(mouse.column, mouse.row);
        if self
            .mouse_regions
            .command_palette
            .is_some_and(|region| rect_contains(region.area, mouse.column, mouse.row))
        {
            match mouse.kind {
                MouseEventKind::ScrollUp => self.navigate_up(),
                MouseEventKind::ScrollDown => self.navigate_down(),
                MouseEventKind::Down(MouseButton::Left) => {
                    if let Some(index) = item {
                        self.command_palette_selected = index;
                        self.palette_pressed = Some(index);
                    }
                }
                MouseEventKind::Up(MouseButton::Left) => {
                    match (item, self.palette_pressed.take()) {
                        (Some(index), Some(pressed)) if index == pressed => {
                            self.command_palette_selected = index;
                            self.select_command();
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
            return true;
        }
        if matches!(mouse.kind, MouseEventKind::Down(MouseButton::Left)) {
            self.command_palette_dismissed = true;
            self.palette_pressed = None;
            return true;
        }
        false
    }

    fn command_palette_item_at(&self, column: u16, row: u16) -> Option<usize> {
        let region = self.mouse_regions.command_palette?;
        if !rect_contains(region.area, column, row) {
            return None;
        }
        let offset = row.saturating_sub(region.area.y) as usize;
        (offset < region.item_count).then_some(region.start + offset)
    }

    fn mouse_over_prompt(&self, column: u16, row: u16) -> bool {
        self.mouse_regions
            .prompt
            .is_some_and(|region| rect_contains(region.area, column, row))
    }

    fn mouse_over_scrollbar(&self, column: u16, row: u16) -> bool {
        self.mouse_regions
            .transcript_scrollbar
            .is_some_and(|area| rect_contains(area, column, row))
    }

    fn mouse_over_transcript_text(&self, column: u16, row: u16) -> bool {
        self.mouse_regions
            .transcript_text
            .is_some_and(|area| rect_contains(area, column, row))
    }

    fn mouse_over_transcript(&self, column: u16, row: u16) -> bool {
        self.mouse_over_transcript_text(column, row) || self.mouse_over_scrollbar(column, row)
    }

    fn set_transcript_scroll_from_mouse(&mut self, row: u16) {
        let Some(area) = self.mouse_regions.transcript_scrollbar else {
            return;
        };
        let track = area.height.saturating_sub(1) as usize;
        let relative = row
            .saturating_sub(area.y)
            .min(area.height.saturating_sub(1)) as usize;
        self.transcript_scroll = relative
            .saturating_mul(self.max_scroll())
            .checked_div(track)
            .unwrap_or_default();
        self.follow_tail = self.transcript_scroll == self.max_scroll();
    }

    fn scroll_prompt_up(&mut self) {
        self.prompt_scroll = self.prompt_scroll.saturating_sub(1);
        self.prompt_follow_cursor = false;
    }

    fn scroll_prompt_down(&mut self) {
        let max_scroll = wrap_words(&self.prompt, self.prompt_viewport_width)
            .len()
            .saturating_sub(self.prompt_viewport_height.max(1));
        self.prompt_scroll = self.prompt_scroll.saturating_add(1).min(max_scroll);
        self.prompt_follow_cursor = false;
    }

    fn begin_prompt_selection(&mut self, column: u16, row: u16) {
        let Some((cursor, cursor_end)) = self.prompt_cell_at_screen(column, row) else {
            return;
        };
        self.prompt_cursor = cursor;
        self.prompt_vertical_column = None;
        self.prompt_follow_cursor = true;
        self.transcript_selection = None;
        self.prompt_selection = Some(PromptSelection {
            origin_start: cursor,
            origin_end: cursor_end,
            active_start: cursor,
            active_end: cursor_end,
            origin_screen: (column, row),
            dragged: false,
        });
    }

    fn update_prompt_selection(&mut self, column: u16, row: u16, is_drag: bool) {
        let Some(region) = self.mouse_regions.prompt else {
            return;
        };
        if is_drag {
            if row <= region.area.y {
                self.scroll_prompt_up();
            } else if row >= region.area.bottom().saturating_sub(1) {
                self.scroll_prompt_down();
            }
        }
        let Some((cursor, cursor_end)) = self.prompt_cell_at_screen(column, row) else {
            return;
        };
        if let Some(selection) = &mut self.prompt_selection {
            selection.active_start = cursor;
            selection.active_end = cursor_end;
            selection.dragged |= is_drag || selection.origin_screen != (column, row);
            self.prompt_cursor = if !selection.dragged {
                cursor
            } else if cursor >= selection.origin_start {
                cursor_end
            } else {
                cursor
            };
        }
    }

    fn prompt_cell_at_screen(&self, column: u16, row: u16) -> Option<(usize, usize)> {
        let region = self.mouse_regions.prompt?;
        let rows = wrap_words(&self.prompt, region.width);
        let logical_row = region.view_start
            + row
                .saturating_sub(region.area.y)
                .min(region.area.height.saturating_sub(1)) as usize;
        let row = rows.get(logical_row).or_else(|| rows.last())?;
        let column = column.saturating_sub(region.area.x.saturating_add(2)) as usize;
        let row_end = row.start_char + row.text.chars().count();
        let char_index =
            char_index_at_display_column(&self.prompt, row.start_char, row_end, column);
        let start = byte_index_at_char(&self.prompt, char_index);
        let end = next_char_boundary(&self.prompt, start).unwrap_or(start);
        Some((start, end))
    }

    fn begin_transcript_selection(&mut self, column: u16, row: u16) {
        let Some(cell) = self.transcript_cell_at_screen(column, row) else {
            self.transcript_selection = None;
            return;
        };
        self.transcript_selection = Some(TranscriptSelection {
            origin: cell,
            active: cell,
            origin_screen: (column, row),
            dragged: false,
        });
    }

    fn update_transcript_selection(&mut self, column: u16, row: u16, is_drag: bool) {
        let Some(area) = self.mouse_regions.transcript_text else {
            return;
        };
        if is_drag {
            if row <= area.y {
                self.scroll_lines_up(1);
            } else if row >= area.bottom().saturating_sub(1) {
                self.scroll_lines_down(1);
            }
        }
        let Some(cell) = self.transcript_cell_at_screen(column, row) else {
            return;
        };
        if let Some(selection) = &mut self.transcript_selection {
            selection.active = cell;
            selection.dragged |= is_drag || selection.origin_screen != (column, row);
        }
    }

    fn transcript_cell_at_screen(&self, column: u16, row: u16) -> Option<TranscriptTextCell> {
        let area = self.mouse_regions.transcript_text?;
        if area.width == 0 || area.height == 0 {
            return None;
        }
        let local_row = row
            .saturating_sub(area.y)
            .min(area.height.saturating_sub(1)) as usize;
        let rendered_row = self.transcript_scroll.saturating_add(local_row);
        let rows = self.transcript_rendered_rows();
        let row = rows
            .get(rendered_row)
            .filter(|row| row.source.is_some())
            .or_else(|| {
                rows[..rendered_row.min(rows.len())]
                    .iter()
                    .rev()
                    .find(|row| row.source.is_some())
            })?;
        let display_column = column
            .saturating_sub(area.x)
            .min(area.width.saturating_sub(1)) as usize;
        transcript_text_cell(row, display_column)
    }

    fn submit_prompt(&mut self) {
        let should_complete_command = self
            .selected_command()
            .is_some_and(|command| self.prompt != command.command);
        if (should_complete_command && self.select_command())
            || self.insert_newline_after_backslash()
        {
            return;
        }

        let prompt = self.prompt.trim().to_string();
        if self.pending_session_lifecycle.is_some()
            || self.pending_history.is_some()
            || self.startup_phase == StartupPhase::Failed
        {
            if self.startup_phase != StartupPhase::Failed {
                self.agent_status = "busy".to_string();
            }
            return;
        }
        if self.handle_local_slash_command(&prompt) {
            self.prompt.clear();
            self.prompt_cursor = 0;
            self.prompt_vertical_column = None;
            self.prompt_selection = None;
            self.prompt_scroll = 0;
            self.prompt_follow_cursor = true;
            self.reset_command_palette();
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
            self.prompt_vertical_column = None;
            self.prompt_selection = None;
            self.prompt_scroll = 0;
            self.prompt_follow_cursor = true;
            self.reset_command_palette();
            return;
        }

        let exchange_id = self
            .transcript_document
            .begin_exchange(Some(prompt.clone()), TranscriptPromptVisibility::User);
        self.prompt.clear();
        self.prompt_cursor = 0;
        self.prompt_vertical_column = None;
        self.prompt_selection = None;
        self.prompt_scroll = 0;
        self.prompt_follow_cursor = true;
        self.reset_command_palette();
        self.agent_status = "thinking".to_string();

        let base_url = self.base_url.clone();
        let session_id = self.session_id.clone();
        let sender = Arc::clone(&self.agent_sender);
        let started_at = (self.clock)();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let result = sender(base_url, session_id, prompt, AgentPromptOrigin::User);
            diagnostics::prompt_request_completed(result.is_ok(), started_at.elapsed().as_millis());
            let _ = tx.send(AgentResponse { result });
        });
        let pending = PendingResponse {
            receiver: rx,
            exchange_id,
            expected_submission_id: None,
            started_at,
            spinner_frame: 0,
            duplicate_submit_notice: false,
        };
        self.transcript_document.set_pending_text(
            &pending.exchange_id,
            pending_transcript_line(&pending, started_at),
        );
        self.pending_response = Some(pending);
        self.rebuild_transcript_cache();
        self.jump_to_tail();
    }

    fn submit_internal_prompt(&mut self, prompt: String) {
        if self.pending_response.is_some() {
            return;
        }

        let exchange_id = self
            .transcript_document
            .begin_exchange(None, TranscriptPromptVisibility::Internal);
        self.agent_status = "thinking".to_string();

        let base_url = self.base_url.clone();
        let session_id = self.session_id.clone();
        let sender = Arc::clone(&self.agent_sender);
        let started_at = (self.clock)();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let result = sender(
                base_url,
                session_id,
                prompt,
                AgentPromptOrigin::StartupPreflight,
            );
            let _ = tx.send(AgentResponse { result });
        });
        let pending = PendingResponse {
            receiver: rx,
            exchange_id,
            expected_submission_id: None,
            started_at,
            spinner_frame: 0,
            duplicate_submit_notice: false,
        };
        self.transcript_document.set_pending_text(
            &pending.exchange_id,
            pending_transcript_line(&pending, started_at),
        );
        self.pending_response = Some(pending);
        self.rebuild_transcript_cache();
        self.jump_to_tail();
    }

    fn insert_newline_after_backslash(&mut self) -> bool {
        let Some(previous) = previous_char_boundary(&self.prompt, self.prompt_cursor) else {
            return false;
        };
        if &self.prompt[previous..self.prompt_cursor] != "\\" {
            return false;
        }

        let trailing_backslashes = self.prompt[..self.prompt_cursor]
            .chars()
            .rev()
            .take_while(|ch| *ch == '\\')
            .count();
        if trailing_backslashes % 2 == 0 {
            return false;
        }

        self.prompt
            .replace_range(previous..self.prompt_cursor, "\n");
        self.prompt_cursor = previous + 1;
        self.prompt_vertical_column = None;
        self.prompt_selection = None;
        self.prompt_follow_cursor = true;
        self.reset_command_palette();
        true
    }

    fn reset_command_palette(&mut self) {
        self.command_palette_selected = 0;
        self.command_palette_dismissed = false;
    }

    fn select_command(&mut self) -> bool {
        let Some(command) = self.selected_command() else {
            return false;
        };
        self.prompt = command.insertion.to_string();
        self.prompt_cursor = self.prompt.len();
        self.prompt_vertical_column = None;
        self.prompt_selection = None;
        self.prompt_follow_cursor = true;
        self.command_palette_selected = 0;
        self.command_palette_dismissed = true;
        true
    }

    fn cancel_or_quit(&mut self) {
        if self.command_palette_open() {
            self.command_palette_dismissed = true;
        } else if self.prompt_selection.take().is_some() {
            self.prompt_follow_cursor = true;
        } else if self.transcript_selection.is_some() {
            self.transcript_selection = None;
        } else {
            self.should_quit = true;
        }
    }

    fn navigate_up(&mut self) {
        if self.command_palette_open() {
            self.command_palette_selected = self.command_palette_selected.saturating_sub(1);
        } else if self.prompt.is_empty() {
            self.scroll_lines_up(1);
        } else {
            self.move_prompt_vertical(-1);
        }
    }

    fn navigate_down(&mut self) {
        if self.command_palette_open() {
            let max_selected = self.command_palette_items().len().saturating_sub(1);
            self.command_palette_selected = self
                .command_palette_selected
                .saturating_add(1)
                .min(max_selected);
        } else if self.prompt.is_empty() {
            self.scroll_lines_down(1);
        } else {
            self.move_prompt_vertical(1);
        }
    }

    fn move_prompt_vertical(&mut self, direction: isize) {
        let rows = wrap_words(&self.prompt, self.prompt_viewport_width);
        if rows.len() < 2 {
            return;
        }

        let cursor_char = self.prompt_cursor_chars();
        let current_row = prompt_row_index(&rows, cursor_char);
        let target_row = current_row
            .saturating_add_signed(direction)
            .min(rows.len().saturating_sub(1));
        if target_row == current_row {
            return;
        }

        let current = &rows[current_row];
        let preferred_column = *self.prompt_vertical_column.get_or_insert_with(|| {
            display_width_between(&self.prompt, current.start_char, cursor_char)
                .min(display_width(&current.text))
        });
        let target = &rows[target_row];
        let target_end = target.start_char + target.text.chars().count();
        let target_char = char_index_at_display_column(
            &self.prompt,
            target.start_char,
            target_end,
            preferred_column,
        );
        self.prompt_cursor = byte_index_at_char(&self.prompt, target_char);
        self.prompt_selection = None;
        self.prompt_follow_cursor = true;
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
                let help = TUI_COMMANDS
                    .iter()
                    .map(|item| format!("{} - {}", item.usage, item.description))
                    .collect::<Vec<_>>()
                    .join("\n");
                self.push_speaker_text("system", &help);
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
        self.switch_session_with_announcement(session_id, true);
    }

    fn switch_session_with_announcement(&mut self, session_id: String, announce: bool) {
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
        self.session_title = None;
        self.history_before = None;
        self.history_has_older = false;
        self.stream_start_offset = "-1".to_string();
        self.last_stream_event = None;
        self.legacy_submission_id = None;
        if had_stream {
            self.stream_status = StreamStatus::Connecting;
            self.start_stream();
        } else {
            self.stream_status = StreamStatus::NotAttached;
        }
        if announce {
            self.push_speaker_text("system", &format!("active session {}", self.session_id));
        }
    }

    fn handle_command_session_switch(&mut self, reply: &AgentReply) -> bool {
        let Some(command) = reply.command_name.as_deref() else {
            return false;
        };
        if !matches!(command, "new" | "clear" | "resume") {
            return false;
        }
        let Some(session_id) = reply
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|session_id| !session_id.is_empty())
        else {
            return false;
        };
        if session_id == self.session_id {
            return false;
        }

        let had_stream = self.stream_handle.take().is_some_and(|handle| {
            handle.cancel();
            true
        });
        self.session_id = session_id.to_string();
        self.session_title = clean_session_title(reply.session_title.clone());
        self.history_before = None;
        self.history_has_older = false;
        self.stream_start_offset = if command == "resume" {
            "-1".to_string()
        } else {
            "now".to_string()
        };
        self.last_stream_event = None;
        self.legacy_submission_id = None;
        self.stream_status = StreamStatus::NotAttached;
        self.transcript_document = TranscriptDocument::default();
        self.transcript_selection = None;
        self.transcript_scroll = 0;
        self.follow_tail = true;
        self.rebuild_transcript_cache();

        if command == "resume" {
            self.pending_session_switch_notice = Some(reply.text.trim().to_string());
            self.pending_session_switch_attach_stream = had_stream;
            self.agent_status = "loading history".to_string();
            diagnostics::history_load_started();
            self.start_history_request(None, HistoryRequestKind::SessionSwitch);
        } else {
            if had_stream {
                self.start_stream();
            }
            self.push_speaker_text("system", reply.text.trim());
            self.agent_status = "ready".to_string();
        }
        true
    }

    fn complete_session_lifecycle(
        &mut self,
        reply: SessionLifecycleReply,
        requested_session_id: Option<&str>,
    ) -> Result<(), String> {
        let session_id = reply.id.trim();
        if session_id.is_empty() {
            return Err("Gateway returned an empty TUI session id.".to_string());
        }

        match self.startup_phase {
            StartupPhase::CreatingSession => {
                if !reply.created {
                    return Err("Gateway did not create a fresh TUI session.".to_string());
                }
                self.complete_fresh_startup(
                    session_id,
                    reply.title,
                    format!("created fresh TUI session {session_id}"),
                );
                diagnostics::session_lifecycle_completed("fresh", None, session_id);
            }
            StartupPhase::ResumingSession => {
                let requested_session_selector = requested_session_id
                    .map(str::trim)
                    .filter(|requested| !requested.is_empty())
                    .ok_or_else(|| "A session id is required for explicit resume.".to_string())?;
                if reply.created {
                    self.complete_fresh_startup(
                        session_id,
                        reply.title,
                        format!(
                            "session {requested_session_selector} was not found; created fresh TUI session {session_id}"
                        ),
                    );
                    diagnostics::session_lifecycle_completed(
                        "fresh_fallback",
                        Some(requested_session_selector),
                        session_id,
                    );
                    return Ok(());
                }

                self.switch_session_with_announcement(session_id.to_string(), false);
                self.session_title = clean_session_title(reply.title);
                self.push_speaker_text("preflight", &format!("resumed TUI session {session_id}"));
                self.start_history_load();
                diagnostics::session_lifecycle_completed(
                    if requested_session_selector == session_id {
                        "id_resolved"
                    } else {
                        "name_resolved"
                    },
                    Some(requested_session_selector),
                    session_id,
                );
            }
            _ => return Err("Session lifecycle completed outside startup.".to_string()),
        }

        Ok(())
    }

    fn complete_fresh_startup(
        &mut self,
        session_id: &str,
        session_title: Option<String>,
        announcement: String,
    ) {
        self.switch_session_with_announcement(session_id.to_string(), false);
        self.session_title = clean_session_title(session_title);
        self.stream_start_offset = "now".to_string();
        self.push_speaker_text("preflight", &announcement);
        self.attach_startup_stream();
        self.push_speaker_text("preflight", "all systems go");
        self.startup_phase = StartupPhase::Greeting;
        self.submit_internal_prompt(self.startup_greeting_prompt());
    }

    fn attach_startup_stream(&mut self) {
        if self.startup_attach_stream {
            diagnostics::stream_attach_started(if self.stream_start_offset == "now" {
                "fresh_tail"
            } else {
                "snapshot_tail"
            });
            self.start_stream();
            self.push_speaker_text("preflight", "event stream attached");
        } else {
            self.push_speaker_text("preflight", "event stream attach deferred");
        }
    }

    fn continue_startup_after_agent_reply(&mut self, _reply: &AgentReply) {
        if self.startup_phase == StartupPhase::Greeting {
            self.startup_phase = StartupPhase::Complete;
        }
    }

    fn start_history_load(&mut self) {
        self.startup_phase = StartupPhase::LoadingHistory;
        self.agent_status = "loading history".to_string();
        diagnostics::history_load_started();
        self.start_history_request(None, HistoryRequestKind::Startup);
    }

    fn request_older_history_page(&mut self) {
        if self.startup_phase != StartupPhase::Complete
            || self.pending_history.is_some()
            || !self.history_has_older
        {
            return;
        }
        let Some(before) = self.history_before.clone() else {
            return;
        };
        self.start_history_request(Some(before), HistoryRequestKind::Older);
    }

    fn start_history_request(&mut self, before: Option<String>, kind: HistoryRequestKind) {
        let base_url = self.base_url.clone();
        let session_id = self.session_id.clone();
        let loader = Arc::clone(&self.history_loader);
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let result = loader(base_url, session_id, 50, before);
            let _ = tx.send(HistoryResponse { result });
        });
        self.pending_history = Some(PendingHistory {
            receiver: rx,
            started_at: Instant::now(),
            kind,
        });
    }

    fn fail_startup(&mut self) {
        if matches!(
            self.startup_phase,
            StartupPhase::CreatingSession
                | StartupPhase::ResumingSession
                | StartupPhase::LoadingHistory
                | StartupPhase::Greeting
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
        self.transcript_document.push_notice(speaker, text);
        self.rebuild_transcript_cache();
    }

    fn rebuild_transcript_cache(&mut self) {
        let lines = self.transcript_document.lines();
        self.transcript_lines = lines.iter().map(|line| line.text.clone()).collect();
        self.transcript_line_ids = lines.iter().map(|line| line.id.clone()).collect();
        self.transcript_line_kinds = lines
            .iter()
            .map(|line| transcript_row_kind_from_document(line.kind))
            .collect();
        self.transcript_line_streaming = lines.iter().map(|line| line.is_streaming).collect();
        self.rebuild_transcript_render_cache();
    }

    fn rebuild_transcript_render_cache(&mut self) {
        self.transcript_render_cache = wrap_transcript_rows(
            &self.transcript_lines,
            &self.transcript_line_ids,
            &self.transcript_line_kinds,
            &self.transcript_line_streaming,
            self.transcript_viewport_width,
        );
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
        self.transcript_document
            .set_pending_text(&pending.exchange_id, pending_transcript_line(pending, now));
        self.rebuild_transcript_cache();
    }

    fn correlate_stream_events(&mut self, events: Vec<FlueEvent>) -> Vec<FlueEvent> {
        let mut correlated = Vec::with_capacity(events.len());
        for mut event in events {
            let mut submission_id = event_submission_id(&event).map(str::to_string);
            if submission_id.is_none() {
                let pending_submission = self.pending_response.as_ref().map(|pending| {
                    pending
                        .expected_submission_id
                        .clone()
                        .unwrap_or_else(|| pending.exchange_id.clone())
                });
                let fallback = pending_submission.unwrap_or_else(|| {
                    if event.event_type == "turn_start" || self.legacy_submission_id.is_none() {
                        self.legacy_submission_sequence =
                            self.legacy_submission_sequence.saturating_add(1);
                        self.legacy_submission_id =
                            Some(format!("legacy:{}", self.legacy_submission_sequence));
                    }
                    self.legacy_submission_id
                        .clone()
                        .expect("legacy submission id is initialized")
                });
                if self.pending_response.is_some() {
                    self.legacy_submission_id = Some(fallback.clone());
                }
                event.value["submissionId"] = serde_json::Value::String(fallback.clone());
                submission_id = Some(fallback);
            }

            let submission_id =
                submission_id.expect("stream events always have a correlated submission");
            let should_bind_pending = self.pending_response.as_ref().is_some_and(|pending| {
                pending.expected_submission_id.is_none()
                    && pending.exchange_id != submission_id
                    && !self.transcript_document.contains_submission(&submission_id)
                    && is_submission_boundary_event(&event)
            });
            if should_bind_pending {
                let pending_exchange_id = self
                    .pending_response
                    .as_ref()
                    .map(|pending| pending.exchange_id.clone())
                    .expect("pending response exists");
                if let Some(exchange_id) = self
                    .transcript_document
                    .bind_exchange(&pending_exchange_id, &submission_id)
                {
                    if let Some(pending) = &mut self.pending_response {
                        pending.exchange_id = exchange_id;
                        pending.expected_submission_id = Some(submission_id.clone());
                    }
                }
            }
            correlated.push(event);
        }
        correlated
    }

    fn shift_transcript_selection_lines(&mut self, inserted_lines: usize) {
        if inserted_lines == 0 {
            return;
        }
        let Some(selection) = &mut self.transcript_selection else {
            return;
        };
        selection.origin.start.line = selection.origin.start.line.saturating_add(inserted_lines);
        selection.origin.end.line = selection.origin.end.line.saturating_add(inserted_lines);
        selection.active.start.line = selection.active.start.line.saturating_add(inserted_lines);
        selection.active.end.line = selection.active.end.line.saturating_add(inserted_lines);
    }

    fn clear_pending_exchange_display(&mut self, exchange_id: &str) {
        self.transcript_document.clear_pending_text(exchange_id);
        self.rebuild_transcript_cache();
    }

    fn settle_pending_error(&mut self, exchange_id: &str, text: &str) {
        self.clear_pending_exchange_display(exchange_id);
        self.push_speaker_text("error", text);
        if self.follow_tail {
            self.jump_to_tail();
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

fn wrap_transcript_rows(
    lines: &[String],
    line_ids: &[String],
    line_kinds: &[TranscriptRowKind],
    line_streaming: &[bool],
    width: usize,
) -> Vec<RenderedTranscriptRow> {
    let mut wrapped = Vec::new();
    let mut previous_kind = TranscriptRowKind::Other;
    let mut line_index = 0;
    let mut source_line = 0;

    while line_index < lines.len() {
        let line = &lines[line_index];
        let kind = line_kinds
            .get(line_index)
            .copied()
            .unwrap_or_else(|| transcript_row_kind(line, previous_kind));
        if kind != TranscriptRowKind::Other {
            previous_kind = kind;
        }

        if kind == TranscriptRowKind::Assistant && line.starts_with("assistant:") {
            let block_end = assistant_block_end(lines, line_index);
            let markdown = assistant_markdown_block(lines, line_index, block_end);
            let is_streaming = line_streaming
                .get(line_index..block_end)
                .is_some_and(|streaming| streaming.iter().any(|streaming| *streaming));
            let prefix = TranscriptRowKind::Assistant
                .prefix()
                .expect("assistant rows have a prefix");
            let first_width = width.saturating_sub(display_width(prefix) + 1).max(1);
            let markdown_rows = render_markdown(&markdown, first_width, width);
            let source_line_count = markdown_rows
                .iter()
                .map(|row| row.source_line)
                .max()
                .unwrap_or_default()
                + 1;
            for (markdown_index, markdown_row) in markdown_rows.into_iter().enumerate() {
                let source_id = source_line + markdown_row.source_line;
                let stable_source_id = line_ids
                    .get(line_index + markdown_row.source_line)
                    .cloned()
                    .unwrap_or_else(|| format!("source:{source_id}"));
                let prefix_offset = if markdown_row.source_line == 0 {
                    prefix.chars().count() + 1
                } else {
                    0
                };
                let source_text = if markdown_row.source_line == 0 {
                    format!("{prefix} {}", markdown_row.source_text)
                } else {
                    markdown_row.source_text.clone()
                };
                let source_start = if markdown_index == 0 {
                    0
                } else {
                    prefix_offset + markdown_row.start_char
                };
                let source_end = prefix_offset + markdown_row.end_char;
                if markdown_index == 0 {
                    let mut spans = Vec::with_capacity(markdown_row.spans.len() + 1);
                    spans.push(Span::raw(" "));
                    spans.extend(markdown_row.spans);
                    wrapped.push(RenderedTranscriptRow {
                        text: format!("{prefix} {}", markdown_row.text),
                        kind,
                        is_streaming,
                        styled_spans: Some(spans),
                        selection_range: None,
                        source: Some(TranscriptSourceSpan {
                            id: stable_source_id,
                            line: source_id,
                            text: source_text,
                            start_char: source_start,
                            end_char: source_end,
                        }),
                    });
                } else {
                    wrapped.push(RenderedTranscriptRow {
                        text: markdown_row.text,
                        kind,
                        is_streaming,
                        styled_spans: Some(markdown_row.spans),
                        selection_range: None,
                        source: Some(TranscriptSourceSpan {
                            id: stable_source_id,
                            line: source_id,
                            text: source_text,
                            start_char: source_start,
                            end_char: source_end,
                        }),
                    });
                }
            }
            source_line += source_line_count;
            line_index = block_end;
            continue;
        }

        let is_streaming = line_streaming.get(line_index).copied().unwrap_or(false);
        let stable_source_id = line_ids
            .get(line_index)
            .cloned()
            .unwrap_or_else(|| format!("source:{source_line}"));
        wrapped.extend(wrap_words(line, width).into_iter().map(|row| {
            let visible_char_count = row.text.chars().count();
            RenderedTranscriptRow {
                text: row.text,
                kind,
                is_streaming,
                styled_spans: None,
                selection_range: None,
                source: Some(TranscriptSourceSpan {
                    id: stable_source_id.clone(),
                    line: source_line,
                    text: line.clone(),
                    start_char: row.start_char,
                    end_char: row.start_char + visible_char_count,
                }),
            }
        }));
        source_line += 1;
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

fn transcript_row_kind_from_document(kind: TranscriptLineKind) -> TranscriptRowKind {
    match kind {
        TranscriptLineKind::User => TranscriptRowKind::User,
        TranscriptLineKind::Assistant => TranscriptRowKind::Assistant,
        TranscriptLineKind::Thinking => TranscriptRowKind::Thinking,
        TranscriptLineKind::Tool => TranscriptRowKind::Tool,
        TranscriptLineKind::Task => TranscriptRowKind::Task,
        TranscriptLineKind::Operation => TranscriptRowKind::Operation,
        TranscriptLineKind::Log => TranscriptRowKind::Log,
        TranscriptLineKind::Error => TranscriptRowKind::Error,
        TranscriptLineKind::System => TranscriptRowKind::System,
        TranscriptLineKind::Preflight => TranscriptRowKind::Preflight,
        TranscriptLineKind::Other => TranscriptRowKind::Other,
    }
}

fn event_submission_id(event: &FlueEvent) -> Option<&str> {
    event
        .value
        .get("submissionId")
        .and_then(serde_json::Value::as_str)
}

fn is_submission_boundary_event(event: &FlueEvent) -> bool {
    !event.is_nested()
        && matches!(
            event.event_type.as_str(),
            "operation_start"
                | "turn_start"
                | "thinking_start"
                | "thinking_delta"
                | "text_delta"
                | "message_end"
                | "tool_start"
                | "task_start"
                | "log"
        )
}

fn is_root_assistant_final(event: &FlueEvent) -> bool {
    event.event_type == "message_end"
        && !event.is_nested()
        && event
            .value
            .pointer("/message/role")
            .and_then(serde_json::Value::as_str)
            == Some("assistant")
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
        submission_id: None,
        stream_offset: None,
        session_id: None,
        session_title: None,
        command_name: None,
        session_created: None,
    }
}

fn previous_char_boundary(value: &str, cursor: usize) -> Option<usize> {
    previous_grapheme_boundary(value, cursor)
}

fn next_char_boundary(value: &str, cursor: usize) -> Option<usize> {
    next_grapheme_boundary(value, cursor)
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

fn prompt_row_index(rows: &[WrappedLine], cursor_char: usize) -> usize {
    rows.iter()
        .enumerate()
        .rev()
        .find(|(_, row)| cursor_char >= row.start_char && cursor_char <= row.end_char)
        .map(|(index, _)| index)
        .unwrap_or_else(|| rows.len().saturating_sub(1))
}

fn char_index_at_display_column(
    value: &str,
    start_char: usize,
    end_char: usize,
    target_column: usize,
) -> usize {
    let slice = value
        .chars()
        .skip(start_char)
        .take(end_char.saturating_sub(start_char))
        .collect::<String>();
    let mut column = 0;
    let mut index = start_char;
    for grapheme in slice.graphemes(true) {
        let next_column = column + UnicodeWidthStr::width(grapheme);
        if next_column > target_column {
            break;
        }
        column = next_column;
        index += grapheme.chars().count();
    }
    index
}

fn transcript_text_cell(
    row: &RenderedTranscriptRow,
    target_column: usize,
) -> Option<TranscriptTextCell> {
    let source = row.source.as_ref()?;
    let mut display_column = 0;
    let mut char_index = 0;
    for grapheme in row.text.graphemes(true) {
        let width = UnicodeWidthStr::width(grapheme);
        let next_column = display_column + width;
        if target_column < next_column || (width == 0 && target_column == display_column) {
            let end_index = char_index + grapheme.chars().count();
            return Some(TranscriptTextCell {
                start: TranscriptTextPosition {
                    line: source.line,
                    char_index: source.start_char + char_index,
                },
                end: TranscriptTextPosition {
                    line: source.line,
                    char_index: source.start_char + end_index,
                },
            });
        }
        display_column = next_column;
        char_index += grapheme.chars().count();
    }

    let end = TranscriptTextPosition {
        line: source.line,
        char_index: source.end_char,
    };
    Some(TranscriptTextCell { start: end, end })
}

fn selection_range_for_row(
    source: Option<&TranscriptSourceSpan>,
    selection: (TranscriptTextPosition, TranscriptTextPosition),
) -> Option<(usize, usize)> {
    let source = source?;
    let row_start = TranscriptTextPosition {
        line: source.line,
        char_index: source.start_char,
    };
    let row_end = TranscriptTextPosition {
        line: source.line,
        char_index: source.end_char,
    };
    let start = selection.0.max(row_start);
    let end = selection.1.min(row_end);
    if start >= end || start.line != source.line || end.line != source.line {
        return None;
    }
    Some((
        start.char_index.saturating_sub(source.start_char),
        end.char_index.saturating_sub(source.start_char),
    ))
}

fn selected_transcript_text(
    rows: &[RenderedTranscriptRow],
    selection: (TranscriptTextPosition, TranscriptTextPosition),
) -> Option<String> {
    if selection.0 >= selection.1 {
        return None;
    }
    let mut sources = BTreeMap::new();
    for source in rows.iter().filter_map(|row| row.source.as_ref()) {
        sources
            .entry(source.line)
            .or_insert_with(|| source.text.clone());
    }

    let mut selected = Vec::new();
    for (&line, text) in sources.range(selection.0.line..=selection.1.line) {
        let char_count = text.chars().count();
        let start = if line == selection.0.line {
            selection.0.char_index.min(char_count)
        } else {
            0
        };
        let end = if line == selection.1.line {
            selection.1.char_index.min(char_count)
        } else {
            char_count
        };
        selected.push(
            text.chars()
                .skip(start)
                .take(end.saturating_sub(start))
                .collect::<String>(),
        );
    }
    (!selected.is_empty()).then(|| selected.join("\n"))
}

fn rect_contains(area: Rect, column: u16, row: u16) -> bool {
    column >= area.x && column < area.right() && row >= area.y && row < area.bottom()
}

fn byte_index_at_char(value: &str, char_index: usize) -> usize {
    value
        .char_indices()
        .nth(char_index)
        .map(|(index, _)| index)
        .unwrap_or(value.len())
}

fn clean_session_title(title: Option<String>) -> Option<String> {
    title.and_then(|title| {
        let title = title.trim();
        (!title.is_empty()).then(|| title.to_string())
    })
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
