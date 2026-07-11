use ratatui::layout::{Constraint, Direction, Layout, Position};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{
    Block, Borders, Paragraph, Scrollbar, ScrollbarOrientation, ScrollbarState, Wrap,
};
use ratatui::Frame;

use crate::app::App;

pub fn render(frame: &mut Frame<'_>, app: &mut App) {
    let [transcript_area, bottom_area] = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(5), Constraint::Length(5)])
        .areas(frame.area());

    app.set_transcript_viewport_size(
        transcript_area.height.saturating_sub(2) as usize,
        transcript_area.width.saturating_sub(2) as usize,
    );
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
        .scroll((app.transcript_scroll().min(u16::MAX as usize) as u16, 0));

    frame.render_widget(paragraph, area);

    let mut scrollbar_state =
        ScrollbarState::new(app.transcript_rendered_row_count()).position(app.transcript_scroll());
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

    let status = Line::from(Span::styled(
        visible_status_text(&app.status_text(), status_area.width as usize),
        Style::default()
            .fg(Color::Green)
            .add_modifier(Modifier::BOLD),
    ));
    frame.render_widget(Paragraph::new(status), status_area);

    let inner_width = prompt_area.width.saturating_sub(2) as usize;
    let prompt_width = inner_width.saturating_sub(2).max(1);
    let cursor_chars = app.prompt_cursor_chars();
    let view_start = cursor_chars.saturating_sub(prompt_width.saturating_sub(1));
    let prompt_text = visible_prompt_text(app.prompt(), view_start, prompt_width);
    let prompt = Paragraph::new(Line::from(vec![
        Span::styled(
            "> ",
            Style::default()
                .fg(Color::Green)
                .add_modifier(Modifier::BOLD),
        ),
        if app.prompt().is_empty() {
            Span::styled(
                "Type a message and press Enter...",
                Style::default().fg(Color::DarkGray),
            )
        } else {
            Span::raw(prompt_text)
        },
    ]))
    .block(Block::default().borders(Borders::ALL).title("Prompt"));

    frame.render_widget(prompt, prompt_area);

    let cursor_offset = cursor_chars.saturating_sub(view_start).min(prompt_width) as u16;
    let cursor_x = prompt_area
        .x
        .saturating_add(1)
        .saturating_add(2)
        .saturating_add(cursor_offset)
        .min(prompt_area.right().saturating_sub(2));
    let cursor_y = prompt_area.y.saturating_add(1);
    frame.set_cursor_position(Position::new(cursor_x, cursor_y));
}

fn visible_prompt_text(prompt: &str, start: usize, width: usize) -> String {
    prompt.chars().skip(start).take(width).collect()
}

fn visible_status_text(status: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }

    let count = status.chars().count();
    if count <= width {
        return status.to_string();
    }

    if width <= 3 {
        return status.chars().take(width).collect();
    }

    let mut visible = status.chars().take(width - 3).collect::<String>();
    visible.push_str("...");
    visible
}
