import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { prettyPath, resolvePath } from "../src/core/paths.ts";

describe("resolvePath", () => {
  test("resolves ~ to homedir", () => {
    const result = resolvePath("~");
    expect(result).toBe(homedir());
  });

  test("resolves ~/ to homedir", () => {
    const result = resolvePath("~/");
    expect(result).toBe(homedir());
  });

  test("resolves . to process.cwd()", () => {
    const result = resolvePath(".");
    expect(result).not.toBeNull();
    // realpathSync resolves symlinks, so compare against that
    const { realpathSync } = require("node:fs");
    expect(result).toBe(realpathSync(process.cwd()));
  });

  test("resolves relative path against cwd param", () => {
    const tmp = mkdtempSync(join(require("node:os").tmpdir(), "wrap-paths-test-"));
    const result = resolvePath(".", tmp);
    expect(result).toBe(require("node:fs").realpathSync(tmp));
  });

  test("returns null for non-existent path", () => {
    const result = resolvePath("/nonexistent/path/that/does/not/exist");
    expect(result).toBeNull();
  });

  test("returns null for non-existent relative path", () => {
    const result = resolvePath("./does-not-exist-at-all", "/tmp");
    expect(result).toBeNull();
  });

  test("resolves absolute path that exists", () => {
    const result = resolvePath("/tmp");
    expect(result).not.toBeNull();
    expect(result).toBe(require("node:fs").realpathSync("/tmp"));
  });

  test("ignores cwd param for absolute paths", () => {
    const result = resolvePath("/tmp", "/some/other/dir");
    expect(result).toBe(require("node:fs").realpathSync("/tmp"));
  });
});

describe("prettyPath", () => {
  const home = homedir();

  test("replaces homedir prefix with ~", () => {
    expect(prettyPath(`${home}/foo`)).toBe("~/foo");
  });

  test("replaces homedir itself with ~", () => {
    expect(prettyPath(home)).toBe("~");
  });

  test("does not replace paths not under homedir", () => {
    expect(prettyPath("/usr/local")).toBe("/usr/local");
  });

  test("does not replace partial homedir match", () => {
    // e.g. /Users/talbot should not match /Users/tal
    expect(prettyPath(`${home}extra/foo`)).toBe(`${home}extra/foo`);
  });

  test("returns / as-is", () => {
    expect(prettyPath("/")).toBe("/");
  });
});
