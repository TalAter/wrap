//! The config wizard dialog end to end: section order, every provider
//! screen's layout and key handling, the pill chain per screen, the models
//! load (injected and as a background task), and cancellation.

mod common;

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use common::*;
use crossterm::event::KeyCode;
use ratatui::style::{Color, Modifier};
use serde_json::json;
use wrap::config::ProviderEntry;
use wrap::theme::DARK;
use wrap::tui::wizard_dialog::{
    ConfigWizardDialog, WIZARD_CONTENT_WIDTH, WizardDialogOptions, WizardExit, WizardSection,
};
use wrap::tui::{Dialog, Progress};
use wrap::wizard::models_dev::ModelsDevData;
use wrap::wizard::state::{ProviderScreen, ScreenTag};

fn model(id: &str, date: &str) -> serde_json::Value {
    json!({
        "id": id,
        "tool_call": true,
        "modalities": { "input": ["text"], "output": ["text"] },
        "release_date": date,
    })
}

fn fixture() -> ModelsDevData {
    json!({
        "anthropic": { "id": "anthropic", "models": {
            "claude-sonnet-4-6": model("claude-sonnet-4-6", "2026-03-01"),
            "claude-haiku-4-5": model("claude-haiku-4-5", "2025-11-01"),
        }},
        "openai": { "id": "openai", "models": {
            "gpt-5": model("gpt-5", "2026-01-01"),
        }},
        "ollama": { "id": "ollama", "models": {
            "llama3.2": model("llama3.2", "2024-10-01"),
        }},
    })
}

fn options() -> WizardDialogOptions {
    WizardDialogOptions {
        theme: &DARK,
        color_level: 3,
        nerd_fonts: false,
        no_animation: false,
        cli_available: BTreeMap::new(),
        models_loader: None,
        on_nerd_fonts: None,
    }
}

fn dialog() -> ConfigWizardDialog {
    ConfigWizardDialog::new(options())
}

fn with_cli() -> ConfigWizardDialog {
    let mut opts = options();
    opts.cli_available = BTreeMap::from([("claude-code".to_string(), true)]);
    ConfigWizardDialog::new(opts)
}

fn draw(d: &ConfigWizardDialog, width: u16, height: u16) -> ratatui::buffer::Buffer {
    let mut buf = buffer(width, height);
    let area = buf.area;
    d.render_to(&mut buf, area);
    buf
}

fn text(d: &ConfigWizardDialog) -> String {
    screen(&draw(d, 100, 36))
}

fn enter(d: &mut ConfigWizardDialog) -> Option<WizardExit> {
    d.key(key(KeyCode::Enter))
}

fn down(d: &mut ConfigWizardDialog) -> Option<WizardExit> {
    d.key(key(KeyCode::Down))
}

fn esc(d: &mut ConfigWizardDialog) -> Option<WizardExit> {
    d.key(key(KeyCode::Esc))
}

fn type_text(d: &mut ConfigWizardDialog, s: &str) {
    for c in s.chars() {
        assert!(d.key(ch(c)).is_none());
    }
}

/// Welcome → nerd icons (No, so screens render plain) → providers.
fn to_providers(d: &mut ConfigWizardDialog) {
    assert!(enter(d).is_none());
    assert_eq!(d.section(), WizardSection::NerdIcons);
    assert!(down(d).is_none());
    assert!(enter(d).is_none());
    assert_eq!(d.section(), WizardSection::Providers);
    assert!(!d.nerd_fonts());
}

fn tag(d: &ConfigWizardDialog) -> ScreenTag {
    d.screen().expect("providers section").tag()
}

/// Selects the row `index` rows below the cursor and submits.
fn pick_and_submit(d: &mut ConfigWizardDialog, rows: &[usize]) {
    let mut at = 0;
    for &row in rows {
        while at < row {
            down(d);
            at += 1;
        }
        assert!(d.key(ch(' ')).is_none());
    }
    assert!(enter(d).is_none());
    assert_eq!(tag(d), ScreenTag::LoadingModels);
}

/// Through the provider loop for one API provider with a key.
fn to_anthropic_key(d: &mut ConfigWizardDialog) {
    to_providers(d);
    pick_and_submit(d, &[0]);
    assert!(d.models_fetched(Ok(fixture())).is_none());
    assert_eq!(tag(d), ScreenTag::EnteringKey);
}

