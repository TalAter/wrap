//! The `--forget` dialog: a checklist of the four data buckets with their
//! on-disk footprints, everything checked up front.

use std::io;

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::Frame;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use unicode_width::UnicodeWidthStr;

use super::drive::{Dialog, Progress, drive};
use super::frame::DialogFrame;
use super::terminal::{SessionSignals, TerminalSession};
use super::widgets::{
    ActionItem, Checklist, ChecklistEvent, ChecklistItem, Paint, action_bar_line,
};
use super::wizard_dialog::{Row, render_rows};
use crate::subcommands::forget::{Bucket, Footprint, Footprints, Unit, format_footprint};
use crate::theme::Theme;

pub const FORGET_CONTENT_WIDTH: u16 = 60;

struct RowSpec {
    bucket: Bucket,
    name: &'static str,
    unit: Unit,
}

const ROWS: [RowSpec; 4] = [
    RowSpec {
        bucket: Bucket::Memory,
        name: "Memory",
        unit: Unit::Facts,
    },
    RowSpec {
        bucket: Bucket::Logs,
        name: "Logs",
        unit: Unit::Entries,
    },
    RowSpec {
        bucket: Bucket::Cache,
        name: "Cache",
        unit: Unit::Files,
    },
    RowSpec {
        bucket: Bucket::Scratch,
        name: "Temp files",
        unit: Unit::Dirs,
    },
];

fn bucket_value(bucket: Bucket) -> &'static str {
    match bucket {
        Bucket::Memory => "memory",
        Bucket::Logs => "logs",
        Bucket::Cache => "cache",
        Bucket::Scratch => "scratch",
    }
}

fn footprint_of(footprints: &Footprints, bucket: Bucket) -> &Footprint {
    match bucket {
        Bucket::Memory => &footprints.memory,
        Bucket::Logs => &footprints.logs,
        Bucket::Cache => &footprints.cache,
        Bucket::Scratch => &footprints.scratch,
    }
}

/// `Name   (detail)` padded so the footprints line up in a column.
fn to_item(row: &RowSpec, footprint: &Footprint) -> ChecklistItem {
    let detail = format_footprint(row.unit, footprint);
    let name_width = ROWS.iter().map(|r| r.name.width()).max().unwrap_or(0);
    let pad = " ".repeat((name_width - row.name.width() + 4).max(2));
    ChecklistItem::option(
        format!("{}{pad}{detail}", row.name),
        bucket_value(row.bucket),
    )
}

pub struct ForgetDialog {
    theme: &'static Theme,
    color_level: u8,
    nerd_fonts: bool,
    list: Checklist,
}

impl ForgetDialog {
    pub fn new(
        footprints: &Footprints,
        theme: &'static Theme,
        color_level: u8,
        nerd_fonts: bool,
    ) -> Self {
        let items = ROWS
            .iter()
            .map(|row| to_item(row, footprint_of(footprints, row.bucket)))
            .collect();
        let list = Checklist::new(items)
            .with_checked(ROWS.iter().map(|r| bucket_value(r.bucket)))
            .allow_empty_submit();
        Self {
            theme,
            color_level,
            nerd_fonts,
            list,
        }
    }

    fn paint(&self) -> Paint {
        Paint::new(self.theme, self.color_level, self.nerd_fonts)
    }

    /// The checked buckets in row order.
    pub fn checked(&self) -> Vec<Bucket> {
        Bucket::ALL
            .into_iter()
            .filter(|b| self.list.is_checked(bucket_value(*b)))
            .collect()
    }

    /// Renders into `area` of `buf` and applies the color level. Rows wrap
    /// at the inner width rather than truncating.
    pub fn render_to(&self, buf: &mut Buffer, area: Rect) {
        let paint = self.paint();
        let frame = DialogFrame::new(self.theme.forget.frame, FORGET_CONTENT_WIDTH, paint);
        let mut rows: Vec<Row> = self.list.lines(paint).into_iter().map(Row::Para).collect();
        rows.push(Row::Line(Line::default()));
        let bar = action_bar_line(
            &[
                ActionItem::new("↑↓", "move"),
                ActionItem::new("Space", "toggle"),
                ActionItem::new("⏎", "forget").primary(),
                ActionItem::new("Esc", "cancel"),
            ],
            None,
            None,
            paint,
        );
        let mut spans = vec![Span::raw("   ")];
        spans.extend(bar.spans);
        rows.push(Row::Para(Line::from(spans)));
        render_rows(buf, area, paint, &frame, &rows);
    }
}

impl Dialog for ForgetDialog {
    /// `None` cancels; `Some` is the selection, possibly empty.
    type Exit = Option<Vec<Bucket>>;

    fn render(&self, frame: &mut Frame<'_>) {
        let area = frame.area();
        self.render_to(frame.buffer_mut(), area);
    }

    fn animating(&self) -> bool {
        false
    }

    fn set_tick(&mut self, _tick: usize) {}

    fn key(&mut self, key: KeyEvent) -> Option<Self::Exit> {
        if key.kind == KeyEventKind::Release {
            return None;
        }
        let ctrl_c =
            key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL);
        if ctrl_c || key.code == KeyCode::Esc {
            return Some(None);
        }
        match self.list.key(key) {
            ChecklistEvent::Submit(_) => Some(Some(self.checked())),
            _ => None,
        }
    }

    fn paste(&mut self, _text: &str) {}

    fn poll(&mut self) -> io::Result<Progress<Self::Exit>> {
        Ok(Progress::Idle)
    }

    fn cancelled(&mut self) -> Self::Exit {
        None
    }
}

/// How the real dialog ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ForgetOutcome {
    /// The buckets to delete, possibly none.
    Selected(Vec<Bucket>),
    /// Esc or Ctrl+C.
    Cancelled,
    /// SIGINT/SIGTERM/SIGHUP (the number) closed the dialog.
    Interrupted(i32),
}

/// Opens the alternate screen, runs the dialog, and reports how it ended.
/// Fails when stderr is not a terminal.
pub async fn show_forget_dialog(
    footprints: &Footprints,
    theme: &'static Theme,
    color_level: u8,
    nerd_fonts: bool,
) -> io::Result<ForgetOutcome> {
    let signals = SessionSignals::open()?;
    let mut terminal = TerminalSession::open()?;
    let mut dialog = ForgetDialog::new(footprints, theme, color_level, nerd_fonts);
    let exit = drive(&mut dialog, &mut terminal, || signals.received()).await?;
    if let Some(signal) = signals.signal() {
        return Ok(ForgetOutcome::Interrupted(signal));
    }
    Ok(match exit {
        Some(buckets) => ForgetOutcome::Selected(buckets),
        None => ForgetOutcome::Cancelled,
    })
}

/// [`show_forget_dialog`] for synchronous callers such as the `--forget`
/// subcommand. Inside a multi-thread tokio runtime the call blocks in place;
/// outside any runtime a temporary one is built.
pub fn show_forget_dialog_blocking(
    footprints: &Footprints,
    theme: &'static Theme,
    color_level: u8,
    nerd_fonts: bool,
) -> io::Result<ForgetOutcome> {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => tokio::task::block_in_place(|| {
            handle.block_on(show_forget_dialog(
                footprints,
                theme,
                color_level,
                nerd_fonts,
            ))
        }),
        Err(_) => tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(show_forget_dialog(
                footprints,
                theme,
                color_level,
                nerd_fonts,
            )),
    }
}
