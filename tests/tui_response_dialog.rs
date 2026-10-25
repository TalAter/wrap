//! The response dialog in every state: layout at several terminal sizes,
//! key routing to reducer events, copy flash, folding, and degradation.

mod common;

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use common::*;
use crossterm::event::KeyCode;
use ratatui::style::{Color, Modifier};
use wrap::response::{CommandResponse, ResponseType, RiskLevel};
use wrap::session::reducer::reduce;
use wrap::session::state::{ActionId, AppEvent, AppState, LoopReturn, StepSource};
use wrap::theme::{DARK, LIGHT, Theme};
use wrap::tui::{
    COPY_FLASH, CommandDisplay, DialogSignal, EditorInfo, INTERACTIVE_PLACEHOLDERS,
    OUTPUT_SLOT_EMPTY, ResponseDialog, ResponseDialogOptions, fold_command, format_output_slot,
    truncate_command,
};

fn response(content: &str, risk: RiskLevel) -> CommandResponse {
    CommandResponse {
        scratchpad: None,
        kind: ResponseType::Command,
        is_final: true,
        discard_command: None,
        plan: None,
        content: content.into(),
        risk_level: risk,
        explanation: None,
        memory_updates: None,
        memory_updates_message: None,
        watchlist_additions: None,
    }
}

fn confirming(content: &str, risk: RiskLevel) -> AppState {
    AppState::Confirming {
        response: response(content, risk),
        output_slot: None,
        answer: None,
    }
}

fn opts(theme: &'static Theme) -> ResponseDialogOptions {
    ResponseDialogOptions {
        theme,
        nerd_fonts: false,
        no_animation: false,
        color_level: 3,
        editor: None,
        clipboard: None,
        continuation_prompt: None,
    }
}

fn dialog(state: &AppState) -> ResponseDialog {
    ResponseDialog::new(state, opts(&DARK))
}

fn with_clipboard(state: &AppState) -> (ResponseDialog, Rc<RefCell<Vec<String>>>) {
    let copies = Rc::new(RefCell::new(Vec::new()));
    let sink = copies.clone();
    let mut o = opts(&DARK);
    o.clipboard = Some(Box::new(move |text: &str| {
        sink.borrow_mut().push(text.to_string())
    }));
    (ResponseDialog::new(state, o), copies)
}

fn draw(dialog: &ResponseDialog, width: u16, height: u16) -> ratatui::buffer::Buffer {
    let mut buf = buffer(width, height);
    let buf_area = buf.area;
    dialog.render_to(&mut buf, buf_area);
    buf
}

fn screen_of(dialog: &ResponseDialog, width: u16, height: u16) -> String {
    screen(&draw(dialog, width, height))
}

fn dialog_rows(buf: &ratatui::buffer::Buffer) -> Vec<String> {
    rows(buf).into_iter().filter(|r| !r.is_empty()).collect()
}

// ── confirming ───────────────────────────────────────────────────

fn answered_proposal(answer: &str) -> AppState {
    let mut state = confirming("echo ORIGINAL", RiskLevel::Medium);
    for event in [
        AppEvent::KeyAction(ActionId::Followup),
        AppEvent::SubmitFollowup {
            text: "explain it".into(),
        },
        AppEvent::LoopFinal {
            result: LoopReturn::Answer(answer.into()),
        },
    ] {
        state = reduce(&state, &event, false).unwrap();
    }
    state
}

#[test]
fn followup_answer_renders_below_the_pending_proposal_and_survives_edit_and_compose() {
    let state = answered_proposal("Prints ORIGINAL without changing files.");
    let mut d = dialog(&state);
    let s = screen_of(&d, 100, 24);
    assert!(s.contains("Answer:"), "{s}");
    assert!(s.contains("Prints ORIGINAL without changing files."), "{s}");
    assert!(s.find("echo ORIGINAL").unwrap() < s.find("Answer:").unwrap());
    assert!(s.contains("Run command?"), "{s}");
    for (action, bar) in [
        (ActionId::Edit, "to discard changes"),
        (ActionId::Followup, "to send"),
    ] {
        let next = reduce(&state, &AppEvent::KeyAction(action), false).unwrap();
        d.sync(&next);
        let s = screen_of(&d, 100, 24);
        assert!(s.contains("Prints ORIGINAL without changing files."), "{s}");
        assert!(s.contains(bar), "{s}");
    }
}

#[test]
fn long_followup_answer_scrolls_without_hiding_actions_or_changing_the_draft() {
    let answer = (0..40)
        .map(|i| format!("Explanation row {i:02}"))
        .collect::<Vec<_>>()
        .join("\n");
    let state = answered_proposal(&answer);
    let mut d = dialog(&state);
    let s = screen_of(&d, 80, 18);
    assert!(s.contains("Explanation row 00"), "{s}");
    assert!(!s.contains("Explanation row 39"), "{s}");
    assert!(s.contains("PgUp/PgDn"), "{s}");
    for _ in 0..40 {
        d.key(key(KeyCode::PageDown));
        let s = screen_of(&d, 80, 18);
        assert!(s.contains("Run command?"), "{s}");
        assert!(s.contains("echo ORIGINAL"), "{s}");
    }
    assert!(screen_of(&d, 80, 18).contains("Explanation row 39"));
    assert!(d.take_events().is_empty());
    for _ in 0..40 {
        d.key(key(KeyCode::PageUp));
        draw(&d, 80, 18);
    }
    assert!(screen_of(&d, 80, 18).contains("Explanation row 00"));
    for (action, bar) in [
        (ActionId::Edit, "to discard changes"),
        (ActionId::Followup, "to send"),
    ] {
        let next = reduce(&state, &AppEvent::KeyAction(action), false).unwrap();
        d.sync(&next);
        for _ in 0..40 {
            d.key(key(KeyCode::PageDown));
            let s = screen_of(&d, 80, 18);
            assert!(s.contains(bar), "{s}");
        }
        assert!(screen_of(&d, 80, 18).contains("Explanation row 39"));
        assert!(
            d.take_events().is_empty(),
            "scrolling must not edit the draft"
        );
    }
    let replacement = reduce(&state, &AppEvent::KeyAction(ActionId::Followup), false).unwrap();
    let processing = reduce(
        &replacement,
        &AppEvent::SubmitFollowup {
            text: "again".into(),
        },
        false,
    )
    .unwrap();
    let latest = reduce(
        &processing,
        &AppEvent::LoopFinal {
            result: LoopReturn::Answer("Latest answer".into()),
        },
        false,
    )
    .unwrap();
    d.sync(&latest);
    let s = screen_of(&d, 80, 18);
    assert!(
        s.contains("Latest answer") && !s.contains("Explanation row"),
        "{s}"
    );
    let next = reduce(
        &processing,
        &AppEvent::LoopFinal {
            result: LoopReturn::Command(response("echo REPLACEMENT", RiskLevel::Low)),
        },
        false,
    )
    .unwrap();
    d.sync(&next);
    let s = screen_of(&d, 80, 18);
    assert!(
        s.contains("echo REPLACEMENT") && !s.contains("Answer:"),
        "{s}"
    );
}

