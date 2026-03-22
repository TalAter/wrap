import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { getWrapHome } from "../src/core/home.ts";

describe("getWrapHome", () => {
  test("returns WRAP_HOME when set", () => {
    expect(getWrapHome({ WRAP_HOME: "/custom/path" })).toBe("/custom/path");
  });

  test("falls back to ~/.wrap when WRAP_HOME is unset", () => {
    expect(getWrapHome({})).toBe(join(homedir(), ".wrap"));
  });

  test("falls back to ~/.wrap when WRAP_HOME is undefined", () => {
    expect(getWrapHome({ WRAP_HOME: undefined })).toBe(join(homedir(), ".wrap"));
  });

  test("falls back to ~/.wrap when WRAP_HOME is empty string", () => {
    expect(getWrapHome({ WRAP_HOME: "" })).toBe(join(homedir(), ".wrap"));
  });
});
