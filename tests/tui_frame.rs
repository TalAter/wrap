//! Dialog chrome: width math, pill chains, and the gradient border.

mod common;

use common::*;
use ratatui::style::{Color, Modifier};
use ratatui::text::Line;
use unicode_width::UnicodeWidthStr;
use wrap::ansi::gradient;
use wrap::theme::{ColorRef, DARK, TokenPair};
use wrap::tui::{
    Align, DialogFrame, PillSegment, SizeBasis, TopBadge, bottom_border_line,
    content_natural_width, dialog_inner_width, fit_top, pill_spans, pill_width, top_border_line,
};

fn text(line: &Line<'_>) -> String {
    line.spans.iter().map(|s| s.content.as_ref()).collect()
}

fn pair(fg: (u8, u8, u8), bg: (u8, u8, u8)) -> TokenPair {
    TokenPair {
        fg: ColorRef::rgb(fg),
        bg: ColorRef::rgb(bg),
    }
}

fn seg(label: &str) -> PillSegment {
    PillSegment::new(label, pair((255, 255, 255), (30, 30, 30)))
}

fn risk_pill(level: &str) -> PillSegment {
    let (tokens, label) = match level {
        "low" => (&DARK.risk.low, "✔ low risk"),
        "medium" => (&DARK.risk.medium, "⚠ medium risk"),
        _ => (&DARK.risk.high, "⚠ high risk"),
    };
    PillSegment::new(label, tokens.pill).bold()
}

fn render_top(width: u16, top: Option<&TopBadge>, nerd: bool) -> Line<'static> {
    let p = paint_with(&DARK, 3, nerd);
    let prepared = fit_top(top, width - 2, nerd, p, None);
    top_border_line(width, DARK.risk.medium.frame, p, prepared.as_ref())
}

// ── width math ───────────────────────────────────────────────────

#[test]
fn inner_width_clamps_natural_content_to_the_terminal_minus_margin_and_borders() {
    assert_eq!(
        dialog_inner_width(100, 40),
        40,
        "content fits: natural wins"
    );
    assert_eq!(
        dialog_inner_width(80, 200),
        72,
        "clamped to cols - 4 margin - 4 borders"
    );
    assert_eq!(dialog_inner_width(3, 200), 1, "never below a 5-cell dialog");
}

#[test]
fn natural_width_takes_the_widest_contributor_floored_at_min() {
    assert_eq!(
        content_natural_width(&[SizeBasis::Text("ab"), SizeBasis::Text("abcd")], 0),
        4
    );
    assert_eq!(
        content_natural_width(&[SizeBasis::Cells(10), SizeBasis::Text("ab")], 0),
        10
    );
    assert_eq!(content_natural_width(&[SizeBasis::Text("ab")], 5), 5);
    assert_eq!(
        content_natural_width(&[SizeBasis::Text("日本")], 0),
        4,
        "CJK is two cells"
    );
    assert_eq!(
        content_natural_width(&[SizeBasis::Text("short\nmuch longer line")], 0),
        16,
        "multi-line text measures its widest line"
    );
    assert_eq!(content_natural_width(&[], 0), 0);
}

// ── pills ────────────────────────────────────────────────────────

#[test]
fn pill_width_counts_padded_bodies_plus_nerd_caps_and_flames() {
    let wiz = seg("Wizard").narrow("W");
    let done = seg("API Key").narrow("K");
    let active = seg("Model").narrow("M");
    assert_eq!(pill_width(std::slice::from_ref(&wiz), false, false), 8);
    assert_eq!(pill_width(std::slice::from_ref(&wiz), true, false), 10);
    let chain = [wiz, done, active];
    assert_eq!(pill_width(&chain, false, false), 8 + 9 + 7);
    assert_eq!(pill_width(&chain, true, false), 8 + 9 + 7 + 2 + 2);
    assert_eq!(pill_width(&chain, false, true), 3 + 3 + 3);
    assert_eq!(
        pill_width(&[seg("Risk")], false, true),
        6,
        "narrow falls back to label"
    );
    assert_eq!(pill_width(&[], true, true), 0);
}

