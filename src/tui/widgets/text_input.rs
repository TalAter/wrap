//! The input strip: a full-width surface with one cell of horizontal
//! padding holding read-only text, a single-line (optionally masked) editor,
//! or a multiline composer with hard wrapping and a scrolling row window.

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Paragraph, Widget, Wrap};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use super::{Cursor, Paint};

/// Buffers are capped so a paste bomb cannot stall rendering.
pub const MAX_BUFFER_BYTES: usize = 256 * 1024;
const EDITOR_NOTICE: &str = "... Save and close editor to continue ...";

/// Caps `text` at [`MAX_BUFFER_BYTES`] on a char boundary. Returns the text
/// and whether it was cut.
pub fn clamp_buffer_size(text: &str) -> (String, bool) {
    if text.len() <= MAX_BUFFER_BYTES {
        return (text.to_string(), false);
    }
    let mut end = MAX_BUFFER_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true)
}

/// What a key or paste did to the buffer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InputEvent {
    Idle,
    Changed { truncated: bool },
    Submit(String),
}

/// Terminal-dependent layout for unmasked editable text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InputLayout {
    /// Column at which long logical lines hard-wrap into visual rows.
    pub wrap_width: u16,
    /// Visible visual rows; the window scrolls to keep the cursor in view.
    /// `None` shows every row.
    pub max_rows: Option<u16>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Single { masked: bool },
    Multi,
}

/// The editable strip. Enter submits (newlines in multiline come from
/// Shift+Enter, Ctrl+J or a trailing backslash), Esc is left to the owner.
#[derive(Clone, Debug)]
pub struct TextInput {
    cursor: Cursor,
    killed: Option<String>,
    mode: Mode,
    placeholder: Option<String>,
    editing_external: bool,
}

impl TextInput {
    pub fn single_line(value: impl Into<String>) -> Self {
        Self::with_mode(value, Mode::Single { masked: false })
    }

    /// Renders every character as a bullet; the buffer keeps the real text.
    pub fn masked(value: impl Into<String>) -> Self {
        Self::with_mode(value, Mode::Single { masked: true })
    }

    pub fn multiline(value: impl Into<String>) -> Self {
        Self::with_mode(value, Mode::Multi)
    }

    fn with_mode(value: impl Into<String>, mode: Mode) -> Self {
        Self {
            cursor: Cursor::at_end(value),
            killed: None,
            mode,
            placeholder: None,
            editing_external: false,
        }
    }

    pub fn with_placeholder(mut self, placeholder: impl Into<String>) -> Self {
        self.placeholder = Some(placeholder.into());
        self
    }

    pub fn set_placeholder(&mut self, placeholder: impl Into<String>) {
        self.placeholder = Some(placeholder.into());
    }

    pub fn text(&self) -> &str {
        self.cursor.text()
    }

    pub fn cursor(&self) -> &Cursor {
        &self.cursor
    }

    /// Replaces the buffer and parks the cursor at the end.
    pub fn set_text(&mut self, text: impl Into<String>) {
        self.cursor = Cursor::at_end(text);
    }

    /// While an external GUI editor owns the text the strip shows a notice
    /// and swallows input.
    pub fn set_editing_external(&mut self, editing: bool) {
        self.editing_external = editing;
    }

    pub fn editing_external(&self) -> bool {
        self.editing_external
    }

    fn multiline_mode(&self) -> bool {
        self.mode == Mode::Multi
    }

    fn changed(&self, before: &str) -> InputEvent {
        if self.text() == before {
            InputEvent::Idle
        } else {
            InputEvent::Changed { truncated: false }
        }
    }

    /// Inserts `s`, clamping the buffer to the cap; reports truncation.
    fn insert_clamped(&mut self, s: &str) -> InputEvent {
        let before = self.text().to_string();
        let mut combined = String::with_capacity(before.len() + s.len());
        combined.push_str(self.cursor.before());
        combined.push_str(s);
        let inserted_end = combined.len();
        combined.push_str(&self.text()[self.cursor.offset()..]);
        let (clamped, truncated) = clamp_buffer_size(&combined);
        let offset = inserted_end.min(clamped.len());
        self.cursor = Cursor::new(clamped, offset);
        if self.text() == before && !truncated {
            InputEvent::Idle
        } else {
            InputEvent::Changed { truncated }
        }
    }

