use ratatui::style::{Color, Modifier, Style};

use crate::app::TranscriptRowKind;

pub const USER_PROMPT_BACKGROUND: Color = Color::Rgb(52, 52, 56);
pub const PROMPT_EDITOR_BACKGROUND: Color = Color::Rgb(38, 38, 40);

pub(crate) fn user_prompt_style() -> Style {
    Style::default().bg(USER_PROMPT_BACKGROUND)
}

pub(crate) fn prompt_editor_style() -> Style {
    Style::default().bg(PROMPT_EDITOR_BACKGROUND)
}

pub(crate) fn thinking_style() -> Style {
    Style::default()
        .fg(Color::DarkGray)
        .add_modifier(Modifier::ITALIC)
}

pub(crate) fn transcript_prefix_style(kind: TranscriptRowKind) -> Option<Style> {
    let color = match kind {
        TranscriptRowKind::Assistant => Color::Cyan,
        TranscriptRowKind::Thinking | TranscriptRowKind::Log => Color::DarkGray,
        TranscriptRowKind::Tool => Color::Blue,
        TranscriptRowKind::Task => Color::Magenta,
        TranscriptRowKind::Operation => Color::Yellow,
        TranscriptRowKind::Progress => Color::Green,
        TranscriptRowKind::Error => Color::LightRed,
        TranscriptRowKind::System | TranscriptRowKind::Preflight => Color::LightGreen,
        TranscriptRowKind::User | TranscriptRowKind::Other => return None,
    };
    let mut style = Style::default().fg(color).add_modifier(Modifier::BOLD);
    if kind == TranscriptRowKind::Thinking {
        style = style.add_modifier(Modifier::ITALIC);
    }
    Some(style)
}
