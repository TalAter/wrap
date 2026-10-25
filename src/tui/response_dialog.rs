//! The response dialog: confirms a command, edits it in place, composes a
//! follow-up or the first interactive prompt, and shows progress while a
//! round or a step runs. It is a pure function of the session state plus a
//! little presentation state of its own (action-bar focus, copy flash,
//! compose placeholder, truncation banner, edit cursor).
//!
//! Events for the reducer are queued on the dialog and collected with
//! [`ResponseDialog::take_events`]; dialog-local requests to the coordinator
//! (opening a GUI editor) are collected with [`ResponseDialog::take_signals`].

use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::Frame;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Paragraph, Widget, Wrap};
use unicode_width::UnicodeWidthStr;

use super::frame::{Align, DialogFrame, PillSegment, SizeBasis, TopBadge, content_natural_width};
use super::terminal::drain_pending_input;
use super::widgets::{
    ActionItem, InputEvent, InputFrame, InputLayout, Paint, TextInput, action_bar_line,
    format_continuation_badge, spinner_status,
};
use crate::response::RiskLevel;
use crate::session::state::{ActionId, AppEvent, AppState, StateTag};
use crate::theme::{FrameStops, Theme};

/// Border status while a follow-up round runs before any chrome line arrives.
pub const FOLLOWUP_FALLBACK_STATUS: &str = "Reticulating splines...";
/// Border status while a confirmed non-final step runs in capture mode.
pub const EXECUTING_STEP_STATUS: &str = "Running step...";
/// Output-slot text when a step produced nothing.
pub const OUTPUT_SLOT_EMPTY: &str = "(no output)";
const OUTPUT_SLOT_TAIL_ROWS: usize = 3;
const CONFIRMING_BAR_WIDTH: u16 = 61;
const MIN_INNER_WIDTH: u16 = CONFIRMING_BAR_WIDTH + 4;
/// How long the Copy item reads `Copied`.
pub const COPY_FLASH: Duration = Duration::from_millis(2500);
const TRUNCATED_BANNER: &str = "paste truncated — for large input, pipe with cat file | w";
/// Ticks are 25ms; the spinner advances with the 80ms chrome cadence.
const TICKS_PER_SPINNER_FRAME: usize = 3;

pub const INTERACTIVE_PLACEHOLDERS: [&str; 3] = [
    "list all markdown files here",
    "delete all .DS_Store files in this project",
    "add .env to git ignore",
];

/// The external editor Ctrl-G opens, if one is configured.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EditorInfo {
    pub display_name: String,
    /// GUI editors do not take the TTY: the dialog stays up and shows a
    /// notice while they run.
    pub gui: bool,
}

pub type ClipboardCopy = Box<dyn Fn(&str)>;

pub struct ResponseDialogOptions {
    pub theme: &'static Theme,
    pub nerd_fonts: bool,
    pub no_animation: bool,
    pub color_level: u8,
    pub editor: Option<EditorInfo>,
    /// Present when a clipboard tool exists; adds the Copy action.
    pub clipboard: Option<ClipboardCopy>,
    /// Parent prompt of a `-c` invocation, shown as a badge.
    pub continuation_prompt: Option<String>,
}

/// Dialog-local requests the coordinator fulfils outside the reducer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DialogSignal {
    /// Spawn the GUI editor on `draft`; report back with
    /// [`ResponseDialog::gui_editor_done`].
    OpenGuiEditor { draft: String },
}

/// How a command is shown when it may not fit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CommandDisplay {
    Full(String),
    Folded {
        head: String,
        hidden_count: usize,
        tail: String,
    },
}

fn visual_rows(line: &str, text_width: usize) -> usize {
    let w = line.width();
    if w == 0 { 1 } else { w.div_ceil(text_width) }
}