#[test]
fn wrapped_answer_remains_readable_after_resize_with_proposal_details() {
    let answer = format!("FIRST {} LAST", "wide 界 explanation ".repeat(40));
    let mut state = answered_proposal(&answer);
    if let AppState::Confirming {
        response,
        output_slot,
        ..
    } = &mut state
    {
        response.explanation = Some("A harmless proposal.".into());
        response.plan = Some("Print the text.".into());
        *output_slot = Some("Previous output".into());
    }
    let mut d = dialog(&state);
    for (w, h) in [(100, 28), (70, 22), (90, 24)] {
        for _ in 0..100 {
            d.key(key(KeyCode::PageUp));
            draw(&d, w, h);
        }
        let s = screen_of(&d, w, h);
        assert!(s.contains("FIRST"), "{s}");
        for _ in 0..100 {
            d.key(key(KeyCode::PageDown));
            let s = screen_of(&d, w, h);
            assert!(s.contains("Run command?"), "{s}");
            assert!(
                s.contains("A harmless proposal.") && s.contains("Previous output"),
                "{s}"
            );
        }
        assert!(screen_of(&d, w, h).contains("LAST"));
    }
}

#[test]
fn crowded_answer_keeps_followup_input_and_actions_visible() {
    check_crowded_answer(true, 18);
}

#[test]
fn crowded_answer_keeps_confirmation_actions_visible_on_short_terminal() {
    check_crowded_answer(false, 12);
}

