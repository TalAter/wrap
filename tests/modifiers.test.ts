import { describe, expect, test } from "bun:test";
import { extractModifiers, parseArgs } from "../src/core/input.ts";

describe("extractModifiers", () => {
  test("no args returns empty modifiers and empty remaining", () => {
    const result = extractModifiers([]);
    expect(result.modifiers).toEqual({ verbose: false });
    expect(result.remaining).toEqual([]);
  });

  test("--verbose is extracted from leading position", () => {
    const result = extractModifiers(["--verbose", "find", "files"]);
    expect(result.modifiers).toEqual({ verbose: true });
    expect(result.remaining).toEqual(["find", "files"]);
  });

  test("--verbose alone", () => {
    const result = extractModifiers(["--verbose"]);
    expect(result.modifiers).toEqual({ verbose: true });
    expect(result.remaining).toEqual([]);
  });

  test("--verbose before a flag", () => {
    const result = extractModifiers(["--verbose", "--help"]);
    expect(result.modifiers).toEqual({ verbose: true });
    expect(result.remaining).toEqual(["--help"]);
  });

  test("non-modifier args pass through unchanged", () => {
    const result = extractModifiers(["find", "all", "files"]);
    expect(result.modifiers).toEqual({ verbose: false });
    expect(result.remaining).toEqual(["find", "all", "files"]);
  });

  test("--verbose in non-leading position is not extracted", () => {
    const result = extractModifiers(["find", "--verbose", "files"]);
    expect(result.modifiers).toEqual({ verbose: false });
    expect(result.remaining).toEqual(["find", "--verbose", "files"]);
  });

  test("flag in leading position stops modifier extraction", () => {
    const result = extractModifiers(["--help", "--verbose"]);
    expect(result.modifiers).toEqual({ verbose: false });
    expect(result.remaining).toEqual(["--help", "--verbose"]);
  });

  test("prompt word in leading position stops modifier extraction", () => {
    const result = extractModifiers(["hello", "--verbose"]);
    expect(result.modifiers).toEqual({ verbose: false });
    expect(result.remaining).toEqual(["hello", "--verbose"]);
  });
});

describe("parseArgs", () => {
  const argv = (...args: string[]) => ["bun", "src/index.ts", ...args];

  test("--verbose + prompt", () => {
    const { modifiers, input } = parseArgs(argv("--verbose", "find", "files"));
    expect(modifiers).toEqual({ verbose: true });
    expect(input).toEqual({ type: "prompt", prompt: "find files" });
  });

  test("--verbose + flag", () => {
    const { modifiers, input } = parseArgs(argv("--verbose", "--help"));
    expect(modifiers).toEqual({ verbose: true });
    expect(input).toEqual({ type: "flag", flag: "--help", args: [] });
  });

  test("--verbose alone returns none", () => {
    const { modifiers, input } = parseArgs(argv("--verbose"));
    expect(modifiers).toEqual({ verbose: true });
    expect(input).toEqual({ type: "none" });
  });

  test("no args", () => {
    const { modifiers, input } = parseArgs(argv());
    expect(modifiers).toEqual({ verbose: false });
    expect(input).toEqual({ type: "none" });
  });

  test("plain prompt without modifier", () => {
    const { modifiers, input } = parseArgs(argv("list", "files"));
    expect(modifiers).toEqual({ verbose: false });
    expect(input).toEqual({ type: "prompt", prompt: "list files" });
  });
});
