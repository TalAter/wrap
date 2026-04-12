import { describe, expect, test } from "bun:test";
import type { ModelsDevData } from "../src/wizard/models-filter.ts";
import { initWizardState, reduce, type WizardState } from "../src/wizard/state.ts";

const FIXTURE: ModelsDevData = {
  anthropic: {
    id: "anthropic",
    models: {
      "claude-sonnet-4-6": {
        id: "claude-sonnet-4-6",
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
        release_date: "2026-03-01",
      },
      "claude-haiku-4-5": {
        id: "claude-haiku-4-5",
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
        release_date: "2025-11-01",
      },
    },
  },
  openai: {
    id: "openai",
    models: {
      "gpt-5": {
        id: "gpt-5",
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
        release_date: "2026-01-01",
      },
    },
  },
  ollama: {
    id: "ollama",
    models: {
      "llama3.2": {
        id: "llama3.2",
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
        release_date: "2024-10-01",
      },
    },
  },
};

function screenTag(state: WizardState) {
  return state.screen.tag;
}

describe("initWizardState", () => {
  test("returns empty-selection screen", () => {
    const state = initWizardState();
    expect(state.modelsData).toBeNull();
    expect(state.pickedProviders).toEqual([]);
    expect(state.builtEntries).toEqual({});
    expect(state.defaultProvider).toBeNull();
    expect(state.loopIndex).toBe(0);
    expect(state.screen).toEqual({ tag: "selecting-providers", checked: new Set() });
  });
});

describe("reduce — selecting-providers", () => {
  test("toggle adds and removes names from the checked set", () => {
    let s = initWizardState();
    s = reduce(s, { type: "toggle-provider", name: "anthropic" });
    expect(s.screen).toEqual({
      tag: "selecting-providers",
      checked: new Set(["anthropic"]),
    });
    s = reduce(s, { type: "toggle-provider", name: "openai" });
    expect((s.screen as { checked: Set<string> }).checked).toEqual(
      new Set(["anthropic", "openai"]),
    );
    s = reduce(s, { type: "toggle-provider", name: "anthropic" });
    expect((s.screen as { checked: Set<string> }).checked).toEqual(new Set(["openai"]));
  });

  test("submit with empty selection is a no-op", () => {
    const s = initWizardState();
    const next = reduce(s, { type: "submit-providers" });
    expect(next).toBe(s);
  });

  test("submit orders picks by API_PROVIDERS order then CLI_PROVIDERS", () => {
    let s = initWizardState();
    s = reduce(s, { type: "toggle-provider", name: "claude-code" });
    s = reduce(s, { type: "toggle-provider", name: "openai" });
    s = reduce(s, { type: "toggle-provider", name: "anthropic" });
    s = reduce(s, { type: "submit-providers" });
    // anthropic before openai (API order), claude-code last
    expect(s.pickedProviders).toEqual(["anthropic", "openai", "claude-code"]);
    expect(screenTag(s)).toBe("loading-models");
  });
});

describe("reduce — models-fetched", () => {
  test("advances into the first provider's first screen (entering-key for anthropic)", () => {
    let s = initWizardState();
    s = reduce(s, { type: "toggle-provider", name: "anthropic" });
    s = reduce(s, { type: "submit-providers" });
    s = reduce(s, { type: "models-fetched", data: FIXTURE });
    expect(s.modelsData).toBe(FIXTURE);
    expect(s.screen).toEqual({ tag: "entering-key", provider: "anthropic", draft: "" });
  });

  test("ollama skips the key screen and jumps straight to picking-model", () => {
    let s = initWizardState();
    s = reduce(s, { type: "toggle-provider", name: "ollama" });
    s = reduce(s, { type: "submit-providers" });
    s = reduce(s, { type: "models-fetched", data: FIXTURE });
    expect(screenTag(s)).toBe("picking-model");
    if (s.screen.tag === "picking-model") {
      expect(s.screen.provider).toBe("ollama");
      expect(s.screen.models.map((m) => m.id)).toEqual(["llama3.2"]);
    }
  });

  test("claude-code jumps to disclaimer", () => {
    let s = initWizardState();
    s = reduce(s, { type: "toggle-provider", name: "claude-code" });
    s = reduce(s, { type: "submit-providers" });
    s = reduce(s, { type: "models-fetched", data: FIXTURE });
    expect(s.screen).toEqual({ tag: "disclaimer", provider: "claude-code" });
  });
});

