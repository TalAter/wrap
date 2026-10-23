//! Action bar, checklist, select, continuation badge, spinner status and
//! the color-level pass.

mod common;

use common::*;
use crossterm::event::KeyCode;
use ratatui::style::{Color, Modifier};
use ratatui::text::Line;
use wrap::theme::{DARK, LIGHT};
use wrap::tui::{
    ActionItem, Checklist, ChecklistEvent, ChecklistItem, Select, SelectEvent, SelectOption,
    action_bar_line, action_bar_width, apply_color_level, format_continuation_badge,
    spinner_status,
};

fn text(line: &Line<'_>) -> String {
    line.spans.iter().map(|s| s.content.as_ref()).collect()
}

fn span<'a>(line: &'a Line<'a>, content: &str) -> &'a ratatui::text::Span<'a> {
    line.spans
        .iter()
        .find(|s| s.content == content)
        .unwrap_or_else(|| panic!("no span {content:?} in {:?}", text(line)))
}

// ── action bar ───────────────────────────────────────────────────

#[test]
fn approve_items_underline_the_hotkey_and_combo_items_prefix_the_glyph() {
    let items = [
        ActionItem::new("Y", "Yes").primary(),
        ActionItem::new("Esc", "to cancel"),
    ];
    let line = action_bar_line(&items, None, None, paint());
    assert_eq!(text(&line), " Yes  │ Esc to cancel");
    let head = span(&line, "Y");
    assert!(
        head.style
            .add_modifier
            .contains(Modifier::BOLD | Modifier::UNDERLINED)
    );
    assert_eq!(
        head.style.fg,
        Some(rgb(DARK.action_bar.shortcut_primary.base))
    );
    assert_eq!(
        span(&line, "es").style.fg,
        Some(rgb(DARK.action_bar.label.base))
    );
    let glyph = span(&line, "Esc");
    assert!(glyph.style.add_modifier.contains(Modifier::BOLD));
    assert!(!glyph.style.add_modifier.contains(Modifier::UNDERLINED));
    assert_eq!(glyph.style.fg, Some(rgb(DARK.action_bar.shortcut.base)));
    assert_eq!(
        span(&line, " │ ").style.fg,
        Some(rgb(DARK.action_bar.separator.base))
    );
    assert!(
        text(&action_bar_line(
            &[ActionItem::new("⏎", "x")],
            None,
            None,
            paint()
        ))
        .starts_with('⏎')
    );
}

#[test]
fn glyph_must_be_one_ascii_letter_matching_the_label_to_be_approve_style() {
    let p = paint();
    assert_eq!(
        text(&action_bar_line(
            &[ActionItem::new("y", "Yes")],
            None,
            None,
            p
        )),
        " Yes "
    );
    assert_eq!(
        text(&action_bar_line(
            &[ActionItem::new("Y", "no")],
            None,
            None,
            p
        )),
        "Y no"
    );
    assert_eq!(
        text(&action_bar_line(
            &[ActionItem::new("Yo", "Yes")],
            None,
            None,
            p
        )),
        "Yo Yes"
    );
    assert_eq!(
        text(&action_bar_line(
            &[ActionItem::new("↑↓", "move")],
            None,
            None,
            p
        )),
        "↑↓ move"
    );
}

#[test]
fn focus_paints_the_item_on_the_selection_background_with_selected_tints() {
    let items = [
        ActionItem::new("N", "No").primary(),
        ActionItem::new("E", "Edit"),
    ];
    let line = action_bar_line(&items, Some(1), None, paint());
    assert_eq!(text(&line), " No  │  Edit ");
    let selected_bg = rgb(DARK.action_bar.selected_bg.base);
    assert_eq!(span(&line, "E").style.bg, Some(selected_bg));
    assert_eq!(
        span(&line, "E").style.fg,
        Some(rgb(DARK.action_bar.selected_shortcut.base))
    );
    let tail = span(&line, "dit");
    assert_eq!(tail.style.fg, Some(rgb(DARK.action_bar.selected.base)));
    assert!(
        tail.style.add_modifier.contains(Modifier::BOLD),
        "focused tail is bold"
    );
    assert_eq!(span(&line, "N").style.bg, None, "unfocused item has no bg");
    assert_eq!(
        span(&line, "N").style.fg,
        Some(rgb(DARK.action_bar.shortcut_primary.base))
    );
    let primary_focused = action_bar_line(&items, Some(0), None, paint());
    assert_eq!(
        span(&primary_focused, "N").style.fg,
        Some(rgb(DARK.action_bar.selected_shortcut_primary.base))
    );
    assert_eq!(
        text(&action_bar_line(&items, Some(7), None, paint())),
        " No  │  Edit ",
        "out of range is fine"
    );
}

