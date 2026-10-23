//! The wizard's welcome section: the gradient logo and setup blurb, with
//! the brain animation beside them when the terminal has room.

use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_width::UnicodeWidthStr;

use super::frame::{DIALOG_CHROME_HEIGHT, DIALOG_CHROME_WIDTH, DialogFrame};
use super::welcome_frames::{AnimationFrame, CANVAS_HEIGHT, CANVAS_WIDTH, FRAMES};
use super::widgets::{ActionItem, Paint, action_bar_line};
use super::wizard_dialog::{WIZARD_CONTENT_WIDTH, render_body};
use crate::ansi::{Rgb, interpolate};

pub const LOGO: [&str; 6] = [
    "██╗    ██╗██████╗  █████╗ ██████╗ ",
    "██║    ██║██╔══██╗██╔══██╗██╔══██╗",
    "██║ █╗ ██║██████╔╝███████║██████╔╝",
    "██║███╗██║██╔══██╗██╔══██║██╔═══╝ ",
    "╚███╔███╔╝██║  ██║██║  ██║██║     ",
    " ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ",
];

/// How long the first frame holds before the sweep starts.
pub const START_HOLD_MS: f64 = 1000.0;
/// Frame durations are stretched by this factor.
pub const FRAME_DURATION_SCALE: f64 = 1.5;

const ANIMATION_GAP: u16 = 4;
const ANIMATION_CONTENT_WIDTH: u16 = WIZARD_CONTENT_WIDTH + ANIMATION_GAP + CANVAS_WIDTH;
/// Terminal size at which the two-column layout with the animation is used.
pub const ANIMATION_MIN_TERM_COLS: u16 = ANIMATION_CONTENT_WIDTH + DIALOG_CHROME_WIDTH;
pub const ANIMATION_MIN_TERM_ROWS: u16 = CANVAS_HEIGHT + DIALOG_CHROME_HEIGHT;
const PAD_LEFT: usize = 3;
const BLURB: &str = "Quick one-time setup — pick your AI provider and a couple of preferences.";

/// The next frame of the one-shot sweep and how long to wait for it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AnimationStep {
    pub next_index: usize,
    pub delay_ms: f64,
}

/// Frame 0 holds for [`START_HOLD_MS`]; later frames advance by their own
/// scaled duration; the last frame is held forever. Lists shorter than two
/// frames never step.
pub fn next_step(index: usize, frames: &[AnimationFrame]) -> Option<AnimationStep> {
    let last = frames.len().checked_sub(1)?;
    if last == 0 || index >= last {
        return None;
    }
    if index == 0 {
        return Some(AnimationStep {
            next_index: 1,
            delay_ms: START_HOLD_MS,
        });
    }
    Some(AnimationStep {
        next_index: index + 1,
        delay_ms: frames[index].duration_ms * FRAME_DURATION_SCALE,
    })
}