describe("reduce — entering-key", () => {
  function stateAtKey() {
    let s = initWizardState();
    s = reduce(s, { type: "toggle-provider", name: "anthropic" });
    s = reduce(s, { type: "submit-providers" });
    s = reduce(s, { type: "models-fetched", data: FIXTURE });
    return s;
  }

  test("key-change updates draft", () => {
    let s = stateAtKey();
    s = reduce(s, { type: "key-change", draft: "sk-ant-abc" });
    if (s.screen.tag === "entering-key") {
      expect(s.screen.draft).toBe("sk-ant-abc");
    } else {
      throw new Error("wrong screen");
    }
  });

  test("submit-key with empty draft is a no-op", () => {
    const s = stateAtKey();
    const next = reduce(s, { type: "submit-key" });
    expect(next).toBe(s);
  });

  test("submit-key with whitespace-only draft is a no-op", () => {
    let s = stateAtKey();
    s = reduce(s, { type: "key-change", draft: "   " });
    const next = reduce(s, { type: "submit-key" });
    expect(screenTag(next)).toBe("entering-key");
  });

  test("submit-key stores trimmed key and transitions to picking-model", () => {
    let s = stateAtKey();
    s = reduce(s, { type: "key-change", draft: "  sk-ant-abc\n" });
    s = reduce(s, { type: "submit-key" });
    expect(screenTag(s)).toBe("picking-model");
    expect(s.builtEntries.anthropic?.apiKey).toBe("sk-ant-abc");
    if (s.screen.tag === "picking-model") {
      expect(s.screen.provider).toBe("anthropic");
      // Recommendation applied: claude-sonnet-4-6 promoted to top and marked
      expect(s.screen.models[0]?.id).toBe("claude-sonnet-4-6");
      expect(s.screen.models[0]?.recommended).toBe(true);
      expect(s.screen.cursor).toBe(0);
    }
  });
});

describe("reduce — picking-model", () => {
  function stateAtModel() {
    let s = initWizardState();
    s = reduce(s, { type: "toggle-provider", name: "anthropic" });
    s = reduce(s, { type: "submit-providers" });
    s = reduce(s, { type: "models-fetched", data: FIXTURE });
    s = reduce(s, { type: "key-change", draft: "sk-ant" });
    s = reduce(s, { type: "submit-key" });
    return s;
  }

  test("move-cursor clamps to [0, models.length - 1]", () => {
    let s = stateAtModel();
    s = reduce(s, { type: "move-cursor", delta: -5 });
    if (s.screen.tag === "picking-model") expect(s.screen.cursor).toBe(0);
    s = reduce(s, { type: "move-cursor", delta: 1 });
    if (s.screen.tag === "picking-model") expect(s.screen.cursor).toBe(1);
    s = reduce(s, { type: "move-cursor", delta: 999 });
    if (s.screen.tag === "picking-model") {
      expect(s.screen.cursor).toBe(s.screen.models.length - 1);
    }
  });

  test("submit-model on the only provider → done with defaultProvider set", () => {
    const s = reduce(stateAtModel(), { type: "submit-model" });
    expect(s.screen).toEqual({ tag: "done" });
    expect(s.defaultProvider).toBe("anthropic");
    expect(s.builtEntries.anthropic).toEqual({
      apiKey: "sk-ant",
      model: "claude-sonnet-4-6",
    });
  });

  test("ollama submit-model writes baseURL into the entry", () => {
    let s = initWizardState();
    s = reduce(s, { type: "toggle-provider", name: "ollama" });
    s = reduce(s, { type: "submit-providers" });
    s = reduce(s, { type: "models-fetched", data: FIXTURE });
    s = reduce(s, { type: "submit-model" });
    expect(s.builtEntries.ollama).toEqual({
      baseURL: "http://localhost:11434/v1",
      model: "llama3.2",
    });
  });
});

