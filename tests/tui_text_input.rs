//! The editable strip: cursor movement, readline keys, multiline wrapping
//! and windowing, masking, paste sanitising and the buffer cap.

mod common;

use common::*;
use crossterm::event::KeyCode;
use ratatui::style::Modifier;
use wrap::theme::DARK;
use wrap::tui::{
    Cursor, InputEvent, InputFrame, InputLayout, MAX_BUFFER_BYTES, TextInput, clamp_buffer_size,
};

fn render(input: &TextInput, width: u16, layout: Option<InputLayout>) -> ratatui::buffer::Buffer {
    let frame = input.frame(paint(), layout);
    let h = frame.height(width);
    let mut buf = buffer(width, h);
    let buf_area = buf.area;
    frame.render(&mut buf, buf_area, paint());
    buf
}

fn cursor_cells(buf: &ratatui::buffer::Buffer) -> Vec<(u16, u16, String)> {
    let mut out = Vec::new();
    for y in 0..buf.area.height {
        for x in 0..buf.area.width {
            if buf[(x, y)].modifier.contains(Modifier::REVERSED) {
                out.push((x, y, buf[(x, y)].symbol().to_string()));
            }
        }
    }
    out
}

// ── cursor ───────────────────────────────────────────────────────

#[test]
fn cursor_edits_by_grapheme_and_clamps_offsets() {
    let mut c = Cursor::new("hllo", 1);
    c.insert("e");
    assert_eq!((c.text(), c.offset()), ("hello", 2));
    c.end();
    c.backspace();
    assert_eq!((c.text(), c.offset()), ("hell", 4));
    c.home();
    c.backspace();
    assert_eq!(c.text(), "hell", "backspace at start is a no-op");
    c.delete();
    assert_eq!((c.text(), c.offset()), ("ell", 0));
    c.end();
    c.delete();
    assert_eq!(c.text(), "ell");
    let mut emoji = Cursor::new("a👋b", 1);
    emoji.right();
    assert_eq!((emoji.offset(), emoji.at()), (5, "b"));
    emoji.left();
    assert_eq!(emoji.at(), "👋");
    assert_eq!(Cursor::new("hi", 100).offset(), 2);
    assert_eq!(Cursor::new("é", 1).offset(), 0, "snaps to a char boundary");
    let c = Cursor::new("hello", 2);
    assert_eq!((c.before(), c.at(), c.after()), ("he", "l", "lo"));
    assert_eq!(
        Cursor::new("hi", 2).at(),
        " ",
        "past the end reads as a space"
    );
}

#[test]
fn cursor_word_motions_follow_readline_semantics() {
    let mut c = Cursor::at_end("hello world");
    c.word_left();
    assert_eq!(c.offset(), 6);
    c.home();
    c.word_right();
    assert_eq!(c.offset(), 5);
    c.word_right();
    assert_eq!(c.offset(), 11);
    let mut c = Cursor::at_end("hello world");
    assert_eq!(c.delete_word().as_deref(), Some("world"));
    assert_eq!((c.text(), c.offset()), ("hello ", 6));
    let mut c = Cursor::new("hello world", 5);
    assert_eq!(c.kill_to_home().as_deref(), Some("hello"));
    assert_eq!((c.text(), c.offset()), (" world", 0));
    let mut c = Cursor::new("hello world", 5);
    assert_eq!(c.kill_to_end().as_deref(), Some(" world"));
    assert_eq!(c.text(), "hello");
    c.yank(Some(" there"));
    assert_eq!(c.text(), "hello there");
    c.yank(None);
    assert_eq!(c.text(), "hello there");
    assert_eq!(Cursor::new("abc", 0).kill_to_home(), None);
}

#[test]
fn cursor_moves_between_logical_lines_snapping_the_column() {
    let c = Cursor::new("abc\ndef\nghi", 5);
    assert_eq!((c.row(), c.col()), (1, 1));
    let mut c = Cursor::new("abc\ndef", 5);
    c.up_line();
    assert_eq!(c.offset(), 1);
    c.down_line();
    assert_eq!(c.offset(), 5);
    let mut edge = Cursor::new("abc", 1);
    edge.up_line();
    edge.down_line();
    assert_eq!(edge.offset(), 1, "no-ops on a single line");
    let mut snap = Cursor::at_end("longer line\nab");
    snap.up_line();
    assert_eq!(snap.offset(), 2, "column clamps to the shorter line");
    let mut wide = Cursor::new("日本語\nab", 6);
    wide.down_line();
    assert_eq!(
        &wide.text()[wide.offset()..],
        "",
        "columns count chars, not bytes"
    );
}

