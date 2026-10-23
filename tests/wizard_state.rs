//! The provider-wizard reducer: screen transitions, entry building, cursor
//! clamping, and the skip-disclaimer edge cases.

use std::collections::BTreeSet;

use serde_json::json;
use wrap::config::ProviderEntry;
use wrap::wizard::models_dev::ModelsDevData;
use wrap::wizard::state::{Action, ProviderScreen, ProviderWizardState, ScreenTag, reduce};

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

fn toggle(state: ProviderWizardState, name: &str) -> ProviderWizardState {
    reduce(state, Action::ToggleProvider(name.into()))
}

fn checked(state: &ProviderWizardState) -> BTreeSet<String> {
    match &state.screen {
        ProviderScreen::SelectingProviders { checked } => checked.clone(),
        other => panic!("expected selecting-providers, got {other:?}"),
    }
}

fn set(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|s| s.to_string()).collect()
}

fn entry(api_key: Option<&str>, base_url: Option<&str>, model: Option<&str>) -> ProviderEntry {
    ProviderEntry {
        api_key: api_key.map(Into::into),
        base_url: base_url.map(Into::into),
        model: model.map(Into::into),
    }
}

/// Toggles `names`, submits, and feeds the fixture.
fn after_fetch(names: &[&str]) -> ProviderWizardState {
    let mut s = ProviderWizardState::new();
    for name in names {
        s = toggle(s, name);
    }
    s = reduce(s, Action::SubmitProviders);
    reduce(s, Action::ModelsFetched(fixture()))
}

fn state_at_model() -> ProviderWizardState {
    let s = after_fetch(&["anthropic"]);
    let s = reduce(s, Action::KeyChange("sk-ant".into()));
    reduce(s, Action::SubmitKey)
}

#[test]
fn initial_state_is_an_empty_selection() {
    let s = ProviderWizardState::new();
    assert_eq!(s.models_data, None);
    assert!(s.picked_providers.is_empty());
    assert!(s.built_entries.is_empty());
    assert_eq!(s.default_provider, None);
    assert_eq!(s.loop_index, 0);
    assert_eq!(
        s.screen,
        ProviderScreen::SelectingProviders {
            checked: BTreeSet::new()
        }
    );
}

#[test]
fn toggle_adds_and_removes_names() {
    let s = toggle(ProviderWizardState::new(), "anthropic");
    assert_eq!(checked(&s), set(&["anthropic"]));
    let s = toggle(s, "openai");
    assert_eq!(checked(&s), set(&["anthropic", "openai"]));
    let s = toggle(s, "anthropic");
    assert_eq!(checked(&s), set(&["openai"]));
}

#[test]
fn submit_with_empty_selection_is_a_no_op() {
    let s = ProviderWizardState::new();
    let next = reduce(s.clone(), Action::SubmitProviders);
    assert_eq!(next, s);
}

#[test]
fn submit_orders_picks_by_registry_order_api_then_cli() {
    let s = toggle(ProviderWizardState::new(), "claude-code");
    let s = toggle(s, "openai");
    let s = toggle(s, "anthropic");
    let s = reduce(s, Action::SubmitProviders);
    assert_eq!(s.picked_providers, ["anthropic", "openai", "claude-code"]);
    assert_eq!(s.screen.tag(), ScreenTag::LoadingModels);
}

#[test]
fn models_fetched_opens_the_first_providers_first_screen() {
    let s = after_fetch(&["anthropic"]);
    assert_eq!(s.models_data, Some(fixture()));
    assert_eq!(
        s.screen,
        ProviderScreen::EnteringKey {
            provider: "anthropic".into(),
            draft: String::new()
        }
    );
}

#[test]
fn models_fetched_outside_loading_is_ignored() {
    let s = ProviderWizardState::new();
    let next = reduce(s.clone(), Action::ModelsFetched(fixture()));
    assert_eq!(next, s);
}

#[test]
fn ollama_skips_the_key_screen() {
    let s = after_fetch(&["ollama"]);
    match &s.screen {
        ProviderScreen::PickingModel {
            provider,
            models,
            cursor,
        } => {
            assert_eq!(provider, "ollama");
            assert_eq!(
                models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
                ["llama3.2"]
            );
            assert_eq!(*cursor, 0);
        }
        other => panic!("expected picking-model, got {other:?}"),
    }
}

#[test]
fn claude_code_jumps_to_the_disclaimer() {
    let s = after_fetch(&["claude-code"]);
    assert_eq!(
        s.screen,
        ProviderScreen::Disclaimer {
            provider: "claude-code".into()
        }
    );
}