#[test]
fn pill_spans_wrap_in_powerline_glyphs_only_with_nerd_fonts() {
    let wiz = PillSegment::new("Wizard", pair((200, 200, 240), (70, 90, 150))).bold();
    let done = seg("API Key");
    let plain = pill_spans(std::slice::from_ref(&wiz), false, false, paint());
    assert_eq!(text(&Line::from(plain.clone())), " Wizard ");
    assert_eq!(plain[0].style.bg, Some(Color::Rgb(70, 90, 150)));
    assert!(plain[0].style.add_modifier.contains(Modifier::BOLD));

    let nerd = pill_spans(&[wiz.clone(), done.clone()], true, false, paint());
    assert_eq!(
        text(&Line::from(nerd.clone())),
        "\u{E0B6} Wizard \u{E0C0} API Key \u{E0B4}"
    );
    let flame = nerd.iter().find(|s| s.content == "\u{E0C0}").unwrap();
    assert_eq!(
        flame.style.fg,
        Some(Color::Rgb(70, 90, 150)),
        "flame fg = previous bg"
    );
    assert_eq!(
        flame.style.bg,
        Some(Color::Rgb(30, 30, 30)),
        "flame bg = next bg"
    );
    assert!(
        !nerd[2].style.add_modifier.contains(Modifier::BOLD),
        "bold is per segment"
    );
    for narrow in [false, true] {
        for nerd in [false, true] {
            let spans = pill_spans(&[wiz.clone(), done.clone()], nerd, narrow, paint());
            assert_eq!(
                text(&Line::from(spans)).width() as u16,
                pill_width(&[wiz.clone(), done.clone()], nerd, narrow)
            );
        }
    }
}

// ── top border ───────────────────────────────────────────────────

#[test]
fn top_border_embeds_the_risk_pill_right_aligned_before_the_corner() {
    for (level, label) in [
        ("medium", "⚠ medium risk"),
        ("high", "⚠ high risk"),
        ("low", "✔ low risk"),
    ] {
        let top = TopBadge::new(vec![risk_pill(level)], Align::Right);
        let line = render_top(60, Some(&top), false);
        let s = text(&line);
        assert!(s.starts_with('╭') && s.ends_with('╮'), "{s}");
        assert_eq!(s.width(), 60);
        assert!(s.ends_with(&format!(" {label} ─╮")), "{s}");
        let body = line
            .spans
            .iter()
            .find(|sp| sp.content.contains(label))
            .unwrap();
        assert!(body.style.add_modifier.contains(Modifier::BOLD));
        assert!(body.style.bg.is_some());
    }
    let low = text(&render_top(
        60,
        Some(&TopBadge::new(vec![risk_pill("low")], Align::Right)),
        false,
    ));
    assert!(!low.contains('⚠'));
    let nerd = text(&render_top(
        60,
        Some(&TopBadge::new(vec![risk_pill("medium")], Align::Right)),
        true,
    ));
    assert!(nerd.contains("\u{E0B6} ⚠ medium risk \u{E0B4}"));
}

#[test]
fn top_border_without_a_pill_is_corners_and_a_gradient_of_dashes() {
    let line = render_top(60, None, false);
    let s = text(&line);
    assert_eq!(s.width(), 60);
    assert_eq!(s, format!("╭{}╮", "─".repeat(58)));
    let [start, end] = DARK.risk.medium.frame;
    assert_eq!(line.spans[0].style.fg, Some(rgb(start)));
    assert_eq!(line.spans[59].style.fg, Some(rgb(end)));
    assert_eq!(
        line.spans[30].style.fg,
        Some(rgb(gradient(start, end, 30.0 / 59.0)))
    );
}

#[test]
fn left_aligned_pill_sits_right_after_the_corner_dash() {
    let top = TopBadge::new(vec![seg("LEFT")], Align::Left);
    let s = text(&render_top(60, Some(&top), false));
    assert!(s.starts_with("╭─ LEFT ─"), "{s}");
    assert_eq!(s.width(), 60);
}