#[test]
fn flash_color_tints_the_whole_label_and_drops_the_underline() {
    let mut copied = ActionItem::new("C", "Copied");
    copied.flash_color = Some(Color::Rgb(1, 2, 3));
    let line = action_bar_line(&[copied], None, None, paint());
    assert_eq!(text(&line), " Copied ");
    let head = span(&line, "C");
    assert_eq!(head.style.fg, Some(Color::Rgb(1, 2, 3)));
    assert!(!head.style.add_modifier.contains(Modifier::UNDERLINED));
    assert_eq!(span(&line, "opied").style.fg, Some(Color::Rgb(1, 2, 3)));
}

#[test]
fn dividers_fall_between_every_pair_unless_restricted() {
    let items = [
        ActionItem::new("A", "Alpha"),
        ActionItem::new("B", "Beta"),
        ActionItem::new("G", "Gamma"),
        ActionItem::new("D", "Delta"),
    ];
    assert_eq!(
        text(&action_bar_line(&items, None, None, paint()))
            .matches('│')
            .count(),
        3
    );
    assert_eq!(
        text(&action_bar_line(&items, None, Some(&[]), paint()))
            .matches('│')
            .count(),
        0
    );
    let one = text(&action_bar_line(&items, None, Some(&[1]), paint()));
    assert_eq!(one, " Alpha  Beta  │  Gamma  Delta ");
}

#[test]
fn action_bar_width_mirrors_the_render() {
    let esc = ActionItem::new("Esc", "Cancel");
    let enter = ActionItem::new("Enter", "Run");
    assert_eq!(action_bar_width(std::slice::from_ref(&esc), None), 10);
    assert_eq!(action_bar_width(&[ActionItem::new("Y", "Yes")], None), 5);
    assert_eq!(action_bar_width(&[esc.clone(), enter.clone()], None), 22);
    assert_eq!(
        action_bar_width(&[esc.clone(), enter.clone()], Some(&[])),
        19
    );
    assert_eq!(
        action_bar_width(&[esc.clone(), enter.clone()], Some(&[0])),
        22
    );
    assert_eq!(action_bar_width(&[], None), 0);
    let items = [
        ActionItem::new("N", "No"),
        ActionItem::new("⏎", "to run"),
        esc,
    ];
    let rendered = text(&action_bar_line(&items, Some(1), None, paint()));
    assert_eq!(
        unicode_width::UnicodeWidthStr::width(rendered.as_str()) as u16,
        action_bar_width(&items, None)
    );
}

// ── checklist ────────────────────────────────────────────────────

fn items() -> Vec<ChecklistItem> {
    vec![
        ChecklistItem::header("Select API Provider(s)"),
        ChecklistItem::option("Anthropic", "anthropic").with_icon("\u{F0100}"),
        ChecklistItem::option("OpenAI", "openai"),
        ChecklistItem::header("Use your coding agent's subscription"),
        ChecklistItem::option("Claude Code", "claude-code"),
    ]
}

#[test]
fn checklist_rows_show_pointer_tick_and_focus_fill() {
    let list = Checklist::new(items())
        .with_checked(["openai"])
        .with_width(50);
    let lines = list.lines(paint());
    let rows: Vec<String> = lines.iter().map(text).collect();
    assert_eq!(
        rows[0],
        format!("⠶⠶ SELECT API PROVIDER(S) {}", "⠶".repeat(50 - 24 - 2))
    );
    assert_eq!(
        rows[1],
        format!(" ❯ [ ] Anthropic{}", " ".repeat(50 - 16)),
        "focused row padded to width"
    );
    assert_eq!(rows[2], "   [✓] OpenAI");
    assert_eq!(rows[3], " ", "blank line above a non-first header");
    assert_eq!(
        rows[4],
        "⠶⠶ USE YOUR CODING AGENT'S SUBSCRIPTION ⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶"
    );
    assert_eq!(rows[5], "   [ ] Claude Code");
    let focused = &lines[1].spans[0];
    assert_eq!(focused.style.fg, Some(rgb(DARK.checklist.row_focused.base)));
    assert_eq!(
        focused.style.bg,
        Some(rgb(DARK.checklist.row_focused_bg.base))
    );
    assert_eq!(
        lines[1].spans[1].style.bg,
        Some(rgb(DARK.checklist.row_focused_bg.base)),
        "fill carries the bg"
    );
    assert_eq!(
        lines[2].spans[0].style.fg,
        Some(rgb(DARK.checklist.row_checked.base))
    );
    assert_eq!(
        lines[5].spans[0].style.fg,
        Some(rgb(DARK.checklist.row.base))
    );
    assert_eq!(
        lines[0].spans[0].style.fg,
        Some(rgb(DARK.checklist.section_rule.base))
    );
    assert!(
        lines[0].spans[1]
            .style
            .add_modifier
            .contains(Modifier::BOLD)
    );
    assert_eq!(list.height(), 6);
    let nerd = Checklist::new(items()).lines(paint_with(&DARK, 3, true));
    assert_eq!(
        text(&nerd[1]),
        " ❯ [ ] \u{F0100}  Anthropic",
        "nerd icon sits after the tick"
    );
}

