use ratatui::layout::{Constraint, Direction, Layout, Margin, Position};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{
    Block, Borders, Paragraph, Scrollbar, ScrollbarOrientation, ScrollbarState,
};
use ratatui::Frame;

use crate::app::{App, RenderedTranscriptRow, TranscriptRowKind};
use crate::text_wrap::{
    display_width, display_width_between, pad_to_width, wrap_words, WrappedLine,
};
use crate::theme::{
    live_assistant_body_style, live_assistant_prefix_style, prompt_editor_style, thinking_style,
    transcript_prefix_style, user_prompt_style,
};

const PROMPT_GUTTER_WIDTH: usize = 2;
const PROMPT_MIN_VISIBLE_ROWS: usize = 2;
const PROMPT_MAX_VISIBLE_ROWS: usize = 5;
const TRANSCRIPT_LEFT_MARGIN_WIDTH: usize = 2;

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

    let transcript_inner_width = transcript_area.width.saturating_sub(2) as usize;
    app.set_transcript_viewport_size(
        transcript_area.height.saturating_sub(2) as usize,
        transcript_content_width(transcript_inner_width),
    );
    render_transcript(frame, app, transcript_area);
    render_bottom(frame, app, bottom_area);
}

fn render_transcript(frame: &mut Frame<'_>, app: &mut App, area: ratatui::layout::Rect) {
    let rendered_rows = app.transcript_rendered_rows();
    let visible_height = area.height.saturating_sub(2) as usize;
    let visible_width = area.width.saturating_sub(2) as usize;
    let max_scroll = app.sync_transcript_scroll_for_render(rendered_rows.len());
    let start = app.transcript_scroll().min(rendered_rows.len());
    let lines = rendered_rows
        .into_iter()
        .skip(start)
        .take(visible_height)
        .map(|row| rendered_transcript_line(row, visible_width))
        .collect::<Vec<_>>();
    let title = if app.follow_tail() {
        "Transcript - live tail"
    } else {
        "Transcript - scrolled back"
    };

    let paragraph = Paragraph::new(Text::from(lines))
        .block(Block::default().borders(Borders::ALL).title(title));

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

fn rendered_transcript_line(row: RenderedTranscriptRow, visible_width: usize) -> Line<'static> {
    let margin_width = transcript_left_margin_width(visible_width);
    let margin = " ".repeat(margin_width);
    if row.kind == TranscriptRowKind::User {
        let content_width = visible_width.saturating_sub(margin_width);
        return Line::styled(
            format!("{margin}{}", pad_to_width(&row.text, content_width)),
            user_prompt_style(),
        );
    }

    let body_style = if row.kind == TranscriptRowKind::Assistant && row.is_streaming {
        live_assistant_body_style()
    } else if row.kind == TranscriptRowKind::Thinking {
        thinking_style()
    } else {
        Style::default()
    };
    let Some(prefix) = row.kind.prefix() else {
        return Line::from(vec![Span::raw(margin), Span::styled(row.text, body_style)]);
    };
    let Some(body) = row.text.strip_prefix(prefix) else {
        return Line::from(vec![Span::raw(margin), Span::styled(row.text, body_style)]);
    };
    let prefix_style = if row.kind == TranscriptRowKind::Assistant && row.is_streaming {
        Some(live_assistant_prefix_style())
    } else {
        transcript_prefix_style(row.kind)
    };
    let Some(prefix_style) = prefix_style else {
        return Line::from(vec![Span::raw(margin), Span::styled(row.text, body_style)]);
    };

    Line::from(vec![
        Span::raw(margin),
        Span::styled(prefix.to_string(), prefix_style),
        Span::styled(body.to_string(), body_style),
    ])
}

fn transcript_left_margin_width(visible_width: usize) -> usize {
    TRANSCRIPT_LEFT_MARGIN_WIDTH.min(visible_width.saturating_sub(1))
}

fn transcript_content_width(visible_width: usize) -> usize {
    visible_width
        .saturating_sub(transcript_left_margin_width(visible_width))
        .max(1)
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
    let cursor = prompt_cursor_position(&prompt_rows, app.prompt(), cursor_chars, prompt_width);
    let view_start = prompt_view_start(cursor.row, prompt_rows.len(), visible_rows);
    let prompt_lines = visible_prompt_lines(
        app.prompt(),
        &prompt_rows,
        view_start,
        visible_rows,
        prompt_width,
    );
    let prompt =
        Paragraph::new(prompt_lines).block(Block::default().borders(Borders::ALL).title("Prompt"));

    frame.render_widget(prompt, prompt_area);
    frame
        .buffer_mut()
        .set_style(prompt_area.inner(Margin::new(1, 1)), prompt_editor_style());

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

fn wrap_prompt_rows(prompt: &str, width: usize) -> Vec<WrappedLine> {
    wrap_words(prompt, width)
}

fn prompt_cursor_position(
    rows: &[WrappedLine],
    prompt: &str,
    cursor_chars: usize,
    width: usize,
) -> PromptCursorPosition {
    for (row_index, row) in rows.iter().enumerate().rev() {
        if cursor_chars >= row.start_char && cursor_chars <= row.end_char {
            let col = display_width_between(prompt, row.start_char, cursor_chars)
                .min(display_width(&row.text))
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
            .map(|row| display_width(&row.text).min(width))
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
    rows: &[WrappedLine],
    start: usize,
    visible_rows: usize,
    prompt_width: usize,
) -> Vec<Line<'static>> {
    let mut lines = if prompt.is_empty() {
        vec![styled_prompt_line(
            vec![
                prompt_gutter(0),
                Span::styled(
                    "Type a message and press Enter...",
                    Style::default().fg(Color::DarkGray),
                ),
            ],
            display_width("Type a message and press Enter..."),
            prompt_width,
        )]
    } else {
        rows.iter()
            .enumerate()
            .skip(start)
            .take(visible_rows)
            .map(|(index, row)| {
                styled_prompt_line(
                    vec![prompt_gutter(index), Span::raw(row.text.clone())],
                    display_width(&row.text),
                    prompt_width,
                )
            })
            .collect()
    };

    while lines.len() < visible_rows {
        lines.push(Line::styled(
            " ".repeat(PROMPT_GUTTER_WIDTH + prompt_width),
            prompt_editor_style(),
        ));
    }
    lines
}

fn styled_prompt_line(
    mut spans: Vec<Span<'static>>,
    text_width: usize,
    prompt_width: usize,
) -> Line<'static> {
    spans.push(Span::raw(
        " ".repeat(prompt_width.saturating_sub(text_width)),
    ));
    Line::from(spans).style(prompt_editor_style())
}

fn prompt_gutter(row_index: usize) -> Span<'static> {
    Span::styled(
        if row_index == 0 { "> " } else { "  " },
        Style::default()
            .fg(Color::Green)
            .add_modifier(Modifier::BOLD),
    )
}
