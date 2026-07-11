use ratatui::style::{Color, Modifier, Style};

use crate::app::TranscriptRowKind;

pub const USER_PROMPT_BACKGROUND: Color = Color::Rgb(52, 52, 56);
pub const PROMPT_EDITOR_BACKGROUND: Color = Color::Rgb(38, 38, 40);
pub const COMMAND_PALETTE_BACKGROUND: Color = Color::Rgb(30, 30, 32);
pub const COMMAND_PALETTE_SELECTED_BACKGROUND: Color = Color::Rgb(58, 64, 72);

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct TranscriptMarkdownStyleSheet;

impl tui_markdown::StyleSheet for TranscriptMarkdownStyleSheet {
    fn heading(&self, level: u8) -> Style {
        let color = if level <= 3 {
            Color::LightCyan
        } else {
            Color::Cyan
        };
        Style::default().fg(color).add_modifier(Modifier::BOLD)
    }

    fn code(&self) -> Style {
        Style::default()
            .fg(Color::White)
            .bg(PROMPT_EDITOR_BACKGROUND)
    }

    fn link(&self) -> Style {
        Style::default()
            .fg(Color::LightBlue)
            .add_modifier(Modifier::UNDERLINED)
    }

    fn blockquote(&self) -> Style {
        Style::default()
            .fg(Color::DarkGray)
            .add_modifier(Modifier::ITALIC)
    }

    fn heading_meta(&self) -> Style {
        Style::default().add_modifier(Modifier::DIM)
    }

    fn metadata_block(&self) -> Style {
        Style::default().fg(Color::DarkGray)
    }
}

pub(crate) fn user_prompt_style() -> Style {
    Style::default().bg(USER_PROMPT_BACKGROUND)
}

pub(crate) fn prompt_editor_style() -> Style {
    Style::default().bg(PROMPT_EDITOR_BACKGROUND)
}

pub(crate) fn command_palette_style() -> Style {
    Style::default().bg(COMMAND_PALETTE_BACKGROUND)
}

pub(crate) fn command_palette_selected_style() -> Style {
    Style::default().bg(COMMAND_PALETTE_SELECTED_BACKGROUND)
}

pub(crate) fn command_palette_command_style() -> Style {
    Style::default()
        .fg(Color::LightCyan)
        .add_modifier(Modifier::BOLD)
}

pub(crate) fn command_palette_description_style() -> Style {
    Style::default().fg(Color::Gray)
}

pub(crate) fn thinking_style() -> Style {
    Style::default()
        .fg(Color::DarkGray)
        .add_modifier(Modifier::ITALIC)
}

pub(crate) fn live_assistant_body_style() -> Style {
    Style::default().add_modifier(Modifier::DIM)
}

pub(crate) fn live_assistant_prefix_style() -> Style {
    Style::default()
        .fg(Color::Cyan)
        .add_modifier(Modifier::BOLD | Modifier::DIM)
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