describe("reduce — multi-provider loop and default picker", () => {
  test("two providers → loop advances, then picking-default, then done", () => {
    let s = initWizardState();
    s = reduce(s, { type: "toggle-provider", name: "anthropic" });
    s = reduce(s, { type: "toggle-provider", name: "openai" });
    s = reduce(s, { type: "submit-providers" });
    s = reduce(s, { type: "models-fetched", data: FIXTURE });

    // anthropic flow
    s = reduce(s, { type: "key-change", draft: "sk-ant" });
    s = reduce(s, { type: "submit-key" });
    s = reduce(s, { type: "submit-model" });
    // advances to openai
    expect(s.screen).toEqual({ tag: "entering-key", provider: "openai", draft: "" });
    expect(s.loopIndex).toBe(1);

    // openai flow
    s = reduce(s, { type: "key-change", draft: "sk-openai" });
    s = reduce(s, { type: "submit-key" });
    s = reduce(s, { type: "submit-model" });
    // two providers → picking-default
    expect(screenTag(s)).toBe("picking-default");
    if (s.screen.tag === "picking-default") expect(s.screen.cursor).toBe(0);

    // pick openai as default
    s = reduce(s, { type: "move-cursor", delta: 1 });
    s = reduce(s, { type: "submit-default" });
    expect(s.defaultProvider).toBe("openai");
    expect(s.screen).toEqual({ tag: "done" });
    expect(Object.keys(s.builtEntries)).toEqual(["anthropic", "openai"]);
  });
});

describe("reduce — disclaimer", () => {
  test("accept-disclaimer writes an empty entry and advances", () => {
    let s = initWizardState();
    s = reduce(s, { type: "toggle-provider", name: "claude-code" });
    s = reduce(s, { type: "submit-providers" });
    s = reduce(s, { type: "models-fetched", data: FIXTURE });
    s = reduce(s, { type: "accept-disclaimer" });
    expect(s.builtEntries["claude-code"]).toEqual({});
    expect(s.screen).toEqual({ tag: "done" });
    expect(s.defaultProvider).toBe("claude-code");
  });

  test("skip-disclaimer with claude-code as only pick bounces back to selecting-providers", () => {
    let s = initWizardState();
    s = reduce(s, { type: "toggle-provider", name: "claude-code" });
    s = reduce(s, { type: "submit-providers" });
    s = reduce(s, { type: "models-fetched", data: FIXTURE });
    s = reduce(s, { type: "skip-disclaimer" });
    expect(s.screen).toEqual({ tag: "selecting-providers", checked: new Set() });
    expect(s.pickedProviders).toEqual([]);
    expect(s.builtEntries["claude-code"]).toBeUndefined();
  });

  test("skip-disclaimer mid-loop advances to the next survivor", () => {
    let s = initWizardState();
    s = reduce(s, { type: "toggle-provider", name: "anthropic" });
    s = reduce(s, { type: "toggle-provider", name: "claude-code" });
    s = reduce(s, { type: "toggle-provider", name: "openai" });
    s = reduce(s, { type: "submit-providers" });
    s = reduce(s, { type: "models-fetched", data: FIXTURE });

    // Walk through anthropic
    s = reduce(s, { type: "key-change", draft: "sk-ant" });
    s = reduce(s, { type: "submit-key" });
    s = reduce(s, { type: "submit-model" });
    // Walk through openai
    s = reduce(s, { type: "key-change", draft: "sk-o" });
    s = reduce(s, { type: "submit-key" });
    s = reduce(s, { type: "submit-model" });
    // Now at claude-code disclaimer; order is [anthropic, openai, claude-code]
    expect(s.screen).toEqual({ tag: "disclaimer", provider: "claude-code" });

    // Skip claude-code — loop ends, 2 providers → picking-default
    s = reduce(s, { type: "skip-disclaimer" });
    expect(s.pickedProviders).toEqual(["anthropic", "openai"]);
    expect(screenTag(s)).toBe("picking-default");
  });

  test("skip-disclaimer drops current provider and advances to next", () => {
    let s = initWizardState();
    s = reduce(s, { type: "toggle-provider", name: "anthropic" });
    s = reduce(s, { type: "toggle-provider", name: "claude-code" });
    s = reduce(s, { type: "submit-providers" });
    s = reduce(s, { type: "models-fetched", data: FIXTURE });

    // anthropic first
    s = reduce(s, { type: "key-change", draft: "sk-ant" });
    s = reduce(s, { type: "submit-key" });
    s = reduce(s, { type: "submit-model" });
    expect(s.screen).toEqual({ tag: "disclaimer", provider: "claude-code" });

    // skip claude-code → loop finishes with only anthropic → done
    s = reduce(s, { type: "skip-disclaimer" });
    expect(s.pickedProviders).toEqual(["anthropic"]);
    expect(s.screen).toEqual({ tag: "done" });
    expect(s.defaultProvider).toBe("anthropic");
  });
});
