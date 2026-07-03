use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{
    Block, Borders, Paragraph, Scrollbar, ScrollbarOrientation, ScrollbarState, Wrap,
};
use ratatui::Frame;

use crate::app::App;

pub fn render(frame: &mut Frame<'_>, app: &App) {
    let [transcript_area, bottom_area] = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(5), Constraint::Length(5)])
        .areas(frame.area());

    render_transcript(frame, app, transcript_area);
    render_bottom(frame, app, bottom_area);
}

fn render_transcript(frame: &mut Frame<'_>, app: &App, area: ratatui::layout::Rect) {
    let text = app.transcript_lines().join("\n");
    let title = if app.follow_tail() {
        "Transcript - live tail"
    } else {
        "Transcript - scrolled back"
    };

    let paragraph = Paragraph::new(text)
        .block(Block::default().borders(Borders::ALL).title(title))
        .wrap(Wrap { trim: false })
        .scroll((app.transcript_scroll() as u16, 0));

    frame.render_widget(paragraph, area);

    let mut scrollbar_state =
        ScrollbarState::new(app.transcript_lines().len()).position(app.transcript_scroll());
    frame.render_stateful_widget(
        Scrollbar::new(ScrollbarOrientation::VerticalRight),
        area,
        &mut scrollbar_state,
    );
}

fn render_bottom(frame: &mut Frame<'_>, app: &App, area: ratatui::layout::Rect) {
    let [status_area, prompt_area] = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(1), Constraint::Min(3)])
        .areas(area);

    let status = Line::from(vec![
        Span::styled(
            "SIM-ONE Alpha",
            Style::default()
                .fg(Color::Green)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw("  "),
        Span::raw(format!("session: {}", app.session_id())),
        Span::raw("  "),
        Span::raw(format!("gateway: {}", app.gateway_status())),
        Span::raw("  "),
        Span::raw(format!("agent: {}", app.agent_status())),
        Span::raw("  "),
        Span::raw(format!("messages: {}", app.transcript_lines().len())),
    ]);
    frame.render_widget(Paragraph::new(status), status_area);

    let prompt_text = if app.prompt().is_empty() {
        "Type a message and press Enter..."
    } else {
        app.prompt()
    };
    let prompt = Paragraph::new(Line::from(vec![
        Span::styled(
            "> ",
            Style::default()
                .fg(Color::Green)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(prompt_text),
    ]))
    .block(Block::default().borders(Borders::ALL).title("Prompt"));

    frame.render_widget(prompt, prompt_area);
}
