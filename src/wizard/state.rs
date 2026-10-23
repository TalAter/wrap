//! The provider section's state machine: a pure reducer over a tagged
//! screen. Linear flow, no back navigation: select providers → load models
//! → per-provider loop (key → model, or CLI disclaimer) → default picker
//! when more than one survived.

use std::collections::{BTreeMap, BTreeSet};

use crate::config::ProviderEntry;
use crate::config::providers::{
    API_PROVIDERS, CLI_PROVIDERS, api_provider, is_cli_provider, provider_needs_api_key,
};

use super::models_dev::{ModelEntry, ModelsDevData, apply_recommendation, filter_and_sort_models};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScreenTag {
    SelectingProviders,
    LoadingModels,
    EnteringKey,
    PickingModel,
    Disclaimer,
    PickingDefault,
    Done,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderScreen {
    SelectingProviders {
        checked: BTreeSet<String>,
    },
    LoadingModels,
    EnteringKey {
        provider: String,
        draft: String,
    },
    PickingModel {
        provider: String,
        models: Vec<ModelEntry>,
        cursor: usize,
    },
    Disclaimer {
        provider: String,
    },
    PickingDefault {
        cursor: usize,
    },
    Done,
}

impl ProviderScreen {
    pub fn tag(&self) -> ScreenTag {
        match self {
            Self::SelectingProviders { .. } => ScreenTag::SelectingProviders,
            Self::LoadingModels => ScreenTag::LoadingModels,
            Self::EnteringKey { .. } => ScreenTag::EnteringKey,
            Self::PickingModel { .. } => ScreenTag::PickingModel,
            Self::Disclaimer { .. } => ScreenTag::Disclaimer,
            Self::PickingDefault { .. } => ScreenTag::PickingDefault,
            Self::Done => ScreenTag::Done,
        }
    }

    /// The provider a per-loop screen is about.
    pub fn provider(&self) -> Option<&str> {
        match self {
            Self::EnteringKey { provider, .. }
            | Self::PickingModel { provider, .. }
            | Self::Disclaimer { provider } => Some(provider),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderWizardState {
    pub models_data: Option<ModelsDevData>,
    /// Selected providers in registry order; the loop walks these.
    pub picked_providers: Vec<String>,
    pub built_entries: BTreeMap<String, ProviderEntry>,
    pub default_provider: Option<String>,
    pub loop_index: usize,
    pub screen: ProviderScreen,
}

impl Default for ProviderWizardState {
    fn default() -> Self {
        Self::new()
    }
}

impl ProviderWizardState {
    pub fn new() -> Self {
        Self {
            models_data: None,
            picked_providers: Vec::new(),
            built_entries: BTreeMap::new(),
            default_provider: None,
            loop_index: 0,
            screen: ProviderScreen::SelectingProviders {
                checked: BTreeSet::new(),
            },
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    ToggleProvider(String),
    SubmitProviders,
    ModelsFetched(ModelsDevData),
    KeyChange(String),
    SubmitKey,
    MoveCursor(isize),
    SubmitModel,
    AcceptDisclaimer,
    SkipDisclaimer,
    SubmitDefault,
}

/// API providers in registry order, then CLI providers.
fn order_selection(checked: &BTreeSet<String>) -> Vec<String> {
    API_PROVIDERS
        .iter()
        .map(|p| p.name)
        .chain(CLI_PROVIDERS.iter().map(|p| p.name))
        .filter(|name| checked.contains(*name))
        .map(str::to_string)
        .collect()
}

fn compute_models(data: &ModelsDevData, provider: &str) -> Vec<ModelEntry> {
    let filtered = filter_and_sort_models(data, provider);
    apply_recommendation(
        filtered,
        api_provider(provider).and_then(|p| p.recommended_model_regex),
    )
}

/// A config entry for `provider`: CLI providers are empty; API providers
/// carry the registry's baseURL when it has one, plus whatever was entered.
fn build_entry(provider: &str, api_key: Option<&str>, model: Option<&str>) -> ProviderEntry {
    if is_cli_provider(provider) {
        return ProviderEntry::default();
    }
    ProviderEntry {
        api_key: api_key.filter(|k| !k.is_empty()).map(str::to_string),
        base_url: api_provider(provider)
            .and_then(|p| p.base_url)
            .map(str::to_string),
        model: model.filter(|m| !m.is_empty()).map(str::to_string),
    }
}

fn first_screen_for(provider: &str, data: &ModelsDevData) -> ProviderScreen {
    if is_cli_provider(provider) {
        return ProviderScreen::Disclaimer {
            provider: provider.to_string(),
        };
    }
    if provider_needs_api_key(provider) {
        return ProviderScreen::EnteringKey {
            provider: provider.to_string(),
            draft: String::new(),
        };
    }
    ProviderScreen::PickingModel {
        provider: provider.to_string(),
        models: compute_models(data, provider),
        cursor: 0,
    }
}

fn advance_loop(mut state: ProviderWizardState) -> ProviderWizardState {
    let next = state.loop_index + 1;
    if next >= state.picked_providers.len() {
        return finish_loop(state, next);
    }
    let Some(data) = &state.models_data else {
        return state;
    };
    let screen = first_screen_for(&state.picked_providers[next], data);
    state.loop_index = next;
    state.screen = screen;
    state
}

fn finish_loop(mut state: ProviderWizardState, next: usize) -> ProviderWizardState {
    state.loop_index = next;
    if state.picked_providers.len() == 1 {
        state.default_provider = state.picked_providers.first().cloned();
        state.screen = ProviderScreen::Done;
    } else {
        state.screen = ProviderScreen::PickingDefault { cursor: 0 };
    }
    state
}

fn clamp_cursor(cursor: usize, delta: isize, len: usize) -> usize {
    let moved = (cursor as isize).saturating_add(delta).max(0) as usize;
    moved.min(len.saturating_sub(1))
}

/// Applies `action`; actions that do not fit the current screen leave the
/// state unchanged.
pub fn reduce(mut state: ProviderWizardState, action: Action) -> ProviderWizardState {
    match (action, &mut state.screen) {
        (Action::ToggleProvider(name), ProviderScreen::SelectingProviders { checked }) => {
            if !checked.remove(&name) {
                checked.insert(name);
            }
            state
        }
        (Action::SubmitProviders, ProviderScreen::SelectingProviders { checked }) => {
            if checked.is_empty() {
                return state;
            }
            state.picked_providers = order_selection(checked);
            state.loop_index = 0;
            state.screen = ProviderScreen::LoadingModels;
            state
        }
        (Action::ModelsFetched(data), ProviderScreen::LoadingModels) => {
            let Some(first) = state.picked_providers.first() else {
                return state;
            };
            state.screen = first_screen_for(first, &data);
            state.models_data = Some(data);
            state
        }
        (Action::KeyChange(text), ProviderScreen::EnteringKey { draft, .. }) => {
            *draft = text;
            state
        }
        (Action::SubmitKey, ProviderScreen::EnteringKey { provider, draft }) => {
            let trimmed = draft.trim().to_string();
            let provider = provider.clone();
            let Some(data) = &state.models_data else {
                return state;
            };
            if trimmed.is_empty() {
                return state;
            }
            let models = compute_models(data, &provider);
            state.built_entries.insert(
                provider.clone(),
                build_entry(&provider, Some(&trimmed), None),
            );
            state.screen = ProviderScreen::PickingModel {
                provider,
                models,
                cursor: 0,
            };
            state
        }
        (Action::MoveCursor(delta), ProviderScreen::PickingModel { models, cursor, .. }) => {
            *cursor = clamp_cursor(*cursor, delta, models.len());
            state
        }
        (Action::MoveCursor(delta), ProviderScreen::PickingDefault { cursor }) => {
            *cursor = clamp_cursor(*cursor, delta, state.picked_providers.len());
            state
        }
        (
            Action::SubmitModel,
            ProviderScreen::PickingModel {
                provider,
                models,
                cursor,
            },
        ) => {
            let Some(picked) = models.get(*cursor) else {
                return state;
            };
            let provider = provider.clone();
            let model = picked.id.clone();
            // Providers without a key screen have no entry yet.
            let mut entry = state
                .built_entries
                .remove(&provider)
                .unwrap_or_else(|| build_entry(&provider, None, None));
            entry.model = Some(model);
            state.built_entries.insert(provider, entry);
            advance_loop(state)
        }
        (Action::AcceptDisclaimer, ProviderScreen::Disclaimer { provider }) => {
            let provider = provider.clone();
            state
                .built_entries
                .insert(provider, ProviderEntry::default());
            advance_loop(state)
        }
        (Action::SkipDisclaimer, ProviderScreen::Disclaimer { provider }) => {
            let dropped = provider.clone();
            let picked: Vec<String> = state
                .picked_providers
                .iter()
                .filter(|p| **p != dropped)
                .cloned()
                .collect();
            if picked.is_empty() {
                // Dropping the only selection bounces back to the first screen.
                state.picked_providers = Vec::new();
                state.loop_index = 0;
                state.screen = ProviderScreen::SelectingProviders {
                    checked: BTreeSet::new(),
                };
                return state;
            }
            // The loop index pointed at the dropped provider; after filtering
            // it points at what used to be next, or past the end.
            let next = state.loop_index;
            if next >= picked.len() {
                state.picked_providers = picked;
                return finish_loop(state, next);
            }
            let Some(data) = &state.models_data else {
                return state;
            };
            let screen = first_screen_for(&picked[next], data);
            state.picked_providers = picked;
            state.screen = screen;
            state
        }
        (Action::SubmitDefault, ProviderScreen::PickingDefault { cursor }) => {
            let Some(picked) = state.picked_providers.get(*cursor) else {
                return state;
            };
            state.default_provider = Some(picked.clone());
            state.screen = ProviderScreen::Done;
            state
        }
        _ => state,
    }
}