/// Folds `command` into head, hidden count and tail when its lines (soft-
/// wrapped at `text_width`) exceed `max_rows`, reserving one row for the
/// indicator.
pub fn fold_command(command: &str, max_rows: usize, text_width: usize) -> CommandDisplay {
    if max_rows < 1 || text_width < 1 {
        return CommandDisplay::Full(command.to_string());
    }
    let lines: Vec<&str> = command.split('\n').collect();
    let total: usize = lines.iter().map(|l| visual_rows(l, text_width)).sum();
    if total <= max_rows {
        return CommandDisplay::Full(command.to_string());
    }
    let budget = max_rows - 1;
    if budget < 1 {
        return CommandDisplay::Folded {
            head: String::new(),
            hidden_count: lines.len(),
            tail: String::new(),
        };
    }
    let head_budget = budget / 2;
    let tail_budget = budget - head_budget;
    let mut head = Vec::new();
    let mut used = 0;
    for line in &lines {
        let rows = visual_rows(line, text_width);
        if used + rows > head_budget {
            break;
        }
        head.push(*line);
        used += rows;
    }
    let mut tail = Vec::new();
    let mut used = 0;
    for line in lines[head.len()..].iter().rev() {
        let rows = visual_rows(line, text_width);
        if used + rows > tail_budget {
            break;
        }
        tail.insert(0, *line);
        used += rows;
    }
    CommandDisplay::Folded {
        hidden_count: lines.len() - head.len() - tail.len(),
        head: head.join("\n"),
        tail: tail.join("\n"),
    }
}