fn entry(api_key: Option<&str>, base_url: Option<&str>, model: Option<&str>) -> ProviderEntry {
    ProviderEntry {
        api_key: api_key.map(Into::into),
        base_url: base_url.map(Into::into),
        model: model.map(Into::into),
    }
}

// ── sections ────────────────────────────────────────────────────

#[test]
fn starts_on_the_welcome_section_and_enter_walks_to_providers() {
    let mut d = dialog();
    assert_eq!(d.section(), WizardSection::Welcome);
    assert!(text(&d).contains("a cli with taste (yours)"));
    assert!(enter(&mut d).is_none());
    assert!(text(&d).contains("Do you see four icons below?"));
    assert!(enter(&mut d).is_none());
    assert!(text(&d).contains("Wrap needs at least one LLM provider configured."));
}

#[test]
fn esc_cancels_on_every_section() {
    let mut d = dialog();
    assert!(matches!(esc(&mut d), Some(WizardExit::Cancelled)));
    let mut d = dialog();
    enter(&mut d);
    assert!(matches!(esc(&mut d), Some(WizardExit::Cancelled)));
    let mut d = dialog();
    to_providers(&mut d);
    assert!(matches!(esc(&mut d), Some(WizardExit::Cancelled)));
    let mut d = dialog();
    to_anthropic_key(&mut d);
    assert!(matches!(esc(&mut d), Some(WizardExit::Cancelled)));
}

#[test]
fn external_cancel_is_cancelled_on_any_section() {
    let mut d = dialog();
    to_anthropic_key(&mut d);
    assert!(matches!(d.cancelled(), WizardExit::Cancelled));
}

#[test]
fn nerd_icons_answer_is_reported_immediately_and_reaches_the_result() {
    let seen = Rc::new(RefCell::new(Vec::new()));
    let sink = seen.clone();
    let mut opts = options();
    opts.on_nerd_fonts = Some(Box::new(move |v| sink.borrow_mut().push(v)));
    let mut d = ConfigWizardDialog::new(opts);
    enter(&mut d);
    down(&mut d);
    assert!(enter(&mut d).is_none());
    assert_eq!(*seen.borrow(), [false]);
    assert!(!d.nerd_fonts());
    assert_eq!(d.section(), WizardSection::Providers);

    let mut d = dialog();
    enter(&mut d);
    enter(&mut d);
    assert!(d.nerd_fonts());
    assert_eq!(d.section(), WizardSection::Providers);
    pick_and_submit(&mut d, &[0]);
    d.models_fetched(Ok(fixture()));
    type_text(&mut d, "sk-ant-test-key");
    enter(&mut d);
    match enter(&mut d) {
        Some(WizardExit::Done(result)) => {
            assert_eq!(result.nerd_fonts, Some(true));
            assert_eq!(result.default_provider, "anthropic");
            assert_eq!(
                result.entries["anthropic"],
                entry(Some("sk-ant-test-key"), None, Some("claude-sonnet-4-6"))
            );
        }
        other => panic!("expected done, got {other:?}"),
    }
}

// ── provider selection ──────────────────────────────────────────

#[test]
fn selection_screen_lists_api_providers_with_a_pointer_and_hides_cli_without_a_binary() {
    let mut d = dialog();
    to_providers(&mut d);
    let buf = draw(&d, 100, 36);
    let s = screen(&buf);
    assert!(s.contains("Wrap needs at least one LLM provider configured."));
    assert!(s.contains("SELECT API PROVIDER(S)"));
    assert!(s.contains("❯ [ ] Anthropic"));
    assert!(s.contains("  [ ] OpenAI"));
    assert!(s.contains("  [ ] OpenRouter"));
    assert!(s.contains("  [ ] Groq"));
    assert!(s.contains("  [ ] Mistral"));
    assert!(s.contains("  [ ] Ollama (local)"));
    assert!(!s.contains("Claude Code"));
    assert!(!s.contains("CODING AGENT"));
    assert!(s.contains("Space to toggle"));
    assert!(!s.contains("⏎ to continue"));
    assert!(s.contains("🧙  Setup Wizard  Providers "));
}

