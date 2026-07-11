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
        let mut last_break = None;
        let mut saw_non_whitespace = false;
        let mut emitted = false;

        while cursor < end {
            let ch = chars[cursor];
            let row_len = cursor - row_start + 1;
            if row_len > width {
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
