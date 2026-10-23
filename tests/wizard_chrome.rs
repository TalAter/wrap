//! The wizard's top pill chain: step index per screen, done/active/pending
//! segments in plain and nerd modes, the per-provider loop label, and the
//! narrow fallbacks when the terminal cannot fit the full chain.

use wrap::theme::DARK;
use wrap::tui::PillSegment;
use wrap::tui::wizard_dialog::{
    ActiveProvider, step_index_from_screen, wizard_crumb_pill, wizard_crumb_pill_narrow,
    wizard_label_pill,
};
use wrap::wizard::state::ScreenTag;

const CHECK: &str = "\u{F00C}";
const LIST: &str = "\u{F03A}";
const CUBE: &str = "\u{F1B2}";

fn labels(segs: &[PillSegment]) -> Vec<&str> {
    segs.iter().map(|s| s.label.as_str()).collect()
}

#[test]
fn step_index_groups_screens_into_the_four_steps() {
    assert_eq!(step_index_from_screen(ScreenTag::SelectingProviders), 0);
    assert_eq!(step_index_from_screen(ScreenTag::LoadingModels), 0);
    assert_eq!(step_index_from_screen(ScreenTag::EnteringKey), 1);
    assert_eq!(step_index_from_screen(ScreenTag::Disclaimer), 1);
    assert_eq!(step_index_from_screen(ScreenTag::PickingModel), 2);
    assert_eq!(step_index_from_screen(ScreenTag::PickingDefault), 3);
    assert_eq!(step_index_from_screen(ScreenTag::Done), 4);
}

#[test]
fn label_pill_is_the_bold_wizard_segment() {
    let segs = wizard_label_pill(&DARK);
    assert_eq!(labels(&segs), ["🧙 Setup Wizard"]);
    assert!(segs[0].bold);
    assert_eq!(segs[0].bg, DARK.wizard.label_pill.bg);
}

#[test]
fn first_step_shows_the_wizard_label_and_a_bold_active_providers_segment() {
    let segs = wizard_crumb_pill(&DARK, 0, true, None);
    assert_eq!(segs.len(), 2);
    assert!(segs[0].label.contains("Setup Wizard"));
    assert_eq!(segs[1].label, format!("{LIST} Providers"));
    assert!(segs[1].bold);
    assert_eq!(segs[1].label_narrow.as_deref(), Some("P"));
    assert_eq!(segs[1].bg, DARK.wizard.step_active.bg);
}

#[test]
fn done_segments_get_a_check_in_plain_and_nerd_modes() {
    let plain = wizard_crumb_pill(&DARK, 2, false, None);
    assert_eq!(
        labels(&plain),
        ["🧙 Setup Wizard", "✓ Providers", "✓ API Key", "Model"]
    );
    assert_eq!(plain[1].bg, DARK.wizard.step_done.bg);
    assert!(!plain[1].bold);
    let nerd = wizard_crumb_pill(&DARK, 2, true, None);
    assert_eq!(nerd[1].label, format!("{CHECK} {LIST} Providers"));
}

#[test]
fn past_the_last_step_everything_is_done_and_nothing_is_active() {
    let segs = wizard_crumb_pill(&DARK, 4, false, None);
    assert_eq!(segs.len(), 5);
    assert!(
        segs.iter()
            .all(|s| !s.bold || s.label.contains("Setup Wizard"))
    );
}

#[test]
fn active_provider_replaces_the_done_providers_segment_without_a_check() {
    let anthropic = ActiveProvider {
        display_name: "Anthropic".into(),
        nerd_icon: Some("\u{e754}".into()),
    };
    let plain = wizard_crumb_pill(&DARK, 2, false, Some(&anthropic));
    assert_eq!(plain[1].label, "Anthropic");
    let nerd = wizard_crumb_pill(&DARK, 2, true, Some(&anthropic));
    assert_eq!(nerd[1].label, format!("{CHECK} \u{e754} Anthropic"));
    let ollama = ActiveProvider {
        display_name: "Ollama".into(),
        nerd_icon: None,
    };
    let fallback = wizard_crumb_pill(&DARK, 1, true, Some(&ollama));
    assert_eq!(fallback[1].label, format!("{CHECK} {LIST} Ollama"));
}

#[test]
fn active_provider_is_ignored_before_the_providers_step_is_done() {
    let anthropic = ActiveProvider {
        display_name: "Anthropic".into(),
        nerd_icon: None,
    };
    let segs = wizard_crumb_pill(&DARK, 0, false, Some(&anthropic));
    assert_eq!(segs[1].label, "Providers");
}

#[test]
fn default_step_collapses_to_providers_and_set_default() {
    let segs = wizard_crumb_pill(&DARK, 3, false, None);
    assert_eq!(
        labels(&segs),
        ["🧙 Setup Wizard", "✓ Providers", "Set Default"]
    );
    assert!(segs[2].bold);
}

#[test]
fn narrow_chain_has_one_segment_per_step_and_no_wizard_label() {
    let nerd = wizard_crumb_pill_narrow(&DARK, 1, true);
    assert_eq!(nerd.len(), 4);
    assert!(nerd.iter().all(|s| !s.label.contains("Setup Wizard")));
    assert_eq!(nerd[0].label, CHECK);
    assert_eq!(nerd[2].label, CUBE);
    assert_eq!(nerd[1].label_narrow.as_deref(), Some("\u{F084}"));

    let plain = wizard_crumb_pill_narrow(&DARK, 1, false);
    assert_eq!(labels(&plain), ["✓", "API Key", "M", "D"]);
    assert!(plain[1].bold);
    assert_eq!(plain[1].label_narrow.as_deref(), Some("K"));
    assert_eq!(plain[2].bg, DARK.wizard.step_pending.bg);

    let done = wizard_crumb_pill_narrow(&DARK, 4, false);
    assert_eq!(labels(&done), ["✓", "✓", "✓", "✓"]);
}