    pub fn key(&mut self, key: KeyEvent) -> InputEvent {
        if key.kind == KeyEventKind::Release || self.editing_external {
            return InputEvent::Idle;
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        let shift = key.modifiers.contains(KeyModifiers::SHIFT);
        let multiline = self.multiline_mode();
        let before = self.text().to_string();
        match key.code {
            KeyCode::Enter => {
                if multiline && shift {
                    return self.insert_clamped("\n");
                }
                if multiline
                    && self.text().ends_with('\\')
                    && self.cursor.offset() == self.text().len()
                {
                    let mut stripped = self.text()[..self.text().len() - 1].to_string();
                    stripped.push('\n');
                    self.cursor = Cursor::at_end(stripped);
                    return InputEvent::Changed { truncated: false };
                }
                if multiline && self.text().is_empty() {
                    return InputEvent::Idle;
                }
                InputEvent::Submit(self.text().to_string())
            }
            KeyCode::Char('j') if ctrl && multiline => self.insert_clamped("\n"),
            KeyCode::Backspace if alt => {
                if let Some(killed) = self.cursor.delete_word() {
                    self.killed = Some(killed);
                }
                self.changed(&before)
            }
            KeyCode::Backspace => {
                self.cursor.backspace();
                self.changed(&before)
            }
            KeyCode::Delete => {
                self.cursor.delete();
                self.changed(&before)
            }
            KeyCode::Left if alt => {
                self.cursor.word_left();
                InputEvent::Idle
            }
            KeyCode::Right if alt => {
                self.cursor.word_right();
                InputEvent::Idle
            }
            KeyCode::Left => {
                self.cursor.left();
                InputEvent::Idle
            }
            KeyCode::Right => {
                self.cursor.right();
                InputEvent::Idle
            }
            KeyCode::Home => {
                self.cursor.home();
                InputEvent::Idle
            }
            KeyCode::End => {
                self.cursor.end();
                InputEvent::Idle
            }
            KeyCode::Up if multiline => {
                self.cursor.up_line();
                InputEvent::Idle
            }
            KeyCode::Down if multiline => {
                self.cursor.down_line();
                InputEvent::Idle
            }
            KeyCode::Char(c) if ctrl => {
                match c {
                    'a' => self.cursor.home(),
                    'e' => self.cursor.end(),
                    'u' => {
                        if let Some(killed) = self.cursor.kill_to_home() {
                            self.killed = Some(killed);
                        }
                    }
                    'k' => {
                        if let Some(killed) = self.cursor.kill_to_end() {
                            self.killed = Some(killed);
                        }
                    }
                    'y' => {
                        let killed = self.killed.clone();
                        return match killed {
                            Some(k) => self.insert_clamped(&k),
                            None => InputEvent::Idle,
                        };
                    }
                    _ => {}
                }
                self.changed(&before)
            }
            KeyCode::Char(c) if alt => {
                match c {
                    'b' => self.cursor.word_left(),
                    'f' => self.cursor.word_right(),
                    _ => {}
                }
                InputEvent::Idle
            }
            KeyCode::Char(c) => {
                let mut buf = [0u8; 4];
                self.insert_clamped(c.encode_utf8(&mut buf))
            }
            _ => InputEvent::Idle,
        }
    }

    /// Bracketed paste: CRLF collapses to LF and other control bytes drop
    /// (tab survives); single-line strips newlines outright.
    pub fn paste(&mut self, raw: &str) -> InputEvent {
        if self.editing_external {
            return InputEvent::Idle;
        }
        let cleaned: String = if self.multiline_mode() {
            sanitize_paste(raw)
        } else {
            raw.chars().filter(|c| *c != '\r' && *c != '\n').collect()
        };
        self.insert_clamped(&cleaned)
    }

    /// The strip for this terminal layout. Masked inputs ignore `layout`.
    pub fn frame(&self, paint: Paint, layout: Option<InputLayout>) -> InputFrame {
        let t = &paint.theme.input;
        if self.editing_external {
            return InputFrame::centered(Span::styled(
                EDITOR_NOTICE,
                Style::default().fg(paint.color(&t.editor_status)),
            ));
        }
        let text_style = Style::default().fg(paint.color(&t.text));
        let cursor_style = text_style.add_modifier(Modifier::REVERSED);
        let placeholder = self
            .placeholder
            .as_ref()
            .filter(|_| self.text().is_empty())
            .map(|p| Span::styled(p.clone(), Style::default().fg(paint.color(&t.placeholder))));
        match self.mode {
            Mode::Single { masked } if masked || layout.is_none() => {
                let (before, at, after) = if masked {
                    (
                        mask(self.cursor.before()),
                        if self.cursor.at() == " " { " " } else { "•" }.to_string(),
                        mask(self.cursor.after()),
                    )
                } else {
                    (
                        self.cursor.before().to_string(),
                        match self.cursor.at() {
                            "\n" => " \n",
                            at => at,
                        }
                        .to_string(),
                        self.cursor.after().to_string(),
                    )
                };
                let mut spans = vec![
                    Span::styled(before, text_style),
                    Span::styled(at, cursor_style),
                    Span::styled(after, text_style),
                ];
                spans.extend(placeholder);
                let mut lines = Vec::new();
                let mut line = Line::default();
                for span in spans {
                    for (i, text) in span.content.split('\n').enumerate() {
                        if i > 0 {
                            lines.push(std::mem::take(&mut line));
                        }
                        line.spans.push(Span::styled(text.to_string(), span.style));
                    }
                }
                lines.push(line);
                InputFrame::wrapped(lines)
            }
            _ => {
                let layout = layout.unwrap_or(InputLayout {
                    wrap_width: u16::MAX,
                    max_rows: None,
                });
                let rows = visual_rows(self.text(), layout.wrap_width, self.cursor.offset());
                let cursor_row = rows
                    .iter()
                    .position(|row| {
                        self.cursor.offset() >= row.start && self.cursor.offset() < row.next_start
                    })
                    .unwrap_or(rows.len().saturating_sub(1));
                let max_rows = layout
                    .max_rows
                    .map_or(rows.len(), |m| usize::from(m).max(1));
                let top = rows
                    .len()
                    .saturating_sub(max_rows)
                    .min(cursor_row.saturating_add(1).saturating_sub(max_rows));
                let top = top.min(cursor_row);
                let mut lines = Vec::new();
                for (i, row) in rows.iter().enumerate().skip(top).take(max_rows) {
                    let text = &self.text()[row.start..row.end];
                    if i == cursor_row {
                        let local = self
                            .cursor
                            .offset()
                            .saturating_sub(row.start)
                            .min(text.len());
                        let before = &text[..local];
                        let after = &text[local..];
                        let (at, rest) = match after.graphemes(true).next() {
                            Some(g) => (g.to_string(), &after[g.len()..]),
                            None => (" ".to_string(), after),
                        };
                        let mut spans = vec![
                            Span::styled(before.to_string(), text_style),
                            Span::styled(at, cursor_style),
                            Span::styled(rest.to_string(), text_style),
                        ];
                        spans.extend(placeholder.clone());
                        lines.push(Line::from(spans));
                    } else {
                        lines.push(Line::from(Span::styled(text.to_string(), text_style)));
                    }
                }
                InputFrame::rows(lines)
            }
        }
    }
}

fn mask(text: &str) -> String {
    "•".repeat(text.graphemes(true).count())
}

fn sanitize_paste(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                    out.push('\n');
                }
            }
            '\n' | '\t' => out.push(c),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// One visual row of the multiline composer: a byte range of the buffer and