/// [`fold_command`] flattened to text with an `… N lines hidden` line.
pub fn truncate_command(command: &str, max_rows: usize, text_width: usize) -> String {
    match fold_command(command, max_rows, text_width) {
        CommandDisplay::Full(text) => text,
        CommandDisplay::Folded {
            head,
            hidden_count,
            tail,
        } => [head, format!("… {hidden_count} lines hidden"), tail]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

/// The last three lines of a step's output, or the empty sentinel.
pub fn format_output_slot(text: &str) -> String {
    let trimmed = text.trim_end();
    if trimmed.is_empty() {
        return OUTPUT_SLOT_EMPTY.to_string();
    }
    let lines: Vec<&str> = trimmed.split('\n').collect();
    let start = lines.len().saturating_sub(OUTPUT_SLOT_TAIL_ROWS);
    lines[start..].join("\n")
}

fn risk_preset(theme: &'static Theme, level: RiskLevel) -> (FrameStops, PillSegment) {
    let (tokens, label) = match level {
        RiskLevel::Low => (&theme.risk.low, "✔ low risk"),
        RiskLevel::Medium => (&theme.risk.medium, "⚠ medium risk"),
        RiskLevel::High => (&theme.risk.high, "⚠ high risk"),
    };
    (tokens.frame, PillSegment::new(label, tokens.pill).bold())
}

/// The confirming bar's items: `(action, label, primary)`.
fn confirming_actions(has_clipboard: bool) -> Vec<(ActionId, &'static str, bool)> {
    let mut actions = vec![
        (ActionId::Cancel, "No", true),
        (ActionId::Run, "Yes", true),
        (ActionId::Edit, "Edit", false),
        (ActionId::Followup, "Follow-up", false),
    ];
    if has_clipboard {
        // The trailing space keeps the flip to `Copied` one cell wide.
        actions.push((ActionId::Copy, "Copy ", false));
    }
    actions
}

fn with_editor_action(mut base: Vec<ActionItem>, editor: Option<&EditorInfo>) -> Vec<ActionItem> {
    if let Some(editor) = editor {
        let esc = base.pop();
        base.push(ActionItem::new(
            "ctrl+G",
            format!("edit in {}", editor.display_name),
        ));
        base.extend(esc);
    }
    base
}

fn edit_command_actions(editor: Option<&EditorInfo>) -> Vec<ActionItem> {
    with_editor_action(
        vec![
            ActionItem::new("⏎", "to run").primary(),
            ActionItem::new("Esc", "to discard changes"),
        ],
        editor,
    )
}

fn followup_compose_actions(editor: Option<&EditorInfo>) -> Vec<ActionItem> {
    with_editor_action(
        vec![
            ActionItem::new("⏎", "to send").primary(),
            ActionItem::new("Esc", "to cancel"),
        ],
        editor,
    )
}

fn interactive_compose_actions(editor: Option<&EditorInfo>) -> Vec<ActionItem> {
    with_editor_action(
        vec![
            ActionItem::new("⏎", "send").primary(),
            ActionItem::new("Esc", "cancel"),
        ],
        editor,
    )
}

fn processing_actions() -> Vec<ActionItem> {
    vec![ActionItem::new("Esc", "to abort")]
}

fn executing_step_actions() -> Vec<ActionItem> {
    vec![ActionItem::new("ctrl+C", "to interrupt step")]
}

/// One row group of the dialog body.
enum Block {
    /// Word-wrapped text indented by `indent` cells.
    Para {
        text: Text<'static>,
        indent: u16,
    },
    Input(InputFrame),
    Blank,
}

impl Block {
    fn para(text: impl Into<String>, color: ratatui::style::Color, indent: u16) -> Self {
        let style = Style::default().fg(color);
        let text = text.into();
        Block::Para {
            text: Text::from(
                text.split('\n')
                    .map(|line| Line::from(Span::styled(line.to_string(), style)))
                    .collect::<Vec<_>>(),
            ),
            indent,
        }
    }

    fn line(line: Line<'static>, indent: u16) -> Self {
        Block::Para {
            text: Text::from(line),
            indent,
        }
    }

    fn height(&self, width: u16) -> u16 {
        match self {
            Block::Para { text, indent } => Paragraph::new(text.clone())
                .wrap(Wrap { trim: false })
                .line_count(width.saturating_sub(*indent).max(1))
                .max(1)
                .min(usize::from(u16::MAX)) as u16,
            Block::Input(frame) => frame.height(width),
            Block::Blank => 1,
        }
    }

    fn render(&self, buf: &mut Buffer, area: Rect, paint: Paint) {
        match self {
            Block::Para { text, indent } => {
                let indent = (*indent).min(area.width);
                let rect = Rect::new(area.x + indent, area.y, area.width - indent, area.height);
                Paragraph::new(text.clone())
                    .wrap(Wrap { trim: false })
                    .render(rect, buf);
            }
            Block::Input(frame) => frame.render(buf, area, paint),
            Block::Blank => {}
        }
    }
}

pub struct ResponseDialog {
    opts: ResponseDialogOptions,
    state: AppState,
    selected: usize,
    flash_started: Option<Instant>,
    truncated_banner: bool,
    placeholder: String,
    draft_was_empty: bool,
    /// The state tag whose draft a GUI editor currently owns.
    gui_editing: Option<StateTag>,
    input: TextInput,
    tick: usize,
    events: Vec<AppEvent>,
    signals: Vec<DialogSignal>,
    rng: u64,
}

impl ResponseDialog {
    pub fn new(state: &AppState, opts: ResponseDialogOptions) -> Self {
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0x9E37_79B9, |d| d.as_nanos() as u64)
            | 1;
        let mut dialog = Self {
            opts,
            state: AppState::Thinking,
            selected: 0,
            flash_started: None,
            truncated_banner: false,
            placeholder: String::new(),
            draft_was_empty: true,
            gui_editing: None,
            input: TextInput::single_line(""),
            tick: 0,
            events: Vec::new(),
            signals: Vec::new(),
            rng: seed,
        };
        dialog.placeholder = dialog.pick_placeholder(None);
        dialog.draft_was_empty = state.draft().is_none_or(str::is_empty);
        dialog.sync(state);
        dialog
    }

    fn next_random(&mut self) -> u64 {
        // xorshift64: plenty for choosing a placeholder.
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.rng = x;
        x
    }

    fn pick_placeholder(&mut self, previous: Option<&str>) -> String {
        let pool: Vec<&str> = INTERACTIVE_PLACEHOLDERS
            .iter()
            .copied()
            .filter(|p| Some(*p) != previous)
            .collect();
        let idx = (self.next_random() % pool.len() as u64) as usize;
        pool[idx].to_string()
    }

    pub fn state(&self) -> &AppState {
        &self.state
    }

    pub fn placeholder(&self) -> &str {
        &self.placeholder
    }

    pub fn selected_index(&self) -> usize {
        self.selected
    }

    /// Adopts the reduced state. Called after every reducer step: resets the
    /// action-bar focus and copy flash when leaving `confirming`, rebuilds
    /// the edit buffer when the draft changed underneath it, rotates the
    /// compose placeholder when the buffer empties, and drains queued
    /// keystrokes on every transition so nothing typed earlier lands on the
    /// new state.
    pub fn sync(&mut self, state: &AppState) {
        let prev_tag = self.state.tag();
        let tag = state.tag();
        if prev_tag != tag {
            if tag != StateTag::Confirming {
                self.selected = 0;
                self.flash_started = None;
            }
            let _ = drain_pending_input();
            self.input = match tag {
                StateTag::Editing => TextInput::single_line(state.draft().unwrap_or("")),
                StateTag::ComposingFollowup => TextInput::multiline(state.draft().unwrap_or(""))
                    .with_placeholder("actually..."),
                StateTag::ComposingInteractive => TextInput::multiline(state.draft().unwrap_or(""))
                    .with_placeholder(self.placeholder.clone()),
                _ => TextInput::single_line(state.draft().unwrap_or("")),
            };
        } else if let Some(draft) = state.draft()
            && draft != self.input.text()
        {
            self.input.set_text(draft);
        }
        let now_empty = state.draft().is_none_or(str::is_empty);
        if now_empty && !self.draft_was_empty {
            let previous = self.placeholder.clone();
            self.placeholder = self.pick_placeholder(Some(&previous));
            if tag == StateTag::ComposingInteractive {
                self.input.set_placeholder(self.placeholder.clone());
            }
        }
        self.draft_was_empty = now_empty;
        self.input
            .set_editing_external(self.gui_editing == Some(tag));
        self.state = state.clone();
    }

    pub fn take_events(&mut self) -> Vec<AppEvent> {
        std::mem::take(&mut self.events)
    }

    pub fn take_signals(&mut self) -> Vec<DialogSignal> {
        std::mem::take(&mut self.signals)
    }

    /// The GUI editor closed. `Some` replaces the draft through the reducer;
    /// `None` keeps what the user had.
    pub fn gui_editor_done(&mut self, text: Option<String>) {
        self.gui_editing = None;
        self.input.set_editing_external(false);
        if let Some(text) = text {
            self.events.push(AppEvent::DraftChange { text });
        }
    }

    pub fn set_tick(&mut self, tick: usize) {
        self.tick = tick;
    }

    /// Processing and executing states carry a spinner.
    pub fn animating(&self) -> bool {
        self.processing_label().is_some() && !self.opts.no_animation
    }

    /// Compose states want kitty-disambiguated keys.
    pub fn compose_keys(&self) -> bool {
        matches!(
            self.state.tag(),
            StateTag::ComposingInteractive | StateTag::ComposingFollowup
        )
    }

    /// Expires the copy flash. Returns true when the screen changed.
    pub fn poll_timers(&mut self) -> bool {
        self.poll_timers_at(Instant::now())
    }

    pub fn poll_timers_at(&mut self, now: Instant) -> bool {
        match self.flash_started {
            Some(started) if now.duration_since(started) >= COPY_FLASH => {
                self.flash_started = None;
                true
            }
            _ => false,
        }
    }

    pub fn is_flashing(&self) -> bool {
        self.flash_started.is_some()
    }

    fn processing_label(&self) -> Option<&str> {
        match self.state.tag() {
            StateTag::ProcessingFollowup | StateTag::ProcessingInteractive => {
                Some(self.state.status().unwrap_or(FOLLOWUP_FALLBACK_STATUS))
            }
            StateTag::ExecutingStep => Some(EXECUTING_STEP_STATUS),
            _ => None,
        }
    }

    fn paint(&self) -> Paint {
        Paint::new(self.opts.theme, self.opts.color_level, self.opts.nerd_fonts)
    }

    fn can_open_editor(&self) -> bool {
        self.opts.editor.is_some()
            && matches!(
                self.state.tag(),
                StateTag::ComposingInteractive | StateTag::ComposingFollowup | StateTag::Editing
            )
    }

    fn dispatch_action(&mut self, id: ActionId) {
        if id == ActionId::Copy {
            if let Some(copy) = &self.opts.clipboard {
                let command = self
                    .state
                    .response()
                    .map(|r| r.content.clone())
                    .unwrap_or_default();
                copy(&command);
                self.flash_started = Some(Instant::now());
            }
            return;
        }
        self.events.push(AppEvent::KeyAction(id));
    }

    pub fn key(&mut self, key: KeyEvent) {
        if key.kind == KeyEventKind::Release {
            return;
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        if ctrl && key.code == KeyCode::Char('g') && self.can_open_editor() {
            if self.gui_editing.is_some() {
                return;
            }
            let draft = self.input.text().to_string();
            if self.opts.editor.as_ref().is_some_and(|e| e.gui) {
                self.gui_editing = Some(self.state.tag());
                self.input.set_editing_external(true);
                self.signals.push(DialogSignal::OpenGuiEditor { draft });
            } else {
                self.events.push(AppEvent::EnterEditor { draft });
            }
            return;
        }
        let esc = key.code == KeyCode::Esc || (ctrl && key.code == KeyCode::Char('c'));
        match self.state.tag() {
            StateTag::Confirming => self.confirming_key(key, ctrl, alt),
            StateTag::Editing | StateTag::ComposingFollowup | StateTag::ComposingInteractive => {
                if esc {
                    self.events.push(AppEvent::KeyEsc);
                    return;
                }
                let event = self.input.key(key);
                self.apply_input_event(event);
            }
            StateTag::ProcessingFollowup
            | StateTag::ProcessingInteractive
            | StateTag::ExecutingStep
                if esc =>
            {
                self.events.push(AppEvent::KeyEsc);
            }
            _ => {}
        }
    }

    pub fn paste(&mut self, text: &str) {
        if matches!(
            self.state.tag(),
            StateTag::Editing | StateTag::ComposingFollowup | StateTag::ComposingInteractive
        ) {
            let event = self.input.paste(text);
            self.apply_input_event(event);
        }
    }

    fn apply_input_event(&mut self, event: InputEvent) {
        match event {
            InputEvent::Idle => {}
            InputEvent::Changed { truncated } => {
                self.truncated_banner = truncated;
                self.events.push(AppEvent::DraftChange {
                    text: self.input.text().to_string(),
                });
            }
            InputEvent::Submit(text) => {
                if text.trim().is_empty() {
                    return;
                }
                let event = match self.state.tag() {
                    StateTag::Editing => AppEvent::SubmitEdit { text },
                    StateTag::ComposingFollowup => AppEvent::SubmitFollowup { text },
                    _ => AppEvent::SubmitInteractive { text },
                };
                self.events.push(event);
            }
        }
    }

    fn confirming_key(&mut self, key: KeyEvent, ctrl: bool, alt: bool) {
        let actions = confirming_actions(self.opts.clipboard.is_some());
        match key.code {
            KeyCode::Esc => self.events.push(AppEvent::KeyEsc),
            KeyCode::Char('c') if ctrl && !alt => self.dispatch_action(ActionId::Cancel),
            KeyCode::Char(c) if !ctrl && !alt => {
                let lower = c.to_ascii_lowercase();
                if lower == 'q' {
                    self.dispatch_action(ActionId::Cancel);
                    return;
                }
                let hit = actions.iter().find(|(_, label, _)| {
                    label
                        .chars()
                        .next()
                        .is_some_and(|first| first.to_ascii_lowercase() == lower)
                });
                if let Some((id, _, _)) = hit {
                    self.dispatch_action(*id);
                }
            }
            KeyCode::Left => self.selected = self.selected.saturating_sub(1),
            KeyCode::Right => self.selected = (self.selected + 1).min(actions.len() - 1),
            KeyCode::Enter => {
                if let Some((id, _, _)) = actions.get(self.selected) {
                    self.dispatch_action(*id);
                }
            }
            _ => {}
        }
    }

    fn confirming_bar_items(&self, paint: Paint) -> Vec<ActionItem> {
        confirming_actions(self.opts.clipboard.is_some())
            .into_iter()
            .map(|(id, label, primary)| {
                let flashing = id == ActionId::Copy && self.is_flashing();
                let label = if flashing { "Copied" } else { label };
                let glyph = label
                    .chars()
                    .next()
                    .map(|c| c.to_ascii_uppercase().to_string())
                    .unwrap_or_default();
                let mut item = ActionItem::new(glyph, label);
                item.primary = primary;
                if flashing {
                    item.flash_color = Some(paint.color(&paint.theme.action_bar.success));
                }
                item
            })
            .collect()
    }

    fn badge(&self, term_cols: u16) -> Option<String> {
        self.opts
            .continuation_prompt
            .as_deref()
            .map(|prompt| format_continuation_badge(prompt, term_cols))
            .filter(|badge| !badge.is_empty())
    }

    fn bottom_status(&self) -> Option<String> {
        spinner_status(
            self.processing_label(),
            self.tick / TICKS_PER_SPINNER_FRAME,
            self.opts.no_animation,
        )
    }

    pub fn render(&self, frame: &mut Frame<'_>) {
        let area = frame.area();
        self.render_to(frame.buffer_mut(), area);
    }

    /// Renders into `area` of `buf` and applies the color level.
    pub fn render_to(&self, buf: &mut Buffer, area: Rect) {
        let paint = self.paint();
        let (frame, blocks) = if matches!(
            self.state.tag(),
            StateTag::ComposingInteractive | StateTag::ProcessingInteractive
        ) {
            self.interactive_layout(area, paint)
        } else {
            self.response_layout(area, paint)
        };
        let inner_width = frame.inner_width(area.width);
        let body_rows: u16 = blocks
            .iter()
            .map(|b| b.height(inner_width))
            .fold(0u16, u16::saturating_add);
        let body = frame.draw(buf, area, body_rows);
        let mut y = body.y;
        for block in &blocks {
            let h = block.height(inner_width);
            if y >= body.bottom() {
                break;
            }
            let rect = Rect::new(body.x, y, body.width, h.min(body.bottom() - y));
            block.render(buf, rect, paint);
            y += h;
        }
        paint.finish(buf);
    }

    fn interactive_layout(&self, area: Rect, paint: Paint) -> (DialogFrame, Vec<Block>) {
        let theme = self.opts.theme;
        let badge = self.badge(area.width);
        let chrome_rows = 7 + u16::from(self.truncated_banner) + u16::from(badge.is_some());
        let max_rows = area.height.saturating_sub(chrome_rows).max(3);
        let frame = DialogFrame::new(theme.risk.low.frame, MIN_INNER_WIDTH, paint)
            .with_top(TopBadge::new(
                vec![PillSegment::new("compose", theme.dialog.compose_pill).bold()],
                Align::Left,
            ))
            .with_status(self.bottom_status());
        let inner_width = frame.inner_width(area.width);
        let wrap_width = inner_width.saturating_sub(2).max(1);
        let mut blocks = Vec::new();
        if let Some(badge) = badge {
            blocks.push(Block::para(badge, paint.color(&theme.copy.note), 1));
        }
        let draft = self.state.draft().unwrap_or("");
        if self.state.tag() == StateTag::ComposingInteractive {
            blocks.push(Block::Input(self.input.frame(
                paint,
                Some(InputLayout {
                    wrap_width,
                    max_rows: Some(max_rows),
                }),
            )));
        } else {
            blocks.push(Block::Input(InputFrame::read_only(draft, paint)));
        }
        if self.truncated_banner {
            blocks.push(Block::para(
                TRUNCATED_BANNER,
                paint.color(&theme.copy.note),
                1,
            ));
        }
        blocks.push(Block::Blank);
        blocks.push(Block::Blank);
        let items = if self.state.tag() == StateTag::ComposingInteractive {
            interactive_compose_actions(self.opts.editor.as_ref())
        } else {
            processing_actions()
        };
        blocks.push(Block::line(action_bar_line(&items, None, None, paint), 3));
        (frame, blocks)
    }

    fn response_layout(&self, area: Rect, paint: Paint) -> (DialogFrame, Vec<Block>) {
        let theme = self.opts.theme;
        let tag = self.state.tag();
        let response = self.state.response();
        let command = response.map_or("", |r| r.content.as_str());
        let risk = response.map_or(RiskLevel::Low, |r| r.risk_level);
        let explanation = response.and_then(|r| r.explanation.as_deref());
        let plan = response.and_then(|r| r.plan.as_deref());
        let draft = self.state.draft().unwrap_or("");
        let output_slot = self.state.output_slot();
        let show_followup = matches!(
            tag,
            StateTag::ComposingFollowup | StateTag::ProcessingFollowup
        );

        let mut size_to = vec![SizeBasis::Text(command)];
        size_to.extend(explanation.map(SizeBasis::Text));
        size_to.extend(plan.map(SizeBasis::Text));
        if show_followup {
            size_to.push(SizeBasis::Text(draft));
        }
        let natural = content_natural_width(&size_to, MIN_INNER_WIDTH);
        let (stops, pill) = risk_preset(theme, risk);
        let frame = DialogFrame::new(stops, natural, paint)
            .with_top(TopBadge::new(vec![pill], Align::Right))
            .with_status(self.bottom_status());
        let inner_width = frame.inner_width(area.width);
        let text_width = usize::from(inner_width.saturating_sub(2).max(1));
        let wrapped_rows = |text: &str| -> u16 {
            text.width()
                .div_ceil(text_width)
                .max(1)
                .min(usize::from(u16::MAX)) as u16
        };

        let badge = self.badge(area.width);
        let mut chrome_rows: u16 = 7 + u16::from(badge.is_some());
        if let Some(explanation) = explanation {
            chrome_rows = chrome_rows.saturating_add(1 + wrapped_rows(explanation));
        }
        if let Some(plan) = plan {
            chrome_rows = chrome_rows.saturating_add(1 + wrapped_rows(&format!("Plan: {plan}")));
        }
        let formatted_output = output_slot.map(format_output_slot);
        if let Some(formatted) = &formatted_output {
            let rows: u16 = formatted.split('\n').map(wrapped_rows).sum();
            chrome_rows = chrome_rows.saturating_add(1 + rows + 1);
        }
        if show_followup {
            chrome_rows = chrome_rows.saturating_add(1 + wrapped_rows(draft));
        }
        let max_command_rows = usize::from(area.height.saturating_sub(chrome_rows).max(3));

        let mut blocks = Vec::new();
        if let Some(badge) = badge {
            blocks.push(Block::para(badge, paint.color(&theme.copy.note), 1));
        }
        if let Some(formatted) = formatted_output {
            blocks.push(Block::para(
                "Output:",
                paint.color(&theme.dialog.output_label),
                1,
            ));
            blocks.push(Block::para(
                formatted,
                paint.color(&theme.dialog.output_text),
                1,
            ));
            blocks.push(Block::Blank);
        }
        if tag == StateTag::Editing {
            blocks.push(Block::Input(self.input.frame(paint, None)));
        } else {
            match fold_command(command, max_command_rows, text_width) {
                CommandDisplay::Full(text) => {
                    blocks.push(Block::Input(InputFrame::read_only(&text, paint)));
                }
                CommandDisplay::Folded {
                    head,
                    hidden_count,
                    tail,
                } => {
                    let text_style = Style::default().fg(paint.color(&theme.input.text));
                    let mut lines = Vec::new();
                    if !head.is_empty() {
                        lines.extend(
                            head.split('\n')
                                .map(|l| Line::from(Span::styled(l.to_string(), text_style))),
                        );
                    }
                    let pill = PillSegment::new(
                        format!("{hidden_count} lines hidden"),
                        theme.dialog.fold_indicator,
                    );
                    lines.push(Line::from(super::frame::pill_spans(
                        &[pill],
                        paint.nerd_fonts,
                        false,
                        paint,
                    )));
                    if !tail.is_empty() {
                        lines.extend(
                            tail.split('\n')
                                .map(|l| Line::from(Span::styled(l.to_string(), text_style))),
                        );
                    }
                    blocks.push(Block::Input(InputFrame::wrapped(lines)));
                }
            }
        }
        if let Some(explanation) = explanation {
            blocks.push(Block::Blank);
            blocks.push(Block::para(
                explanation,
                paint.color(&theme.dialog.explanation),
                1,
            ));
        }
        if let Some(plan) = plan {
            blocks.push(Block::Blank);
            blocks.push(Block::para(
                format!("Plan: {plan}"),
                paint.color(&theme.dialog.plan),
                1,
            ));
        }
        if show_followup {
            blocks.push(Block::Blank);
            if tag == StateTag::ComposingFollowup {
                let max_rows = area.height.saturating_sub(chrome_rows).max(3);
                blocks.push(Block::Input(self.input.frame(
                    paint,
                    Some(InputLayout {
                        wrap_width: text_width.min(usize::from(u16::MAX)) as u16,
                        max_rows: Some(max_rows),
                    }),
                )));
            } else {
                blocks.push(Block::Input(InputFrame::read_only(draft, paint)));
            }
        }
        blocks.push(Block::Blank);
        blocks.push(Block::Blank);
        let editor = self.opts.editor.as_ref();
        let bar = match tag {
            StateTag::Editing => action_bar_line(&edit_command_actions(editor), None, None, paint),
            StateTag::ComposingFollowup => {
                action_bar_line(&followup_compose_actions(editor), None, None, paint)
            }
            StateTag::ProcessingFollowup => {
                action_bar_line(&processing_actions(), None, None, paint)
            }
            StateTag::ExecutingStep => {
                action_bar_line(&executing_step_actions(), None, None, paint)
            }
            _ => {
                let mut line = action_bar_line(
                    &self.confirming_bar_items(paint),
                    Some(self.selected),
                    Some(&[1]),
                    paint,
                );
                line.spans.insert(
                    0,
                    Span::styled(
                        "Run command? ",
                        Style::default().fg(paint.color(&theme.dialog.prompt)),
                    ),
                );
                line
            }
        };
        blocks.push(Block::line(bar, 3));
        (frame, blocks)
    }
}
