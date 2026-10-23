//! A text buffer with a byte-offset cursor and readline-style movement over
//! graphemes and words.

use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Cursor {
    text: String,
    offset: usize,
}

impl Cursor {
    /// `offset` is clamped into the text and snapped back to a char boundary.
    pub fn new(text: impl Into<String>, offset: usize) -> Self {
        let text = text.into();
        let mut offset = offset.min(text.len());
        while !text.is_char_boundary(offset) {
            offset -= 1;
        }
        Self { text, offset }
    }

    pub fn at_end(text: impl Into<String>) -> Self {
        let text = text.into();
        let offset = text.len();
        Self { text, offset }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn offset(&self) -> usize {
        self.offset
    }

    pub fn into_text(self) -> String {
        self.text
    }

    // ── Movement ─────────────────────────────────────────────────

    pub fn right(&mut self) {
        self.offset = next_grapheme(&self.text, self.offset);
    }

    pub fn left(&mut self) {
        self.offset = prev_grapheme(&self.text, self.offset);
    }

    pub fn home(&mut self) {
        self.offset = 0;
    }

    pub fn end(&mut self) {
        self.offset = self.text.len();
    }

    pub fn word_right(&mut self) {
        self.offset = word_boundary_right(&self.text, self.offset);
    }

    pub fn word_left(&mut self) {
        self.offset = word_boundary_left(&self.text, self.offset);
    }

    // ── Editing ──────────────────────────────────────────────────

    pub fn insert(&mut self, s: &str) {
        self.text.insert_str(self.offset, s);
        self.offset += s.len();
    }

    pub fn backspace(&mut self) {
        let prev = prev_grapheme(&self.text, self.offset);
        self.text.replace_range(prev..self.offset, "");
        self.offset = prev;
    }

    pub fn delete(&mut self) {
        let next = next_grapheme(&self.text, self.offset);
        self.text.replace_range(self.offset..next, "");
    }

    /// Removes the word before the cursor and returns it for the kill buffer.
    pub fn delete_word(&mut self) -> Option<String> {
        if self.offset == 0 {
            return None;
        }
        let to = word_boundary_left(&self.text, self.offset);
        let killed = self.text[to..self.offset].to_string();
        self.text.replace_range(to..self.offset, "");
        self.offset = to;
        Some(killed)
    }

    pub fn kill_to_home(&mut self) -> Option<String> {
        if self.offset == 0 {
            return None;
        }
        let killed = self.text[..self.offset].to_string();
        self.text.replace_range(..self.offset, "");
        self.offset = 0;
        Some(killed)
    }

    pub fn kill_to_end(&mut self) -> Option<String> {
        if self.offset >= self.text.len() {
            return None;
        }
        let killed = self.text[self.offset..].to_string();
        self.text.truncate(self.offset);
        Some(killed)
    }

    pub fn yank(&mut self, killed: Option<&str>) {
        if let Some(killed) = killed.filter(|k| !k.is_empty()) {
            self.insert(killed);
        }
    }

    // ── Logical lines ────────────────────────────────────────────

    fn line_start(&self) -> usize {
        self.text[..self.offset].rfind('\n').map_or(0, |i| i + 1)
    }

    /// Zero-based line of the cursor.
    pub fn row(&self) -> usize {
        self.text[..self.offset].matches('\n').count()
    }

    /// Characters between the line start and the cursor.
    pub fn col(&self) -> usize {
        self.text[self.line_start()..self.offset].chars().count()
    }

    fn offset_in_line(line_start: usize, line: &str, col: usize) -> usize {
        line_start + line.chars().take(col).map(char::len_utf8).sum::<usize>()
    }

    pub fn up_line(&mut self) {
        let start = self.line_start();
        if start == 0 {
            return;
        }
        let col = self.col();
        let prev_start = self.text[..start - 1].rfind('\n').map_or(0, |i| i + 1);
        let prev_line = &self.text[prev_start..start - 1];
        self.offset = Self::offset_in_line(prev_start, prev_line, col);
    }

    pub fn down_line(&mut self) {
        let Some(next_nl) = self.text[self.offset..].find('\n') else {
            return;
        };
        let col = self.col();
        let next_start = self.offset + next_nl + 1;
        let next_end = self.text[next_start..]
            .find('\n')
            .map_or(self.text.len(), |i| next_start + i);
        let next_line = &self.text[next_start..next_end];
        self.offset = Self::offset_in_line(next_start, next_line, col);
    }

    // ── Rendering ────────────────────────────────────────────────

    pub fn before(&self) -> &str {
        &self.text[..self.offset]
    }

    /// The grapheme under the cursor, or a space past the end.
    pub fn at(&self) -> &str {
        if self.offset >= self.text.len() {
            return " ";
        }
        let next = next_grapheme(&self.text, self.offset);
        &self.text[self.offset..next]
    }

    pub fn after(&self) -> &str {
        if self.offset >= self.text.len() {
            return "";
        }
        &self.text[next_grapheme(&self.text, self.offset)..]
    }
}

fn next_grapheme(text: &str, offset: usize) -> usize {
    text[offset..]
        .graphemes(true)
        .next()
        .map_or(text.len(), |g| offset + g.len())
}

fn prev_grapheme(text: &str, offset: usize) -> usize {
    text[..offset]
        .grapheme_indices(true)
        .next_back()
        .map_or(0, |(i, _)| i)
}

fn is_word_like(segment: &str) -> bool {
    segment.chars().any(char::is_alphanumeric)
}

/// Readline `M-b`: start of the current or previous word.
fn word_boundary_left(text: &str, pos: usize) -> usize {
    let segments: Vec<(usize, &str)> = text.split_word_bound_indices().collect();
    let mut i = segments.len();
    while i > 0 && segments[i - 1].0 >= pos {
        i -= 1;
    }
    while i > 0 && !is_word_like(segments[i - 1].1) {
        i -= 1;
    }
    if i > 0 { segments[i - 1].0 } else { 0 }
}

/// Readline `M-f`: end of the current or next word.
fn word_boundary_right(text: &str, pos: usize) -> usize {
    if pos >= text.len() {
        return text.len();
    }
    let segments: Vec<(usize, &str)> = text.split_word_bound_indices().collect();
    let end = |(start, seg): (usize, &str)| start + seg.len();
    let mut i = 0;
    while i + 1 < segments.len() && segments[i + 1].0 <= pos {
        i += 1;
    }
    if !is_word_like(segments[i].1) {
        while i < segments.len() && !is_word_like(segments[i].1) {
            i += 1;
        }
    } else if pos >= end(segments[i]) {
        i += 1;
        while i < segments.len() && !is_word_like(segments[i].1) {
            i += 1;
        }
    }
    match segments.get(i) {
        Some(seg) if is_word_like(seg.1) => end(*seg),
        _ => text.len(),
    }
}