#[test]
fn key_change_updates_the_draft() {
    let s = after_fetch(&["anthropic"]);
    let s = reduce(s, Action::KeyChange("sk-ant-abc".into()));
    assert_eq!(
        s.screen,
        ProviderScreen::EnteringKey {
            provider: "anthropic".into(),
            draft: "sk-ant-abc".into()
        }
    );
}

#[test]
fn submit_key_with_blank_draft_is_a_no_op() {
    let s = after_fetch(&["anthropic"]);
    assert_eq!(reduce(s.clone(), Action::SubmitKey), s);
    let s = reduce(s, Action::KeyChange("   ".into()));
    let next = reduce(s, Action::SubmitKey);
    assert_eq!(next.screen.tag(), ScreenTag::EnteringKey);
}

#[test]
fn submit_key_stores_the_trimmed_key_and_opens_the_recommended_model_picker() {
    let s = after_fetch(&["anthropic"]);
    let s = reduce(s, Action::KeyChange("  sk-ant-abc\n".into()));
    let s = reduce(s, Action::SubmitKey);
    assert_eq!(
        s.built_entries["anthropic"].api_key.as_deref(),
        Some("sk-ant-abc")
    );
    match &s.screen {
        ProviderScreen::PickingModel {
            provider,
            models,
            cursor,
        } => {
            assert_eq!(provider, "anthropic");
            assert_eq!(models[0].id, "claude-sonnet-4-6");
            assert!(models[0].recommended);
            assert_eq!(*cursor, 0);
        }
        other => panic!("expected picking-model, got {other:?}"),
    }
}

#[test]
fn move_cursor_clamps_to_the_model_list() {
    let cursor = |s: &ProviderWizardState| match &s.screen {
        ProviderScreen::PickingModel { cursor, .. } => *cursor,
        other => panic!("expected picking-model, got {other:?}"),
    };
    let s = reduce(state_at_model(), Action::MoveCursor(-5));
    assert_eq!(cursor(&s), 0);
    let s = reduce(s, Action::MoveCursor(1));
    assert_eq!(cursor(&s), 1);
    let s = reduce(s, Action::MoveCursor(999));
    assert_eq!(cursor(&s), 1);
}

#[test]
fn move_cursor_elsewhere_is_ignored() {
    let s = after_fetch(&["anthropic"]);
    assert_eq!(reduce(s.clone(), Action::MoveCursor(1)), s);
}

#[test]
fn submit_model_on_the_only_provider_finishes_with_it_as_default() {
    let s = reduce(state_at_model(), Action::SubmitModel);
    assert_eq!(s.screen, ProviderScreen::Done);
    assert_eq!(s.default_provider.as_deref(), Some("anthropic"));
    assert_eq!(
        s.built_entries["anthropic"],
        entry(Some("sk-ant"), None, Some("claude-sonnet-4-6"))
    );
}

#[test]
fn ollama_entry_carries_the_registry_base_url() {
    let s = reduce(after_fetch(&["ollama"]), Action::SubmitModel);
    assert_eq!(
        s.built_entries["ollama"],
        entry(None, Some("http://localhost:11434/v1"), Some("llama3.2"))
    );
}

#[test]
fn openrouter_entry_carries_base_url_key_and_model() {
    let data = json!({
        "openrouter": { "id": "openrouter", "models": {
            "some/model": model("some/model", "2026-01-01"),
        }},
    });
    let s = toggle(ProviderWizardState::new(), "openrouter");
    let s = reduce(s, Action::SubmitProviders);
    let s = reduce(s, Action::ModelsFetched(data));
    let s = reduce(s, Action::KeyChange("sk-or-v1-abc".into()));
    let s = reduce(s, Action::SubmitKey);
    let s = reduce(s, Action::SubmitModel);
    assert_eq!(
        s.built_entries["openrouter"],
        entry(
            Some("sk-or-v1-abc"),
            Some("https://openrouter.ai/api/v1"),
            Some("some/model")
        )
    );
}

#[test]
fn submit_model_with_no_models_is_a_no_op() {
    let data = json!({ "groq": { "id": "groq", "models": {} } });
    let s = toggle(ProviderWizardState::new(), "groq");
    let s = reduce(s, Action::SubmitProviders);
    let s = reduce(s, Action::ModelsFetched(data));
    let s = reduce(s, Action::KeyChange("gsk".into()));
    let s = reduce(s, Action::SubmitKey);
    assert_eq!(s.screen.tag(), ScreenTag::PickingModel);
    assert_eq!(reduce(s.clone(), Action::SubmitModel), s);
}