// ── single line ──────────────────────────────────────────────────

#[test]
fn single_line_renders_text_with_an_inverse_cursor_on_the_surface() {
    let input = TextInput::single_line("hello");
    let buf = render(&input, 12, None);
    assert_eq!(buf.area.height, 1);
    assert_eq!(row(&buf, 0), " hello");
    assert_eq!(
        bg(&buf, 0, 0),
        rgb(DARK.input.surface.base),
        "surface spans the full width"
    );
    assert_eq!(bg(&buf, 11, 0), rgb(DARK.input.surface.base));
    assert_eq!(fg(&buf, 1, 0), rgb(DARK.input.text.base));
    assert_eq!(
        cursor_cells(&buf),
        vec![(6, 0, " ".to_string())],
        "cursor at end is an inverse space"
    );
    let mut moved = input.clone();
    moved.key(key(KeyCode::Left));
    moved.key(key(KeyCode::Left));
    assert_eq!(
        cursor_cells(&render(&moved, 12, None)),
        vec![(4, 0, "l".to_string())]
    );
}

#[test]
fn single_line_shows_the_placeholder_only_while_empty() {
    let input = TextInput::single_line("").with_placeholder("actually...");
    let buf = render(&input, 20, None);
    assert_eq!(row(&buf, 0), "  actually...");
    assert_eq!(fg(&buf, 2, 0), rgb(DARK.input.placeholder.base));
    let mut typed = input.clone();
    typed.key(ch('h'));
    assert!(!row(&render(&typed, 20, None), 0).contains("actually"));
}

#[test]
fn single_line_keys_submit_edit_and_report_changes() {
    let mut input = TextInput::single_line("ab");
    assert_eq!(input.key(ch('c')), InputEvent::Changed { truncated: false });
    assert_eq!(input.text(), "abc");
    assert_eq!(
        input.key(key(KeyCode::Enter)),
        InputEvent::Submit("abc".into())
    );
    assert_eq!(
        input.key(key(KeyCode::Esc)),
        InputEvent::Idle,
        "Esc belongs to the owner"
    );
    assert_eq!(
        input.key(key(KeyCode::Left)),
        InputEvent::Idle,
        "movement is not a change"
    );
    assert_eq!(
        input.key(key(KeyCode::Backspace)),
        InputEvent::Changed { truncated: false }
    );
    assert_eq!(input.text(), "ac");
    assert_eq!(
        input.key(key(KeyCode::Backspace)),
        InputEvent::Changed { truncated: false }
    );
    assert_eq!(
        input.key(key(KeyCode::Backspace)),
        InputEvent::Idle,
        "nothing left to delete"
    );
    assert_eq!(
        input.key(shift(KeyCode::Enter)),
        InputEvent::Submit("c".into()),
        "single-line: shift+enter still submits"
    );
    assert_eq!(
        input.key(ctrl('j')),
        InputEvent::Idle,
        "no newlines in single-line"
    );
    assert_eq!(input.text(), "c");
}

#[test]
fn readline_keys_kill_yank_and_jump_words() {
    let mut input = TextInput::single_line("hello brave world");
    input.key(alt(KeyCode::Char('b')));
    assert_eq!(input.cursor().offset(), 12);
    input.key(alt(KeyCode::Backspace));
    assert_eq!(input.text(), "hello world");
    input.key(ctrl('y'));
    assert_eq!(
        input.text(),
        "hello brave world",
        "alt+backspace kill is yankable"
    );
    input.key(ctrl('a'));
    assert_eq!(input.cursor().offset(), 0);
    input.key(alt(KeyCode::Char('f')));
    assert_eq!(input.cursor().offset(), 5);
    input.key(ctrl('k'));
    assert_eq!(input.text(), "hello");
    input.key(ctrl('e'));
    input.key(ctrl('u'));
    assert_eq!(input.text(), "");
    input.key(ctrl('y'));
    assert_eq!(input.text(), "hello");
    input.key(key(KeyCode::Home));
    input.key(alt(KeyCode::Right));
    assert_eq!(input.cursor().offset(), 5);
    input.key(alt(KeyCode::Left));
    assert_eq!(input.cursor().offset(), 0);
    input.key(key(KeyCode::End));
    assert_eq!(input.cursor().offset(), 5);
    assert_eq!(
        input.key(ctrl('x')),
        InputEvent::Idle,
        "unbound ctrl keys are ignored"
    );
}

