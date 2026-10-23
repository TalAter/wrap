//! The `--forget` checklist dialog: four rows with right-aligned footprints,
//! everything checked up front, toggling, submitting (even nothing), and
//! cancelling with Esc or Ctrl+C.

mod common;

use common::*;
use crossterm::event::KeyCode;
use ratatui::style::Color;
use wrap::subcommands::forget::{Bucket, Footprint, Footprints};
use wrap::theme::DARK;
use wrap::tui::Dialog;
use wrap::tui::forget_dialog::{FORGET_CONTENT_WIDTH, ForgetDialog};

fn full() -> Footprints {
    Footprints {
        memory: Footprint::Ok {
            count: 23,
            bytes: 4096,
        },
        logs: Footprint::Ok {
            count: 1203,
            bytes: 4 * 1024 * 1024,
        },
        cache: Footprint::Ok {
            count: 2,
            bytes: 18 * 1024,
        },
        scratch: Footprint::Ok {
            count: 3,
            bytes: 112 * 1024 * 1024,
        },
    }
}

fn empty() -> Footprints {
    Footprints {
        memory: Footprint::Empty,
        logs: Footprint::Empty,
        cache: Footprint::Empty,
        scratch: Footprint::Empty,
    }
}

fn dialog(footprints: &Footprints) -> ForgetDialog {
    ForgetDialog::new(footprints, &DARK, 3, false)
}

fn draw(d: &ForgetDialog, width: u16, height: u16) -> ratatui::buffer::Buffer {
    let mut buf = buffer(width, height);
    let area = buf.area;
    d.render_to(&mut buf, area);
    buf
}

fn text(d: &ForgetDialog) -> String {
    screen(&draw(d, 100, 20))
}

#[test]
fn renders_the_four_rows_with_padded_footprints_all_checked() {
    let d = dialog(&full());
    let s = text(&d);
    assert!(s.contains("❯ [✓] Memory        (23 facts, "), "{s}");
    assert!(s.contains("  [✓] Logs          (1,203 entries, "), "{s}");
    assert!(s.contains("  [✓] Cache         (2 files, "), "{s}");
    assert!(s.contains("  [✓] Temp files    (3 dirs, "), "{s}");
    assert!(s.contains("↑↓ move │ Space toggle │ ⏎ forget │ Esc cancel"));
    assert_eq!(d.checked(), Bucket::ALL);
}

#[test]
fn empty_and_unreadable_buckets_still_render_and_stay_checked() {
    let d = dialog(&empty());
    let s = text(&d);
    assert_eq!(s.matches("(empty)").count(), 4);
    assert_eq!(d.checked(), Bucket::ALL);
    let mut unreadable = full();
    unreadable.memory = Footprint::Unreadable;
    let s = text(&dialog(&unreadable));
    assert!(s.contains("Memory        (unreadable)"));
}

#[test]
fn frame_is_sixty_wide_in_the_forget_gradient() {
    let d = dialog(&full());
    let buf = draw(&d, 100, 20);
    let top = (0..buf.area.height)
        .find(|&y| row(&buf, y).contains("╭"))
        .unwrap();
    let x = find(&buf, top, "╭").unwrap();
    let total = FORGET_CONTENT_WIDTH + 4;
    assert_eq!(x, (100 - total) / 2);
    assert_eq!(buf[(x + total - 1, top)].symbol(), "╮");
    assert_eq!(fg(&buf, x, top), rgb(DARK.forget.frame[0]));
    assert!(row(&buf, top).trim().chars().all(|c| c != ' '), "no pill");
}

#[test]
fn enter_submits_every_checked_bucket_in_row_order() {
    let mut d = dialog(&full());
    assert_eq!(d.key(key(KeyCode::Enter)), Some(Some(Bucket::ALL.to_vec())));
    let mut d = dialog(&empty());
    assert_eq!(d.key(key(KeyCode::Enter)), Some(Some(Bucket::ALL.to_vec())));
}

