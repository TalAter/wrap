import { describe, expect, test } from "bun:test";
import { PROBE_COMMANDS, runProbes } from "../src/memory/memory-init-probes.ts";

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
  test("returns labeled sections for every probe", () => {
    const output = runProbes();
    for (const probe of PROBE_COMMANDS) {
      expect(output).toContain(`## ${probe.label}`);
    }
  });
});
