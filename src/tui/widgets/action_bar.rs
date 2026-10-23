//! The row of key hints at the bottom of every dialog.

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_width::UnicodeWidthStr;

use super::Paint;

/// One hint. A single ASCII letter glyph matching the label's first letter
/// renders approve-style (the hotkey underlined inside the label); anything
/// else renders as `<glyph> <label>`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionItem {
    pub glyph: String,
    pub label: String,
    /// First-tier action: the glyph or hotkey takes the accent color.
    pub primary: bool,
    /// Approve-style only: tints the whole label uniformly and drops the
    /// hotkey underline, for a transient status such as `Copied`.
    pub flash_color: Option<Color>,
}

impl ActionItem {
    pub fn new(glyph: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            glyph: glyph.into(),
            label: label.into(),
            primary: false,
            flash_color: None,
        }
    }

    pub fn primary(mut self) -> Self {
        self.primary = true;
        self
    }

    fn approve_style(&self) -> bool {
        let mut glyph = self.glyph.chars();
        match (glyph.next(), glyph.next(), self.label.chars().next()) {
            (Some(g), None, Some(first)) => {
                g.is_ascii_alphabetic() && g.eq_ignore_ascii_case(&first)
            }
            _ => false,
        }
    }
}

fn has_divider(i: usize, divider_after: Option<&[usize]>) -> bool {
    i > 0 && divider_after.is_none_or(|after| after.contains(&(i - 1)))
}

/// Cells the bar occupies; independent of theme and focus.
pub fn action_bar_width(items: &[ActionItem], divider_after: Option<&[usize]>) -> u16 {
    let mut w = 0usize;
    for (i, item) in items.iter().enumerate() {
        if has_divider(i, divider_after) {
            w += 3;
        }
        w += if item.approve_style() {
            item.label.width() + 2
        } else {
            item.glyph.width() + 1 + item.label.width()
        };
    }
    w.min(u16::MAX as usize) as u16
}

/// The bar as one line. `focused` paints that item on the selection
/// background; dividers fall between every pair unless `divider_after`
/// lists the indices they follow.
pub fn action_bar_line(
    items: &[ActionItem],
    focused: Option<usize>,
    divider_after: Option<&[usize]>,
    paint: Paint,
) -> Line<'static> {
    let t = &paint.theme.action_bar;
    let mut spans = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let is_focused = focused == Some(i);
        let bg = is_focused.then(|| paint.color(&t.selected_bg));
        let with_bg = |style: Style| match bg {
            Some(bg) => style.bg(bg),
            None => style,
        };
        if has_divider(i, divider_after) {
            spans.push(Span::styled(
                " │ ",
                Style::default().fg(paint.color(&t.separator)),
            ));
        }
        if item.approve_style() {
            let default_accent = paint.color(match (item.primary, is_focused) {
                (true, true) => &t.selected_shortcut_primary,
                (true, false) => &t.shortcut_primary,
                (false, true) => &t.selected_shortcut,
                (false, false) => &t.shortcut,
            });
            let default_tail = paint.color(if is_focused { &t.selected } else { &t.label });
            let accent = item.flash_color.unwrap_or(default_accent);
            let tail = item.flash_color.unwrap_or(default_tail);
            let mut chars = item.label.chars();
            let head = chars.next().map(String::from).unwrap_or_default();
            let rest: String = chars.collect();
            let mut head_style = Style::default().fg(accent).add_modifier(Modifier::BOLD);
            if item.flash_color.is_none() {
                head_style = head_style.add_modifier(Modifier::UNDERLINED);
            }
            let mut tail_style = Style::default().fg(tail);
            if is_focused {
                tail_style = tail_style.add_modifier(Modifier::BOLD);
            }
            spans.push(Span::styled(" ", with_bg(Style::default())));
            spans.push(Span::styled(head, with_bg(head_style)));
            spans.push(Span::styled(rest, with_bg(tail_style)));
            spans.push(Span::styled(" ", with_bg(Style::default())));
        } else {
            let glyph_color = paint.color(if item.primary {
                &t.shortcut_primary
            } else {
                &t.shortcut
            });
            spans.push(Span::styled(
                item.glyph.clone(),
                with_bg(
                    Style::default()
                        .fg(glyph_color)
                        .add_modifier(Modifier::BOLD),
                ),
            ));
            spans.push(Span::styled(
                format!(" {}", item.label),
                with_bg(Style::default().fg(paint.color(&t.label))),
            ));
        }
    }
    Line::from(spans)
}
