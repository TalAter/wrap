import { describe, expect, test } from "bun:test";
import { parseInput } from "../src/core/input.ts";

describe("parseInput", () => {
  test("no args returns type none", () => {
    const input = parseInput([]);
    expect(input).toEqual({ type: "none" });
  });

  test("joins args into prompt", () => {
    const input = parseInput(["find", "all", "files"]);
    expect(input).toEqual({ type: "prompt", prompt: "find all files" });
  });

  test("single arg becomes prompt", () => {
    const input = parseInput(["hello"]);
    expect(input).toEqual({ type: "prompt", prompt: "hello" });
  });

  test("first arg with -- prefix returns flag type", () => {
    const input = parseInput(["--log"]);
    expect(input).toEqual({ type: "flag", flag: "--log", args: [] });
  });

  test("flag with one argument", () => {
    const input = parseInput(["--log", "3"]);
    expect(input).toEqual({ type: "flag", flag: "--log", args: ["3"] });
  });

  test("flag with multiple arguments", () => {
    const input = parseInput(["--log", "symlink to", "10"]);
    expect(input).toEqual({ type: "flag", flag: "--log", args: ["symlink to", "10"] });
  });

  test("secondary --flags are collected as args", () => {
    const input = parseInput(["--log", "--raw"]);
    expect(input).toEqual({ type: "flag", flag: "--log", args: ["--raw"] });
  });

  test("mixed args and secondary flags", () => {
    const input = parseInput(["--log", "term", "--raw"]);
    expect(input).toEqual({ type: "flag", flag: "--log", args: ["term", "--raw"] });
  });

  test("-- in non-first position is natural language", () => {
    const input = parseInput(["find", "files", "with", "--verbose"]);
    expect(input).toEqual({
      type: "prompt",
      prompt: "find files with --verbose",
    });
  });

  test("flag with hyphenated name", () => {
    const input = parseInput(["--log-pretty"]);
    expect(input).toEqual({ type: "flag", flag: "--log-pretty", args: [] });
  });

  test("single-dash letter is parsed as flag", () => {
    const input = parseInput(["-h"]);
    expect(input).toEqual({ type: "flag", flag: "-h", args: [] });
  });

  test("single-dash flag passes through remaining args", () => {
    const input = parseInput(["-h", "--log"]);
    expect(input).toEqual({ type: "flag", flag: "-h", args: ["--log"] });
  });

  test("multi-char single-dash is also a flag", () => {
    const input = parseInput(["-rf", "foo"]);
    expect(input).toEqual({ type: "flag", flag: "-rf", args: ["foo"] });
  });
});
