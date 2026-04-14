import { describe, expect, test } from "bun:test";
import { extractModifiers, type ModifierSpec, parseArgs } from "../src/core/input.ts";

const SPECS: readonly ModifierSpec[] = [
  { name: "verbose", flags: ["--verbose"], takesValue: false },
  { name: "model", flags: ["--model", "--provider"], takesValue: true },
];

/** Test helper: build a Modifiers from plain literals. */
function mods(opts: { flags?: string[]; values?: Record<string, string> } = {}) {
  return {
    flags: new Set(opts.flags ?? []),
    values: new Map(Object.entries(opts.values ?? {})),
  };
}

describe("extractModifiers — boolean", () => {
  test("no args returns empty modifiers and empty remaining", () => {
    const result = extractModifiers([], SPECS);
    expect(result.modifiers).toEqual(mods());
    expect(result.remaining).toEqual([]);
  });

  test("--verbose is extracted from leading position", () => {
    const result = extractModifiers(["--verbose", "find", "files"], SPECS);
    expect(result.modifiers).toEqual(mods({ flags: ["verbose"] }));
    expect(result.remaining).toEqual(["find", "files"]);
  });

  test("--verbose alone", () => {
    const result = extractModifiers(["--verbose"], SPECS);
    expect(result.modifiers).toEqual(mods({ flags: ["verbose"] }));
    expect(result.remaining).toEqual([]);
  });

  test("--verbose before a flag", () => {
    const result = extractModifiers(["--verbose", "--help"], SPECS);
    expect(result.modifiers).toEqual(mods({ flags: ["verbose"] }));
    expect(result.remaining).toEqual(["--help"]);
  });

  test("non-modifier args pass through unchanged", () => {
    const result = extractModifiers(["find", "all", "files"], SPECS);
    expect(result.modifiers).toEqual(mods());
    expect(result.remaining).toEqual(["find", "all", "files"]);
  });

  test("--verbose in non-leading position is not extracted", () => {
    const result = extractModifiers(["find", "--verbose", "files"], SPECS);
    expect(result.modifiers).toEqual(mods());
    expect(result.remaining).toEqual(["find", "--verbose", "files"]);
  });

  test("flag in leading position stops modifier extraction", () => {
    const result = extractModifiers(["--help", "--verbose"], SPECS);
    expect(result.modifiers).toEqual(mods());
    expect(result.remaining).toEqual(["--help", "--verbose"]);
  });

  test("prompt word in leading position stops modifier extraction", () => {
    const result = extractModifiers(["hello", "--verbose"], SPECS);
    expect(result.modifiers).toEqual(mods());
    expect(result.remaining).toEqual(["hello", "--verbose"]);
  });

  test("--verbose=true (equals form on bool flag) → throws", () => {
    expect(() => extractModifiers(["--verbose=true", "find"], SPECS)).toThrow(
      "Config error: --verbose does not take a value.",
    );
  });
});