/// the start of the following row (the newline between logical lines belongs
/// to the row before it). A cursor sitting just past a row that exactly fills
/// the width gets an empty row of its own so it stays visible.
struct VisualRow {
    start: usize,
    end: usize,
    next_start: usize,
}

fn visual_rows(text: &str, wrap_width: u16, cursor: usize) -> Vec<VisualRow> {
    let wrap_width = usize::from(wrap_width).max(1);
    let mut rows = Vec::new();
    let mut line_start = 0;
    for line in text.split('\n') {
        let line_end = line_start + line.len();
        if line.is_empty() {
            rows.push(VisualRow {
                start: line_start,
                end: line_end,
                next_start: line_end + 1,
            });
        } else {
            let mut chunk_start = line_start;
            let mut width = 0;
            for (i, g) in line.grapheme_indices(true) {
                let gw = g.width().max(1);
                if width + gw > wrap_width && width > 0 {
                    rows.push(VisualRow {
                        start: chunk_start,
                        end: line_start + i,
                        next_start: line_start + i,
                    });
                    chunk_start = line_start + i;
                    width = 0;
                }
                width += gw;
            }
            if width == wrap_width && cursor == line_end {
                rows.push(VisualRow {
                    start: chunk_start,
                    end: line_end,
                    next_start: line_end,
                });
                chunk_start = line_end;
            }
            rows.push(VisualRow {
                start: chunk_start,
                end: line_end,
                next_start: line_end + 1,
            });
        }
        line_start = line_end + 1;
    }
    if let Some(last) = rows.last_mut() {
        last.next_start = usize::MAX;
    }
    rows
}