#[test]
fn cli_section_appears_when_the_binary_is_present() {
    let mut d = with_cli();
    to_providers(&mut d);
    let s = text(&d);
    assert!(s.contains("USE YOUR CODING AGENT'S SUBSCRIPTION"));
    assert!(s.contains("[ ] Claude Code"));
}

#[test]
fn space_toggles_and_reveals_continue_and_enter_needs_a_selection() {
    let mut d = dialog();
    to_providers(&mut d);
    assert!(enter(&mut d).is_none());
    assert_eq!(tag(&d), ScreenTag::SelectingProviders);
    assert!(d.key(ch(' ')).is_none());
    let s = text(&d);
    assert!(s.contains("❯ [✓] Anthropic"));
    assert!(s.contains("Space to toggle │ ⏎ to continue"));
    assert_eq!(
        d.screen(),
        Some(&ProviderScreen::SelectingProviders {
            checked: ["anthropic".to_string()].into_iter().collect()
        })
    );
    assert!(d.key(ch(' ')).is_none());
    assert!(!text(&d).contains("⏎ to continue"));
}

// ── loading ─────────────────────────────────────────────────────

#[test]
fn loading_screen_spins_in_the_body_and_reports_in_the_bottom_border() {
    let mut d = dialog();
    to_providers(&mut d);
    pick_and_submit(&mut d, &[0]);
    assert!(d.animating());
    d.set_tick(0);
    let s = text(&d);
    assert!(s.contains("⢎  Loading models…"), "{s}");
    assert!(s.contains("╰─ Loading models list… "), "{s}");
    assert!(s.contains("🧙  Setup Wizard  Providers "));
    d.set_tick(3);
    assert!(text(&d).contains("⠎⠁ Loading models…"));

    let mut opts = options();
    opts.no_animation = true;
    let mut d = ConfigWizardDialog::new(opts);
    to_providers(&mut d);
    pick_and_submit(&mut d, &[0]);
    let s = text(&d);
    assert!(s.contains(" Loading models…"));
    assert!(!s.contains("⢎"));
}

#[test]
fn models_failure_fails_the_wizard_with_the_message() {
    let mut d = dialog();
    to_providers(&mut d);
    pick_and_submit(&mut d, &[0]);
    let exit = d.models_fetched(Err("Config error: could not load model list.".into()));
    assert!(
        matches!(exit, Some(WizardExit::Failed(ref m)) if m == "Config error: could not load model list.")
    );
}

#[tokio::test]
async fn models_load_runs_as_a_background_task_and_polls_into_the_key_screen() {
    let mut opts = options();
    opts.models_loader = Some(Box::new(|| Box::pin(async { Ok(fixture()) })));
    let mut d = ConfigWizardDialog::new(opts);
    to_providers(&mut d);
    pick_and_submit(&mut d, &[0]);
    let mut changed = false;
    for _ in 0..200 {
        match d.poll().unwrap() {
            Progress::Idle => tokio::time::sleep(std::time::Duration::from_millis(5)).await,
            Progress::Changed => {
                changed = true;
                break;
            }
            Progress::Exit(_) => panic!("unexpected exit"),
        }
    }
    assert!(changed);
    assert_eq!(tag(&d), ScreenTag::EnteringKey);
    assert!(matches!(d.poll().unwrap(), Progress::Idle));
}

#[tokio::test]
async fn background_load_failure_exits_with_failed() {
    let mut opts = options();
    opts.models_loader = Some(Box::new(|| {
        Box::pin(async { Err("Config error: offline.".to_string()) })
    }));
    let mut d = ConfigWizardDialog::new(opts);
    to_providers(&mut d);
    pick_and_submit(&mut d, &[0]);
    let mut exit = None;
    for _ in 0..200 {
        match d.poll().unwrap() {
            Progress::Idle => tokio::time::sleep(std::time::Duration::from_millis(5)).await,
            Progress::Changed => panic!("unexpected change"),
            Progress::Exit(e) => {
                exit = Some(e);
                break;
            }
        }
    }
    assert!(matches!(exit, Some(WizardExit::Failed(ref m)) if m == "Config error: offline."));
}

// ── api key ─────────────────────────────────────────────────────

