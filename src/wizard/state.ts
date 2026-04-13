import type { ProviderEntry } from "../config/config.ts";
import {
  API_PROVIDERS,
  CLI_PROVIDERS,
  isCliProvider,
  providerNeedsApiKey,
} from "../llm/providers/registry.ts";
import {
  applyRecommendation,
  filterAndSortModels,
  type ModelEntry,
  type ModelsDevData,
} from "./models-filter.ts";

export type ProviderScreen =
  | { tag: "selecting-providers"; checked: Set<string> }
  | { tag: "loading-models" }
  | { tag: "entering-key"; provider: string; draft: string }
  | { tag: "picking-model"; provider: string; models: ModelEntry[]; cursor: number }
  | { tag: "disclaimer"; provider: string }
  | { tag: "picking-default"; cursor: number }
  | { tag: "done" };

export type ProviderWizardState = {
  modelsData: ModelsDevData | null;
  pickedProviders: string[];
  builtEntries: Record<string, ProviderEntry>;
  defaultProvider: string | null;
  loopIndex: number;
  screen: ProviderScreen;
};

export type ProviderWizardAction =
  | { type: "toggle-provider"; name: string }
  | { type: "submit-providers" }
  | { type: "models-fetched"; data: ModelsDevData }
  | { type: "key-change"; draft: string }
  | { type: "submit-key" }
  | { type: "move-cursor"; delta: number }
  | { type: "submit-model" }
  | { type: "accept-disclaimer" }
  | { type: "skip-disclaimer" }
  | { type: "submit-default" };

export function initProviderWizardState(): ProviderWizardState {
  return {
    modelsData: null,
    pickedProviders: [],
    builtEntries: {},
    defaultProvider: null,
    loopIndex: 0,
    screen: { tag: "selecting-providers", checked: new Set() },
  };
}

function orderSelection(checked: Set<string>): string[] {
  const ordered: string[] = [];
  for (const name of Object.keys(API_PROVIDERS)) if (checked.has(name)) ordered.push(name);
  for (const name of Object.keys(CLI_PROVIDERS)) if (checked.has(name)) ordered.push(name);
  return ordered;
}

function computeModels(data: ModelsDevData, provider: string): ModelEntry[] {
  const filtered = filterAndSortModels(data, provider);
  return applyRecommendation(filtered, API_PROVIDERS[provider]?.recommendedModelRegex);
}

function buildEntry(provider: string, fields: { apiKey?: string; model?: string }): ProviderEntry {
  if (isCliProvider(provider)) return {};
  const entry: ProviderEntry = {};
  const baseURL = API_PROVIDERS[provider]?.baseURL;
  if (baseURL) entry.baseURL = baseURL;
  if (fields.apiKey) entry.apiKey = fields.apiKey;
  if (fields.model) entry.model = fields.model;
  return entry;
}

function firstScreenFor(provider: string, data: ModelsDevData): ProviderScreen {
  if (isCliProvider(provider)) return { tag: "disclaimer", provider };
  if (providerNeedsApiKey(provider)) return { tag: "entering-key", provider, draft: "" };
  return { tag: "picking-model", provider, models: computeModels(data, provider), cursor: 0 };
}

function advanceLoop(state: ProviderWizardState): ProviderWizardState {
  const nextIdx = state.loopIndex + 1;
  if (nextIdx >= state.pickedProviders.length) return finishLoop(state, nextIdx);
  const nextName = state.pickedProviders[nextIdx];
  if (!nextName || !state.modelsData) return state;
  return { ...state, loopIndex: nextIdx, screen: firstScreenFor(nextName, state.modelsData) };
}

function finishLoop(state: ProviderWizardState, nextIdx: number): ProviderWizardState {
  if (state.pickedProviders.length === 1) {
    return {
      ...state,
      loopIndex: nextIdx,
      defaultProvider: state.pickedProviders[0] ?? null,
      screen: { tag: "done" },
    };
  }
  return { ...state, loopIndex: nextIdx, screen: { tag: "picking-default", cursor: 0 } };
}

function clampCursor(cursor: number, length: number): number {
  return Math.max(0, Math.min(length - 1, cursor));
}

