//! The dialog chrome: width math, pill chains, and the gradient border with
//! an optional top badge and bottom status.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_width::UnicodeWidthStr;

use super::widgets::Paint;
use crate::theme::{ColorRef, FrameStops, TokenPair};

const DIALOG_MARGIN: u16 = 4;
const MIN_TOTAL_WIDTH: u16 = 5;
/// Horizontal cells the chrome adds around the inner content.
pub const DIALOG_CHROME_WIDTH: u16 = 4 + DIALOG_MARGIN;
/// Vertical cells the chrome adds around the inner content.
pub const DIALOG_CHROME_HEIGHT: u16 = 4;

const PL_LCURVE: &str = "\u{E0B6}";
const PL_RCURVE: &str = "\u{E0B4}";
const PL_RFLAME: &str = "\u{E0C0}";

/// Inner content width for a dialog on a terminal of `term_cols`, given the
/// width its content naturally wants.
pub fn dialog_inner_width(term_cols: u16, natural_content_width: u16) -> u16 {
    let max_width = MIN_TOTAL_WIDTH.max(term_cols.saturating_sub(DIALOG_MARGIN));
    let total_width = natural_content_width.saturating_add(4).min(max_width);
    total_width.saturating_sub(4)
}

/// One contributor to a dialog's natural width.
#[derive(Clone, Copy, Debug)]
pub enum SizeBasis<'a> {
    /// Measured in display cells; multi-line text counts its widest line.
    Text(&'a str),
    /// Already measured (a pill, an action bar).
    Cells(u16),
}