#[test]
fn fit_top_falls_back_to_narrow_labels_then_drops_the_badge() {
    let p = paint();
    let huge = TopBadge::new(
        vec![seg(&"X".repeat(100)).narrow("Y".repeat(100))],
        Align::Left,
    );
    assert!(fit_top(Some(&huge), 38, false, p, None).is_none());
    assert!(
        fit_top(
            Some(&TopBadge::new(vec![], Align::Left)),
            60,
            false,
            p,
            None
        )
        .is_none()
    );
    assert!(fit_top(None, 60, false, p, None).is_none());

    let crumbs = TopBadge::new(
        vec![
            seg("Providers").narrow("P"),
            seg("API Key").narrow("K"),
            seg("Model").narrow("M"),
            seg("Default").narrow("D"),
        ],
        Align::Left,
    );
    let prepared = fit_top(Some(&crumbs), 28, false, p, None).unwrap();
    let s = text(&Line::from(prepared.spans));
    assert!(
        !s.contains("Providers") && s.contains(" P ") && s.contains(" K "),
        "{s}"
    );

    let mut alt = TopBadge::new(
        vec![seg("WIDE LABEL ONE"), seg("WIDE LABEL TWO")],
        Align::Left,
    );
    alt.narrow_segs = Some(vec![seg("N")]);
    let s = text(&Line::from(
        fit_top(Some(&alt), 10, false, p, None).unwrap().spans,
    ));
    assert_eq!(s, " N ");

    let mut prefer_full = TopBadge::new(vec![seg("WIDE")], Align::Left);
    prefer_full.narrow_segs = Some(vec![seg("N")]);
    let s = text(&Line::from(
        fit_top(Some(&prefer_full), 60, false, p, None)
            .unwrap()
            .spans,
    ));
    assert_eq!(s, " WIDE ");

    let mut chain = TopBadge::new(vec![seg(&"X".repeat(50))], Align::Left);
    chain.narrow_segs = Some(vec![seg("API Key").narrow("K"), seg("Model").narrow("M")]);
    let s = text(&Line::from(
        fit_top(Some(&chain), 8, false, p, None).unwrap().spans,
    ));
    assert_eq!(s, " K  M ", "narrow chain, narrow labels");
}

// ── bottom border ────────────────────────────────────────────────

#[test]
fn bottom_border_uses_the_end_color_and_embeds_a_truncated_status() {
    let p = paint();
    let stops = DARK.risk.medium.frame;
    let end = rgb(stops[1]);
    let plain = bottom_border_line(60, stops, p, None);
    let s = text(&plain);
    assert_eq!(s, format!("╰{}╯", "─".repeat(58)));
    assert!(plain.spans.iter().all(|sp| sp.style.fg == Some(end)));

    let status = bottom_border_line(60, stops, p, Some("⢎ Reticulating splines..."));
    let s = text(&status);
    assert!(s.starts_with("╰─ ⢎ Reticulating splines... ─"), "{s}");
    assert!(s.ends_with('╯'));
    assert_eq!(s.width(), 60);
    let status_span = status
        .spans
        .iter()
        .find(|sp| sp.content.contains("Reticulating"))
        .unwrap();
    assert_eq!(status_span.style.fg, Some(rgb(DARK.dialog.status.base)));
    assert_eq!(status.spans[0].style.fg, Some(end));
    assert_eq!(
        text(&bottom_border_line(60, stops, p, Some("⢎ Hi"))).width(),
        60
    );

    let truncated = text(&bottom_border_line(
        20,
        stops,
        p,
        Some("⢎ Reticulating splines..."),
    ));
    assert_eq!(truncated.width(), 20);
    assert!(
        truncated.contains('…') && truncated.starts_with("╰─ ⢎ "),
        "{truncated}"
    );

    let tiny = text(&bottom_border_line(
        7,
        stops,
        p,
        Some("⢎ Reticulating splines..."),
    ));
    assert_eq!(
        tiny, "╰─────╯",
        "no room for even an ellipsis: plain border"
    );
    assert_eq!(text(&bottom_border_line(1, stops, p, None)), "╰");
}

// ── the whole frame ──────────────────────────────────────────────

