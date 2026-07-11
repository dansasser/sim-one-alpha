use ratatui::layout::{Constraint, Direction, Layout, Position};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{
    Block, Borders, Paragraph, Scrollbar, ScrollbarOrientation, ScrollbarState,
};
use ratatui::Frame;

use crate::app::App;

const PROMPT_GUTTER_WIDTH: usize = 2;
const PROMPT_MIN_VISIBLE_ROWS: usize = 2;
const PROMPT_MAX_VISIBLE_ROWS: usize = 5;

#[derive(Debug, Clone)]
struct PromptRow {
    text: String,
    start_char: usize,
    end_char: usize,
}

#[derive(Debug, Clone, Copy)]
struct PromptCursorPosition {
    row: usize,
    col: usize,
}

pub fn render(frame: &mut Frame<'_>, app: &mut App) {
    let bottom_height = bottom_panel_height(app, frame.area().width as usize, frame.area().height);
    let [transcript_area, bottom_area] = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(5), Constraint::Length(bottom_height)])
        .areas(frame.area());

    app.set_transcript_viewport_size(
        transcript_area.height.saturating_sub(2) as usize,
        transcript_area.width.saturating_sub(2) as usize,
    );
    render_transcript(frame, app, transcript_area);
    render_bottom(frame, app, bottom_area);
}

fn render_transcript(frame: &mut Frame<'_>, app: &mut App, area: ratatui::layout::Rect) {
    let rendered_lines = app.transcript_rendered_lines();
    let visible_height = area.height.saturating_sub(2) as usize;
    let max_scroll = app.sync_transcript_scroll_for_render(rendered_lines.len());
    let start = app.transcript_scroll().min(rendered_lines.len());
    let text = rendered_lines
        .into_iter()
        .skip(start)
        .take(visible_height)
        .collect::<Vec<_>>()
        .join("\n");
    let title = if app.follow_tail() {
        "Transcript - live tail"
    } else {
        "Transcript - scrolled back"
    };

    let paragraph = Paragraph::new(text).block(Block::default().borders(Borders::ALL).title(title));

    frame.render_widget(paragraph, area);

    let scroll_positions = max_scroll.saturating_add(1);
    let mut scrollbar_state = ScrollbarState::new(scroll_positions)
        .position(app.transcript_scroll())
        .viewport_content_length(visible_height.max(1));
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

    render_prompt(frame, app, prompt_area);
}