/// Whether a terminal of this size shows the animation column.
pub fn shows_animation(cols: u16, rows: u16) -> bool {
    cols >= ANIMATION_MIN_TERM_COLS && rows >= ANIMATION_MIN_TERM_ROWS
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WelcomeExit {
    Continue,
    Cancel,
}

#[derive(Clone, Debug)]
pub struct WelcomeSection {
    frame_index: usize,
    /// When the current frame started showing.
    frame_started: Instant,
}

impl WelcomeSection {
    pub fn new(now: Instant) -> Self {
        Self {
            frame_index: 0,
            frame_started: now,
        }
    }

    pub fn frame_index(&self) -> usize {
        self.frame_index
    }

    /// True once the sweep has parked on the last frame.
    pub fn finished(&self) -> bool {
        next_step(self.frame_index, &FRAMES).is_none()
    }

    /// Advances past every frame whose time has come by `now`; reports
    /// whether the frame on screen changed.
    pub fn advance(&mut self, now: Instant) -> bool {
        let mut changed = false;
        while let Some(step) = next_step(self.frame_index, &FRAMES) {
            let due = self.frame_started + Duration::from_secs_f64(step.delay_ms / 1000.0);
            if now < due {
                break;
            }
            self.frame_index = step.next_index;
            self.frame_started = due;
            changed = true;
        }
        changed
    }

    pub fn key(&mut self, key: KeyEvent) -> Option<WelcomeExit> {
        if key.kind == KeyEventKind::Release {
            return None;
        }
        match key.code {
            KeyCode::Enter => Some(WelcomeExit::Continue),
            KeyCode::Esc => Some(WelcomeExit::Cancel),
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                Some(WelcomeExit::Cancel)
            }
            _ => None,
        }
    }

    /// Draws the whole dialog (frame included) into `area` and applies the
    /// color level.
    pub fn render_to(&self, buf: &mut Buffer, area: Rect, paint: Paint) {
        let animated = shows_animation(area.width, area.height);
        let content_width = if animated {
            ANIMATION_CONTENT_WIDTH
        } else {
            WIZARD_CONTENT_WIDTH
        };
        let frame = DialogFrame::new(paint.theme.wizard.frame, content_width, paint);
        let wrap_width = usize::from(
            WIZARD_CONTENT_WIDTH
                .min(frame.inner_width(area.width))
                .saturating_sub(PAD_LEFT as u16),
        );
        let lines = if animated {
            self.two_column_lines(paint, wrap_width)
        } else {
            self.stacked_lines(paint, wrap_width)
        };
        render_body(buf, area, paint, &frame, lines);
    }

    /// Logo, tagline, blurb (word-wrapped to `wrap_width`) and the timing
    /// note, with the blank rows between them.
    fn text_block(&self, paint: Paint, wrap_width: usize) -> Vec<Line<'static>> {
        let theme = paint.theme;
        let body = Style::default();
        let mut lines = Vec::new();
        let stops = theme.wizard.welcome_logo;
        for (i, row) in LOGO.iter().enumerate() {
            let color = row_color(paint, &stops, i, LOGO.len());
            lines.push(Line::from(Span::styled(
                *row,
                Style::default().fg(color).add_modifier(Modifier::BOLD),
            )));
        }
        lines.push(Line::from(vec![
            Span::styled("a cli with ", body),
            Span::styled(
                "taste",
                Style::default()
                    .fg(paint.color(&theme.copy.pop))
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(" (yours)", body),
        ]));
        lines.push(Line::default());
        lines.push(Line::default());
        for row in wrap_words(BLURB, wrap_width) {
            lines.push(Line::from(Span::styled(row, body)));
        }
        lines.push(Line::default());
        lines.push(Line::default());
        lines.push(Line::from(vec![
            Span::styled("◷ Takes ", body),
            Span::styled(
                "~45 seconds.",
                Style::default().fg(paint.color(&theme.copy.success)),
            ),
        ]));
        lines.push(Line::default());
        lines
    }

    fn hints(&self, paint: Paint) -> Line<'static> {
        action_bar_line(
            &[
                ActionItem::new("⏎", "to continue").primary(),
                ActionItem::new("Esc", "to cancel"),
            ],
            None,
            None,
            paint,
        )
    }

    fn stacked_lines(&self, paint: Paint, wrap_width: usize) -> Vec<Line<'static>> {
        let mut lines: Vec<Line<'static>> = self
            .text_block(paint, wrap_width)
            .into_iter()
            .map(pad_left)
            .collect();
        lines.push(Line::default());
        lines.push(pad_left(self.hints(paint)));
        lines
    }

    /// The copy centered in a [`CANVAS_HEIGHT`]-row left column with the
    /// hints on its last row, and the animation frame on the right.
    fn two_column_lines(&self, paint: Paint, wrap_width: usize) -> Vec<Line<'static>> {
        let text = self.text_block(paint, wrap_width);
        let rows = usize::from(CANVAS_HEIGHT);
        let text_area = rows - 1;
        let text_len = text.len();
        let offset = text_area.saturating_sub(text_len) / 2;
        let frame = &FRAMES[self.frame_index.min(FRAMES.len() - 1)];
        let stops = paint.theme.wizard.welcome_brain;
        let mut text = text.into_iter();
        (0..rows)
            .map(|row| {
                let left = if row == rows - 1 {
                    pad_left(self.hints(paint))
                } else if row >= offset && row < offset + text_len {
                    pad_left(text.next().unwrap_or_default())
                } else {
                    Line::default()
                };
                let mut spans = left.spans;
                let used: usize = spans.iter().map(|s| s.content.width()).sum();
                let gap = usize::from(WIZARD_CONTENT_WIDTH + ANIMATION_GAP).saturating_sub(used);
                spans.push(Span::raw(" ".repeat(gap)));
                spans.push(Span::styled(
                    frame.content[row],
                    Style::default().fg(row_color(paint, stops, row, rows)),
                ));
                Line::from(spans)
            })
            .collect()
    }
}

/// Greedy word wrap by display width; a word wider than `width` gets its
/// own row.
fn wrap_words(text: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    let mut rows = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        if current.is_empty() {
            current = word.to_string();
        } else if current.width() + 1 + word.width() <= width {
            current.push(' ');
            current.push_str(word);
        } else {
            rows.push(std::mem::replace(&mut current, word.to_string()));
        }
    }
    if !current.is_empty() || rows.is_empty() {
        rows.push(current);
    }
    rows
}

fn pad_left(line: Line<'static>) -> Line<'static> {
    let mut spans = vec![Span::raw(" ".repeat(PAD_LEFT))];
    spans.extend(line.spans);
    Line::from(spans)
}

/// Row `index` of `total` on a multi-stop OKLAB gradient; below truecolor
/// every row takes the body text color.
fn row_color(paint: Paint, stops: &[Rgb], index: usize, total: usize) -> Color {
    if paint.level < 3 {
        return paint.color(&paint.theme.copy.body);
    }
    let t = if total > 1 {
        index as f32 / (total - 1) as f32
    } else {
        0.0
    };
    let (r, g, b) = interpolate(stops, t);
    Color::Rgb(r, g, b)
}