#[test]
fn frame_centers_the_dialog_and_returns_the_padded_body_rect() {
    let mut buf = buffer(80, 12);
    let frame = DialogFrame::new(DARK.risk.low.frame, 40, paint())
        .with_top(TopBadge::new(vec![risk_pill("low")], Align::Right))
        .with_status(Some("Loading models list…".into()));
    let buf_area = buf.area;
    let body = frame.draw(&mut buf, buf_area, 2);
    // total 44 wide × 6 tall, centered: x = (80-44)/2 = 18, y = (12-6)/2 = 3.
    assert_eq!(body, ratatui::layout::Rect::new(20, 5, 40, 2));
    let top = row(&buf, 3);
    assert!(top.starts_with(&format!("{}╭", " ".repeat(18))), "{top}");
    assert!(top.ends_with(" ✔ low risk ─╮"), "{top}");
    assert_eq!(top.width(), 18 + 44);
    assert_eq!(
        row(&buf, 4),
        format!("{}│{}│", " ".repeat(18), " ".repeat(42)),
        "padding row"
    );
    assert_eq!(
        row(&buf, 7),
        format!("{}│{}│", " ".repeat(18), " ".repeat(42))
    );
    assert!(
        row(&buf, 8).contains("╰─ Loading models list… ─"),
        "{}",
        row(&buf, 8)
    );
    assert_eq!(row(&buf, 9), "");
    // Left column is a vertical gradient; right column is the end color.
    let [start, end] = DARK.risk.low.frame;
    assert_eq!(fg(&buf, 18, 4), rgb(start));
    assert_eq!(fg(&buf, 18, 7), rgb(end));
    assert_eq!(fg(&buf, 18, 5), rgb(gradient(start, end, 1.0 / 3.0)));
    assert_eq!(fg(&buf, 61, 4), rgb(end));
    assert_eq!(fg(&buf, 61, 7), rgb(end));
}

#[test]
fn frame_widens_to_fit_its_pill_and_clamps_to_the_terminal() {
    let p = paint();
    let wide = DialogFrame::new(DARK.risk.low.frame, 10, p).with_top(TopBadge::new(
        vec![seg("a much wider pill label")],
        Align::Left,
    ));
    assert_eq!(
        wide.inner_width(100),
        25,
        "pill natural width wins over content"
    );
    assert_eq!(
        DialogFrame::new(DARK.risk.low.frame, 10, p).inner_width(100),
        10
    );
    assert_eq!(wide.inner_width(20), 12, "terminal clamp: 20 - 4 - 4");
    let mut buf = buffer(20, 8);
    let buf_area = buf.area;
    let body = wide.draw(&mut buf, buf_area, 1);
    assert_eq!(body.width, 12);
    assert_eq!(
        row(&buf, 2),
        "  ╭──────────────╮",
        "pill dropped when it cannot fit"
    );
}

#[test]
fn frame_taller_than_the_terminal_starts_at_the_top_and_clips() {
    let mut buf = buffer(40, 5);
    let frame = DialogFrame::new(DARK.risk.low.frame, 20, paint());
    let buf_area = buf.area;
    let body = frame.draw(&mut buf, buf_area, 10);
    assert_eq!(body.y, 2);
    assert_eq!(body.height, 3, "only the rows that fit");
    assert!(row(&buf, 0).contains('╭'));
}

#[test]
fn gradient_collapses_to_the_body_color_below_truecolor() {
    for level in [1u8, 2] {
        let p = paint_with(&DARK, level, false);
        let line = top_border_line(30, DARK.risk.high.frame, p, None);
        let body = wrap::theme::resolve_color(&DARK.copy.body, level);
        assert!(
            line.spans.iter().all(|s| s.style.fg == Some(body)),
            "level {level}"
        );
        assert_ne!(body, Color::Rgb(210, 210, 225), "quantized, not raw rgb");
    }
    let spans = pill_spans(
        &[risk_pill("high")],
        false,
        false,
        paint_with(&DARK, 1, false),
    );
    assert!(
        matches!(spans[0].style.fg, Some(Color::Red | Color::LightRed)),
        "{:?}",
        spans[0].style.fg
    );
}

#[test]
fn frame_rounds_odd_centering_slack_up_on_both_axes() {
    // 69 wide on 100 columns: slack 31 → x = 16; 10 tall on 15 rows: slack 5 → y = 3.
    let mut buf = buffer(100, 15);
    let frame = DialogFrame::new(DARK.risk.low.frame, 65, paint());
    let buf_area = buf.area;
    let body = frame.draw(&mut buf, buf_area, 6);
    assert_eq!(body, ratatui::layout::Rect::new(18, 5, 65, 6));
    assert!(
        row(&buf, 3).starts_with(&format!("{}╭", " ".repeat(16))),
        "{}",
        row(&buf, 3)
    );
    assert_eq!(row(&buf, 2), "");
    assert!(row(&buf, 12).contains('╯'), "{}", row(&buf, 12));
    assert_eq!(row(&buf, 13), "");
}