#[test]
fn masked_input_renders_bullets_but_submits_the_real_value() {
    let mut input = TextInput::masked("secret");
    let buf = render(&input, 12, None);
    assert_eq!(row(&buf, 0), " ••••••");
    assert!(!screen(&buf).contains("secret"));
    input.key(key(KeyCode::Left));
    let buf = render(&input, 12, None);
    assert_eq!(cursor_cells(&buf), vec![(6, 0, "•".to_string())]);
    assert_eq!(
        input.key(key(KeyCode::Enter)),
        InputEvent::Submit("secret".into())
    );
}

#[test]
fn single_line_strips_newlines_from_pastes_and_wraps_long_text() {
    let mut input = TextInput::single_line("");
    assert_eq!(
        input.paste("hi\r\nthere\n"),
        InputEvent::Changed { truncated: false }
    );
    assert_eq!(input.text(), "hithere");
    let long = TextInput::single_line("word ".repeat(10));
    let buf = render(&long, 22, None);
    assert!(
        buf.area.height >= 3,
        "wraps within the strip: {}",
        buf.area.height
    );
    assert!(rows(&buf).iter().all(|r| r.len() <= 22));
}

// ── read-only / external ─────────────────────────────────────────

#[test]
fn read_only_frame_keeps_a_row_for_empty_text_and_wraps_lines() {
    let empty = InputFrame::read_only("", paint());
    assert_eq!(empty.height(20), 1);
    let two = InputFrame::read_only("line1\nline2", paint());
    assert_eq!(two.height(20), 2);
    let mut buf = buffer(20, 2);
    let buf_area = buf.area;
    two.render(&mut buf, buf_area, paint());
    assert_eq!(rows(&buf), [" line1", " line2"]);
    assert_eq!(bg(&buf, 19, 1), rgb(DARK.input.surface.base));
    let input = TextInput::single_line("abc");
    let mut frozen = buffer(10, 1);
    let frozen_area = frozen.area;
    InputFrame::read_only("abc", paint()).render(&mut frozen, frozen_area, paint());
    assert!(cursor_cells(&frozen).is_empty(), "read-only has no cursor");
    drop(input);
}

#[test]
fn external_editing_shows_the_notice_centered_and_swallows_input() {
    let mut input = TextInput::multiline("buffer text");
    input.set_editing_external(true);
    let buf = render(&input, 60, None);
    let line = row(&buf, 0);
    assert!(
        line.contains("... Save and close editor to continue ..."),
        "{line}"
    );
    assert!(!line.contains("buffer text"));
    let lead = line.len() - line.trim_start().len();
    assert!(lead > 5, "centered, not flush left: {lead}");
    assert_eq!(input.key(ch('x')), InputEvent::Idle);
    assert_eq!(input.paste("y"), InputEvent::Idle);
    assert_eq!(input.text(), "buffer text");
    input.set_editing_external(false);
    assert_eq!(input.key(ch('x')), InputEvent::Changed { truncated: false });
}

// ── multiline ────────────────────────────────────────────────────

#[test]
fn multiline_newlines_come_from_shift_enter_ctrl_j_or_a_trailing_backslash() {
    let mut input = TextInput::multiline("abc");
    assert_eq!(
        input.key(key(KeyCode::Enter)),
        InputEvent::Submit("abc".into()),
        "plain Enter submits"
    );
    assert_eq!(
        input.key(shift(KeyCode::Enter)),
        InputEvent::Changed { truncated: false }
    );
    assert_eq!(input.text(), "abc\n");
    assert_eq!(
        input.key(ctrl('j')),
        InputEvent::Changed { truncated: false }
    );
    assert_eq!(input.text(), "abc\n\n");
    let mut slash = TextInput::multiline("foo\\");
    assert_eq!(
        slash.key(key(KeyCode::Enter)),
        InputEvent::Changed { truncated: false }
    );
    assert_eq!(slash.text(), "foo\n");
    let mut mid = TextInput::multiline("foo\\");
    mid.key(key(KeyCode::Left));
    assert_eq!(
        mid.key(key(KeyCode::Enter)),
        InputEvent::Submit("foo\\".into()),
        "backslash rule needs the cursor at the end"
    );
    let mut empty = TextInput::multiline("");
    assert_eq!(
        empty.key(key(KeyCode::Enter)),
        InputEvent::Idle,
        "empty buffer Enter is a no-op"
    );
}

