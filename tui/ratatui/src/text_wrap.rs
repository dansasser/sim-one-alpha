use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WrappedLine {
    pub text: String,
    pub start_char: usize,
    pub end_char: usize,
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

    let mut row_start = start;
    while row_start < end {
        let mut cursor = row_start;
        let mut row_width = 0;
        let mut last_break = None;
        let mut saw_non_whitespace = false;
        let mut emitted = false;

        while cursor < end {
            let ch = chars[cursor];
            row_width += UnicodeWidthChar::width(ch).unwrap_or_default();
            if row_width > width {
                if let Some(break_at) = last_break {
                    push_row(chars, row_start, break_at, break_at, rows);
                    row_start = break_at;
                } else if ch.is_whitespace() {
                    let next_word = consume_whitespace(chars, cursor, end);
                    push_row(chars, row_start, cursor, next_word, rows);
                    row_start = next_word;
                } else {
                    let word_end = consume_word(chars, cursor, end);
                    let next_word = consume_whitespace(chars, word_end, end);
                    push_row(chars, row_start, word_end, next_word, rows);
                    row_start = next_word;
                }
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
            push_row(chars, row_start, end, end, rows);
            break;
        }
    }
}

fn push_row(
    chars: &[char],
    start: usize,
    display_end: usize,
    source_end: usize,
    rows: &mut Vec<WrappedLine>,
) {
    let mut visible_end = display_end;
    while visible_end > start && chars[visible_end - 1].is_whitespace() {
        visible_end -= 1;
    }
    rows.push(WrappedLine {
        text: chars[start..visible_end].iter().collect(),
        start_char: start,
        end_char: source_end,
    });
}

fn consume_word(chars: &[char], mut index: usize, end: usize) -> usize {
    while index < end && !chars[index].is_whitespace() {
        index += 1;
    }
    index
}

fn consume_whitespace(chars: &[char], mut index: usize, end: usize) -> usize {
    while index < end && chars[index].is_whitespace() {
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
}