fn check_crowded_answer(compose: bool, height: u16) {
    let answer = (0..20)
        .map(|i| format!("Answer line {i:02}"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut state = answered_proposal(&answer);
    if let AppState::Confirming {
        response,
        output_slot,
        ..
    } = &mut state
    {
        response.content = "echo FIRST\necho SECOND".into();
        response.explanation = Some("A harmless proposal.".into());
        response.plan = Some("Print the text.".into());
        *output_slot = Some("Output one\nOutput two\nOutput three".into());
    }
    if compose {
        state = reduce(&state, &AppEvent::KeyAction(ActionId::Followup), false).unwrap();
        state = reduce(
            &state,
            &AppEvent::DraftChange {
                text: "explain again".into(),
            },
            false,
        )
        .unwrap();
    }
    let mut d = dialog(&state);
    let mut seen = String::new();
    for _ in 0..40 {
        let s = screen_of(&d, 80, height);
        assert!(
            s.contains(if compose { "to send" } else { "Run command?" }),
            "{s}"
        );
        assert!(s.contains("echo FIRST") && s.contains("echo SECOND"), "{s}");
        if compose {
            assert!(s.contains("explain again"), "{s}");
        }
        seen.push_str(&s);
        d.key(key(KeyCode::PageDown));
    }
    for text in [
        "Output one",
        "Output two",
        "Output three",
        "A harmless proposal.",
        "Print the text.",
        "Answer:",
    ] {
        assert!(seen.contains(text), "missing {text}");
    }
    for i in 0..20 {
        assert!(
            seen.contains(&format!("Answer line {i:02}")),
            "missing answer line {i}"
        );
    }
    for _ in 0..40 {
        d.key(key(KeyCode::PageUp));
        draw(&d, 80, height);
    }
    assert!(screen_of(&d, 80, height).contains("Output one"));
    assert!(d.take_events().is_empty());
}

#[test]
fn confirming_lays_out_pill_command_explanation_and_action_bar() {
    let mut resp = response("ls -la", RiskLevel::Medium);
    resp.explanation = Some("lists everything".into());
    let d = dialog(&AppState::Confirming {
        response: resp,
        output_slot: None,
        answer: None,
    });
    let buf = draw(&d, 100, 20);
    let lines = dialog_rows(&buf);
    // 65 inner + 4 = 69 wide; centred on 100 with the odd slack rounded up → x = 16.
    assert!(
        lines[0].starts_with(&format!("{}╭", " ".repeat(16))),
        "{}",
        lines[0]
    );
    assert!(lines[0].ends_with(" ⚠ medium risk ─╮"), "{}", lines[0]);
    assert_eq!(
        lines[1].trim(),
        "│                                                                   │"
    );
    assert_eq!(
        lines[2].trim(),
        "│  ls -la                                                           │".trim()
    );
    assert!(
        lines[2].contains("│  ls -la"),
        "command in the strip after one cell of padding"
    );
    assert!(lines[4].contains("│  lists everything"), "{}", lines[4]);
    let bar = &lines[7];
    assert!(
        bar.contains("│    Run command?  No  Yes  │  Edit  Follow-up "),
        "{bar}"
    );
    assert!(!bar.contains("Copy"), "no clipboard tool: no Copy item");
    assert!(lines[9].contains("╰") && lines[9].ends_with('╯'));
    assert_eq!(
        lines.len(),
        10,
        "top, pad, command, blank, explanation, blank, blank, bar, pad, bottom"
    );
    // Colors: pill, surface strip, prompt, focused "No".
    let y_top = 5;
    let x_pill = find(&buf, y_top, "⚠").unwrap();
    assert_eq!(bg(&buf, x_pill, y_top), rgb(DARK.risk.medium.pill.bg.base));
    assert!(buf[(x_pill, y_top)].modifier.contains(Modifier::BOLD));
    let y_cmd = 7;
    let x_cmd = find(&buf, y_cmd, "ls").unwrap();
    assert_eq!(bg(&buf, x_cmd, y_cmd), rgb(DARK.input.surface.base));
    assert_eq!(
        bg(&buf, x_cmd + 60, y_cmd),
        rgb(DARK.input.surface.base),
        "strip spans the inner width"
    );
    assert_eq!(fg(&buf, x_cmd, y_cmd), rgb(DARK.input.text.base));
    let y_bar = 12;
    let x_prompt = find(&buf, y_bar, "Run").unwrap();
    assert_eq!(fg(&buf, x_prompt, y_bar), rgb(DARK.dialog.prompt.base));
    let x_no = find(&buf, y_bar, "No").unwrap();
    assert_eq!(
        bg(&buf, x_no, y_bar),
        rgb(DARK.action_bar.selected_bg.base),
        "first item focused"
    );
    assert!(buf[(x_no, y_bar)].modifier.contains(Modifier::UNDERLINED));
    let x_yes = find(&buf, y_bar, "Yes").unwrap();
    assert_eq!(bg(&buf, x_yes, y_bar), Color::Reset);
}

#[test]
fn confirming_renders_each_risk_pill_with_its_gradient_and_label() {
    for (risk, label, tokens) in [
        (RiskLevel::Low, "✔ low risk", &DARK.risk.low),
        (RiskLevel::Medium, "⚠ medium risk", &DARK.risk.medium),
        (RiskLevel::High, "⚠ high risk", &DARK.risk.high),
    ] {
        let buf = draw(&dialog(&confirming("true", risk)), 90, 14);
        let top = rows(&buf)
            .into_iter()
            .position(|r| r.contains('╭'))
            .unwrap() as u16;
        assert!(row(&buf, top).contains(label), "{}", row(&buf, top));
        let x = find(&buf, top, "╭").unwrap();
        assert_eq!(fg(&buf, x, top), rgb(tokens.frame[0]));
        assert_eq!(
            fg(&buf, find(&buf, top, label).unwrap(), top),
            rgb(tokens.pill.fg.base)
        );
    }
    let light = ResponseDialog::new(&confirming("true", RiskLevel::High), opts(&LIGHT));
    let buf = draw(&light, 90, 14);
    let top = rows(&buf)
        .into_iter()
        .position(|r| r.contains('╭'))
        .unwrap() as u16;
    assert_eq!(
        fg(&buf, find(&buf, top, "╭").unwrap(), top),
        rgb(LIGHT.risk.high.frame[0])
    );
}

#[test]
fn confirming_hotkeys_arrows_and_enter_dispatch_actions() {
    let mut d = dialog(&confirming("true", RiskLevel::Medium));
    d.key(key(KeyCode::Enter));
    assert_eq!(
        d.take_events(),
        [AppEvent::KeyAction(ActionId::Cancel)],
        "default focus is No"
    );
    for (c, id) in [
        ('y', ActionId::Run),
        ('N', ActionId::Cancel),
        ('e', ActionId::Edit),
        ('f', ActionId::Followup),
        ('q', ActionId::Cancel),
    ] {
        d.key(ch(c));
        assert_eq!(d.take_events(), [AppEvent::KeyAction(id)], "{c}");
    }
    d.key(ctrl('c'));
    assert_eq!(
        d.take_events(),
        [AppEvent::KeyAction(ActionId::Cancel)],
        "ctrl+c cancels"
    );
    d.key(key(KeyCode::Esc));
    assert_eq!(d.take_events(), [AppEvent::KeyEsc]);
    d.key(ch('c'));
    assert!(
        d.take_events().is_empty(),
        "bare c without a clipboard tool does nothing"
    );
    d.key(alt(KeyCode::Char('y')));
    assert!(d.take_events().is_empty(), "alt blocks bare hotkeys");
    d.key(key(KeyCode::Right));
    d.key(key(KeyCode::Right));
    assert_eq!(d.selected_index(), 2);
    d.key(key(KeyCode::Enter));
    assert_eq!(d.take_events(), [AppEvent::KeyAction(ActionId::Edit)]);
    for _ in 0..10 {
        d.key(key(KeyCode::Right));
    }
    assert_eq!(d.selected_index(), 3, "clamps at the last item");
    for _ in 0..10 {
        d.key(key(KeyCode::Left));
    }
    assert_eq!(d.selected_index(), 0);
    let buf = draw(&d, 90, 14);
    let bar = rows(&buf)
        .into_iter()
        .find(|r| r.contains("Run command?"))
        .unwrap();
    assert!(bar.contains(" No "), "{bar}");
}

#[test]
fn copy_is_dialog_local_flashes_copied_and_reverts_after_the_window() {
    let (mut d, copies) = with_clipboard(&confirming("ls -la", RiskLevel::Medium));
    let before = screen_of(&d, 90, 14);
    assert!(before.contains("Copy "), "{before}");
    d.key(ch('c'));
    assert_eq!(copies.borrow().as_slice(), ["ls -la"]);
    assert!(d.take_events().is_empty(), "copy never reaches the reducer");
    let flashed = draw(&d, 90, 14);
    let bar_y = rows(&flashed)
        .into_iter()
        .position(|r| r.contains("Copied"))
        .unwrap() as u16;
    let x = find(&flashed, bar_y, "Copied").unwrap();
    assert_eq!(fg(&flashed, x, bar_y), rgb(DARK.action_bar.success.base));
    assert_eq!(
        fg(&flashed, x + 3, bar_y),
        rgb(DARK.action_bar.success.base)
    );
    assert!(!flashed[(x, bar_y)].modifier.contains(Modifier::UNDERLINED));
    d.key(ch('c'));
    assert_eq!(copies.borrow().len(), 2, "re-press copies again");
    assert!(d.is_flashing());
    assert!(!d.poll_timers_at(Instant::now() + Duration::from_millis(500)));
    assert!(d.poll_timers_at(Instant::now() + COPY_FLASH + Duration::from_millis(1)));
    let reverted = screen_of(&d, 90, 14);
    assert!(reverted.contains("Copy ") && !reverted.contains("Copied"));
    d.key(key(KeyCode::Right));
    d.key(key(KeyCode::Right));
    d.key(key(KeyCode::Right));
    d.key(key(KeyCode::Right));
    d.key(key(KeyCode::Enter));
    assert_eq!(
        copies.borrow().len(),
        3,
        "Copy is the fifth item and Enter triggers it"
    );
    assert!(screen_of(&d, 90, 14).contains("Copied"));
    d.sync(&AppState::Editing {
        response: response("ls -la", RiskLevel::Medium),
        draft: "ls -la".into(),
        output_slot: None,
        answer: None,
    });
    assert!(!d.is_flashing(), "leaving confirming clears the flash");
    assert_eq!(d.selected_index(), 0);
}

// ── editing ──────────────────────────────────────────────────────

fn editing(draft: &str) -> AppState {
    AppState::Editing {
        response: response("echo rm-fake", RiskLevel::High),
        draft: draft.into(),
        output_slot: None,
        answer: None,
    }
}

#[test]
fn editing_reserves_wrapped_explanation_and_action_rows() {
    let draft = (1..=20)
        .map(|i| format!("echo LINE{i:02}"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut state = editing(&draft);
    if let AppState::Editing { response, .. } = &mut state {
        response.explanation = Some("one\ntwo\nthree\nfour\nfive\nsix".into());
    }
    let d = dialog(&state);
    for width in [80, 40] {
        let buf = draw(&d, width, 16);
        let s = screen(&buf);
        assert!(s.contains("LINE20"), "cursor row missing: {s}");
        assert!(s.contains("six"), "explanation missing: {s}");
        let compact: String = s
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '│')
            .collect();
        assert!(
            compact.contains("torun") && compact.contains("todiscardchanges"),
            "actions missing: {s}"
        );
        assert!(s.contains('╯'), "bottom border missing: {s}");
        assert_eq!(
            buf.content
                .iter()
                .filter(|c| c.modifier.contains(Modifier::REVERSED))
                .count(),
            1,
            "cursor missing: {s}"
        );
    }
}

#[test]
fn editing_viewport_keeps_cursor_and_actions_visible_through_navigation_and_resize() {
    let commands = (1..=20)
        .map(|i| format!("echo LINE{i:02}"))
        .collect::<Vec<_>>()
        .join("\n");
    for draft in [commands, format!("echo START{}END", "x".repeat(1200))] {
        let mut state = editing(&draft);
        let mut d = dialog(&state);
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 16)).unwrap();
        let mut check = |d: &ResponseDialog, width, height, visible: &str, cursor: &str| {
            terminal.backend_mut().resize(width, height);
            terminal.autoresize().unwrap();
            terminal.draw(|f| d.render(f)).unwrap();
            let buf = terminal.backend().buffer();
            let s = screen(buf);
            assert!(s.contains(visible), "cursor's text missing: {s}");
            assert!(
                s.contains("to run") && s.contains("to discard changes"),
                "actions missing: {s}"
            );
            assert!(s.contains('╯'), "bottom border missing: {s}");
            let cursors = buf
                .content
                .iter()
                .filter(|c| c.modifier.contains(Modifier::REVERSED))
                .collect::<Vec<_>>();
            assert_eq!(cursors.len(), 1, "cursor missing: {s}");
            assert_eq!(cursors[0].symbol(), cursor, "{s}");
        };
        let tail = if draft.contains('\n') {
            "LINE20"
        } else {
            "END"
        };
        check(&d, 80, 16, tail, " ");
        d.key(key(KeyCode::Home));
        check(&d, 80, 16, "echo", "e");
        d.key(key(KeyCode::End));
        d.key(key(KeyCode::Left));
        check(
            &d,
            60,
            12,
            tail,
            if draft.contains('\n') { "0" } else { "D" },
        );
        d.key(key(KeyCode::Right));
        d.key(ch('X'));
        for event in d.take_events() {
            state = wrap::session::reduce(&state, &event, false).unwrap();
            d.sync(&state);
        }
        check(&d, 80, 16, &format!("{tail}X"), " ");
        d.key(key(KeyCode::Enter));
        assert_eq!(
            d.take_events(),
            [AppEvent::SubmitEdit {
                text: format!("{draft}X")
            }]
        );
    }
}

#[test]
fn batched_typing_preserves_the_cursor_after_reducer_acknowledgments() {
    for initial in [editing("abc"), composing("abc"), interactive("abc")] {
        let mut state = initial;
        let mut d = dialog(&state);
        d.key(key(KeyCode::Left));
        d.key(ch('X'));
        d.key(ch('Y'));
        for event in d.take_events() {
            state = wrap::session::reduce(&state, &event, false).unwrap();
            d.sync(&state);
        }
        d.key(ch('Z'));
        for event in d.take_events() {
            state = wrap::session::reduce(&state, &event, false).unwrap();
            d.sync(&state);
        }
        assert_eq!(state.draft(), Some("abXYZc"));
        d.key(key(KeyCode::Enter));
        let expected = match state {
            AppState::Editing { .. } => AppEvent::SubmitEdit {
                text: "abXYZc".into(),
            },
            AppState::ComposingFollowup { .. } => AppEvent::SubmitFollowup {
                text: "abXYZc".into(),
            },
            _ => AppEvent::SubmitInteractive {
                text: "abXYZc".into(),
            },
        };
        assert_eq!(d.take_events(), [expected]);
    }
}

#[test]
fn editing_preserves_visible_command_line_breaks_and_the_cursor() {
    let mut d = dialog(&editing("echo FIRST\necho SECOND"));
    d.key(key(KeyCode::Left));
    let buf = draw(&d, 90, 16);
    let lines = rows(&buf);
    let first = lines.iter().position(|r| r.contains("echo FIRST")).unwrap();
    assert!(lines[first + 1].contains("echo SECOND"), "{}", screen(&buf));
    let y = (first + 1) as u16;
    let x = find(&buf, y, "SECOND").unwrap() + 5;
    assert!(buf[(x, y)].modifier.contains(Modifier::REVERSED));
    d.key(ch('X'));
    d.take_events();
    d.key(key(KeyCode::Enter));
    assert_eq!(
        d.take_events(),
        [AppEvent::SubmitEdit {
            text: "echo FIRST\necho SECONXD".into()
        }]
    );
}

#[test]
fn editing_shows_the_draft_with_a_cursor_and_routes_keys_to_the_reducer() {
    let mut d = dialog(&editing("echo rm-i-fake"));
    let buf = draw(&d, 90, 14);
    let s = screen(&buf);
    assert!(s.contains("echo rm-i-fake"));
    assert!(s.contains("⏎ to run │ Esc to discard changes"), "{s}");
    assert!(!s.contains("Run command?"));
    let y = rows(&buf)
        .into_iter()
        .position(|r| r.contains("rm-i-fake"))
        .unwrap() as u16;
    let x = find(&buf, y, "echo").unwrap();
    assert!(
        buf[(x + 14, y)].modifier.contains(Modifier::REVERSED),
        "cursor after the draft"
    );
    d.key(ch('x'));
    assert_eq!(
        d.take_events(),
        [AppEvent::DraftChange {
            text: "echo rm-i-fakex".into()
        }]
    );
    d.sync(&editing("echo rm-i-fakex"));
    d.key(key(KeyCode::Enter));
    assert_eq!(
        d.take_events(),
        [AppEvent::SubmitEdit {
            text: "echo rm-i-fakex".into()
        }]
    );
    d.key(key(KeyCode::Esc));
    assert_eq!(d.take_events(), [AppEvent::KeyEsc]);
    d.key(ctrl('c'));
    assert_eq!(d.take_events(), [AppEvent::KeyEsc]);
    let mut blank = dialog(&editing("   "));
    blank.key(key(KeyCode::Enter));
    assert!(blank.take_events().is_empty(), "blank draft never submits");
}

#[test]
fn sync_rebuilds_the_buffer_only_when_the_draft_differs() {
    let mut d = dialog(&editing("abc"));
    d.key(key(KeyCode::Left));
    d.sync(&editing("abc"));
    let buf = draw(&d, 90, 14);
    let y = rows(&buf)
        .into_iter()
        .position(|r| r.contains("abc"))
        .unwrap() as u16;
    let x = find(&buf, y, "abc").unwrap();
    assert!(
        buf[(x + 2, y)].modifier.contains(Modifier::REVERSED),
        "cursor kept at c"
    );
    d.sync(&editing("xyz"));
    let buf = draw(&d, 90, 14);
    let y = rows(&buf)
        .into_iter()
        .position(|r| r.contains("xyz"))
        .unwrap() as u16;
    let x = find(&buf, y, "xyz").unwrap();
    assert!(
        buf[(x + 3, y)].modifier.contains(Modifier::REVERSED),
        "new draft: cursor at end"
    );
}

// ── composing / processing follow-up ─────────────────────────────

fn composing(draft: &str) -> AppState {
    AppState::ComposingFollowup {
        response: response("echo rm-fake", RiskLevel::Medium),
        draft: draft.into(),
        output_slot: None,
        answer: None,
    }
}

#[test]
fn composing_followup_adds_a_multiline_input_under_the_read_only_command() {
    let mut d = dialog(&composing(""));
    let buf = draw(&d, 90, 16);
    let lines = dialog_rows(&buf);
    assert!(lines[2].contains("echo rm-fake"), "{}", lines[2]);
    assert!(
        lines[4].contains("actually..."),
        "placeholder on the compose strip after a spacer: {}",
        lines[4]
    );
    let s = screen(&buf);
    assert!(s.contains("⏎ to send │ Esc to cancel"), "{s}");
    d.key(ch('x'));
    assert_eq!(
        d.take_events(),
        [AppEvent::DraftChange { text: "x".into() }]
    );
    d.sync(&composing("be safer"));
    d.key(key(KeyCode::Enter));
    assert_eq!(
        d.take_events(),
        [AppEvent::SubmitFollowup {
            text: "be safer".into()
        }]
    );
    d.key(shift(KeyCode::Enter));
    assert_eq!(
        d.take_events(),
        [AppEvent::DraftChange {
            text: "be safer\n".into()
        }]
    );
    d.key(key(KeyCode::Esc));
    assert_eq!(d.take_events(), [AppEvent::KeyEsc]);
    let mut blank = dialog(&composing("  "));
    blank.key(key(KeyCode::Enter));
    assert!(blank.take_events().is_empty());
    assert!(d.compose_keys());
}

#[test]
fn processing_followup_freezes_the_draft_and_spins_in_the_bottom_border() {
    let state = AppState::ProcessingFollowup {
        response: response("echo rm-fake", RiskLevel::Medium),
        draft: "the draft".into(),
        status: Some("Probing the database".into()),
        output_slot: None,
        answer: None,
    };
    let mut d = dialog(&state);
    assert!(d.animating());
    let s = screen_of(&d, 90, 16);
    assert!(s.contains("the draft"));
    assert!(s.contains("╰─ ⢎  Probing the database ─"), "{s}");
    assert!(s.contains("Esc to abort") && !s.contains("to send"));
    d.set_tick(3);
    assert!(
        screen_of(&d, 90, 16).contains("⠎⠁ Probing the database"),
        "frame advances every three ticks"
    );
    d.key(ch('x'));
    assert!(
        d.take_events().is_empty(),
        "typing is ignored while processing"
    );
    d.key(key(KeyCode::Esc));
    assert_eq!(d.take_events(), [AppEvent::KeyEsc]);
    assert!(!d.compose_keys());
    let fallback = dialog(&AppState::ProcessingFollowup {
        response: response("echo rm-fake", RiskLevel::Medium),
        draft: String::new(),
        status: None,
        output_slot: None,
        answer: None,
    });
    assert!(screen_of(&fallback, 90, 16).contains("Reticulating splines..."));
    let mut quiet = opts(&DARK);
    quiet.no_animation = true;
    let still = ResponseDialog::new(&state, quiet);
    assert!(!still.animating());
    assert!(screen_of(&still, 90, 16).contains("╰─ Probing the database ─"));
}

#[test]
fn executing_step_shows_output_slot_running_status_and_interrupt_hint() {
    let d = dialog(&AppState::ExecutingStep {
        response: response("echo git-stash-fake", RiskLevel::Medium),
        source: StepSource::Model,
        output_slot: Some("Saved working directory.".into()),
        answer: None,
    });
    let buf = draw(&d, 90, 16);
    let lines = dialog_rows(&buf);
    assert!(lines[2].contains("│  Output:"), "{}", lines[2]);
    assert!(
        lines[3].contains("│  Saved working directory."),
        "{}",
        lines[3]
    );
    assert_eq!(
        lines[4].trim(),
        "│                                                                   │",
        "spacer"
    );
    assert!(lines[5].contains("echo git-stash-fake"), "{}", lines[5]);
    let s = screen(&buf);
    assert!(
        s.contains("Running step...") && s.contains("ctrl+C to interrupt step"),
        "{s}"
    );
    let y = rows(&buf)
        .into_iter()
        .position(|r| r.contains("Output:"))
        .unwrap() as u16;
    assert_eq!(
        fg(&buf, find(&buf, y, "Output:").unwrap(), y),
        rgb(DARK.dialog.output_label.base)
    );
    assert_eq!(
        fg(&buf, find(&buf, y + 1, "Saved").unwrap(), y + 1),
        rgb(DARK.dialog.output_text.base)
    );
}

#[test]
fn output_slot_sentinel_plan_and_omission() {
    let empty = dialog(&AppState::Confirming {
        response: response("echo done", RiskLevel::Medium),
        output_slot: Some(String::new()),
        answer: None,
    });
    assert!(screen_of(&empty, 90, 16).contains(OUTPUT_SLOT_EMPTY));
    let none = dialog(&confirming("echo done", RiskLevel::Medium));
    assert!(!screen_of(&none, 90, 16).contains("Output:"));
    let mut planned = response("bash $WRAP_TEMP_DIR/install.sh", RiskLevel::Medium);
    planned.plan = Some("Download, inspect, then run.".into());
    planned.is_final = false;
    let d = dialog(&AppState::Confirming {
        response: planned,
        output_slot: None,
        answer: None,
    });
    let buf = draw(&d, 90, 16);
    let s = screen(&buf);
    assert!(s.contains("Plan: Download, inspect, then run."), "{s}");
    let y = rows(&buf)
        .into_iter()
        .position(|r| r.contains("Plan:"))
        .unwrap() as u16;
    assert_eq!(
        fg(&buf, find(&buf, y, "Plan:").unwrap(), y),
        rgb(DARK.dialog.plan.base)
    );
}

// ── interactive compose ──────────────────────────────────────────

fn interactive(draft: &str) -> AppState {
    AppState::ComposingInteractive {
        draft: draft.into(),
    }
}

#[test]
fn interactive_compose_has_the_compose_pill_a_placeholder_and_send_hints() {
    let mut d = dialog(&interactive(""));
    let buf = draw(&d, 100, 20);
    let lines = dialog_rows(&buf);
    assert!(
        lines[0].contains("╭─ compose ─"),
        "left-aligned compose pill: {}",
        lines[0]
    );
    assert_eq!(
        lines[0].trim().chars().count(),
        69,
        "min inner width 65 + borders"
    );
    assert!(INTERACTIVE_PLACEHOLDERS.contains(&d.placeholder()));
    assert!(lines[2].contains(d.placeholder()), "{}", lines[2]);
    assert!(lines[5].contains("⏎ send │ Esc cancel"), "{}", lines[5]);
    let top = rows(&buf)
        .into_iter()
        .position(|r| r.contains("compose"))
        .unwrap() as u16;
    let x = find(&buf, top, "compose").unwrap();
    assert_eq!(bg(&buf, x, top), rgb(DARK.dialog.compose_pill.bg.base));
    assert_eq!(
        fg(&buf, find(&buf, top, "╭").unwrap(), top),
        rgb(DARK.risk.low.frame[0])
    );
    assert!(d.compose_keys());
    d.key(ch('l'));
    assert_eq!(
        d.take_events(),
        [AppEvent::DraftChange { text: "l".into() }]
    );
    d.sync(&interactive("list files"));
    d.key(key(KeyCode::Enter));
    assert_eq!(
        d.take_events(),
        [AppEvent::SubmitInteractive {
            text: "list files".into()
        }]
    );
    let previous = d.placeholder().to_string();
    d.sync(&interactive(""));
    assert_ne!(
        d.placeholder(),
        previous,
        "a fresh placeholder when the buffer empties"
    );
    assert!(screen_of(&d, 100, 20).contains(d.placeholder()));
}

#[test]
fn processing_interactive_freezes_the_prompt_and_shows_the_abort_hint() {
    let d = dialog(&AppState::ProcessingInteractive {
        draft: "ok do it".into(),
        status: None,
    });
    let s = screen_of(&d, 100, 20);
    assert!(
        s.contains("ok do it") && s.contains("Esc to abort") && s.contains("Reticulating"),
        "{s}"
    );
    assert!(s.contains("compose"));
    assert!(!d.compose_keys());
}

#[test]
fn oversized_paste_shows_the_truncation_banner_until_the_next_change() {
    let mut d = dialog(&interactive(""));
    d.paste(&"a".repeat(wrap::tui::MAX_BUFFER_BYTES + 10));
    let events = d.take_events();
    assert_eq!(events.len(), 1);
    let AppEvent::DraftChange { text } = &events[0] else {
        panic!("{events:?}");
    };
    assert_eq!(text.len(), wrap::tui::MAX_BUFFER_BYTES);
    d.sync(&interactive(text));
    let s = screen_of(&d, 100, 20);
    assert!(
        s.contains("paste truncated — for large input, pipe with cat file | w"),
        "{s}"
    );
    d.key(key(KeyCode::Backspace));
    d.take_events();
    assert!(
        !screen_of(&d, 100, 20).contains("paste truncated"),
        "cleared by the next change"
    );
}

#[test]
fn interactive_input_fits_the_terminal_height() {
    let draft: String = (1..=40).map(|i| format!("line {i}\n")).collect();
    let d = dialog(&interactive(&draft));
    let buf = draw(&d, 80, 14);
    let lines = dialog_rows(&buf);
    assert!(lines.len() <= 14);
    let s = screen(&buf);
    assert!(s.contains("line 40"), "cursor row visible: {s}");
    assert!(!s.contains("line 1\n"), "earlier rows scrolled out");
    assert!(s.contains("╭") && s.contains("╯"), "both borders fit: {s}");
    assert!(s.contains("⏎ send"), "{s}");
}

// ── continuation badge ───────────────────────────────────────────

#[test]
fn continuation_badge_renders_in_compose_processing_and_confirming() {
    let mut o = opts(&DARK);
    o.continuation_prompt = Some("how do I deploy this project".into());
    let d = ResponseDialog::new(&interactive(""), o);
    let buf = draw(&d, 100, 20);
    let lines = dialog_rows(&buf);
    assert!(
        lines[2].contains("│  ↳ Continuing: how do I deploy this project"),
        "{}",
        lines[2]
    );
    let y = rows(&buf)
        .into_iter()
        .position(|r| r.contains("Continuing"))
        .unwrap() as u16;
    assert_eq!(
        fg(&buf, find(&buf, y, "↳").unwrap(), y),
        rgb(DARK.copy.note.base)
    );
    let mut o = opts(&DARK);
    o.continuation_prompt = Some("how do I deploy".into());
    for state in [
        AppState::ProcessingInteractive {
            draft: "ok".into(),
            status: None,
        },
        confirming("ls", RiskLevel::Low),
    ] {
        let s = screen_of(&ResponseDialog::new(&state, o_clone(&o)), 100, 20);
        assert!(s.contains("↳ Continuing: how do I deploy"), "{s}");
    }
    assert!(!screen_of(&dialog(&interactive("")), 100, 20).contains("Continuing"));
}

fn o_clone(o: &ResponseDialogOptions) -> ResponseDialogOptions {
    ResponseDialogOptions {
        theme: o.theme,
        nerd_fonts: o.nerd_fonts,
        no_animation: o.no_animation,
        color_level: o.color_level,
        editor: o.editor.clone(),
        clipboard: None,
        continuation_prompt: o.continuation_prompt.clone(),
    }
}

// ── external editor ──────────────────────────────────────────────

#[test]
fn ctrl_g_in_the_same_input_batch_includes_the_latest_keystrokes() {
    for gui in [false, true] {
        let mut o = opts(&DARK);
        o.editor = Some(EditorInfo {
            display_name: "Editor".into(),
            gui,
        });
        let mut dialog = ResponseDialog::new(&composing("draft"), o);
        dialog.key(ch('x'));
        dialog.key(ctrl('g'));
        let mut events = dialog.take_events();
        assert_eq!(
            events.remove(0),
            AppEvent::DraftChange {
                text: "draftx".into()
            }
        );
        if gui {
            assert_eq!(
                dialog.take_signals(),
                [DialogSignal::OpenGuiEditor {
                    draft: "draftx".into()
                }]
            );
        } else {
            assert_eq!(
                events,
                [AppEvent::EnterEditor {
                    draft: "draftx".into()
                }]
            );
        }
    }
}

#[test]
fn ctrl_g_opens_a_terminal_editor_through_the_reducer_and_a_gui_editor_locally() {
    let mut o = opts(&DARK);
    o.editor = Some(EditorInfo {
        display_name: "Vim".into(),
        gui: false,
    });
    let mut d = ResponseDialog::new(&composing("draft text"), o);
    assert!(screen_of(&d, 90, 16).contains("⏎ to send │ ctrl+G edit in Vim │ Esc to cancel"));
    d.key(ctrl('g'));
    assert_eq!(
        d.take_events(),
        [AppEvent::EnterEditor {
            draft: "draft text".into()
        }]
    );
    assert!(d.take_signals().is_empty());

    let mut o = opts(&DARK);
    o.editor = Some(EditorInfo {
        display_name: "VS Code".into(),
        gui: true,
    });
    let mut g = ResponseDialog::new(&editing("echo a"), o);
    assert!(
        screen_of(&g, 90, 16)
            .contains("⏎ to run │ ctrl+G edit in VS Code │ Esc to discard changes")
    );
    g.key(ctrl('g'));
    assert!(g.take_events().is_empty());
    assert_eq!(
        g.take_signals(),
        [DialogSignal::OpenGuiEditor {
            draft: "echo a".into()
        }]
    );
    let s = screen_of(&g, 90, 16);
    assert!(
        s.contains("... Save and close editor to continue ...") && !s.contains("echo a"),
        "{s}"
    );
    g.key(ch('x'));
    g.key(ctrl('g'));
    assert!(
        g.take_events().is_empty() && g.take_signals().is_empty(),
        "input swallowed while the editor is open"
    );
    g.gui_editor_done(Some("echo b".into()));
    assert_eq!(
        g.take_events(),
        [AppEvent::DraftChange {
            text: "echo b".into()
        }]
    );
    g.sync(&editing("echo b"));
    assert!(screen_of(&g, 90, 16).contains("echo b"));
    g.key(ctrl('g'));
    g.take_signals();
    g.gui_editor_done(None);
    assert!(
        g.take_events().is_empty(),
        "a failed editor keeps the buffer"
    );

    let mut confirming_d =
        ResponseDialog::new(&confirming("true", RiskLevel::Low), o_clone(&opts(&DARK)));
    confirming_d.key(ctrl('g'));
    assert!(
        confirming_d.take_events().is_empty(),
        "no editor configured, not an edit state"
    );
}

// ── sizes ────────────────────────────────────────────────────────

#[test]
fn narrow_terminal_clamps_the_dialog_and_drops_the_pill() {
    let mut resp = response(
        "echo a-very-long-command-line that keeps going and going",
        RiskLevel::High,
    );
    resp.explanation = Some("an explanation that is also fairly long and wraps around".into());
    let d = dialog(&AppState::Confirming {
        response: resp,
        output_slot: None,
        answer: None,
    });
    let buf = draw(&d, 40, 24);
    let lines = dialog_rows(&buf);
    for line in &lines {
        assert!(
            unicode_width::UnicodeWidthStr::width(line.as_str()) <= 40,
            "{line}"
        );
    }
    assert_eq!(
        unicode_width::UnicodeWidthStr::width(lines[0].trim()),
        36,
        "{}",
        lines[0]
    );
    assert!(
        lines[0].ends_with(" ⚠ high risk ─╮"),
        "the pill still fits at 36: {}",
        lines[0]
    );
    assert!(
        screen(&buf).contains("keeps going"),
        "command wraps inside the strip"
    );
    assert!(screen(&buf).contains("Run command?"));
    let tiny = draw(&dialog(&confirming("true", RiskLevel::High)), 20, 10);
    let top = rows(&tiny).into_iter().find(|r| r.contains('╭')).unwrap();
    assert!(!top.contains("risk"), "pill dropped: {top}");
}

#[test]
fn short_terminal_folds_the_command_with_a_hidden_lines_pill() {
    let command: String = (0..30)
        .map(|i| format!("echo line{i}"))
        .collect::<Vec<_>>()
        .join("\n");
    let d = dialog(&confirming(&command, RiskLevel::Medium));
    let buf = draw(&d, 90, 14);
    let s = screen(&buf);
    assert!(s.contains("echo line0") && s.contains("echo line29"), "{s}");
    assert!(s.contains("lines hidden"), "{s}");
    let y = rows(&buf)
        .into_iter()
        .position(|r| r.contains("lines hidden"))
        .unwrap() as u16;
    let x = find(&buf, y, "lines hidden").unwrap();
    assert_eq!(bg(&buf, x, y), rgb(DARK.dialog.fold_indicator.bg.base));
    assert_eq!(fg(&buf, x, y), rgb(DARK.dialog.fold_indicator.fg.base));
    assert!(dialog_rows(&buf).len() <= 14);
    let editing_state = AppState::Editing {
        response: response(&command, RiskLevel::Medium),
        draft: command.clone(),
        output_slot: None,
        answer: None,
    };
    assert!(
        !screen_of(&dialog(&editing_state), 90, 14).contains("lines hidden"),
        "editing never folds"
    );
}

#[test]
fn color_levels_degrade_the_whole_frame() {
    let state = confirming("true", RiskLevel::Medium);
    let mut o = opts(&DARK);
    o.color_level = 1;
    let buf = draw(&ResponseDialog::new(&state, o_clone(&o)), 90, 14);
    for cell in &buf.content {
        assert!(
            !matches!(cell.fg, Color::Rgb(..)) && !matches!(cell.bg, Color::Rgb(..)),
            "{cell:?}"
        );
    }
    let top = rows(&buf)
        .into_iter()
        .position(|r| r.contains('╭'))
        .unwrap() as u16;
    let x = find(&buf, top, "╭").unwrap();
    assert_eq!(
        fg(&buf, x, top),
        wrap::theme::resolve_color(&DARK.copy.body, 1),
        "gradient collapses"
    );
    let mut o = opts(&DARK);
    o.color_level = 2;
    let buf = draw(&ResponseDialog::new(&state, o_clone(&o)), 90, 14);
    assert!(
        buf.content
            .iter()
            .any(|c| matches!(c.bg, Color::Indexed(_)))
    );
    let mut o = opts(&DARK);
    o.color_level = 0;
    let buf = draw(&ResponseDialog::new(&state, o_clone(&o)), 90, 14);
    assert!(
        buf.content
            .iter()
            .all(|c| c.fg == Color::Reset && c.bg == Color::Reset)
    );
    let bar = rows(&buf)
        .into_iter()
        .position(|r| r.contains("Run command?"))
        .unwrap() as u16;
    let x = find(&buf, bar, "No").unwrap();
    assert!(
        buf[(x, bar)].modifier.contains(Modifier::REVERSED),
        "focus survives as reverse video"
    );
    assert!(
        !buf[(find(&buf, bar, "Yes").unwrap(), bar)]
            .modifier
            .contains(Modifier::REVERSED)
    );
    assert!(
        screen(&buf).contains("⚠ medium risk"),
        "text is intact without color"
    );
}

#[test]
fn nerd_fonts_wrap_the_pills_in_powerline_caps() {
    let mut o = opts(&DARK);
    o.nerd_fonts = true;
    let s = screen_of(
        &ResponseDialog::new(&confirming("true", RiskLevel::Low), o),
        90,
        14,
    );
    assert!(s.contains("\u{E0B6} ✔ low risk \u{E0B4}"), "{s}");
}

// ── pure helpers ─────────────────────────────────────────────────

#[test]
fn format_output_slot_tails_three_lines_or_shows_the_sentinel() {
    assert_eq!(format_output_slot(""), OUTPUT_SLOT_EMPTY);
    assert_eq!(format_output_slot("   \n  \n"), OUTPUT_SLOT_EMPTY);
    assert_eq!(format_output_slot("a\nb\nc"), "a\nb\nc");
    assert_eq!(format_output_slot("only one line"), "only one line");
    assert_eq!(format_output_slot("1\n2\n3\n4\n5\n"), "3\n4\n5");
}

#[test]
fn fold_command_keeps_head_and_tail_within_the_row_budget() {
    assert_eq!(
        fold_command("ls -la", 10, 80),
        CommandDisplay::Full("ls -la".into())
    );
    let cmd = "echo a\necho b\necho c";
    assert_eq!(truncate_command(cmd, 10, 80), cmd);
    assert_eq!(truncate_command(cmd, 1000, 80), cmd);
    assert_eq!(
        truncate_command(cmd, 5, 0),
        cmd,
        "no width: nothing to fold against"
    );
    let lines: Vec<String> = (0..30).map(|i| format!("echo line{i}")).collect();
    let long = lines.join("\n");
    let CommandDisplay::Folded {
        head,
        hidden_count,
        tail,
    } = fold_command(&long, 10, 80)
    else {
        panic!("expected a fold");
    };
    assert!(head.contains("echo line0") && !head.contains("hidden"));
    assert!(tail.contains("echo line29"));
    assert_eq!(hidden_count, 30 - 4 - 5);
    let text = truncate_command(&long, 10, 80);
    assert!(
        text.contains("… 21 lines hidden") && text.lines().count() <= 10,
        "{text}"
    );
    assert_eq!(
        fold_command(&"x".repeat(200), 3, 40),
        CommandDisplay::Folded {
            head: String::new(),
            hidden_count: 1,
            tail: String::new()
        },
        "one line wider than the whole budget"
    );
    let mixed = [
        "a".repeat(100),
        "short".into(),
        "b".repeat(100),
        "also short".into(),
        "c".repeat(100),
        "end".into(),
    ]
    .join("\n");
    let folded = truncate_command(&mixed, 4, 50);
    assert!(folded.contains("end"));
    let rows: usize = folded.lines().map(|l| l.len().div_ceil(50).max(1)).sum();
    assert!(rows <= 4, "{folded}");
}

#[test]
fn many_short_command_lines_size_the_dialog_to_the_widest_line_not_their_sum() {
    let short: Vec<String> = (1..=30).map(|i| format!("echo {i}")).collect();
    let d = dialog(&confirming(&short.join("\n"), RiskLevel::Medium));
    let buf = draw(&d, 120, 60);
    let top = dialog_rows(&buf)[0].trim().to_string();
    assert_eq!(
        unicode_width::UnicodeWidthStr::width(top.as_str()),
        69,
        "thirty short lines stay at the minimum width: {top}"
    );
    let mut lines = short.clone();
    lines.push("x".repeat(80));
    let d = dialog(&confirming(&lines.join("\n"), RiskLevel::Medium));
    let top = dialog_rows(&draw(&d, 120, 60))[0].trim().to_string();
    assert_eq!(
        unicode_width::UnicodeWidthStr::width(top.as_str()),
        84,
        "one 80-cell line widens to that line plus the chrome: {top}"
    );
}
