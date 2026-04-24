import { describe, expect, test } from "bun:test";
import { CLIPBOARD_PASTE_TOOLS, CLIPBOARD_TOOLS } from "../src/core/clipboard.ts";
import {
  PROBE_COMMANDS,
  PROBED_TOOLS,
  probeTools,
  runProbes,
} from "../src/discovery/init-probes.ts";

describe("PROBE_COMMANDS", () => {
  test("is a non-empty array of {label, command} entries", () => {
    expect(PROBE_COMMANDS.length).toBeGreaterThan(0);
    for (const probe of PROBE_COMMANDS) {
      expect(typeof probe.label).toBe("string");
      expect(typeof probe.command).toBe("string");
    }
  });

  test("does not include Core tools or Package manager", () => {
    const labels = PROBE_COMMANDS.map((p) => p.label);
    expect(labels).not.toContain("Core tools");
    expect(labels).not.toContain("Package manager");
  });
});

describe("PROBED_TOOLS", () => {
  test("includes every clipboard tool (copy + paste)", () => {
    for (const tool of [...CLIPBOARD_TOOLS, ...CLIPBOARD_PASTE_TOOLS]) {
      expect(PROBED_TOOLS).toContain(tool);
    }
  });
});

describe("runProbes", () => {
  test("returns a non-empty string with probe output", () => {
    const output = runProbes();
    expect(output.length).toBeGreaterThan(0);
  });

  test("includes OS label in output", () => {
    const output = runProbes();
    expect(output).toContain("## OS");
  });

  test("includes Shell label in output", () => {
    const output = runProbes();
    expect(output).toContain("## Shell");
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
});
