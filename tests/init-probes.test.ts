import { describe, expect, test } from "bun:test";
import { PROBE_COMMANDS, PROBED_TOOLS, probeTools, runProbes } from "../src/memory/init-probes.ts";

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
  test("returns a non-empty string", () => {
    const output = probeTools();
    expect(output.length).toBeGreaterThan(0);
  });

  test("every probed tool appears in output (found or not found)", () => {
    const output = probeTools();
    for (const tool of PROBED_TOOLS) {
      expect(output).toContain(tool);
    }
  });

  test("missing tools have 'not found' in output", () => {
    const output = probeTools();
    // At least one of these exotic tools should be missing on any dev machine
    const unlikely = ["wl-copy", "wl-paste", "pacman", "dnf", "yum"];
    const hasMissing = unlikely.some((t) => output.includes(`${t} not found`));
    expect(hasMissing).toBe(true);
  });

  test("found tools show a path", () => {
    const output = probeTools();
    // git should be installed on any dev machine
    expect(output).toMatch(/\/.*git/);
  });
});
