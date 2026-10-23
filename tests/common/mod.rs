//! Shared helpers for the TUI integration tests.
#![allow(dead_code)]

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Color;
use wrap::theme::{DARK, Theme};
use wrap::tui::Paint;

pub fn paint() -> Paint {
    Paint::new(&DARK, 3, false)
}

pub fn paint_with(theme: &'static Theme, level: u8, nerd: bool) -> Paint {
    Paint::new(theme, level, nerd)
}

pub fn buffer(width: u16, height: u16) -> Buffer {
    Buffer::empty(Rect::new(0, 0, width, height))
}

/// The buffer as text, one string per row, trailing spaces trimmed.
pub fn rows(buf: &Buffer) -> Vec<String> {
    (0..buf.area.height)
        .map(|y| {
            let row: String = (0..buf.area.width).map(|x| buf[(x, y)].symbol()).collect();
            row.trim_end().to_string()
        })
        .collect()
}

pub fn screen(buf: &Buffer) -> String {
    rows(buf).join("\n")
}

/// Row `y` without trailing spaces.
pub fn row(buf: &Buffer, y: u16) -> String {
    rows(buf)[usize::from(y)].clone()
}

/// Column of the first occurrence of `needle` in row `y`, in cells.
pub fn find(buf: &Buffer, y: u16, needle: &str) -> Option<u16> {
    let row: Vec<&str> = (0..buf.area.width).map(|x| buf[(x, y)].symbol()).collect();
    let joined = row.concat();
    let byte = joined.find(needle)?;
    let mut acc = 0;
    for (i, sym) in row.iter().enumerate() {
        if acc == byte {
            return Some(i as u16);
        }
        acc += sym.len();
    }
    None
}

pub fn fg(buf: &Buffer, x: u16, y: u16) -> Color {
    buf[(x, y)].fg
}

pub fn bg(buf: &Buffer, x: u16, y: u16) -> Color {
    buf[(x, y)].bg
}

pub fn rgb((r, g, b): (u8, u8, u8)) -> Color {
    Color::Rgb(r, g, b)
}

pub fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

pub fn ch(c: char) -> KeyEvent {
    key(KeyCode::Char(c))
}

pub fn ctrl(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
}

pub fn alt(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::ALT)
}

pub fn shift(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::SHIFT)
}