#[test]
fn api_key_screen_shows_the_provider_link_and_a_masked_input() {
    let mut d = dialog();
    to_anthropic_key(&mut d);
    let buf = draw(&d, 100, 36);
    let s = screen(&buf);
    assert!(s.contains("Anthropic API key"));
    assert!(s.contains("Get one: https://console.anthropic.com/settings/keys"));
    assert!(s.contains("sk-ant-api03-"), "placeholder");
    assert!(s.contains("⏎ to continue"));
    assert!(s.contains("🧙  Setup Wizard  Anthropic  API Key "), "{s}");
    let y = (0..buf.area.height)
        .find(|&y| row(&buf, y).contains("Anthropic API key"))
        .unwrap();
    let x = find(&buf, y, "Anthropic").unwrap();
    assert!(buf[(x, y)].modifier.contains(Modifier::BOLD));
    let ly = y + 1;
    let lx = find(&buf, ly, "https://").unwrap();
    assert_eq!(fg(&buf, lx, ly), rgb(DARK.wizard.provider_link.base));

    type_text(&mut d, "abc");
    let s = text(&d);
    assert!(s.contains("•••"));
    assert!(!s.contains("abc"));
    assert!(!s.contains("sk-ant-api03-"));
    assert_eq!(
        d.screen(),
        Some(&ProviderScreen::EnteringKey {
            provider: "anthropic".into(),
            draft: "abc".into()
        })
    );
}

#[test]
fn pasted_keys_land_in_the_input_and_blank_keys_do_not_submit() {
    let mut d = dialog();
    to_anthropic_key(&mut d);
    assert!(enter(&mut d).is_none());
    assert_eq!(tag(&d), ScreenTag::EnteringKey);
    d.paste("  sk-ant-pasted\n");
    assert!(enter(&mut d).is_none());
    assert_eq!(tag(&d), ScreenTag::PickingModel);
    let exit = enter(&mut d);
    match exit {
        Some(WizardExit::Done(result)) => {
            assert_eq!(
                result.entries["anthropic"].api_key.as_deref(),
                Some("sk-ant-pasted")
            );
        }
        other => panic!("expected done, got {other:?}"),
    }
}

// ── model picker ────────────────────────────────────────────────

#[test]
fn model_picker_marks_the_recommended_model_and_down_picks_the_next() {
    let mut d = dialog();
    to_anthropic_key(&mut d);
    type_text(&mut d, "k");
    enter(&mut d);
    let s = text(&d);
    assert!(s.contains("Anthropic model"));
    assert!(s.contains("❯ claude-sonnet-4-6  ✦ Recommended"), "{s}");
    assert!(s.contains("  claude-haiku-4-5"));
    assert!(s.contains("↑↓ to move │ ⏎ to continue"));
    assert!(
        s.contains("🧙  Setup Wizard  Anthropic  ✓ API Key  Model "),
        "{s}"
    );
    down(&mut d);
    assert!(text(&d).contains("❯ claude-haiku-4-5"));
    match enter(&mut d) {
        Some(WizardExit::Done(result)) => {
            assert_eq!(
                result.entries["anthropic"].model.as_deref(),
                Some("claude-haiku-4-5")
            );
            assert_eq!(result.nerd_fonts, Some(false));
        }
        other => panic!("expected done, got {other:?}"),
    }
}

#[test]
fn model_picker_windows_to_eight_rows() {
    let mut models = serde_json::Map::new();
    for i in 0..12 {
        models.insert(
            format!("m-{i:02}"),
            model(&format!("m-{i:02}"), &format!("2026-01-{:02}", 28 - i)),
        );
    }
    let data = json!({ "ollama": { "id": "ollama", "models": models } });
    let mut d = dialog();
    to_providers(&mut d);
    pick_and_submit(&mut d, &[5]);
    d.models_fetched(Ok(data));
    assert_eq!(tag(&d), ScreenTag::PickingModel);
    let s = text(&d);
    assert!(s.contains("Ollama (local) model"));
    assert!(s.contains("❯ m-00"));
    assert!(s.contains("  m-07"));
    assert!(!s.contains("m-08"));
    for _ in 0..8 {
        down(&mut d);
    }
    let s = text(&d);
    assert!(s.contains("❯ m-08"));
    assert!(!s.contains("m-00"));
}

// ── disclaimer ──────────────────────────────────────────────────

