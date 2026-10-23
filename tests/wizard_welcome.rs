//! The welcome section: the one-shot animation schedule, the layout switch
//! on terminal size, the gradient-colored logo, and its two keys.

mod common;

use std::time::{Duration, Instant};

use common::*;
use crossterm::event::KeyCode;
use ratatui::style::Modifier;
use wrap::ansi::interpolate;
use wrap::theme::DARK;
use wrap::tui::welcome::{
    ANIMATION_MIN_TERM_COLS, ANIMATION_MIN_TERM_ROWS, LOGO, WelcomeExit, WelcomeSection, next_step,
    shows_animation,
};
use wrap::tui::welcome_frames::{CANVAS_HEIGHT, FRAMES};
use wrap::tui::wizard_dialog::WIZARD_CONTENT_WIDTH;

fn draw(w: &WelcomeSection, width: u16, height: u16) -> ratatui::buffer::Buffer {
    let mut buf = buffer(width, height);
    let area = buf.area;
    w.render_to(&mut buf, area, paint());
    buf
}

fn row_of(buf: &ratatui::buffer::Buffer, needle: &str) -> u16 {
    (0..buf.area.height)
        .find(|&y| row(buf, y).contains(needle))
        .unwrap_or_else(|| panic!("{needle:?} not on screen:\n{}", screen(buf)))
}

#[test]
fn next_step_holds_then_sweeps_forward_once_and_parks_on_the_last_frame() {
    let last = FRAMES.len() - 1;
    let first = next_step(0, &FRAMES).unwrap();
    assert_eq!((first.next_index, first.delay_ms), (1, 1000.0));
    let mid = next_step(3, &FRAMES).unwrap();
    assert_eq!(mid.next_index, 4);
    assert_eq!(mid.delay_ms, FRAMES[3].duration_ms * 1.5);
    assert!(next_step(last, &FRAMES).is_none());
    assert!(next_step(0, &[]).is_none());
    assert!(next_step(0, &FRAMES[..1]).is_none());

    let mut visited = vec![0];
    let mut index = 0;
    while let Some(step) = next_step(index, &FRAMES) {
        index = step.next_index;
        visited.push(index);
    }
    assert_eq!(visited, (0..=last).collect::<Vec<_>>());
}

#[test]
fn animation_needs_the_wide_and_tall_terminal() {
    assert_eq!(ANIMATION_MIN_TERM_COLS, WIZARD_CONTENT_WIDTH + 4 + 40 + 8);
    assert_eq!(ANIMATION_MIN_TERM_ROWS, CANVAS_HEIGHT + 4);
    assert!(shows_animation(
        ANIMATION_MIN_TERM_COLS,
        ANIMATION_MIN_TERM_ROWS
    ));
    assert!(!shows_animation(
        ANIMATION_MIN_TERM_COLS - 1,
        ANIMATION_MIN_TERM_ROWS
    ));
    assert!(!shows_animation(
        ANIMATION_MIN_TERM_COLS,
        ANIMATION_MIN_TERM_ROWS - 1
    ));
}

#[test]
fn narrow_layout_stacks_logo_copy_and_hints_without_the_brain() {
    let w = WelcomeSection::new(Instant::now());
    let buf = draw(&w, 100, 30);
    let s = screen(&buf);
    for line in LOGO {
        assert!(s.contains(line.trim_end()), "{line}");
    }
    assert!(s.contains("a cli with taste (yours)"));
    assert!(s.contains("Quick one-time setup — pick your AI provider and a couple of"));
    assert!(
        s.contains("preferences."),
        "the blurb wraps inside the padded column"
    );
    assert!(s.contains("◷ Takes ~45 seconds."));
    assert!(s.contains("⏎ to continue │ Esc to cancel"));
    assert!(!s.contains("⣿"));

    let top = row_of(&buf, "╭");
    let frame_x = find(&buf, top, "╭").unwrap();
    let total = WIZARD_CONTENT_WIDTH + 4;
    assert_eq!(buf[(frame_x + total - 1, top)].symbol(), "╮");
    let logo_y = row_of(&buf, LOGO[0].trim_end());
    assert_eq!(
        find(&buf, logo_y, "██╗").unwrap(),
        frame_x + 2 + 3,
        "padded 3"
    );
    assert_eq!(logo_y, top + 2, "logo is the first body row");
    let hints_y = row_of(&buf, "⏎ to continue");
    assert_eq!(hints_y, logo_y + 16, "15 copy rows + blank + hints");
}