#[test]
fn checklist_header_drops_leaders_when_too_narrow_and_fills_without_width() {
    let narrow = Checklist::new(vec![ChecklistItem::header("Providers")]).with_width(12);
    assert_eq!(text(&narrow.lines(paint())[0]), "PROVIDERS");
    let unbounded = Checklist::new(vec![ChecklistItem::header("Providers")]);
    assert_eq!(text(&unbounded.lines(paint())[0]), "⠶⠶ PROVIDERS ");
}

#[test]
fn checklist_keys_move_toggle_and_submit_only_with_a_selection() {
    let mut list = Checklist::new(items());
    assert_eq!(
        list.key(key(KeyCode::Enter)),
        ChecklistEvent::Idle,
        "nothing checked"
    );
    assert_eq!(list.key(key(KeyCode::Up)), ChecklistEvent::Idle);
    assert_eq!(list.focused(), Some("anthropic"), "up at the top stays");
    assert_eq!(list.key(key(KeyCode::Down)), ChecklistEvent::Idle);
    assert_eq!(list.key(ch(' ')), ChecklistEvent::Toggled("openai".into()));
    assert_eq!(list.key(key(KeyCode::Down)), ChecklistEvent::Idle);
    assert_eq!(list.key(key(KeyCode::Down)), ChecklistEvent::Idle);
    assert_eq!(
        list.focused(),
        Some("claude-code"),
        "headers are skipped and the end clamps"
    );
    assert_eq!(
        list.key(ch(' ')),
        ChecklistEvent::Toggled("claude-code".into())
    );
    assert_eq!(
        list.key(ch(' ')),
        ChecklistEvent::Toggled("claude-code".into())
    );
    assert_eq!(list.checked(), ["openai"]);
    assert_eq!(
        list.key(key(KeyCode::Enter)),
        ChecklistEvent::Submit(vec!["openai".into()])
    );
    let mut empty_ok = Checklist::new(items()).allow_empty_submit();
    assert_eq!(
        empty_ok.key(key(KeyCode::Enter)),
        ChecklistEvent::Submit(vec![])
    );
}

// ── select ───────────────────────────────────────────────────────

fn options(n: usize) -> Vec<SelectOption> {
    (1..=n)
        .map(|i| SelectOption::new(format!("model-{i}"), format!("m{i}")))
        .collect()
}

#[test]
fn select_marks_focus_with_a_pointer_and_windows_the_options() {
    let mut select = Select::new(options(7)).with_visible_option_count(3);
    let rows: Vec<String> = select.lines(paint()).iter().map(text).collect();
    assert_eq!(rows, ["❯ model-1", "  model-2", "  model-3"]);
    let lines = select.lines(paint());
    assert_eq!(
        lines[0].spans[0].style.fg,
        Some(rgb(DARK.picker.focus_indicator.base))
    );
    assert_eq!(
        lines[0].spans[1].style.fg,
        Some(rgb(DARK.picker.option_focused.base))
    );
    assert_eq!(
        lines[1].spans[1].style.fg,
        Some(rgb(DARK.picker.option.base))
    );
    for _ in 0..3 {
        assert_eq!(select.key(key(KeyCode::Down)), SelectEvent::Moved);
    }
    let rows: Vec<String> = select.lines(paint()).iter().map(text).collect();
    assert_eq!(
        rows,
        ["  model-2", "  model-3", "❯ model-4"],
        "window scrolls with focus"
    );
    for _ in 0..10 {
        select.key(key(KeyCode::Down));
    }
    assert_eq!(select.focused_value(), Some("m7"), "clamps at the end");
    assert_eq!(select.key(key(KeyCode::Down)), SelectEvent::Idle);
    assert_eq!(
        select.key(key(KeyCode::Enter)),
        SelectEvent::Submit("m7".into())
    );
    let rows: Vec<String> = select.lines(paint()).iter().map(text).collect();
    assert_eq!(rows[2], "❯ model-7 ✔", "selected value shows the tick");
    for _ in 0..6 {
        select.key(key(KeyCode::Up));
    }
    let lines = select.lines(paint());
    assert_eq!(text(&lines[0]), "❯ model-1");
    assert_eq!(select.height(), 3);
    assert_eq!(Select::new(options(2)).height(), 2);
}