#[test]
fn space_toggles_the_focused_row_and_the_order_stays_by_row() {
    let mut d = dialog(&full());
    assert_eq!(d.key(ch(' ')), None);
    assert!(text(&d).contains("❯ [ ] Memory"));
    assert_eq!(d.checked(), [Bucket::Logs, Bucket::Cache, Bucket::Scratch]);
    d.key(key(KeyCode::Down));
    d.key(ch(' '));
    assert!(text(&d).contains("❯ [ ] Logs"));
    d.key(key(KeyCode::Up));
    d.key(ch(' '));
    assert_eq!(
        d.key(key(KeyCode::Enter)),
        Some(Some(vec![Bucket::Memory, Bucket::Cache, Bucket::Scratch]))
    );
}

#[test]
fn unchecking_everything_submits_an_empty_selection() {
    let mut d = dialog(&full());
    for i in 0..4 {
        d.key(ch(' '));
        if i < 3 {
            d.key(key(KeyCode::Down));
        }
    }
    assert!(d.checked().is_empty());
    assert_eq!(d.key(key(KeyCode::Enter)), Some(Some(Vec::new())));
}

#[test]
fn esc_ctrl_c_and_external_cancel_all_cancel() {
    let mut d = dialog(&full());
    assert_eq!(d.key(key(KeyCode::Esc)), Some(None));
    let mut d = dialog(&full());
    assert_eq!(d.key(ctrl('c')), Some(None));
    let mut d = dialog(&full());
    assert_eq!(d.cancelled(), None);
    assert!(!d.animating());
}

#[test]
fn opening_the_real_dialog_without_a_terminal_is_an_io_error() {
    use std::io::IsTerminal;
    if std::io::stderr().is_terminal() {
        return;
    }
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let result = rt.block_on(wrap::tui::forget_dialog::show_forget_dialog(
        &full(),
        &DARK,
        3,
        false,
    ));
    assert!(result.is_err());
}

fn row_of(buf: &ratatui::buffer::Buffer, needle: &str) -> u16 {
    (0..buf.area.height)
        .find(|&y| row(buf, y).contains(needle))
        .unwrap_or_else(|| panic!("{needle:?} not on screen:\n{}", screen(buf)))
}

#[test]
fn focus_highlight_covers_only_the_row_text() {
    let d = dialog(&full());
    let buf = draw(&d, 100, 20);
    let y = row_of(&buf, "❯ [✓] Memory");
    let start = find(&buf, y, "❯").unwrap();
    let close = find(&buf, y, "4K)").unwrap() + 2;
    let highlight = rgb(DARK.checklist.row_focused_bg.base);
    assert_eq!(bg(&buf, start, y), highlight);
    assert_eq!(bg(&buf, close, y), highlight, "last glyph of the row");
    assert_eq!(
        bg(&buf, close + 1, y),
        Color::Reset,
        "no fill past the text: {}",
        row(&buf, y)
    );
}

#[test]
fn narrow_terminals_wrap_rows_and_the_action_bar_instead_of_truncating() {
    let d = dialog(&full());
    for width in [48u16, 40] {
        let buf = draw(&d, width, 30);
        // Wrapped rows interleave with the frame's side borders.
        let s = screen(&buf);
        let flat: String = s
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '│')
            .collect();
        for needle in [
            "(23facts,4K)",
            "(1,203entries,4M)",
            "(3dirs,112M)",
            "↑↓move",
            "Spacetoggle",
            "⏎forget",
            "Esccancel",
        ] {
            assert!(
                flat.contains(needle),
                "{needle} missing at {width} cols:\n{s}"
            );
        }
        for line in rows(&buf) {
            assert!(
                unicode_width::UnicodeWidthStr::width(line.as_str()) <= usize::from(width),
                "{line}"
            );
        }
        let top = row_of(&buf, "╭");
        let bottom = row_of(&buf, "╰");
        let frame_x = find(&buf, top, "╭").unwrap();
        for y in top + 1..bottom {
            assert_eq!(
                buf[(frame_x, y)].symbol(),
                "│",
                "left border continuous at row {y}:\n{s}"
            );
        }
    }
}
