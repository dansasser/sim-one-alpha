use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::sync::Arc;
use std::thread;

use crate::agent::send_agent_prompt;

pub const SCROLL_PAGE_LINES: usize = 8;
const PLACEHOLDER_CONTEXT_LINES: usize = 24;

pub type AgentSender =
    Arc<dyn Fn(String, String, String) -> Result<String, String> + Send + Sync + 'static>;

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
    pending_response: Option<PendingResponse>,
}

#[derive(Debug)]
struct PendingResponse {
    receiver: Receiver<AgentResponse>,
    transcript_line: usize,
}

#[derive(Debug)]
struct AgentResponse {
    result: Result<String, String>,
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
            pending_response: None,
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

    pub fn is_agent_pending(&self) -> bool {
        self.pending_response.is_some()
    }

    pub fn max_scroll(&self) -> usize {
        self.transcript_lines
            .len()
            .saturating_sub(SCROLL_PAGE_LINES)
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
        if self.pending_response.is_some() {
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
        self.transcript_lines
            .push("assistant: thinking...".to_string());
        self.prompt.clear();
        self.prompt_cursor = 0;
        self.agent_status = "submitted".to_string();
        self.jump_to_tail();

        let base_url = self.base_url.clone();
        let session_id = self.session_id.clone();
        let sender = Arc::clone(&self.agent_sender);
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let result = sender(base_url, session_id, prompt);
            let _ = tx.send(AgentResponse { result });
        });
        self.pending_response = Some(PendingResponse {
            receiver: rx,
            transcript_line,
        });
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
        self.transcript_lines
            .splice(line_index..=line_index, replacement);
    }

    fn after_transcript_changed(&mut self) {
        if self.follow_tail {
            self.jump_to_tail();
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