export function reduce(
  state: ProviderWizardState,
  action: ProviderWizardAction,
): ProviderWizardState {
  const { screen } = state;

  switch (action.type) {
    case "toggle-provider": {
      if (screen.tag !== "selecting-providers") return state;
      const checked = new Set(screen.checked);
      if (checked.has(action.name)) checked.delete(action.name);
      else checked.add(action.name);
      return { ...state, screen: { tag: "selecting-providers", checked } };
    }

    case "submit-providers": {
      if (screen.tag !== "selecting-providers") return state;
      if (screen.checked.size === 0) return state;
      return {
        ...state,
        pickedProviders: orderSelection(screen.checked),
        loopIndex: 0,
        screen: { tag: "loading-models" },
      };
    }

    case "models-fetched": {
      if (screen.tag !== "loading-models") return state;
      const first = state.pickedProviders[0];
      if (!first) return state;
      return {
        ...state,
        modelsData: action.data,
        screen: firstScreenFor(first, action.data),
      };
    }

    case "key-change": {
      if (screen.tag !== "entering-key") return state;
      return { ...state, screen: { ...screen, draft: action.draft } };
    }

    case "submit-key": {
      if (screen.tag !== "entering-key") return state;
      const trimmed = screen.draft.trim();
      if (!trimmed || !state.modelsData) return state;
      return {
        ...state,
        builtEntries: {
          ...state.builtEntries,
          [screen.provider]: buildEntry(screen.provider, { apiKey: trimmed }),
        },
        screen: {
          tag: "picking-model",
          provider: screen.provider,
          models: computeModels(state.modelsData, screen.provider),
          cursor: 0,
        },
      };
    }

    case "move-cursor": {
      if (screen.tag === "picking-model") {
        return {
          ...state,
          screen: {
            ...screen,
            cursor: clampCursor(screen.cursor + action.delta, screen.models.length),
          },
        };
      }
      if (screen.tag === "picking-default") {
        return {
          ...state,
          screen: {
            ...screen,
            cursor: clampCursor(screen.cursor + action.delta, state.pickedProviders.length),
          },
        };
      }
      return state;
    }

    case "submit-model": {
      if (screen.tag !== "picking-model") return state;
      const picked = screen.models[screen.cursor];
      if (!picked) return state;
      // ollama skips entering-key, so there's no prior entry to merge into.
      const prev = state.builtEntries[screen.provider] ?? buildEntry(screen.provider, {});
      return advanceLoop({
        ...state,
        builtEntries: {
          ...state.builtEntries,
          [screen.provider]: { ...prev, model: picked.id },
        },
      });
    }

    case "accept-disclaimer": {
      if (screen.tag !== "disclaimer") return state;
      return advanceLoop({
        ...state,
        builtEntries: { ...state.builtEntries, [screen.provider]: {} },
      });
    }

    case "skip-disclaimer": {
      if (screen.tag !== "disclaimer") return state;
      const dropped = screen.provider;
      const picked = state.pickedProviders.filter((p) => p !== dropped);
      if (picked.length === 0) {
        // Dropping the only selection: bounce back to Screen 1.
        return {
          ...state,
          pickedProviders: [],
          loopIndex: 0,
          screen: { tag: "selecting-providers", checked: new Set() },
        };
      }
      // loopIndex pointed at `dropped`; after filtering, the same index now
      // points to what was previously the next entry. If we were already at
      // the end (dropped was the last), the loop has finished.
      const nextIdx = state.loopIndex;
      if (nextIdx >= picked.length) {
        return finishLoop({ ...state, pickedProviders: picked, loopIndex: nextIdx - 1 }, nextIdx);
      }
      if (!state.modelsData) return state;
      const nextName = picked[nextIdx];
      if (!nextName) return state;
      return {
        ...state,
        pickedProviders: picked,
        screen: firstScreenFor(nextName, state.modelsData),
      };
    }

    case "submit-default": {
      if (screen.tag !== "picking-default") return state;
      const picked = state.pickedProviders[screen.cursor];
      if (!picked) return state;
      return { ...state, defaultProvider: picked, screen: { tag: "done" } };
    }
  }
}
