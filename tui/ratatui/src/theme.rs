use ratatui::style::{Color, Modifier, Style};

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
