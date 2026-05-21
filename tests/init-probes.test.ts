import { describe, expect, test } from "bun:test";
import { CLIPBOARD_PASTE_TOOLS, CLIPBOARD_TOOLS } from "../src/core/clipboard.ts";
import { PROBED_TOOLS, probeTools } from "../src/discovery/init-probes.ts";

describe("PROBED_TOOLS", () => {
  test("includes every clipboard tool (copy + paste)", () => {
    for (const tool of [...CLIPBOARD_TOOLS, ...CLIPBOARD_PASTE_TOOLS]) {
      expect(PROBED_TOOLS).toContain(tool);
    }
  });
});

describe("probeTools", () => {
  function probe() {
    const result = probeTools();
    if (!result) throw new Error("probeTools() returned null unexpectedly");
    return result;
  }

  test("returns structured data with available and unavailable arrays", () => {
    const result = probe();
    expect(Array.isArray(result.available)).toBe(true);
    expect(Array.isArray(result.unavailable)).toBe(true);
  });

  test("every probed tool appears in either available or unavailable", () => {
    const result = probe();
    const all = [...result.available, ...result.unavailable];
    for (const tool of PROBED_TOOLS) {
      const found = all.some((entry) => entry.endsWith(`/${tool}`) || entry === tool);
      expect(found).toBe(true);
    }
  });

  test("available entries are full paths", () => {
    const result = probe();
    const gitEntry = result.available.find((p) => p.endsWith("/git"));
    expect(gitEntry).toBeDefined();
    expect(gitEntry).toMatch(/^\//);
  });

  test("unavailable entries are bare tool names", () => {
    const result = probe();
    const unlikely = ["wl-copy", "wl-paste", "pacman", "dnf", "yum"];
    const hasMissing = unlikely.some((t) => result.unavailable.includes(t));
    expect(hasMissing).toBe(true);
  });

  test("returns non-null on a normal system", () => {
    expect(probeTools()).not.toBeNull();
  });

  test("unavailable excludes tools that are installed", () => {
    const result = probe();
    expect(result.unavailable).not.toContain("bun");
  });

  test("extraTools are included in results", () => {
    // "thistooldoesnotexist" won't be installed anywhere
    const result = probeTools(["thistooldoesnotexist"]);
    if (!result) throw new Error("probeTools() returned null unexpectedly");
    expect(result.unavailable).toContain("thistooldoesnotexist");
  });

  test("extraTools deduplicates with default tools", () => {
    const result = probeTools(["git"]);
    if (!result) throw new Error("probeTools() returned null unexpectedly");
    // git should appear exactly once in available (not duplicated)
    const gitPaths = result.available.filter((p) => p.endsWith("/git"));
    expect(gitPaths.length).toBe(1);
  });

  test("extraTools with invalid names are silently dropped", () => {
    const result = probeTools(["; rm -rf /", "valid-tool", "$(whoami)", ""]);
    if (!result) throw new Error("probeTools() returned null unexpectedly");
    // Malicious strings should not appear in either list
    const all = [...result.available, ...result.unavailable];
    expect(all).not.toContain("; rm -rf /");
    expect(all).not.toContain("$(whoami)");
    expect(all).not.toContain("");
    // valid-tool should be in unavailable (not installed)
    expect(result.unavailable).toContain("valid-tool");
  });

  test("rejects tool names whose prefix contains shell metacharacters", () => {
    // The validation regex must reject the entire string, not just match
    // somewhere inside it. A name like "; legit" has an alphanumeric suffix
    // but a leading shell metacharacter — letting it through would interpolate
    // `;` directly into `which $tools 2>&1`, ending the `which` call and
    // running an attacker-controlled command after it.
    const result = probeTools(["; legit"]);
    if (!result) throw new Error("probeTools() returned null unexpectedly");
    const all = [...result.available, ...result.unavailable];
    expect(all).not.toContain("; legit");
  });
});
