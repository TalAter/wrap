import { describe, expect, test } from "bun:test";
import { parseInput } from "../src/core/input.ts";

describe("parseInput", () => {
  test("returns null prompt when no args", () => {
    const input = parseInput(["bun", "src/index.ts"]);
    expect(input.prompt).toBeNull();
  });

  test("joins args into prompt string", () => {
    const input = parseInput(["bun", "src/index.ts", "find", "all", "files"]);
    expect(input.prompt).toBe("find all files");
  });

  test("single arg becomes prompt", () => {
    const input = parseInput(["bun", "src/index.ts", "hello"]);
    expect(input.prompt).toBe("hello");
  });
});
