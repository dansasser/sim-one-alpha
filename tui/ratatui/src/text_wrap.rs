use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

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
    let chars = text.chars().collect::<Vec<_>>();
    let mut rows = Vec::new();
    let mut line_start = 0;

    for index in 0..=chars.len() {
        if index == chars.len() || chars[index] == '\n' {
            wrap_logical_line(&chars, line_start, index, width, &mut rows);
            line_start = index.saturating_add(1);
        }
    }

    rows
}

pub(crate) fn display_width(text: &str) -> usize {
    UnicodeWidthStr::width(text)
}

pub(crate) fn display_width_between(text: &str, start_char: usize, end_char: usize) -> usize {
    text.chars()
        .skip(start_char)
        .take(end_char.saturating_sub(start_char))
        .map(|ch| UnicodeWidthChar::width(ch).unwrap_or_default())
        .sum()
}

fn wrap_logical_line(
    chars: &[char],
    start: usize,
    end: usize,
    width: usize,
    rows: &mut Vec<WrappedLine>,
) {
    if start == end {
        rows.push(WrappedLine {
            text: String::new(),
            start_char: start,
            end_char: end,
        });
        return;
    }

    for range in wrap_ranges(
        start,
        end,
        width,
        width,
        |index| UnicodeWidthChar::width(chars[index]).unwrap_or_default(),
        |index| chars[index].is_whitespace(),
    ) {
        rows.push(WrappedLine {
            text: chars[range.start..range.visible_end].iter().collect(),
            start_char: range.start,
            end_char: range.source_end,
        });
    }
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
    use super::wrap_words;

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
    fn splits_only_tokens_that_are_wider_than_the_viewport() {
        let rows = wrap_words("prefix abcdefghijkl suffix", 8);
        assert_eq!(
            rows.into_iter().map(|row| row.text).collect::<Vec<_>>(),
            ["prefix", "abcdefgh", "ijkl", "suffix"]
        );
    }
}
