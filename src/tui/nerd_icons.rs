//! The wizard's nerd-icons detection screen: four test glyphs and a yes/no
//! choice that decides whether later screens render Nerd Font icons.

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};

use super::frame::{Align, DialogFrame, TopBadge};
use super::widgets::{ActionItem, Paint, action_bar_line};
use super::wizard_dialog::{WIZARD_CONTENT_WIDTH, render_body, wizard_label_pill};

/// Star Wars glyphs: death star, rebel, galactic republic, empire.
pub const NERD_TEST_ICONS: [&str; 4] = ["\u{F08D9}", "\u{F1D0}", "\u{EDD6}", "\u{F1D1}"];
const OPTIONS: [&str; 2] = [
    "Yes — enable icons throughout Wrap",
    "No — they look like boxes or question marks",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NerdIconsExit {
    /// `true` when the user sees the icons.
    Selected(bool),
    Cancel,
}

#[derive(Clone, Debug, Default)]
pub struct NerdIconsSection {
    /// 0 = Yes, 1 = No.
    cursor: usize,
}

impl NerdIconsSection {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cursor(&self) -> usize {
        self.cursor
    }

    pub fn key(&mut self, key: KeyEvent) -> Option<NerdIconsExit> {
        if key.kind == KeyEventKind::Release {
            return None;
        }
        match key.code {
            KeyCode::Up | KeyCode::Down | KeyCode::Left | KeyCode::Right => {
                self.cursor = 1 - self.cursor;
                None
            }
            KeyCode::Enter => Some(NerdIconsExit::Selected(self.cursor == 0)),
            KeyCode::Esc => Some(NerdIconsExit::Cancel),
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                Some(NerdIconsExit::Cancel)
            }
            _ => None,
        }
    }

    /// Draws the whole dialog (frame included) into `area` and applies the
    /// color level.
    pub fn render_to(&self, buf: &mut Buffer, area: Rect, paint: Paint) {
        let theme = paint.theme;
        let frame = DialogFrame::new(theme.wizard.frame, WIZARD_CONTENT_WIDTH, paint)
            .with_top(TopBadge::new(wizard_label_pill(theme), Align::Left));
        let body = Style::default().fg(paint.color(&theme.copy.body));
        let marker = paint.color(&theme.wizard.nerd_choice_marker);
        let muted = paint.color(&theme.wizard.nerd_choice_label);
        let bright = paint.color(&theme.wizard.nerd_choice_selected_label);
        let mut lines = vec![
            Line::from(Span::styled("Do you see four icons below?", body)),
            Line::default(),
            Line::from(Span::styled(
                format!("    {}", NERD_TEST_ICONS.join("  ")),
                body,
            )),
            Line::default(),
        ];
        for (i, label) in OPTIONS.iter().enumerate() {
            let focused = i == self.cursor;
            lines.push(Line::from(vec![
                Span::styled(
                    if focused { "  ❯ " } else { "    " },
                    Style::default().fg(if focused { marker } else { muted }),
                ),
                Span::styled(
                    *label,
                    Style::default().fg(if focused { bright } else { muted }),
                ),
            ]));
        }
        lines.push(Line::default());
        let bar = action_bar_line(
            &[
                ActionItem::new("↑↓", "to move"),
                ActionItem::new("⏎", "to select").primary(),
            ],
            None,
            None,
            paint,
        );
        let mut spans = vec![Span::raw("   ")];
        spans.extend(bar.spans);
        lines.push(Line::from(spans));
        render_body(buf, area, paint, &frame, lines);
    }
}
