use ratatui::style::Style;
use ratatui::text::{Line, Span};
use tui_markdown::{from_str_with_options, Options};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::text_wrap::wrap_ranges;
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

#[derive(Debug, Clone, Copy)]
struct StyledGrapheme {
    start_char: usize,
    end_char: usize,
    width: usize,
    whitespace: bool,
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

    let graphemes = styled_graphemes(source_text);
    for range in wrap_ranges(
        0,
        graphemes.len(),
        first_width,
        continuation_width,
        |index| graphemes[index].width,
        |index| graphemes[index].whitespace,
    ) {
        let start = grapheme_boundary(&graphemes, range.start, chars.len());
        let visible_end = grapheme_boundary(&graphemes, range.visible_end, chars.len());
        let source_end = grapheme_boundary(&graphemes, range.source_end, chars.len());
        push_row(
            chars,
            start,
            visible_end,
            source_end,
            source_line,
            source_text,
            rows,
        );
    }
}

fn styled_graphemes(source_text: &str) -> Vec<StyledGrapheme> {
    let mut char_index = 0;
    source_text
        .graphemes(true)
        .map(|grapheme| {
            let start_char = char_index;
            char_index += grapheme.chars().count();
            StyledGrapheme {
                start_char,
                end_char: char_index,
                width: UnicodeWidthStr::width(grapheme),
                whitespace: grapheme.chars().all(char::is_whitespace),
            }
        })
        .collect()
}

fn grapheme_boundary(graphemes: &[StyledGrapheme], index: usize, total_chars: usize) -> usize {
    graphemes
        .get(index)
        .map(|grapheme| grapheme.start_char)
        .or_else(|| graphemes.last().map(|grapheme| grapheme.end_char))
        .unwrap_or(total_chars)
}

fn push_row(
    chars: &[StyledChar],
    start: usize,
    visible_end: usize,
    source_end: usize,
    source_line: usize,
    source_text: &str,
    rows: &mut Vec<StyledMarkdownLine>,
) {
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
        end_char: source_end,
    });
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

    #[test]
    fn preserves_emoji_graphemes_across_markdown_wrapping() {
        let rows = render_markdown("**👩‍💻x**", 2, 2);
        assert_eq!(
            rows.iter().map(|row| row.text.as_str()).collect::<Vec<_>>(),
            ["👩‍💻", "x"]
        );
    }

    #[test]
    fn splits_an_oversized_markdown_token_at_terminal_width() {
        let rows = render_markdown("**abcdefghijkl**", 8, 8);
        assert_eq!(
            rows.iter().map(|row| row.text.as_str()).collect::<Vec<_>>(),
            ["abcdefgh", "ijkl"]
        );
    }
}