describe("extractModifiers — value-taking", () => {
  test("--model anthropic captures next arg as value", () => {
    const result = extractModifiers(["--model", "anthropic", "find", "files"], SPECS);
    expect(result.modifiers).toEqual(mods({ values: { model: "anthropic" } }));
    expect(result.remaining).toEqual(["find", "files"]);
  });

  test("--model=anthropic uses equals form", () => {
    const result = extractModifiers(["--model=anthropic", "find", "files"], SPECS);
    expect(result.modifiers).toEqual(mods({ values: { model: "anthropic" } }));
    expect(result.remaining).toEqual(["find", "files"]);
  });

  test("--provider is an alias mapping to the same key", () => {
    const result = extractModifiers(["--provider", "openai"], SPECS);
    expect(result.modifiers).toEqual(mods({ values: { model: "openai" } }));
    expect(result.remaining).toEqual([]);
  });

  test("--provider=openai equals form", () => {
    const result = extractModifiers(["--provider=openai", "do", "thing"], SPECS);
    expect(result.modifiers).toEqual(mods({ values: { model: "openai" } }));
    expect(result.remaining).toEqual(["do", "thing"]);
  });

  test("--verbose then --model combined", () => {
    const result = extractModifiers(["--verbose", "--model", "gpt-4o", "find", "files"], SPECS);
    expect(result.modifiers).toEqual(mods({ flags: ["verbose"], values: { model: "gpt-4o" } }));
    expect(result.remaining).toEqual(["find", "files"]);
  });

  test("--model then --verbose combined", () => {
    const result = extractModifiers(["--model", "gpt-4o", "--verbose", "find", "files"], SPECS);
    expect(result.modifiers).toEqual(mods({ flags: ["verbose"], values: { model: "gpt-4o" } }));
    expect(result.remaining).toEqual(["find", "files"]);
  });

  test("--model with provider:model value", () => {
    const result = extractModifiers(["--model", "anthropic:claude-opus-4-5", "hi"], SPECS);
    expect(result.modifiers).toEqual(mods({ values: { model: "anthropic:claude-opus-4-5" } }));
    expect(result.remaining).toEqual(["hi"]);
  });

  test("--model with empty quoted value", () => {
    const result = extractModifiers(["--model", "", "hi"], SPECS);
    expect(result.modifiers).toEqual(mods({ values: { model: "" } }));
    expect(result.remaining).toEqual(["hi"]);
  });

  test("--model= (equals form, empty value)", () => {
    const result = extractModifiers(["--model=", "hi"], SPECS);
    expect(result.modifiers).toEqual(mods({ values: { model: "" } }));
    expect(result.remaining).toEqual(["hi"]);
  });

  test("--model with no following arg → throws", () => {
    expect(() => extractModifiers(["--model"], SPECS)).toThrow(
      "Config error: --model requires a value.",
    );
  });

  test("--provider with no following arg → throws", () => {
    expect(() => extractModifiers(["--provider"], SPECS)).toThrow(
      "Config error: --provider requires a value.",
    );
  });

  test("--model followed by another known modifier flag → throws (not silent consume)", () => {
    expect(() => extractModifiers(["--model", "--verbose", "find"], SPECS)).toThrow(
      "Config error: --model requires a value.",
    );
  });

  test("--model in non-leading position is not extracted", () => {
    const result = extractModifiers(["find", "--model", "anthropic", "files"], SPECS);
    expect(result.modifiers).toEqual(mods());
    expect(result.remaining).toEqual(["find", "--model", "anthropic", "files"]);
  });

  test("--model=anthropic:claude-opus-4-5 (equals form, colon in value)", () => {
    const result = extractModifiers(["--model=anthropic:claude-opus-4-5", "hi"], SPECS);
    expect(result.modifiers).toEqual(mods({ values: { model: "anthropic:claude-opus-4-5" } }));
    expect(result.remaining).toEqual(["hi"]);
  });

  test("two value modifiers in a row → last wins", () => {
    const result = extractModifiers(["--model", "anthropic", "--provider", "openai", "go"], SPECS);
    expect(result.modifiers).toEqual(mods({ values: { model: "openai" } }));
    expect(result.remaining).toEqual(["go"]);
  });
});

describe("extractModifiers — generic spec contract", () => {
  test("empty specs → no modifiers extracted", () => {
    const result = extractModifiers(["--verbose", "find"], []);
    expect(result.modifiers).toEqual(mods());
    expect(result.remaining).toEqual(["--verbose", "find"]);
  });

  test("custom spec name and flag list works", () => {
    const customSpecs: ModifierSpec[] = [
      { name: "logLevel", flags: ["--log", "-l"], takesValue: true },
      { name: "dryRun", flags: ["--dry"], takesValue: false },
    ];
    const result = extractModifiers(["--dry", "-l", "debug", "go"], customSpecs);
    expect(result.modifiers).toEqual(mods({ flags: ["dryRun"], values: { logLevel: "debug" } }));
    expect(result.remaining).toEqual(["go"]);
  });
});

describe("parseArgs", () => {
  const argv = (...args: string[]) => ["bun", "src/index.ts", ...args];

  test("--verbose + prompt", () => {
    const { modifiers, input } = parseArgs(argv("--verbose", "find", "files"), SPECS);
    expect(modifiers).toEqual(mods({ flags: ["verbose"] }));
    expect(input).toEqual({ type: "prompt", prompt: "find files" });
  });

  test("--verbose + flag", () => {
    const { modifiers, input } = parseArgs(argv("--verbose", "--help"), SPECS);
    expect(modifiers).toEqual(mods({ flags: ["verbose"] }));
    expect(input).toEqual({ type: "flag", flag: "--help", args: [] });
  });

  test("--verbose alone returns none", () => {
    const { modifiers, input } = parseArgs(argv("--verbose"), SPECS);
    expect(modifiers).toEqual(mods({ flags: ["verbose"] }));
    expect(input).toEqual({ type: "none" });
  });

  test("no args", () => {
    const { modifiers, input } = parseArgs(argv(), SPECS);
    expect(modifiers).toEqual(mods());
    expect(input).toEqual({ type: "none" });
  });

  test("plain prompt without modifier", () => {
    const { modifiers, input } = parseArgs(argv("list", "files"), SPECS);
    expect(modifiers).toEqual(mods());
    expect(input).toEqual({ type: "prompt", prompt: "list files" });
  });

  test("--model + prompt", () => {
    const { modifiers, input } = parseArgs(argv("--model", "anthropic", "find", "files"), SPECS);
    expect(modifiers).toEqual(mods({ values: { model: "anthropic" } }));
    expect(input).toEqual({ type: "prompt", prompt: "find files" });
  });
});
