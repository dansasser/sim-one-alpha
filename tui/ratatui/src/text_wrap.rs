use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WrappedLine {
    pub text: String,
    pub start_char: usize,
    pub end_char: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WrappedRange {
    pub start: usize,
    pub visible_end: usize,
    pub source_end: usize,
}

pub(crate) fn wrap_words(text: &str, width: usize) -> Vec<WrappedLine> {
    let width = width.max(1);
    let units = grapheme_units(text);
    let total_chars = text.chars().count();
    let mut rows = Vec::new();
    let mut line_start = 0;

    for index in 0..=units.len() {
        if index == units.len() || matches!(units[index].text, "\n" | "\r\n") {
            wrap_logical_line(
                &units,
                line_start,
                index,
                boundary_char_index(&units, line_start, total_chars),
                total_chars,
                width,
                &mut rows,
            );
            line_start = index.saturating_add(1);
        }
    }

    rows
}

pub(crate) fn display_width(text: &str) -> usize {
    UnicodeWidthStr::width(text)
}

pub(crate) fn display_width_between(text: &str, start_char: usize, end_char: usize) -> usize {
    let value = text
        .chars()
        .skip(start_char)
        .take(end_char.saturating_sub(start_char))
        .collect::<String>();
    UnicodeWidthStr::width(value.as_str())
}

pub(crate) fn previous_grapheme_boundary(value: &str, cursor: usize) -> Option<usize> {
    value
        .get(..cursor)?
        .grapheme_indices(true)
        .next_back()
        .map(|(index, _)| index)
}

pub(crate) fn next_grapheme_boundary(value: &str, cursor: usize) -> Option<usize> {
    value
        .get(cursor..)?
        .graphemes(true)
        .next()
        .map(|grapheme| cursor + grapheme.len())
}

#[derive(Debug, Clone, Copy)]
struct GraphemeUnit<'a> {
    text: &'a str,
    start_char: usize,
}

fn wrap_logical_line(
    units: &[GraphemeUnit<'_>],
    start: usize,
    end: usize,
    empty_char_index: usize,
    total_chars: usize,
    width: usize,
    rows: &mut Vec<WrappedLine>,
) {
    if start == end {
        rows.push(WrappedLine {
            text: String::new(),
            start_char: empty_char_index,
            end_char: empty_char_index,
        });
        return;
    }

    for range in wrap_ranges(
        start,
        end,
        width,
        width,
        |index| UnicodeWidthStr::width(units[index].text),
        |index| units[index].text.chars().all(char::is_whitespace),
    ) {
        rows.push(WrappedLine {
            text: units[range.start..range.visible_end]
                .iter()
                .map(|unit| unit.text)
                .collect(),
            start_char: boundary_char_index(units, range.start, total_chars),
            end_char: boundary_char_index(units, range.source_end, total_chars),
        });
    }
}

fn grapheme_units(text: &str) -> Vec<GraphemeUnit<'_>> {
    let mut char_index = 0;
    text.graphemes(true)
        .map(|grapheme| {
            let unit = GraphemeUnit {
                text: grapheme,
                start_char: char_index,
            };
            char_index += grapheme.chars().count();
            unit
        })
        .collect()
}

fn boundary_char_index(units: &[GraphemeUnit<'_>], index: usize, total_chars: usize) -> usize {
    units
        .get(index)
        .map(|unit| unit.start_char)
        .unwrap_or(total_chars)
}

pub(crate) fn wrap_ranges(
    start: usize,
    end: usize,
    first_width: usize,
    continuation_width: usize,
    char_width: impl Fn(usize) -> usize,
    is_whitespace: impl Fn(usize) -> bool,
) -> Vec<WrappedRange> {
    let mut ranges = Vec::new();
    let mut row_start = start;
    let mut row_width_limit = first_width.max(1);

    while row_start < end {
        let mut cursor = row_start;
        let mut row_width = 0usize;
        let mut last_break = None;
        let mut saw_non_whitespace = false;

        while cursor < end {
            let next_width = row_width.saturating_add(char_width(cursor));
            if next_width > row_width_limit {
                let (display_end, source_end) = if let Some(break_at) = last_break {
                    (break_at, consume_whitespace(break_at, end, &is_whitespace))
                } else if is_whitespace(cursor) {
                    (cursor, consume_whitespace(cursor, end, &is_whitespace))
                } else if cursor > row_start {
                    (cursor, cursor)
                } else {
                    (cursor + 1, cursor + 1)
                };
                ranges.push(WrappedRange {
                    start: row_start,
                    visible_end: trim_trailing_whitespace(row_start, display_end, &is_whitespace),
                    source_end,
                });
                row_start = source_end;
                row_width_limit = continuation_width.max(1);
                break;
            }

            row_width = next_width;
            if is_whitespace(cursor) {
                if saw_non_whitespace {
                    last_break = Some(cursor);
                }
            } else {
                saw_non_whitespace = true;
            }
            cursor += 1;
        }

        if cursor == end {
            ranges.push(WrappedRange {
                start: row_start,
                visible_end: trim_trailing_whitespace(row_start, end, &is_whitespace),
                source_end: end,
            });
            break;
        }
    }

    ranges
}

fn trim_trailing_whitespace(
    start: usize,
    mut end: usize,
    is_whitespace: &impl Fn(usize) -> bool,
) -> usize {
    while end > start && is_whitespace(end - 1) {
        end -= 1;
    }
    end
}

fn consume_whitespace(
    mut index: usize,
    end: usize,
    is_whitespace: &impl Fn(usize) -> bool,
) -> usize {
    while index < end && is_whitespace(index) {
        index += 1;
    }
    index
}

#[cfg(test)]
mod tests {
    use super::{display_width_between, wrap_words};

    #[test]
    fn wraps_cjk_words_using_terminal_column_width() {
        let rows = wrap_words("test 界界", 8);
        assert_eq!(
            rows.into_iter().map(|row| row.text).collect::<Vec<_>>(),
            ["test", "界界"]
        );
    }

    #[test]
    fn wraps_emoji_using_terminal_column_width() {
        let rows = wrap_words("go 👍 test", 9);
        assert_eq!(
            rows.into_iter().map(|row| row.text).collect::<Vec<_>>(),
            ["go 👍", "test"]
        );
    }

    #[test]
    fn combining_marks_do_not_consume_an_extra_column() {
        let rows = wrap_words("cafe\u{301} test", 9);
        assert_eq!(
            rows.into_iter().map(|row| row.text).collect::<Vec<_>>(),
            ["cafe\u{301} test"]
        );
    }

    #[test]
    fn keeps_emoji_zwj_sequences_in_one_display_unit() {
        let rows = wrap_words("👩‍💻x", 2);
        assert_eq!(
            rows.into_iter().map(|row| row.text).collect::<Vec<_>>(),
            ["👩‍💻", "x"]
        );
        assert_eq!(display_width_between("👩‍💻", 0, 3), 2);
    }

    #[test]
    fn splits_only_tokens_that_are_wider_than_the_viewport() {
        let rows = wrap_words("prefix abcdefghijkl suffix", 8);
        assert_eq!(
            rows.into_iter().map(|row| row.text).collect::<Vec<_>>(),
            ["prefix", "abcdefgh", "ijkl", "suffix"]
        );
    }
}