fn render_prompt(frame: &mut Frame<'_>, app: &App, prompt_area: ratatui::layout::Rect) {
    let prompt_width = prompt_text_width(prompt_area.width as usize);
    let visible_rows = prompt_area.height.saturating_sub(2).max(1) as usize;
    let prompt_rows = wrap_prompt_rows(app.prompt(), prompt_width);
    let cursor_chars = app.prompt_cursor_chars();
    let cursor = prompt_cursor_position(&prompt_rows, cursor_chars, prompt_width);
    let view_start = prompt_view_start(cursor.row, prompt_rows.len(), visible_rows);
    let prompt_lines = visible_prompt_lines(app.prompt(), &prompt_rows, view_start, visible_rows);
    let prompt =
        Paragraph::new(prompt_lines).block(Block::default().borders(Borders::ALL).title("Prompt"));

    frame.render_widget(prompt, prompt_area);

    let cursor_offset = cursor.col.min(prompt_width) as u16;
    let cursor_row = cursor.row.saturating_sub(view_start).min(visible_rows - 1) as u16;
    let cursor_x = prompt_area
        .x
        .saturating_add(1)
        .saturating_add(PROMPT_GUTTER_WIDTH as u16)
        .saturating_add(cursor_offset)
        .min(prompt_area.right().saturating_sub(2));
    let cursor_y = prompt_area
        .y
        .saturating_add(1)
        .saturating_add(cursor_row)
        .min(prompt_area.bottom().saturating_sub(2));
    frame.set_cursor_position(Position::new(cursor_x, cursor_y));
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

fn bottom_panel_height(app: &App, width: usize, frame_height: u16) -> u16 {
    let prompt_rows = wrap_prompt_rows(app.prompt(), prompt_text_width(width)).len();
    let visible_prompt_rows = prompt_rows.clamp(PROMPT_MIN_VISIBLE_ROWS, PROMPT_MAX_VISIBLE_ROWS);
    let desired = 1 + visible_prompt_rows + 2;
    let max_bottom = (frame_height as usize)
        .saturating_sub(5)
        .max(1 + PROMPT_MIN_VISIBLE_ROWS + 2);
    desired.min(max_bottom).max(4) as u16
}

fn prompt_text_width(area_width: usize) -> usize {
    area_width
        .saturating_sub(2)
        .saturating_sub(PROMPT_GUTTER_WIDTH)
        .max(1)
}

fn wrap_prompt_rows(prompt: &str, width: usize) -> Vec<PromptRow> {
    let width = width.max(1);
    let mut rows = Vec::new();
    let mut row = String::new();
    let mut row_len = 0;
    let mut start_char = 0;
    let mut total_chars = 0;

    for (index, ch) in prompt.chars().enumerate() {
        total_chars = index + 1;
        if ch == '\n' {
            rows.push(PromptRow {
                text: std::mem::take(&mut row),
                start_char,
                end_char: index,
            });
            row_len = 0;
            start_char = index + 1;
            continue;
        }

        row.push(ch);
        row_len += 1;
        if row_len == width {
            rows.push(PromptRow {
                text: std::mem::take(&mut row),
                start_char,
                end_char: index + 1,
            });
            row_len = 0;
            start_char = index + 1;
        }
    }

    if rows.is_empty() || !row.is_empty() || start_char == total_chars {
        rows.push(PromptRow {
            text: row,
            start_char,
            end_char: total_chars,
        });
    }

    rows
}

fn prompt_cursor_position(
    rows: &[PromptRow],
    cursor_chars: usize,
    width: usize,
) -> PromptCursorPosition {
    for (row_index, row) in rows.iter().enumerate().rev() {
        if cursor_chars >= row.start_char && cursor_chars <= row.end_char {
            let col = cursor_chars
                .saturating_sub(row.start_char)
                .min(row.text.chars().count())
                .min(width);
            return PromptCursorPosition {
                row: row_index,
                col,
            };
        }
    }

    let last_row = rows.len().saturating_sub(1);
    PromptCursorPosition {
        row: last_row,
        col: rows
            .get(last_row)
            .map(|row| row.text.chars().count().min(width))
            .unwrap_or_default(),
    }
}

fn prompt_view_start(cursor_row: usize, row_count: usize, visible_rows: usize) -> usize {
    if row_count <= visible_rows {
        return 0;
    }

    let max_start = row_count - visible_rows;
    cursor_row
        .saturating_sub(visible_rows.saturating_sub(1))
        .min(max_start)
}

fn visible_prompt_lines(
    prompt: &str,
    rows: &[PromptRow],
    start: usize,
    visible_rows: usize,
) -> Vec<Line<'static>> {
    if prompt.is_empty() {
        return vec![Line::from(vec![
            prompt_gutter(0),
            Span::styled(
                "Type a message and press Enter...",
                Style::default().fg(Color::DarkGray),
            ),
        ])];
    }

    rows.iter()
        .enumerate()
        .skip(start)
        .take(visible_rows)
        .map(|(index, row)| Line::from(vec![prompt_gutter(index), Span::raw(row.text.clone())]))
        .collect()
}

fn prompt_gutter(row_index: usize) -> Span<'static> {
    Span::styled(
        if row_index == 0 { "> " } else { "  " },
        Style::default()
            .fg(Color::Green)
            .add_modifier(Modifier::BOLD),
    )
}
