pub const SCROLL_PAGE_LINES: usize = 8;
const PLACEHOLDER_CONTEXT_LINES: usize = 42;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppEvent {
    Text(String),
    Backspace,
    Submit,
    ScrollLineUp,
    ScrollLineDown,
    ScrollPageUp,
    ScrollPageDown,
    JumpToTail,
    Quit,
}

#[derive(Debug, Clone)]
pub struct App {
    prompt: String,
    transcript_lines: Vec<String>,
    transcript_scroll: usize,
    follow_tail: bool,
    should_quit: bool,
    session_id: String,
    gateway_status: String,
    agent_status: String,
}

impl App {
    pub fn new() -> Self {
        Self::with_session("primary")
    }

    pub fn new_for_test() -> Self {
        Self::new()
    }

    pub fn with_session(session_id: impl Into<String>) -> Self {
        let mut app = Self {
            prompt: String::new(),
            transcript_lines: placeholder_transcript(),
            transcript_scroll: 0,
            follow_tail: true,
            should_quit: false,
            session_id: session_id.into(),
            gateway_status: "offline placeholder".to_string(),
            agent_status: "static shell".to_string(),
        };
        app.jump_to_tail();
        app
    }

    pub fn handle_event(&mut self, event: AppEvent) {
        match event {
            AppEvent::Text(text) => self.prompt.push_str(&text),
            AppEvent::Backspace => {
                self.prompt.pop();
            }
            AppEvent::Submit => self.submit_prompt(),
            AppEvent::ScrollLineUp => self.scroll_lines_up(1),
            AppEvent::ScrollLineDown => self.scroll_lines_down(1),
            AppEvent::ScrollPageUp => self.scroll_page_up(),
            AppEvent::ScrollPageDown => self.scroll_page_down(),
            AppEvent::JumpToTail => self.jump_to_tail(),
            AppEvent::Quit => self.should_quit = true,
        }
    }

    pub fn prompt(&self) -> &str {
        &self.prompt
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

    pub fn agent_status(&self) -> &str {
        &self.agent_status
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
        let prompt = self.prompt.trim();
        if prompt.is_empty() {
            self.prompt.clear();
            return;
        }

        self.transcript_lines.push(String::new());
        self.transcript_lines.push(format!("you: {prompt}"));
        self.transcript_lines.push(
            "assistant: Placeholder response from the static Ratatui shell. Gateway wiring begins in Phase 2."
                .to_string(),
        );
        self.prompt.clear();
        self.jump_to_tail();
    }
}

impl Default for App {
    fn default() -> Self {
        Self::new()
    }
}

fn placeholder_transcript() -> Vec<String> {
    let mut lines = vec![
        "system: SIM-ONE Alpha Ratatui TUI static shell".to_string(),
        "assistant: This Phase 1 shell proves the terminal layout, prompt state, scroll state, and clean exit path before gateway wiring.".to_string(),
        "assistant: The top pane is the transcript/context viewport. The bottom pane is status plus prompt input.".to_string(),
        String::new(),
    ];

    for index in 1..=PLACEHOLDER_CONTEXT_LINES {
        lines.push(format!(
            "context {index:02}: scroll test row; prompt input remains active."
        ));
    }

    lines.push(String::new());
    lines.push("assistant: End jumps back to live tail. PgUp/PgDown scroll this transcript without stealing prompt input.".to_string());
    lines
}