// ── badge, spinner, color level ──────────────────────────────────

#[test]
fn continuation_badge_collapses_whitespace_truncates_and_hides_when_narrow() {
    assert_eq!(
        format_continuation_badge("how do I deploy", 80),
        "↳ Continuing: how do I deploy"
    );
    assert_eq!(
        format_continuation_badge("a\n\n\n   b", 80),
        "↳ Continuing: a b"
    );
    let long = format_continuation_badge(&"a".repeat(100), 40);
    assert!(long.starts_with("↳ Continuing: ") && long.ends_with('…'));
    assert_eq!(long.chars().count(), 39, "columns minus the gutter");
    assert_eq!(
        format_continuation_badge(&"a".repeat(50), 20)
            .chars()
            .count(),
        34,
        "20-char body floor"
    );
    assert_eq!(format_continuation_badge("anything", 19), "");
    assert_eq!(format_continuation_badge("   \n ", 80), "");
    let exact = "x".repeat(25);
    assert_eq!(
        format_continuation_badge(&exact, 40),
        format!("↳ Continuing: {exact}")
    );
}

#[test]
fn spinner_status_prefixes_a_frame_unless_animation_is_off() {
    assert_eq!(
        spinner_status(Some("Loading"), 0, false).as_deref(),
        Some("⢎  Loading")
    );
    assert_eq!(
        spinner_status(Some("Loading"), 9, false).as_deref(),
        Some("⠎⠁ Loading"),
        "wraps around"
    );
    assert_eq!(
        spinner_status(Some("Loading"), 5, true).as_deref(),
        Some("Loading")
    );
    assert_eq!(spinner_status(None, 0, false), None);
    assert_eq!(spinner_status(Some(""), 0, false), None);
}

#[test]
fn color_level_pass_quantizes_or_strips_and_keeps_focus_visible_in_mono() {
    let selected_bg = rgb(DARK.action_bar.selected_bg.base);
    let mut buf = buffer(2, 1);
    buf[(0, 0)]
        .set_fg(Color::Rgb(245, 186, 74))
        .set_bg(selected_bg);
    buf[(1, 0)]
        .set_fg(Color::Rgb(245, 186, 74))
        .set_bg(Color::Rgb(35, 35, 50));
    let mut l2 = buf.clone();
    apply_color_level(&mut l2, 2, &[selected_bg]);
    assert!(matches!(l2[(0, 0)].fg, Color::Indexed(_)));
    assert!(matches!(l2[(0, 0)].bg, Color::Indexed(_)));
    let mut l1 = buf.clone();
    apply_color_level(&mut l1, 1, &[selected_bg]);
    assert!(
        matches!(l1[(0, 0)].fg, Color::Yellow | Color::LightYellow),
        "{:?}",
        l1[(0, 0)].fg
    );
    let mut l0 = buf.clone();
    apply_color_level(&mut l0, 0, &[selected_bg]);
    assert_eq!((l0[(0, 0)].fg, l0[(0, 0)].bg), (Color::Reset, Color::Reset));
    assert!(
        l0[(0, 0)].modifier.contains(Modifier::REVERSED),
        "focused cell reversed"
    );
    assert!(!l0[(1, 0)].modifier.contains(Modifier::REVERSED));
    let mut l3 = buf.clone();
    apply_color_level(&mut l3, 3, &[selected_bg]);
    assert_eq!(l3[(0, 0)].bg, selected_bg, "truecolor untouched");
    let light = paint_with(&LIGHT, 3, false);
    assert_eq!(light.color(&LIGHT.copy.body), Color::Rgb(0, 0, 0));
}
