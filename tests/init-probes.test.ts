import { describe, expect, test } from "bun:test";
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

  test("each probe section has label and output", () => {
    const output = runProbes();
    for (const probe of PROBE_COMMANDS) {
      expect(output).toContain(`## ${probe.label}`);
    }
  });
});

describe("PROBED_TOOLS", () => {
  test("includes clipboard tools", () => {
    expect(PROBED_TOOLS).toContain("pbcopy");
    expect(PROBED_TOOLS).toContain("pbpaste");
    expect(PROBED_TOOLS).toContain("xclip");
    expect(PROBED_TOOLS).toContain("xsel");
    expect(PROBED_TOOLS).toContain("wl-copy");
    expect(PROBED_TOOLS).toContain("wl-paste");
  });

  test("includes package managers", () => {
    expect(PROBED_TOOLS).toContain("brew");
  });

  test("includes core dev tools", () => {
    expect(PROBED_TOOLS).toContain("git");
    expect(PROBED_TOOLS).toContain("docker");
    expect(PROBED_TOOLS).toContain("node");
    expect(PROBED_TOOLS).toContain("bun");
    expect(PROBED_TOOLS).toContain("curl");
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
