import { describe, expect, test } from "bun:test";
import { parseInput } from "../src/core/input.ts";

describe("parseInput", () => {
  test("no args returns type none", () => {
    const input = parseInput(["bun", "src/index.ts"]);
    expect(input).toEqual({ type: "none" });
  });

  test("joins args into prompt", () => {
    const input = parseInput(["bun", "src/index.ts", "find", "all", "files"]);
    expect(input).toEqual({ type: "prompt", prompt: "find all files" });
  });

  test("single arg becomes prompt", () => {
    const input = parseInput(["bun", "src/index.ts", "hello"]);
    expect(input).toEqual({ type: "prompt", prompt: "hello" });
  });

  test("first arg with -- prefix returns flag type", () => {
    const input = parseInput(["bun", "src/index.ts", "--log"]);
    expect(input).toEqual({ type: "flag", flag: "--log", arg: null });
  });

  test("flag with argument captures next token", () => {
    const input = parseInput(["bun", "src/index.ts", "--log", "3"]);
    expect(input).toEqual({ type: "flag", flag: "--log", arg: "3" });
  });

  test("-- in non-first position is natural language", () => {
    const input = parseInput(["bun", "src/index.ts", "find", "files", "with", "--verbose"]);
    expect(input).toEqual({
      type: "prompt",
      prompt: "find files with --verbose",
    });
  });

  test("flag with hyphenated name", () => {
    const input = parseInput(["bun", "src/index.ts", "--log-pretty"]);
    expect(input).toEqual({ type: "flag", flag: "--log-pretty", arg: null });
  });
});
