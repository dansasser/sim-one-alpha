use ratatui::layout::{Constraint, Direction, Layout, Margin, Position, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{
    Block, Borders, Clear, Paragraph, Scrollbar, ScrollbarOrientation, ScrollbarState,
};
use ratatui::Frame;

use crate::app::{
    App, CommandPaletteMouseRegion, MouseRegions, PromptMouseRegion, RenderedTranscriptRow,
    TranscriptRowKind,
};
use crate::text_wrap::{display_width, display_width_between, wrap_words, WrappedLine};
use crate::theme::{
    command_palette_command_style, command_palette_description_style,
    command_palette_selected_style, command_palette_style, live_assistant_body_style,
    live_assistant_prefix_style, prompt_editor_style, thinking_style, transcript_prefix_style,
    user_prompt_style,
};

const PROMPT_GUTTER_WIDTH: usize = 2;
const PROMPT_MIN_VISIBLE_ROWS: usize = 2;
const PROMPT_MAX_VISIBLE_ROWS: usize = 5;
const TRANSCRIPT_LEFT_MARGIN_WIDTH: usize = 2;
const COMMAND_PALETTE_MAX_ROWS: usize = 6;
const COMMAND_PALETTE_USAGE_WIDTH: usize = 28;

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
    let [status_area, prompt_area] = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(1), Constraint::Min(3)])
        .areas(bottom_area);

    let transcript_inner_width = transcript_area.width.saturating_sub(2) as usize;
    let transcript_margin = transcript_left_margin_width(transcript_inner_width) as u16;
    let transcript_inner = transcript_area.inner(Margin::new(1, 1));
    app.set_transcript_viewport_size(
        transcript_area.height.saturating_sub(2) as usize,
        transcript_content_width(transcript_inner_width),
    );
    app.set_mouse_regions(MouseRegions {
        transcript_text: Some(Rect::new(
            transcript_inner.x.saturating_add(transcript_margin),
            transcript_inner.y,
            transcript_inner.width.saturating_sub(transcript_margin),
            transcript_inner.height,
        )),
        transcript_scrollbar: Some(Rect::new(
            transcript_area.right().saturating_sub(1),
            transcript_area.y.saturating_add(1),
            1,
            transcript_area.height.saturating_sub(2),
        )),
        status: Some(status_area),
        prompt: None,
        command_palette: None,
    });
    render_transcript(frame, app, transcript_area);
    render_bottom(frame, app, status_area, prompt_area);
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
    let title = app.transcript_header_title();

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
        let padding = " ".repeat(content_width.saturating_sub(display_width(&row.text)));
        let mut content = apply_selection_style(
            vec![
                Span::styled(row.text, user_prompt_style()),
                Span::styled(padding, user_prompt_style()),
            ],
            row.selection_range,
        );
        let mut spans = vec![Span::styled(margin, user_prompt_style())];
        spans.append(&mut content);
        return Line::from(spans);
    }

    let body_style = if row.kind == TranscriptRowKind::Assistant && row.is_streaming {
        live_assistant_body_style()
    } else if row.kind == TranscriptRowKind::Thinking {
        thinking_style()
    } else {
        Style::default()
    };
    let content = row.kind.prefix().and_then(|prefix| {
        let body = row.text.strip_prefix(prefix)?.to_string();
        let prefix_style = if row.kind == TranscriptRowKind::Assistant && row.is_streaming {
            Some(live_assistant_prefix_style())
        } else {
            transcript_prefix_style(row.kind)
        }?;
        let mut spans = vec![Span::styled(prefix.to_string(), prefix_style)];
        spans.extend(styled_body_spans(
            row.styled_spans.clone(),
            body,
            body_style,
        ));
        Some(spans)
    });
    let mut content = apply_selection_style(
        content.unwrap_or_else(|| styled_body_spans(row.styled_spans, row.text, body_style)),
        row.selection_range,
    );
    let mut spans = vec![Span::raw(margin)];
    spans.append(&mut content);
    Line::from(spans)
}

fn apply_selection_style(
    spans: Vec<Span<'static>>,
    selection: Option<(usize, usize)>,
) -> Vec<Span<'static>> {
    let Some((selection_start, selection_end)) = selection else {
        return spans;
    };
    let mut result = Vec::new();
    let mut span_start = 0;
    for span in spans {
        let chars = span.content.chars().collect::<Vec<_>>();
        let span_end = span_start + chars.len();
        let selected_start = selection_start.max(span_start).min(span_end) - span_start;
        let selected_end = selection_end.max(span_start).min(span_end) - span_start;
        for (start, end, selected) in [
            (0, selected_start, false),
            (selected_start, selected_end, true),
            (selected_end, chars.len(), false),
        ] {
            if start == end {
                continue;
            }
            let text = chars[start..end].iter().collect::<String>();
            let style = if selected {
                span.style.add_modifier(Modifier::REVERSED)
            } else {
                span.style
            };
            result.push(Span::styled(text, style));
        }
        span_start = span_end;
    }
    result
}

fn styled_body_spans(
    styled_spans: Option<Vec<Span<'static>>>,
    fallback: String,
    base_style: Style,
) -> Vec<Span<'static>> {
    styled_spans.map_or_else(
        || vec![Span::styled(fallback, base_style)],
        |spans| {
            spans
                .into_iter()
                .map(|span| Span::styled(span.content.into_owned(), span.style.patch(base_style)))
                .collect()
        },
    )
}

fn transcript_left_margin_width(visible_width: usize) -> usize {
    TRANSCRIPT_LEFT_MARGIN_WIDTH.min(visible_width.saturating_sub(1))
}