/// Natural (pre-clamp) content width: the widest contributor, floored at `min`.
pub fn content_natural_width(size_to: &[SizeBasis<'_>], min: u16) -> u16 {
    size_to.iter().fold(min, |w, item| match item {
        SizeBasis::Cells(cells) => w.max(*cells),
        SizeBasis::Text(text) => w.max(text_width(text)),
    })
}

/// Display width of `text`; the widest line when it spans several.
pub fn text_width(text: &str) -> u16 {
    text.lines()
        .map(|line| line.width())
        .max()
        .unwrap_or(0)
        .min(u16::MAX as usize) as u16
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PillSegment {
    pub label: String,
    pub label_narrow: Option<String>,
    pub fg: ColorRef,
    pub bg: ColorRef,
    pub bold: bool,
}

impl PillSegment {
    pub fn new(label: impl Into<String>, colors: TokenPair) -> Self {
        Self {
            label: label.into(),
            label_narrow: None,
            fg: colors.fg,
            bg: colors.bg,
            bold: false,
        }
    }

    pub fn bold(mut self) -> Self {
        self.bold = true;
        self
    }

    pub fn narrow(mut self, label: impl Into<String>) -> Self {
        self.label_narrow = Some(label.into());
        self
    }

    fn label(&self, narrow: bool) -> &str {
        if narrow {
            self.label_narrow.as_deref().unwrap_or(&self.label)
        } else {
            &self.label
        }
    }
}

/// Cells a pill chain occupies: padded bodies, plus curves and flames with
/// nerd fonts.
pub fn pill_width(segs: &[PillSegment], nerd: bool, narrow: bool) -> u16 {
    if segs.is_empty() {
        return 0;
    }
    let bodies: usize = segs.iter().map(|seg| seg.label(narrow).width() + 2).sum();
    let glyphs = if nerd { 2 + (segs.len() - 1) } else { 0 };
    (bodies + glyphs).min(u16::MAX as usize) as u16
}

/// Styled spans of a pill chain: ` label ` bodies on their backgrounds, with
/// powerline caps and flames between segments when nerd fonts are on.
pub fn pill_spans(
    segs: &[PillSegment],
    nerd: bool,
    narrow: bool,
    paint: Paint,
) -> Vec<Span<'static>> {
    if segs.is_empty() {
        return Vec::new();
    }
    let bgs: Vec<_> = segs.iter().map(|seg| paint.color(&seg.bg)).collect();
    let mut out = Vec::new();
    if nerd {
        out.push(Span::styled(PL_LCURVE, Style::default().fg(bgs[0])));
    }
    for (i, seg) in segs.iter().enumerate() {
        let mut style = Style::default().fg(paint.color(&seg.fg)).bg(bgs[i]);
        if seg.bold {
            style = style.add_modifier(Modifier::BOLD);
        }
        out.push(Span::styled(format!(" {} ", seg.label(narrow)), style));
        if nerd && i + 1 < segs.len() {
            out.push(Span::styled(
                PL_RFLAME,
                Style::default().fg(bgs[i]).bg(bgs[i + 1]),
            ));
        }
    }
    if nerd {
        out.push(Span::styled(
            PL_RCURVE,
            Style::default().fg(bgs[bgs.len() - 1]),
        ));
    }
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Align {
    Left,
    Right,
}

/// The pill chain a dialog wants in its top border.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TopBadge {
    pub segs: Vec<PillSegment>,
    /// Alternative chain tried before dropping the badge entirely.
    pub narrow_segs: Option<Vec<PillSegment>>,
    pub align: Align,
}

impl TopBadge {
    pub fn new(segs: Vec<PillSegment>, align: Align) -> Self {
        Self {
            segs,
            narrow_segs: None,
            align,
        }
    }
}

/// A badge that fits its budget, ready to splice into the top border.
#[derive(Clone, Debug)]
pub struct PreparedTop {
    pub spans: Vec<Span<'static>>,
    pub align: Align,
    pub width: u16,
}

/// Fits `top` into `budget` cells: the full chain, else the narrow chain
/// (or the chain's narrow labels), else nothing.
pub fn fit_top(
    top: Option<&TopBadge>,
    budget: u16,
    nerd: bool,
    paint: Paint,
    full_width: Option<u16>,
) -> Option<PreparedTop> {
    let top = top?;
    if top.segs.is_empty() {
        return None;
    }
    let full = full_width.unwrap_or_else(|| pill_width(&top.segs, nerd, false));
    if full <= budget {
        return Some(PreparedTop {
            spans: pill_spans(&top.segs, nerd, false, paint),
            align: top.align,
            width: full,
        });
    }
    let (segs, is_fallback) = match &top.narrow_segs {
        Some(narrow) if !narrow.is_empty() => (narrow, true),
        _ => (&top.segs, false),
    };
    for narrow in [false, true] {
        if !narrow && !is_fallback {
            continue;
        }
        let w = pill_width(segs, nerd, narrow);
        if w <= budget {
            return Some(PreparedTop {
                spans: pill_spans(segs, nerd, narrow, paint),
                align: top.align,
                width: w,
            });
        }
    }
    None
}

fn gradient_cells(total: u16, stops: FrameStops, paint: Paint) -> Vec<ratatui::style::Color> {
    let denom = total.saturating_sub(1).max(1) as f32;
    (0..total)
        .map(|i| paint.gradient(stops, f32::from(i) / denom))
        .collect()
}

/// `╭`, gradient dashes, the badge at column 2 (left) or ending two cells
/// before the corner (right), `╮`.
pub fn top_border_line(
    total_width: u16,
    stops: FrameStops,
    paint: Paint,
    prepared: Option<&PreparedTop>,
) -> Line<'static> {
    if total_width == 0 {
        return Line::default();
    }
    let colors = gradient_cells(total_width, stops, paint);
    let dash = |col: u16| Span::styled("─", Style::default().fg(colors[col as usize]));
    let pill_w = prepared.map_or(0, |p| p.width);
    let pill_start = match prepared {
        None => 1,
        Some(p) if p.align == Align::Right => total_width.saturating_sub(2 + pill_w),
        Some(_) => 2,
    };
    let mut spans = vec![Span::styled("╭", Style::default().fg(colors[0]))];
    if total_width == 1 {
        return Line::from(spans);
    }
    let mut col = 1;
    while col < pill_start && col + 1 < total_width {
        spans.push(dash(col));
        col += 1;
    }
    if let Some(p) = prepared {
        spans.extend(p.spans.iter().cloned());
        col += pill_w;
    }
    while col + 1 < total_width {
        spans.push(dash(col));
        col += 1;
    }
    spans.push(Span::styled(
        "╮",
        Style::default().fg(colors[(total_width - 1) as usize]),
    ));
    Line::from(spans)
}

fn truncate_to_width(text: &str, max_width: usize) -> Option<String> {
    if text.width() <= max_width {
        return Some(text.to_string());
    }
    if max_width < 2 {
        return None;
    }
    let mut cut = String::new();
    for ch in text.chars() {
        let next = cut.width() + ch.to_string().width();
        if next + 1 > max_width {
            break;
        }
        cut.push(ch);
    }
    (!cut.is_empty()).then(|| format!("{cut}…"))
}

