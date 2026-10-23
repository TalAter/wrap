//! The nerd-icons detection screen: prompt and test glyphs, the ❯ marker
//! and its colors, arrow toggling, Enter selecting, Esc cancelling.

mod common;

use common::*;
use crossterm::event::KeyCode;
use ratatui::style::Color;
use wrap::theme::DARK;
use wrap::tui::nerd_icons::{NERD_TEST_ICONS, NerdIconsExit, NerdIconsSection};

fn draw(n: &NerdIconsSection) -> ratatui::buffer::Buffer {
    let mut buf = buffer(100, 30);
    let area = buf.area;
    n.render_to(&mut buf, area, paint());
    buf
}

fn row_of(buf: &ratatui::buffer::Buffer, needle: &str) -> u16 {
    (0..buf.area.height)
        .find(|&y| row(buf, y).contains(needle))
        .unwrap_or_else(|| panic!("{needle:?} not on screen:\n{}", screen(buf)))
}

#[test]
fn shows_the_prompt_the_four_glyphs_both_options_and_the_wizard_pill() {
    let n = NerdIconsSection::new();
    let buf = draw(&n);
    let s = screen(&buf);
    assert!(s.contains("Do you see four icons below?"));
    assert!(
        s.contains(&format!("    {}", NERD_TEST_ICONS.join("  "))),
        "{s}"
    );
    assert!(s.contains("  ❯ Yes — enable icons throughout Wrap"));
    assert!(s.contains("    No — they look like boxes or question marks"));
    assert!(s.contains("↑↓ to move │ ⏎ to select"));
    assert!(s.contains(" 🧙  Setup Wizard "), "{s}");
    assert!(!s.contains("Providers"), "label pill only");
    let icons_y = row_of(&buf, NERD_TEST_ICONS[0]);
    assert_eq!(icons_y, row_of(&buf, "four icons") + 2);
}

#[test]
fn marker_and_labels_take_the_nerd_choice_colors() {
    let mut n = NerdIconsSection::new();
    let buf = draw(&n);
    let yes_y = row_of(&buf, "Yes —");
    let marker_x = find(&buf, yes_y, "❯").unwrap();
    assert_eq!(
        fg(&buf, marker_x, yes_y),
        rgb(DARK.wizard.nerd_choice_marker.base)
    );
    let yes_x = find(&buf, yes_y, "Yes").unwrap();
    assert_eq!(
        fg(&buf, yes_x, yes_y),
        rgb(DARK.wizard.nerd_choice_selected_label.base)
    );
    let no_x = find(&buf, yes_y + 1, "No").unwrap();
    assert_eq!(
        fg(&buf, no_x, yes_y + 1),
        rgb(DARK.wizard.nerd_choice_label.base)
    );

    assert_eq!(n.key(key(KeyCode::Down)), None);
    let buf = draw(&n);
    assert!(screen(&buf).contains("  ❯ No — they look"));
    assert!(screen(&buf).contains("    Yes — enable"));
    assert_eq!(
        fg(&buf, no_x, yes_y + 1),
        rgb(DARK.wizard.nerd_choice_selected_label.base)
    );
}

#[test]
fn every_arrow_toggles_between_the_two_options() {
    let mut n = NerdIconsSection::new();
    assert_eq!(n.cursor(), 0);
    n.key(key(KeyCode::Down));
    assert_eq!(n.cursor(), 1);
    n.key(key(KeyCode::Down));
    assert_eq!(n.cursor(), 0);
    n.key(key(KeyCode::Up));
    assert_eq!(n.cursor(), 1);
    n.key(key(KeyCode::Left));
    assert_eq!(n.cursor(), 0);
    n.key(key(KeyCode::Right));
    assert_eq!(n.cursor(), 1);
}

#[test]
fn enter_selects_and_esc_cancels() {
    let mut n = NerdIconsSection::new();
    assert_eq!(n.key(ch('x')), None);
    assert_eq!(
        n.key(key(KeyCode::Enter)),
        Some(NerdIconsExit::Selected(true))
    );
    n.key(key(KeyCode::Down));
    assert_eq!(
        n.key(key(KeyCode::Enter)),
        Some(NerdIconsExit::Selected(false))
    );
    assert_eq!(n.key(key(KeyCode::Esc)), Some(NerdIconsExit::Cancel));
}

#[test]
fn prompt_and_glyph_rows_use_the_terminal_default_colour() {
    let n = NerdIconsSection::new();
    let buf = draw(&n);
    let y = row_of(&buf, "four icons");
    let x = find(&buf, y, "Do").unwrap();
    assert_eq!(fg(&buf, x, y), Color::Reset);
    let y = row_of(&buf, NERD_TEST_ICONS[0]);
    let x = find(&buf, y, NERD_TEST_ICONS[0]).unwrap();
    assert_eq!(fg(&buf, x, y), Color::Reset);
}
