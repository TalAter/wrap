import { describe, expect, test } from "bun:test";
import {
  applyRecommendation,
  filterAndSortModels,
  type ModelsDevData,
} from "../src/wizard/models-filter.ts";

const BASE_MODEL = {
  tool_call: true as const,
  modalities: { input: ["text"], output: ["text"] },
  release_date: "2024-01-01",
};

const DATA: ModelsDevData = {
  anthropic: {
    id: "anthropic",
    models: {
      "claude-sonnet-4-6": {
        ...BASE_MODEL,
        id: "claude-sonnet-4-6",
        release_date: "2026-03-01",
      },
      "claude-sonnet-4-5": {
        ...BASE_MODEL,
        id: "claude-sonnet-4-5",
        release_date: "2025-09-01",
      },
      "claude-haiku-4-5": {
        ...BASE_MODEL,
        id: "claude-haiku-4-5",
        release_date: "2025-11-01",
      },
      "claude-opus-4-6": {
        ...BASE_MODEL,
        id: "claude-opus-4-6",
        release_date: "2026-02-15",
      },
      "claude-no-tools": {
        ...BASE_MODEL,
        id: "claude-no-tools",
        tool_call: false,
        release_date: "2026-03-02",
      },
      "claude-deprecated": {
        ...BASE_MODEL,
        id: "claude-deprecated",
        status: "deprecated",
        release_date: "2026-03-03",
      },
      "claude-image-only": {
        ...BASE_MODEL,
        id: "claude-image-only",
        modalities: { input: ["image"], output: ["text"] },
      },
      "claude-no-text-out": {
        ...BASE_MODEL,
        id: "claude-no-text-out",
        modalities: { input: ["text"], output: ["audio"] },
      },
    },
  },
  openai: {
    id: "openai",
    models: {
      "gpt-5": { ...BASE_MODEL, id: "gpt-5", release_date: "2026-01-01" },
      "gpt-5.1": { ...BASE_MODEL, id: "gpt-5.1", release_date: "2026-04-01" },
      "gpt-4o": { ...BASE_MODEL, id: "gpt-4o", release_date: "2024-05-01" },
    },
  },
  ollama: {
    id: "ollama",
    models: {
      "llama3.2": { ...BASE_MODEL, id: "llama3.2", release_date: "2024-10-01" },
    },
  },
};

describe("filterAndSortModels", () => {
  test("drops deprecated, non-tool_call, and non-text-modality models", () => {
    const result = filterAndSortModels(DATA, "anthropic");
    const ids = result.map((m) => m.id);
    expect(ids).not.toContain("claude-no-tools");
    expect(ids).not.toContain("claude-deprecated");
    expect(ids).not.toContain("claude-image-only");
    expect(ids).not.toContain("claude-no-text-out");
  });

  test("sorts by release_date descending (newest first)", () => {
    const result = filterAndSortModels(DATA, "anthropic");
    expect(result.map((m) => m.id)).toEqual([
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "claude-haiku-4-5",
      "claude-sonnet-4-5",
    ]);
  });

  test("returns empty array for provider not in data", () => {
    expect(filterAndSortModels(DATA, "doesnotexist")).toEqual([]);
  });

  test("returns empty array for provider with no models", () => {
    const empty: ModelsDevData = { foo: { id: "foo", models: {} } };
    expect(filterAndSortModels(empty, "foo")).toEqual([]);
  });

  test("drops model with undefined modalities without throwing", () => {
    const data: ModelsDevData = {
      test: {
        id: "test",
        models: {
          "no-modalities": {
            id: "no-modalities",
            tool_call: true,
            release_date: "2026-01-01",
          },
        },
      },
    };
    expect(() => filterAndSortModels(data, "test")).not.toThrow();
    expect(filterAndSortModels(data, "test")).toEqual([]);
  });

  test("sorts model with undefined release_date after dated models", () => {
    const data: ModelsDevData = {
      test: {
        id: "test",
        models: {
          dated: {
            id: "dated",
            tool_call: true,
            modalities: { input: ["text"], output: ["text"] },
            release_date: "2026-04-01",
          },
          undated: {
            id: "undated",
            tool_call: true,
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    };
    const result = filterAndSortModels(data, "test");
    expect(result.map((m) => m.id)).toEqual(["dated", "undated"]);
  });

  test("drops models with tool_call undefined (missing from wire)", () => {
    const data: ModelsDevData = {
      test: {
        id: "test",
        models: {
          "no-tool-call": {
            id: "no-tool-call",
            modalities: { input: ["text"], output: ["text"] },
            release_date: "2026-01-01",
          },
        },
      },
    };
    expect(filterAndSortModels(data, "test")).toEqual([]);
  });
});

describe("applyRecommendation", () => {
  test("no regex → returns list unchanged, nothing marked", () => {
    const sorted = filterAndSortModels(DATA, "anthropic");
    const result = applyRecommendation(sorted, undefined);
    expect(result).toEqual(sorted);
    expect(result.some((m) => m.recommended)).toBe(false);
  });

  test("regex matches nothing → list unchanged, nothing marked", () => {
    const sorted = filterAndSortModels(DATA, "anthropic");
    const result = applyRecommendation(sorted, /^gemini-/);
    expect(result.map((m) => m.id)).toEqual(sorted.map((m) => m.id));
    expect(result.some((m) => m.recommended)).toBe(false);
  });

  test("regex matches one → promoted to top and marked", () => {
    const sorted = filterAndSortModels(DATA, "anthropic");
    const result = applyRecommendation(sorted, /^claude-opus-\d+-\d+$/);
    expect(result[0]?.id).toBe("claude-opus-4-6");
    expect(result[0]?.recommended).toBe(true);
    expect(result.slice(1).some((m) => m.recommended)).toBe(false);
  });

  test("regex matches multiple → newest is promoted to top and marked", () => {
    const sorted = filterAndSortModels(DATA, "anthropic");
    const result = applyRecommendation(sorted, /^claude-sonnet-\d+-\d+$/);
    // claude-sonnet-4-6 (2026-03-01) is newer than claude-sonnet-4-5 (2025-09-01)
    expect(result[0]?.id).toBe("claude-sonnet-4-6");
    expect(result[0]?.recommended).toBe(true);
    // claude-sonnet-4-5 stays in its release_date position, no marker
    const fourFive = result.find((m) => m.id === "claude-sonnet-4-5");
    expect(fourFive?.recommended).toBe(false);
  });

  test("non-matching models retain their release_date order", () => {
    const sorted = filterAndSortModels(DATA, "anthropic");
    const result = applyRecommendation(sorted, /^claude-opus-\d+-\d+$/);
    // after promotion: [opus, then the rest in release_date order minus opus]
    expect(result.map((m) => m.id)).toEqual([
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "claude-sonnet-4-5",
    ]);
  });

  test("empty input → empty output", () => {
    expect(applyRecommendation([], /^anything$/)).toEqual([]);
  });
});