/// `╰`, dashes in the gradient's end color, `╯`; with a status the left
/// run reads `╰─ <status> ───╯`, the status truncated with an ellipsis.
pub fn bottom_border_line(
    total_width: u16,
    stops: FrameStops,
    paint: Paint,
    status: Option<&str>,
) -> Line<'static> {
    let color = paint.gradient(stops, 1.0);
    let dim = Style::default().fg(color);
    if total_width <= 1 {
        return Line::from(Span::styled("╰", dim));
    }
    if let Some(status) = status.filter(|s| !s.is_empty())
        && let Some(fitted) = truncate_to_width(status, usize::from(total_width.saturating_sub(6)))
    {
        let trailing = usize::from(total_width).saturating_sub(5 + fitted.width());
        return Line::from(vec![
            Span::styled("╰", dim),
            Span::styled("─ ", dim),
            Span::styled(
                fitted,
                Style::default().fg(paint.color(&paint.theme.dialog.status)),
            ),
            Span::styled(format!(" {}", "─".repeat(trailing)), dim),
            Span::styled("╯", dim),
        ]);
    }
    Line::from(vec![
        Span::styled("╰", dim),
        Span::styled("─".repeat(usize::from(total_width - 2)), dim),
        Span::styled("╯", dim),
    ])
}

/// A centered dialog: gradient top border carrying an optional pill chain,
/// a vertical gradient down the left edge, the end color on the right and
/// bottom edges, an optional bottom status, and one row of padding above and
/// below the body.
#[derive(Clone, Debug)]
pub struct DialogFrame {
    pub stops: FrameStops,
    pub top: Option<TopBadge>,
    pub bottom_status: Option<String>,
    /// Natural content width before the terminal clamp.
    pub natural_width: u16,
    pub paint: Paint,
}

impl DialogFrame {
    pub fn new(stops: FrameStops, natural_width: u16, paint: Paint) -> Self {
        Self {
            stops,
            top: None,
            bottom_status: None,
            natural_width,
            paint,
        }
    }

    pub fn with_top(mut self, top: TopBadge) -> Self {
        self.top = Some(top);
        self
    }

    pub fn with_status(mut self, status: Option<String>) -> Self {
        self.bottom_status = status;
        self
    }

    fn pill_natural(&self) -> u16 {
        self.top
            .as_ref()
            .map_or(0, |top| pill_width(&top.segs, self.paint.nerd_fonts, false))
    }

    /// Inner content width on a terminal `term_cols` wide: the dialog widens
    /// to fit its pill, then clamps to the terminal.
    pub fn inner_width(&self, term_cols: u16) -> u16 {
        dialog_inner_width(term_cols, self.natural_width.max(self.pill_natural()))
    }

    /// Draws the chrome for a body of `body_rows` rows centered in `area` and
    /// returns the body rectangle (clipped to `area`). Bodies taller than the
    /// terminal start at the top and are cut at the bottom.
    pub fn draw(&self, buf: &mut Buffer, area: Rect, body_rows: u16) -> Rect {
        let inner_width = self.inner_width(area.width);
        let total_width = inner_width + 4;
        let middle_rows = body_rows.saturating_add(2);
        let total_height = middle_rows.saturating_add(2);
        // Odd slack rounds toward the bottom-right.
        let x = area.x + area.width.saturating_sub(total_width).div_ceil(2);
        let y = area.y + area.height.saturating_sub(total_height).div_ceil(2);
        let paint = self.paint;

        let prepared = fit_top(
            self.top.as_ref(),
            total_width.saturating_sub(4),
            paint.nerd_fonts,
            paint,
            Some(self.pill_natural()),
        );
        let top = top_border_line(total_width, self.stops, paint, prepared.as_ref());
        set_line_clipped(buf, area, x, y, &top);

        let border_count = middle_rows.max(1);
        let left_colors = gradient_cells(border_count, self.stops, paint);
        let right_color = paint.gradient(self.stops, 1.0);
        for row in 0..middle_rows {
            let yy = y + 1 + row;
            if yy >= area.bottom() {
                break;
            }
            let left = Line::from(Span::styled(
                "│ ",
                Style::default().fg(left_colors[row as usize]),
            ));
            set_line_clipped(buf, area, x, yy, &left);
            let right = Line::from(Span::styled(" │", Style::default().fg(right_color)));
            set_line_clipped(buf, area, x + total_width - 2, yy, &right);
        }

        let bottom = bottom_border_line(
            total_width,
            self.stops,
            paint,
            self.bottom_status.as_deref(),
        );
        set_line_clipped(buf, area, x, y + 1 + middle_rows, &bottom);

        let body_y = y + 2;
        let visible_rows = area.bottom().saturating_sub(body_y).min(body_rows);
        Rect::new(x + 2, body_y, inner_width, visible_rows).intersection(area)
    }
}

fn set_line_clipped(buf: &mut Buffer, area: Rect, x: u16, y: u16, line: &Line<'_>) {
    if y >= area.bottom() || x >= area.right() {
        return;
    }
    buf.set_line(x, y, line, area.right() - x);
}