#[test]
fn disclaimer_accepts_with_enter_and_skips_with_esc() {
    let mut d = with_cli();
    to_providers(&mut d);
    pick_and_submit(&mut d, &[6]);
    d.models_fetched(Ok(fixture()));
    assert_eq!(tag(&d), ScreenTag::Disclaimer);
    let s = text(&d);
    assert!(
        s.contains("Wrap will route your queries through the claude CLI"),
        "{s}"
    );
    assert!(s.contains("the Anthropic API directly. This is slower, and your prompts flow"));
    assert!(s.contains("through Claude Code under its own terms — bring your own subscription"));
    assert!(s.contains("and credentials."));
    assert!(s.contains("⏎ to accept │ Esc to skip this provider"));
    assert!(s.contains("🧙  Setup Wizard  Claude Code  API Key "), "{s}");
    assert!(esc(&mut d).is_none(), "esc skips rather than cancelling");
    assert_eq!(tag(&d), ScreenTag::SelectingProviders);
    assert!(text(&d).contains("❯ [ ] Anthropic"));

    pick_and_submit(&mut d, &[6]);
    d.models_fetched(Ok(fixture()));
    match enter(&mut d) {
        Some(WizardExit::Done(result)) => {
            assert_eq!(result.default_provider, "claude-code");
            assert_eq!(result.entries["claude-code"], ProviderEntry::default());
        }
        other => panic!("expected done, got {other:?}"),
    }
}

// ── default picker ──────────────────────────────────────────────

#[test]
fn two_providers_end_on_the_default_picker() {
    let mut d = dialog();
    to_providers(&mut d);
    pick_and_submit(&mut d, &[0, 1]);
    d.models_fetched(Ok(fixture()));
    assert!(text(&d).contains("Anthropic API key"));
    type_text(&mut d, "sk-ant-key");
    enter(&mut d);
    assert!(text(&d).contains("Anthropic model"));
    enter(&mut d);
    assert!(text(&d).contains("OpenAI API key"));
    assert!(text(&d).contains("sk-proj-"), "fresh input per provider");
    type_text(&mut d, "sk-proj-key");
    enter(&mut d);
    assert!(text(&d).contains("OpenAI model"));
    assert!(enter(&mut d).is_none());
    let s = text(&d);
    assert!(s.contains("Which provider should be the default?"));
    assert!(s.contains("❯ Anthropic"));
    assert!(s.contains("  OpenAI"));
    assert!(s.contains("↑↓ to move │ ⏎ to select"));
    assert!(
        s.contains("🧙  Setup Wizard  ✓ Providers  Set Default "),
        "{s}"
    );
    down(&mut d);
    match enter(&mut d) {
        Some(WizardExit::Done(result)) => {
            assert_eq!(result.default_provider, "openai");
            assert_eq!(
                result.entries["anthropic"].model.as_deref(),
                Some("claude-sonnet-4-6")
            );
            assert_eq!(result.entries["openai"].model.as_deref(), Some("gpt-5"));
        }
        other => panic!("expected done, got {other:?}"),
    }
}

// ── chrome ──────────────────────────────────────────────────────

#[test]
fn frame_uses_the_wizard_gradient_at_the_wizard_width() {
    let mut d = dialog();
    to_providers(&mut d);
    let buf = draw(&d, 100, 36);
    let top = (0..buf.area.height)
        .find(|&y| row(&buf, y).starts_with("╭") || row(&buf, y).contains("╭"))
        .unwrap();
    let x = find(&buf, top, "╭").unwrap();
    let total = WIZARD_CONTENT_WIDTH + 4;
    assert_eq!(x, (100 - total) / 2);
    assert_eq!(fg(&buf, x, top), rgb(DARK.wizard.frame[0]));
    assert_eq!(
        buf[(x + total - 1, top)].symbol(),
        "╮",
        "frame is {total} wide"
    );
}

#[test]
fn nerd_mode_pill_chain_uses_powerline_glyphs_and_icons() {
    let mut opts = options();
    opts.nerd_fonts = true;
    let mut d = ConfigWizardDialog::new(opts);
    enter(&mut d);
    enter(&mut d);
    let s = text(&d);
    assert!(
        s.contains("\u{E0B6} 🧙  Setup Wizard \u{E0C0} \u{F03A} Providers \u{E0B4}"),
        "{s}"
    );
    assert!(s.contains("[ ] \u{e754}  Anthropic"), "{s}");
}

