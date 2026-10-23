//! A multi-select list with braille section headers and a pointer cursor.

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_width::UnicodeWidthStr;

use super::Paint;

const BRAILLE: &str = "⠶";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChecklistItem {
    Option {
        label: String,
        value: String,
        /// Shown after the checkbox when nerd fonts are on.
        icon: Option<String>,
    },
    Header {
        label: String,
    },
}

impl ChecklistItem {
    pub fn option(label: impl Into<String>, value: impl Into<String>) -> Self {
        Self::Option {
            label: label.into(),
            value: value.into(),
            icon: None,
        }
    }

    pub fn with_icon(self, icon: impl Into<String>) -> Self {
        match self {
            Self::Option { label, value, .. } => Self::Option {
                label,
                value,
                icon: Some(icon.into()),
            },
            header => header,
        }
    }

    pub fn header(label: impl Into<String>) -> Self {
        Self::Header {
            label: label.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChecklistEvent {
    Idle,
    Toggled(String),
    Submit(Vec<String>),
}

#[derive(Clone, Debug)]
pub struct Checklist {
    items: Vec<ChecklistItem>,
    /// Checked values in the order they were checked.
    checked: Vec<String>,
    cursor_pos: usize,
    /// Total width available to headers with dot leaders and focus fill.
    width: Option<u16>,
    allow_empty_submit: bool,
}

impl Checklist {
    pub fn new(items: Vec<ChecklistItem>) -> Self {
        Self {
            items,
            checked: Vec::new(),
            cursor_pos: 0,
            width: None,
            allow_empty_submit: false,
        }
    }

    pub fn with_checked<I: IntoIterator<Item = S>, S: Into<String>>(mut self, values: I) -> Self {
        self.checked = values.into_iter().map(Into::into).collect();
        self
    }

    pub fn with_width(mut self, width: u16) -> Self {
        self.width = Some(width);
        self
    }

    /// Enter submits an empty selection too.
    pub fn allow_empty_submit(mut self) -> Self {
        self.allow_empty_submit = true;
        self
    }

    pub fn checked(&self) -> &[String] {
        &self.checked
    }

    pub fn is_checked(&self, value: &str) -> bool {
        self.checked.iter().any(|v| v == value)
    }

    pub fn toggle(&mut self, value: &str) {
        if let Some(i) = self.checked.iter().position(|v| v == value) {
            self.checked.remove(i);
        } else {
            self.checked.push(value.to_string());
        }
    }

    fn selectable(&self) -> Vec<usize> {
        self.items
            .iter()
            .enumerate()
            .filter_map(|(i, item)| matches!(item, ChecklistItem::Option { .. }).then_some(i))
            .collect()
    }

    fn cursor_index(&self) -> usize {
        self.selectable().get(self.cursor_pos).copied().unwrap_or(0)
    }

    /// The value under the cursor.
    pub fn focused(&self) -> Option<&str> {
        match self.items.get(self.cursor_index()) {
            Some(ChecklistItem::Option { value, .. }) => Some(value),
            _ => None,
        }
    }

    pub fn key(&mut self, key: KeyEvent) -> ChecklistEvent {
        if key.kind == KeyEventKind::Release {
            return ChecklistEvent::Idle;
        }
        match key.code {
            KeyCode::Up => {
                self.cursor_pos = self.cursor_pos.saturating_sub(1);
                ChecklistEvent::Idle
            }
            KeyCode::Down => {
                let last = self.selectable().len().saturating_sub(1);
                self.cursor_pos = (self.cursor_pos + 1).min(last);
                ChecklistEvent::Idle
            }
            KeyCode::Char(' ') => match self.focused().map(str::to_string) {
                Some(value) => {
                    self.toggle(&value);
                    ChecklistEvent::Toggled(value)
                }
                None => ChecklistEvent::Idle,
            },
            KeyCode::Enter if !self.checked.is_empty() || self.allow_empty_submit => {
                ChecklistEvent::Submit(self.checked.clone())
            }
            _ => ChecklistEvent::Idle,
        }
    }

    pub fn lines(&self, paint: Paint) -> Vec<Line<'static>> {
        let t = &paint.theme.checklist;
        let cursor_index = self.cursor_index();
        let mut lines = Vec::new();
        for (i, item) in self.items.iter().enumerate() {
            match item {
                ChecklistItem::Header { label } => {
                    if i > 0 {
                        lines.push(Line::from(" "));
                    }
                    lines.push(self.header_line(label, paint));
                }
                ChecklistItem::Option { label, value, icon } => {
                    let focused = i == cursor_index;
                    let checked = self.is_checked(value);
                    let tick = if checked { "[✓]" } else { "[ ]" };
                    let checkbox = match icon.as_ref().filter(|_| paint.nerd_fonts) {
                        Some(icon) => format!("{tick} {icon} "),
                        None => tick.to_string(),
                    };
                    let pointer = if focused { " ❯" } else { "  " };
                    let row_text = format!("{pointer} {checkbox} {label}");
                    let color = paint.color(if focused {
                        &t.row_focused
                    } else if checked {
                        &t.row_checked
                    } else {
                        &t.row
                    });
                    let mut style = Style::default().fg(color);
                    let mut fill = Style::default();
                    if focused {
                        let bg = paint.color(&t.row_focused_bg);
                        style = style.bg(bg);
                        fill = fill.bg(bg);
                    }
                    let pad = self
                        .width
                        .map_or(0, |w| usize::from(w).saturating_sub(row_text.width()));
                    let mut spans = vec![Span::styled(row_text, style)];
                    if focused && pad > 0 {
                        spans.push(Span::styled(" ".repeat(pad), fill));
                    }
                    lines.push(Line::from(spans));
                }
            }
        }
        lines
    }

    fn header_line(&self, label: &str, paint: Paint) -> Line<'static> {
        let t = &paint.theme.checklist;
        let upper = label.to_uppercase();
        let show_braille = self
            .width
            .is_none_or(|w| usize::from(w) >= label.chars().count() + 8);
        let text = if show_braille {
            format!(" {upper} ")
        } else {
            upper
        };
        let trail = match self.width {
            Some(w) if show_braille => usize::from(w).saturating_sub(text.chars().count() + 2),
            _ => 0,
        };
        let rule = Style::default().fg(paint.color(&t.section_rule));
        let mut spans = Vec::new();
        if show_braille {
            spans.push(Span::styled(BRAILLE.repeat(2), rule));
        }
        spans.push(Span::styled(
            text,
            Style::default()
                .fg(paint.color(&t.section_label))
                .add_modifier(Modifier::BOLD),
        ));
        if trail > 0 {
            spans.push(Span::styled(BRAILLE.repeat(trail), rule));
        }
        Line::from(spans)
    }

    pub fn height(&self) -> u16 {
        self.items
            .iter()
            .enumerate()
            .map(|(i, item)| match item {
                ChecklistItem::Header { .. } if i > 0 => 2,
                _ => 1,
            })
            .sum()
    }

    pub fn render(&self, buf: &mut Buffer, area: Rect, paint: Paint) {
        for (row, line) in self.lines(paint).iter().enumerate() {
            let y = area.y + row as u16;
            if y >= area.bottom() {
                break;
            }
            buf.set_line(area.x, y, line, area.width);
        }
    }
}
