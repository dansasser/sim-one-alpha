use ratatui::style::Style;
use ratatui::text::{Line, Span};
use tui_markdown::{from_str_with_options, Options};
use unicode_width::UnicodeWidthChar;

use crate::theme::TranscriptMarkdownStyleSheet;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StyledMarkdownLine {
    pub text: String,
    pub spans: Vec<Span<'static>>,
    pub source_line: usize,
    pub source_text: String,
    pub start_char: usize,
    pub end_char: usize,
}

#[derive(Debug, Clone, Copy)]
struct StyledChar {
    ch: char,
    style: Style,
}

pub(crate) fn render_markdown(
    input: &str,
    first_line_width: usize,
    continuation_width: usize,
) -> Vec<StyledMarkdownLine> {
    let options = Options::new(TranscriptMarkdownStyleSheet);
    let markdown = from_str_with_options(input, &options);
    let mut rows = Vec::new();

    for (source_line, line) in markdown.lines.into_iter().enumerate() {
        let chars = styled_chars(line);
        let source_text = chars.iter().map(|styled| styled.ch).collect::<String>();
        let width = if rows.is_empty() {
            first_line_width
        } else {
            continuation_width
        };
        wrap_styled_line(
            &chars,
            width.max(1),
            continuation_width.max(1),
            source_line,
            &source_text,
            &mut rows,
        );
    }

    if rows.is_empty() {
        rows.push(StyledMarkdownLine {
            text: String::new(),
            spans: Vec::new(),
            source_line: 0,
            source_text: String::new(),
            start_char: 0,
            end_char: 0,
        });
    }

    rows
}

fn styled_chars(line: Line<'_>) -> Vec<StyledChar> {
    let line_style = line.style;
    line.spans
        .into_iter()
        .flat_map(|span| {
            let style = line_style.patch(span.style);
            span.content
                .into_owned()
                .chars()
                .map(move |ch| StyledChar { ch, style })
                .collect::<Vec<_>>()
        })
        .collect()
}

fn wrap_styled_line(
    chars: &[StyledChar],
    first_width: usize,
    continuation_width: usize,
    source_line: usize,
    source_text: &str,
    rows: &mut Vec<StyledMarkdownLine>,
) {
    if chars.is_empty() {
        rows.push(StyledMarkdownLine {
            text: String::new(),
            spans: Vec::new(),
            source_line,
            source_text: source_text.to_string(),
            start_char: 0,
            end_char: 0,
        });
        return;
    }

    let mut row_start = 0;
    let mut row_width_limit = first_width;
    while row_start < chars.len() {
        let mut cursor = row_start;
        let mut row_width = 0;
        let mut last_break = None;
        let mut saw_non_whitespace = false;
        let mut emitted = false;

        while cursor < chars.len() {
            let ch = chars[cursor].ch;
            row_width += UnicodeWidthChar::width(ch).unwrap_or_default();
            if row_width > row_width_limit {
                if let Some(break_at) = last_break {
                    push_row(chars, row_start, break_at, source_line, source_text, rows);
                    row_start = consume_whitespace(chars, break_at);
                } else if ch.is_whitespace() {
                    push_row(chars, row_start, cursor, source_line, source_text, rows);
                    row_start = consume_whitespace(chars, cursor);
                } else {
                    let word_end = consume_word(chars, cursor);
                    push_row(chars, row_start, word_end, source_line, source_text, rows);
                    row_start = consume_whitespace(chars, word_end);
                }
                row_width_limit = continuation_width;
                emitted = true;
                break;
            }

            if ch.is_whitespace() {
                if saw_non_whitespace {
                    last_break = Some(cursor + 1);
                }
            } else {
                saw_non_whitespace = true;
            }
            cursor += 1;
        }

        if !emitted {
            push_row(
                chars,
                row_start,
                chars.len(),
                source_line,
                source_text,
                rows,
            );
            break;
        }
    }
}

fn push_row(
    chars: &[StyledChar],
    start: usize,
    display_end: usize,
    source_line: usize,
    source_text: &str,
    rows: &mut Vec<StyledMarkdownLine>,
) {
    let mut visible_end = display_end;
    while visible_end > start && chars[visible_end - 1].ch.is_whitespace() {
        visible_end -= 1;
    }

    let mut spans: Vec<Span<'static>> = Vec::new();
    for styled in &chars[start..visible_end] {
        if let Some(last) = spans.last_mut().filter(|last| last.style == styled.style) {
            last.content.to_mut().push(styled.ch);
        } else {
            spans.push(Span::styled(styled.ch.to_string(), styled.style));
        }
    }
    rows.push(StyledMarkdownLine {
        text: chars[start..visible_end]
            .iter()
            .map(|styled| styled.ch)
            .collect(),
        spans,
        source_line,
        source_text: source_text.to_string(),
        start_char: start,
        end_char: visible_end,
    });
}

fn consume_word(chars: &[StyledChar], mut index: usize) -> usize {
    while index < chars.len() && !chars[index].ch.is_whitespace() {
        index += 1;
    }
    index
}

fn consume_whitespace(chars: &[StyledChar], mut index: usize) -> usize {
    while index < chars.len() && chars[index].ch.is_whitespace() {
        index += 1;
    }
    index
}

#[cfg(test)]
mod tests {
    use ratatui::style::Modifier;

    use super::render_markdown;

    #[test]
    fn preserves_inline_style_across_word_wrapping() {
        let rows = render_markdown("plain **bold words** after", 8, 18);

        assert_eq!(
            rows.iter().map(|row| row.text.as_str()).collect::<Vec<_>>(),
            ["plain", "bold words after"]
        );
        assert!(rows[1].spans.iter().any(|span| {
            span.content.contains("bold words") && span.style.add_modifier.contains(Modifier::BOLD)
        }));
    }

    #[test]
    fn wraps_unicode_using_terminal_column_width() {
        let rows = render_markdown("test **界界**", 8, 8);
        assert_eq!(
            rows.iter().map(|row| row.text.as_str()).collect::<Vec<_>>(),
            ["test", "界界"]
        );
    }
}