#[test]
fn logo_rows_interpolate_the_welcome_gradient_and_copy_is_accented() {
    let w = WelcomeSection::new(Instant::now());
    let buf = draw(&w, 100, 30);
    let logo_y = row_of(&buf, LOGO[0].trim_end());
    let x = find(&buf, logo_y, "██╗").unwrap();
    let stops = DARK.wizard.welcome_logo;
    assert_eq!(fg(&buf, x, logo_y), rgb(interpolate(&stops, 0.0)));
    assert!(buf[(x, logo_y)].modifier.contains(Modifier::BOLD));
    assert_eq!(fg(&buf, x + 1, logo_y + 5), rgb(interpolate(&stops, 1.0)));
    let two_fifths = interpolate(&stops, 2.0 / 5.0);
    assert_eq!(fg(&buf, x, logo_y + 2), rgb(two_fifths));

    let tag_y = row_of(&buf, "a cli with taste");
    let tx = find(&buf, tag_y, "taste").unwrap();
    assert_eq!(fg(&buf, tx, tag_y), rgb(DARK.copy.pop.base));
    assert!(buf[(tx, tag_y)].modifier.contains(Modifier::BOLD));
    assert!(!buf[(tx - 1, tag_y)].modifier.contains(Modifier::BOLD));

    let takes_y = row_of(&buf, "◷ Takes");
    let sx = find(&buf, takes_y, "~45").unwrap();
    assert_eq!(fg(&buf, sx, takes_y), rgb(DARK.copy.success.base));
    assert_ne!(fg(&buf, sx - 2, takes_y), rgb(DARK.copy.success.base));
}

#[test]
fn wide_layout_puts_the_brain_in_a_right_column_and_centers_the_copy() {
    let w = WelcomeSection::new(Instant::now());
    let buf = draw(&w, 140, 30);
    let s = screen(&buf);
    let brain_row = FRAMES[0].content[5].trim_end();
    assert!(s.contains(brain_row), "{s}");
    let top = row_of(&buf, "╭");
    let frame_x = find(&buf, top, "╭").unwrap();
    let total = WIZARD_CONTENT_WIDTH + 4 + 40 + 4;
    assert_eq!(buf[(frame_x + total - 1, top)].symbol(), "╮");
    let body_y = top + 2;
    let logo_y = row_of(&buf, LOGO[0].trim_end());
    assert_eq!(logo_y, body_y + 2, "15 rows centered in 19");
    let hints_y = row_of(&buf, "⏎ to continue");
    assert_eq!(hints_y, body_y + CANVAS_HEIGHT - 1);
    let brain_x = frame_x + 2 + WIZARD_CONTENT_WIDTH + 4;
    let brain_y = row_of(&buf, brain_row);
    assert_eq!(brain_y, body_y + 5);
    let first_cell = FRAMES[0].content[5].find(|c| c != ' ').unwrap();
    let first_cell_x = brain_x + FRAMES[0].content[5][..first_cell].chars().count() as u16;
    let stops = DARK.wizard.welcome_brain;
    assert_eq!(
        fg(&buf, first_cell_x, brain_y),
        rgb(interpolate(stops, 5.0 / 19.0))
    );
}

#[test]
fn frames_advance_on_the_schedule_and_stop_on_the_last() {
    let start = Instant::now();
    let mut w = WelcomeSection::new(start);
    assert_eq!(w.frame_index(), 0);
    assert!(!w.advance(start + Duration::from_millis(999)));
    assert_eq!(w.frame_index(), 0);
    assert!(w.advance(start + Duration::from_millis(1000)));
    assert_eq!(w.frame_index(), 1);
    let frame_ms = FRAMES[1].duration_ms * 1.5;
    assert!(!w.advance(start + Duration::from_millis(1000 + frame_ms as u64 - 2)));
    assert!(w.advance(start + Duration::from_millis(1000 + frame_ms.ceil() as u64)));
    assert_eq!(w.frame_index(), 2);
    assert!(w.advance(start + Duration::from_secs(60)));
    assert_eq!(w.frame_index(), FRAMES.len() - 1);
    assert!(w.finished());
    assert!(!w.advance(start + Duration::from_secs(120)));

    let s = screen(&draw(&w, 140, 30));
    let last = FRAMES[FRAMES.len() - 1].content[5].trim_end();
    assert!(s.contains(last));
}

#[test]
fn enter_continues_and_esc_cancels() {
    let mut w = WelcomeSection::new(Instant::now());
    assert_eq!(w.key(key(KeyCode::Down)), None);
    assert_eq!(w.key(ch('x')), None);
    assert_eq!(w.key(key(KeyCode::Enter)), Some(WelcomeExit::Continue));
    assert_eq!(w.key(key(KeyCode::Esc)), Some(WelcomeExit::Cancel));
}