#[test]
fn two_providers_loop_then_pick_a_default() {
    let s = after_fetch(&["anthropic", "openai"]);
    let s = reduce(s, Action::KeyChange("sk-ant".into()));
    let s = reduce(s, Action::SubmitKey);
    let s = reduce(s, Action::SubmitModel);
    assert_eq!(
        s.screen,
        ProviderScreen::EnteringKey {
            provider: "openai".into(),
            draft: String::new()
        }
    );
    assert_eq!(s.loop_index, 1);

    let s = reduce(s, Action::KeyChange("sk-openai".into()));
    let s = reduce(s, Action::SubmitKey);
    let s = reduce(s, Action::SubmitModel);
    assert_eq!(s.screen, ProviderScreen::PickingDefault { cursor: 0 });

    let s = reduce(s, Action::MoveCursor(1));
    assert_eq!(s.screen, ProviderScreen::PickingDefault { cursor: 1 });
    let s = reduce(s, Action::MoveCursor(5));
    assert_eq!(s.screen, ProviderScreen::PickingDefault { cursor: 1 });
    let s = reduce(s, Action::SubmitDefault);
    assert_eq!(s.default_provider.as_deref(), Some("openai"));
    assert_eq!(s.screen, ProviderScreen::Done);
    assert_eq!(
        s.built_entries.keys().collect::<Vec<_>>(),
        ["anthropic", "openai"]
    );
}

#[test]
fn accept_disclaimer_writes_an_empty_entry_and_advances() {
    let s = reduce(after_fetch(&["claude-code"]), Action::AcceptDisclaimer);
    assert_eq!(s.built_entries["claude-code"], ProviderEntry::default());
    assert_eq!(s.screen, ProviderScreen::Done);
    assert_eq!(s.default_provider.as_deref(), Some("claude-code"));
}

#[test]
fn skip_disclaimer_on_the_only_pick_returns_to_an_empty_selection() {
    let s = reduce(after_fetch(&["claude-code"]), Action::SkipDisclaimer);
    assert_eq!(
        s.screen,
        ProviderScreen::SelectingProviders {
            checked: BTreeSet::new()
        }
    );
    assert!(s.picked_providers.is_empty());
    assert!(!s.built_entries.contains_key("claude-code"));
}

#[test]
fn skip_disclaimer_at_the_end_of_a_long_loop_opens_the_default_picker() {
    let s = after_fetch(&["anthropic", "claude-code", "openai"]);
    let s = reduce(s, Action::KeyChange("sk-ant".into()));
    let s = reduce(s, Action::SubmitKey);
    let s = reduce(s, Action::SubmitModel);
    let s = reduce(s, Action::KeyChange("sk-o".into()));
    let s = reduce(s, Action::SubmitKey);
    let s = reduce(s, Action::SubmitModel);
    assert_eq!(
        s.screen,
        ProviderScreen::Disclaimer {
            provider: "claude-code".into()
        }
    );
    let s = reduce(s, Action::SkipDisclaimer);
    assert_eq!(s.picked_providers, ["anthropic", "openai"]);
    assert_eq!(s.screen, ProviderScreen::PickingDefault { cursor: 0 });
}

#[test]
fn skip_disclaimer_mid_loop_advances_to_the_next_survivor() {
    let s = after_fetch(&["anthropic", "claude-code"]);
    let s = reduce(s, Action::KeyChange("sk-ant".into()));
    let s = reduce(s, Action::SubmitKey);
    let s = reduce(s, Action::SubmitModel);
    assert_eq!(s.screen.tag(), ScreenTag::Disclaimer);
    let s = reduce(s, Action::SkipDisclaimer);
    assert_eq!(s.picked_providers, ["anthropic"]);
    assert_eq!(s.screen, ProviderScreen::Done);
    assert_eq!(s.default_provider.as_deref(), Some("anthropic"));
}

#[test]
fn actions_on_the_wrong_screen_are_ignored() {
    let s = ProviderWizardState::new();
    for action in [
        Action::SubmitKey,
        Action::SubmitModel,
        Action::AcceptDisclaimer,
        Action::SkipDisclaimer,
        Action::SubmitDefault,
        Action::KeyChange("x".into()),
    ] {
        assert_eq!(reduce(s.clone(), action), s);
    }
    let loading = reduce(toggle(s, "anthropic"), Action::SubmitProviders);
    assert_eq!(
        reduce(loading.clone(), Action::ToggleProvider("openai".into())),
        loading
    );
}