#[test]
fn multiline_up_and_down_move_between_lines() {
    let mut input = TextInput::multiline("abc\ndef");
    input.key(key(KeyCode::Up));
    assert_eq!(input.cursor().offset(), 3);
    input.key(key(KeyCode::Down));
    assert_eq!(input.cursor().offset(), 7);
    let mut single = TextInput::single_line("abc\ndef");
    single.key(key(KeyCode::Up));
    assert_eq!(single.cursor().offset(), 7, "single-line ignores Up");
}

#[test]
fn multiline_hard_wraps_at_the_wrap_width_and_windows_rows_around_the_cursor() {
    let text = "a".repeat(2000);
    let input = TextInput::multiline(text);
    let layout = Some(InputLayout {
        wrap_width: 20,
        max_rows: Some(3),
    });
    let buf = render(&input, 24, layout);
    assert_eq!(buf.area.height, 3);
    for r in rows(&buf) {
        assert!(r.len() <= 22, "{r:?}");
    }
    assert_eq!(cursor_cells(&buf).len(), 1);
    let (x, y, _) = cursor_cells(&buf)[0];
    assert_eq!(y, 2, "cursor row is the last visible row");
    assert_eq!(
        x, 1,
        "2000 = 100 × 20, so the cursor sits on an empty 101st row"
    );

    let lines = TextInput::multiline("l1\nl2\nl3\nl4\nl5\nl6");
    let buf = render(
        &lines,
        20,
        Some(InputLayout {
            wrap_width: 18,
            max_rows: Some(3),
        }),
    );
    assert_eq!(
        rows(&buf),
        [" l4", " l5", " l6"],
        "cursor at the end: last three rows"
    );
    let mut top = lines.clone();
    for _ in 0..5 {
        top.key(key(KeyCode::Up));
    }
    let buf = render(
        &top,
        20,
        Some(InputLayout {
            wrap_width: 18,
            max_rows: Some(3),
        }),
    );
    assert_eq!(
        rows(&buf),
        [" l1", " l2", " l3"],
        "window follows the cursor up"
    );
    assert_eq!(cursor_cells(&buf), vec![(3, 0, " ".to_string())]);
}

#[test]
fn multiline_without_a_row_cap_shows_every_line_and_the_placeholder_when_empty() {
    let input = TextInput::multiline("line1\nline2");
    let buf = render(&input, 20, None);
    assert_eq!(rows(&buf), [" line1", " line2"]);
    let empty = TextInput::multiline("").with_placeholder("list all markdown files here");
    let buf = render(
        &empty,
        40,
        Some(InputLayout {
            wrap_width: 38,
            max_rows: Some(3),
        }),
    );
    assert_eq!(buf.area.height, 1);
    assert_eq!(row(&buf, 0), "  list all markdown files here");
    assert_eq!(cursor_cells(&buf), vec![(1, 0, " ".to_string())]);
    let wide = TextInput::multiline("日本語テキスト");
    let buf = render(
        &wide,
        10,
        Some(InputLayout {
            wrap_width: 8,
            max_rows: None,
        }),
    );
    assert_eq!(buf.area.height, 2, "wide chars wrap by display width");
}

#[test]
fn multiline_paste_sanitizes_control_bytes_and_clamps_at_the_cap() {
    let mut input = TextInput::multiline("");
    assert_eq!(
        input.paste("a\r\nb\x07c\td\x1b[31m"),
        InputEvent::Changed { truncated: false }
    );
    assert_eq!(input.text(), "a\nbc\td[31m");
    let mut big = TextInput::multiline("");
    let bomb = "é".repeat(MAX_BUFFER_BYTES);
    assert_eq!(big.paste(&bomb), InputEvent::Changed { truncated: true });
    assert!(big.text().len() <= MAX_BUFFER_BYTES);
    assert!(big.text().len() > MAX_BUFFER_BYTES - 2);
    assert_eq!(
        big.key(ch('x')),
        InputEvent::Changed { truncated: true },
        "typing at the cap stays truncated"
    );
    let (exact, cut) = clamp_buffer_size(&"a".repeat(MAX_BUFFER_BYTES));
    assert!(!cut && exact.len() == MAX_BUFFER_BYTES);
    let (short, cut) = clamp_buffer_size("hello");
    assert!(!cut && short == "hello");
    let (over, cut) = clamp_buffer_size(&"a".repeat(MAX_BUFFER_BYTES + 100));
    assert!(cut && over.len() == MAX_BUFFER_BYTES);
}