#[test]
fn narrow_terminals_fall_back_to_abbreviated_steps() {
    let mut d = dialog();
    to_providers(&mut d);
    let s = screen(&draw(&d, 30, 36));
    assert!(!s.contains("Setup Wizard"), "{s}");
    assert!(s.contains(" Providers  K  M  D "), "{s}");
    let s = screen(&draw(&d, 24, 36));
    assert!(s.contains(" P  K  M  D "), "{s}");
}

// ── narrow terminals ────────────────────────────────────────────

fn row_of(buf: &ratatui::buffer::Buffer, needle: &str) -> u16 {
    (0..buf.area.height)
        .find(|&y| row(buf, y).contains(needle))
        .unwrap_or_else(|| panic!("{needle:?} not on screen:\n{}", screen(buf)))
}

fn assert_all_visible(buf: &ratatui::buffer::Buffer, width: u16, needles: &[&str]) {
    // Wrapped rows interleave with the frame's side borders.
    let flatten = |text: &str| -> String {
        text.chars()
            .filter(|c| !c.is_whitespace() && *c != '│')
            .collect()
    };
    let s = screen(buf);
    let flat = flatten(&s);
    for needle in needles {
        assert!(
            flat.contains(&flatten(needle)),
            "{needle:?} missing at {width} cols:\n{s}"
        );
    }
    for line in rows(buf) {
        assert!(
            unicode_width::UnicodeWidthStr::width(line.as_str()) <= usize::from(width),
            "{line}"
        );
    }
    let top = row_of(buf, "╭");
    let bottom = row_of(buf, "╰");
    let frame_x = find(buf, top, "╭").unwrap();
    for y in top + 1..bottom {
        assert_eq!(
            buf[(frame_x, y)].symbol(),
            "│",
            "left border continuous at row {y}:\n{s}"
        );
    }
}

#[test]
fn narrow_selection_screen_wraps_the_intro_headers_and_action_bar() {
    let mut d = with_cli();
    to_providers(&mut d);
    for width in [48u16, 40] {
        let buf = draw(&d, width, 40);
        assert_all_visible(
            &buf,
            width,
            &[
                "Wrap needs at least one LLM provider configured.",
                "SELECT API PROVIDER(S)",
                "USE YOUR CODING AGENT'S SUBSCRIPTION",
                "[ ] Ollama (local)",
                "[ ] Claude Code",
                "Space to toggle",
            ],
        );
    }
}

#[test]
fn narrow_key_screen_wraps_the_link_and_action_bar() {
    let mut d = dialog();
    to_anthropic_key(&mut d);
    for width in [48u16, 40] {
        let buf = draw(&d, width, 30);
        assert_all_visible(
            &buf,
            width,
            &[
                "Anthropic API key",
                "Get one: https://console.anthropic.com/settings/keys",
                "⏎ to continue",
            ],
        );
    }
}

// ── copy colours ────────────────────────────────────────────────

#[test]
fn body_copy_uses_the_terminal_default_colour_and_headings_stay_bold() {
    let mut d = dialog();
    to_providers(&mut d);
    let buf = draw(&d, 100, 36);
    let y = row_of(&buf, "Wrap needs");
    let x = find(&buf, y, "Wrap").unwrap();
    assert_eq!(fg(&buf, x, y), Color::Reset);
    assert!(!buf[(x, y)].modifier.contains(Modifier::BOLD));

    let mut d = dialog();
    to_anthropic_key(&mut d);
    let buf = draw(&d, 100, 36);
    let y = row_of(&buf, "Anthropic API key");
    let x = find(&buf, y, "Anthropic").unwrap();
    assert_eq!(fg(&buf, x, y), Color::Reset);
    assert!(buf[(x, y)].modifier.contains(Modifier::BOLD));
    let y = row_of(&buf, "Get one:");
    let x = find(&buf, y, "Get").unwrap();
    assert_eq!(fg(&buf, x, y), Color::Reset);
    let lx = find(&buf, y, "https").unwrap();
    assert_eq!(fg(&buf, lx, y), rgb(DARK.wizard.provider_link.base));
}
