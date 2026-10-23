//! A single-choice picker: `❯` marks focus, `✔` the chosen value, and the
//! option list scrolls inside a fixed window.

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};

use super::Paint;

const DEFAULT_VISIBLE: usize = 5;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelectOption {
    pub label: String,
    pub value: String,
}

impl SelectOption {
    pub fn new(label: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            value: value.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SelectEvent {
    Idle,
    Moved,
    Submit(String),
}

#[derive(Clone, Debug)]
pub struct Select {
    options: Vec<SelectOption>,
    focused: usize,
    selected: Option<usize>,
    visible: usize,
    from: usize,
}

impl Select {
    pub fn new(options: Vec<SelectOption>) -> Self {
        Self {
            options,
            focused: 0,
            selected: None,
            visible: DEFAULT_VISIBLE,
            from: 0,
        }
    }

    pub fn with_visible_option_count(mut self, count: usize) -> Self {
        self.visible = count.max(1);
        self
    }

    pub fn focused_value(&self) -> Option<&str> {
        self.options.get(self.focused).map(|o| o.value.as_str())
    }

    pub fn key(&mut self, key: KeyEvent) -> SelectEvent {
        if key.kind == KeyEventKind::Release || self.options.is_empty() {
            return SelectEvent::Idle;
        }
        match key.code {
            KeyCode::Up if self.focused > 0 => {
                self.focused -= 1;
                if self.focused < self.from {
                    self.from = self.focused;
                }
                SelectEvent::Moved
            }
            KeyCode::Down if self.focused + 1 < self.options.len() => {
                self.focused += 1;
                if self.focused >= self.from + self.visible {
                    self.from = self.focused + 1 - self.visible;
                }
                SelectEvent::Moved
            }
            KeyCode::Enter => {
                self.selected = Some(self.focused);
                SelectEvent::Submit(self.options[self.focused].value.clone())
            }
            _ => SelectEvent::Idle,
        }
    }

    pub fn lines(&self, paint: Paint) -> Vec<Line<'static>> {
        let t = &paint.theme.picker;
        self.options
            .iter()
            .enumerate()
            .skip(self.from)
            .take(self.visible)
            .map(|(i, option)| {
                let focused = i == self.focused;
                let selected = self.selected == Some(i);
                let label_color = paint.color(if focused {
                    &t.option_focused
                } else if selected {
                    &t.option_selected
                } else {
                    &t.option
                });
                let mut spans = vec![if focused {
                    Span::styled("❯ ", Style::default().fg(paint.color(&t.focus_indicator)))
                } else {
                    Span::raw("  ")
                }];
                spans.push(Span::styled(
                    option.label.clone(),
                    Style::default().fg(label_color),
                ));
                if selected {
                    spans.push(Span::styled(
                        " ✔",
                        Style::default().fg(paint.color(&t.selected_indicator)),
                    ));
                }
                Line::from(spans)
            })
            .collect()
    }

    pub fn height(&self) -> u16 {
        self.options.len().min(self.visible) as u16
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
