//! Reusable dialog widgets and the color-level pass they all end with.

mod action_bar;
mod checklist;
mod cursor;
mod select;
mod text_input;

pub use action_bar::{ActionItem, action_bar_line, action_bar_width};
pub use checklist::{Checklist, ChecklistEvent, ChecklistItem};
pub use cursor::Cursor;
pub use select::{Select, SelectEvent, SelectOption};
pub use text_input::{
    InputEvent, InputFrame, InputLayout, MAX_BUFFER_BYTES, TextInput, clamp_buffer_size,
};

use ratatui::buffer::Buffer;
use ratatui::style::{Color, Modifier};

use crate::ansi::{self, quantize};
use crate::chrome::SPINNER_FRAMES;
use crate::theme::{ColorRef, FrameStops, Theme, TokenPair, resolve_color};

/// Resolves theme tokens for one render: which theme, what color level the
/// terminal has, and whether nerd-font glyphs are allowed. Tokens render in
/// truecolor at level 0 so [`apply_color_level`] can still recognise the
/// focus background before stripping color.
#[derive(Clone, Copy, Debug)]
pub struct Paint {
    pub theme: &'static Theme,
    pub level: u8,
    pub nerd_fonts: bool,
}

impl Paint {
    pub fn new(theme: &'static Theme, level: u8, nerd_fonts: bool) -> Self {
        Self {
            theme,
            level,
            nerd_fonts,
        }
    }

    fn render_level(self) -> u8 {
        if self.level == 0 { 3 } else { self.level }
    }

    pub fn color(self, token: &ColorRef) -> Color {
        resolve_color(token, self.render_level())
    }

    pub fn pair(self, pair: &TokenPair) -> (Color, Color) {
        (self.color(&pair.fg), self.color(&pair.bg))
    }

    /// A point on a two-stop OKLAB gradient. Below truecolor the gradient
    /// collapses to the body text color: banding reads worse than a solid.
    pub fn gradient(self, stops: FrameStops, t: f32) -> Color {
        if self.level < 3 {
            return self.color(&self.theme.copy.body);
        }
        let (r, g, b) = ansi::gradient(stops[0], stops[1], t.clamp(0.0, 1.0));
        Color::Rgb(r, g, b)
    }

    /// The final pass over a rendered buffer.
    pub fn finish(self, buf: &mut Buffer) {
        apply_color_level(
            buf,
            self.level,
            &[
                self.color(&self.theme.action_bar.selected_bg),
                self.color(&self.theme.checklist.row_focused_bg),
            ],
        );
    }
}

/// Reduces every cell to what the terminal supports. Without color, cells
/// whose background is one of `reversed_bgs` (a focused item) fall back to
/// reverse video so focus stays visible.
pub fn apply_color_level(buf: &mut Buffer, level: u8, reversed_bgs: &[Color]) {
    if level >= 3 {
        return;
    }
    for cell in &mut buf.content {
        if level == 0 {
            if reversed_bgs.contains(&cell.bg) {
                cell.modifier.insert(Modifier::REVERSED);
            }
            cell.fg = Color::Reset;
            cell.bg = Color::Reset;
        } else {
            cell.fg = quantize(cell.fg, level);
            cell.bg = quantize(cell.bg, level);
        }
    }
}

const BADGE_PREFIX: &str = "↳ Continuing: ";
const BADGE_MIN_COLUMNS: usize = 20;

/// The single-line `↳ Continuing: …` badge: whitespace collapsed, truncated
/// with an ellipsis to the terminal minus a one-cell gutter, and empty when
/// the prompt is blank or the terminal is narrower than 20 columns.
pub fn format_continuation_badge(parent_prompt: &str, columns: u16) -> String {
    let columns = usize::from(columns);
    if columns < BADGE_MIN_COLUMNS {
        return String::new();
    }
    let body = parent_prompt
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if body.is_empty() {
        return String::new();
    }
    let prefix_len = BADGE_PREFIX.chars().count();
    let budget = BADGE_MIN_COLUMNS.max(columns.saturating_sub(prefix_len + 1));
    if body.chars().count() <= budget {
        return format!("{BADGE_PREFIX}{body}");
    }
    let cut: String = body.chars().take(budget - 1).collect();
    format!("{BADGE_PREFIX}{cut}…")
}

/// The bottom-border status for one animation frame: spinner glyph plus
/// label, the bare label without animation, nothing without a label.
pub fn spinner_status(label: Option<&str>, frame: usize, no_animation: bool) -> Option<String> {
    let label = label.filter(|l| !l.is_empty())?;
    if no_animation {
        return Some(label.to_string());
    }
    let glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.len()];
    Some(format!("{glyph} {label}"))
}
