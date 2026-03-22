import { describe, expect, test } from "bun:test";
import { runProbes, PROBE_COMMANDS, parseDetectedTools } from "../src/memory/init-probes.ts";

describe("PROBE_COMMANDS", () => {
  test("is a non-empty array of {label, command} entries", () => {
    expect(PROBE_COMMANDS.length).toBeGreaterThan(0);
    for (const probe of PROBE_COMMANDS) {
      expect(typeof probe.label).toBe("string");
      expect(typeof probe.command).toBe("string");
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

  test("each probe section has label and output", () => {
    const output = runProbes();
    for (const probe of PROBE_COMMANDS) {
      expect(output).toContain(`## ${probe.label}`);
    }
  });
});

describe("parseDetectedTools", () => {
  test("extracts tool basenames from which output", () => {
    const whichOutput = "/usr/bin/git\n/usr/local/bin/docker\n/opt/homebrew/bin/node";
    const tools = parseDetectedTools(whichOutput);
    expect(tools).toEqual(["git", "docker", "node"]);
  });

  test("skips 'not found' lines", () => {
    const whichOutput = "/usr/bin/git\nkubectl not found\n/usr/bin/curl";
    const tools = parseDetectedTools(whichOutput);
    expect(tools).toEqual(["git", "curl"]);
  });

  test("returns empty array for empty input", () => {
    expect(parseDetectedTools("")).toEqual([]);
  });

  test("skips blank lines", () => {
    const whichOutput = "/usr/bin/git\n\n\n/usr/bin/curl";
    const tools = parseDetectedTools(whichOutput);
    expect(tools).toEqual(["git", "curl"]);
  });
});