/// The surface strip itself: background across the full width, one cell of
/// padding on each side, text that either word-wraps to the width or arrives
/// pre-wrapped as rows.
#[derive(Clone, Debug)]
pub struct InputFrame {
    lines: Vec<Line<'static>>,
    wrap: bool,
    centered: bool,
}

impl InputFrame {
    /// Word-wrapped content (read-only text, single-line editor).
    pub fn wrapped(lines: Vec<Line<'static>>) -> Self {
        Self {
            lines,
            wrap: true,
            centered: false,
        }
    }

    /// Pre-wrapped rows rendered one per line.
    pub fn rows(lines: Vec<Line<'static>>) -> Self {
        Self {
            lines,
            wrap: false,
            centered: false,
        }
    }

    fn centered(span: Span<'static>) -> Self {
        Self {
            lines: vec![Line::from(span)],
            wrap: false,
            centered: true,
        }
    }

    /// Frozen text in the input color; an empty value still takes a row.
    pub fn read_only(text: &str, paint: Paint) -> Self {
        let style = Style::default().fg(paint.color(&paint.theme.input.text));
        let text = if text.is_empty() { " " } else { text };
        Self::wrapped(
            text.split('\n')
                .map(|line| Line::from(Span::styled(line.to_string(), style)))
                .collect(),
        )
    }

    fn text_width(width: u16) -> u16 {
        width.saturating_sub(2).max(1)
    }

    /// Rows the strip takes at `width`.
    pub fn height(&self, width: u16) -> u16 {
        if self.wrap {
            let text = Text::from(self.lines.clone());
            Paragraph::new(text)
                .wrap(Wrap { trim: false })
                .line_count(Self::text_width(width))
                .max(1)
                .min(usize::from(u16::MAX)) as u16
        } else {
            (self.lines.len().max(1)).min(usize::from(u16::MAX)) as u16
        }
    }

    pub fn render(&self, buf: &mut Buffer, area: Rect, paint: Paint) {
        if area.is_empty() {
            return;
        }
        buf.set_style(
            area,
            Style::default().bg(paint.color(&paint.theme.input.surface)),
        );
        let text_area = Rect::new(
            area.x + 1,
            area.y,
            Self::text_width(area.width).min(area.width),
            area.height,
        );
        let mut paragraph = Paragraph::new(Text::from(self.lines.clone()));
        if self.wrap {
            paragraph = paragraph.wrap(Wrap { trim: false });
        }
        if self.centered {
            paragraph = paragraph.alignment(ratatui::layout::Alignment::Center);
        }
        paragraph.render(text_area, buf);
    }
}