fn transcript_content_width(visible_width: usize) -> usize {
    visible_width
        .saturating_sub(transcript_left_margin_width(visible_width))
        .max(1)
}

fn render_bottom(frame: &mut Frame<'_>, app: &mut App, status_area: Rect, prompt_area: Rect) {
    let status = Line::from(Span::styled(
        visible_status_text(&app.status_text(), status_area.width as usize),
        Style::default()
            .fg(Color::Green)
            .add_modifier(Modifier::BOLD),
    ));
    frame.render_widget(Paragraph::new(status), status_area);

    app.set_prompt_viewport_width(prompt_text_width(prompt_area.width as usize));
    render_prompt(frame, app, prompt_area);
    render_command_palette(frame, app, status_area, prompt_area);
}

fn render_command_palette(
    frame: &mut Frame<'_>,
    app: &mut App,
    status_area: Rect,
    prompt_area: Rect,
) {
    if !app.command_palette_open() {
        app.set_command_palette_mouse_region(None);
        return;
    }

    let items = app.command_palette_items();
    let available_height = status_area.y.saturating_sub(frame.area().y) as usize;
    if available_height < 3 {
        app.set_command_palette_mouse_region(None);
        return;
    }

    let visible_rows = items
        .len()
        .clamp(1, COMMAND_PALETTE_MAX_ROWS)
        .min(available_height.saturating_sub(2).max(1));
    let selected = app
        .command_palette_selected()
        .min(items.len().saturating_sub(1));
    let max_start = items.len().saturating_sub(visible_rows);
    let start = selected
        .saturating_sub(visible_rows.saturating_sub(1))
        .min(max_start);
    let end = (start + visible_rows).min(items.len());
    let title = if items.is_empty() {
        "Commands 0/0".to_string()
    } else {
        format!("Commands {}-{}/{}", start + 1, end, items.len())
    };

    let lines = if items.is_empty() {
        vec![Line::styled(
            " No matching commands",
            command_palette_description_style(),
        )]
    } else {
        items[start..end]
            .iter()
            .enumerate()
            .map(|(offset, item)| {
                let row_index = start + offset;
                let row_style = if row_index == selected {
                    command_palette_selected_style()
                } else {
                    command_palette_style()
                };
                Line::from(vec![
                    Span::styled(
                        format!(
                            " {:<width$}",
                            item.usage,
                            width = COMMAND_PALETTE_USAGE_WIDTH
                        ),
                        command_palette_command_style(),
                    ),
                    Span::styled(item.description, command_palette_description_style()),
                ])
                .style(row_style)
            })
            .collect()
    };

    let height = (visible_rows + 2) as u16;
    let area = Rect::new(
        prompt_area.x,
        status_area.y.saturating_sub(height),
        prompt_area.width,
        height,
    );
    app.set_command_palette_mouse_region(Some(CommandPaletteMouseRegion {
        area: area.inner(Margin::new(1, 1)),
        start,
        item_count: end.saturating_sub(start),
    }));
    frame.render_widget(Clear, area);
    frame.render_widget(
        Paragraph::new(lines)
            .style(command_palette_style())
            .block(Block::default().borders(Borders::ALL).title(title)),
        area,
    );
}

fn render_prompt(frame: &mut Frame<'_>, app: &mut App, prompt_area: ratatui::layout::Rect) {
    let prompt_width = prompt_text_width(prompt_area.width as usize);
    let visible_rows = prompt_area.height.saturating_sub(2).max(1) as usize;
    let prompt_rows = wrap_prompt_rows(app.prompt(), prompt_width);
    let cursor_chars = app.prompt_cursor_chars();
    let cursor = prompt_cursor_position(&prompt_rows, app.prompt(), cursor_chars, prompt_width);
    let view_start = app.sync_prompt_view_for_render(prompt_rows.len(), cursor.row, visible_rows);
    let prompt_inner = prompt_area.inner(Margin::new(1, 1));
    app.set_prompt_mouse_region(PromptMouseRegion {
        area: prompt_inner,
        view_start,
        width: prompt_width,
        visible_rows,
    });
    let prompt_lines = visible_prompt_lines(
        app.prompt(),
        &prompt_rows,
        view_start,
        visible_rows,
        prompt_width,
        app.prompt_selection_chars(),
    );
    let prompt =
        Paragraph::new(prompt_lines).block(Block::default().borders(Borders::ALL).title("Prompt"));

    frame.render_widget(prompt, prompt_area);
    frame
        .buffer_mut()
        .set_style(prompt_area.inner(Margin::new(1, 1)), prompt_editor_style());

    if cursor.row >= view_start && cursor.row < view_start + visible_rows {
        let cursor_offset = cursor.col.min(prompt_width) as u16;
        let cursor_row = cursor.row.saturating_sub(view_start) as u16;
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

fn visible_prompt_lines(
    prompt: &str,
    rows: &[WrappedLine],
    start: usize,
    visible_rows: usize,
    prompt_width: usize,
    selection: Option<(usize, usize)>,
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
                let row_end = row.start_char + row.text.chars().count();
                let selection = selection.and_then(|(start, end)| {
                    let selected_start = start.max(row.start_char).min(row_end);
                    let selected_end = end.max(row.start_char).min(row_end);
                    (selected_start < selected_end).then_some((
                        selected_start - row.start_char,
                        selected_end - row.start_char,
                    ))
                });
                let mut text_spans =
                    apply_selection_style(vec![Span::raw(row.text.clone())], selection);
                let mut spans = vec![prompt_gutter(index)];
                spans.append(&mut text_spans);
                styled_prompt_line(spans, display_width(&row.text), prompt_width)
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
