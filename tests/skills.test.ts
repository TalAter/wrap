import { beforeAll, describe, expect, test } from "bun:test";
import { runSkills, type Skill } from "../src/skills/index.ts";
import { seedTestConfig } from "./helpers.ts";

beforeAll(() => seedTestConfig());

describe("Trigger matching", () => {
  test("always trigger matches every prompt", async () => {
    const skill: Skill = {
      name: "s",
      trigger: { kind: "always" },
      tasks: () => [{ command: "echo hi", run: async () => ({ output: "hi", exitCode: 0 }) }],
    };
    const turns = await runSkills([skill], "anything");
    expect(turns).toHaveLength(1);
  });

  test("match trigger fires when pattern matches the prompt", async () => {
    const skill: Skill = {
      name: "s",
      trigger: { kind: "match", pattern: /foo/i },
      tasks: () => [{ command: "echo hi", run: async () => ({ output: "hi", exitCode: 0 }) }],
    };
    const turns = await runSkills([skill], "FOO bar");
    expect(turns).toHaveLength(1);
  });

  test("match trigger skips skill when pattern doesn't match", async () => {
    const skill: Skill = {
      name: "s",
      trigger: { kind: "match", pattern: /foo/i },
      tasks: () => [{ command: "echo hi", run: async () => ({ output: "hi", exitCode: 0 }) }],
    };
    const turns = await runSkills([skill], "baz");
    expect(turns).toEqual([]);
  });
});

describe("Task emission", () => {
  test("successful task emits a single probe turn", async () => {
    const skill: Skill = {
      name: "discovery",
      trigger: { kind: "always" },
      tasks: () => [{ command: "echo hi", run: async () => ({ output: "hi", exitCode: 0 }) }],
    };
    const turns = await runSkills([skill], "anything");
    expect(turns).toHaveLength(1);
    const probe = turns[0];
    if (probe?.kind !== "probe") throw new Error("expected probe turn");
    expect(probe.skill).toBe("discovery");
    expect(probe.command).toBe("echo hi");
    expect(probe.output).toBe("hi");
  });

  test("task with non-zero exitCode drops the pair silently", async () => {
    const skill: Skill = {
      name: "s",
      trigger: { kind: "always" },
      tasks: () => [{ command: "echo hi", run: async () => ({ output: "oops", exitCode: 1 }) }],
    };
    const turns = await runSkills([skill], "anything");
    expect(turns).toEqual([]);
  });

  test("task whose `run` returns null drops the pair silently", async () => {
    const skill: Skill = {
      name: "s",
      trigger: { kind: "always" },
      tasks: () => [{ command: "echo hi", run: async () => null }],
    };
    const turns = await runSkills([skill], "anything");
    expect(turns).toEqual([]);
  });

  test("task whose `run` throws drops the pair silently", async () => {
    const skill: Skill = {
      name: "s",
      trigger: { kind: "always" },
      tasks: () => [
        {
          command: "echo hi",
          run: async () => {
            throw new Error("boom");
          },
        },
      ],
    };
    const turns = await runSkills([skill], "anything");
    expect(turns).toEqual([]);
  });
});

describe("Shell exec (no `run`)", () => {
  test("runs the command and captures stdout", async () => {
    const skill: Skill = {
      name: "s",
      trigger: { kind: "always" },
      tasks: () => [{ command: "echo hi" }],
    };
    const turns = await runSkills([skill], "anything");
    expect(turns).toHaveLength(1);
    const probe = turns[0];
    if (probe?.kind !== "probe") throw new Error("expected probe");
    expect(probe.output).toContain("hi");
  });

  test("stderr is appended when command writes to both streams", async () => {
    const skill: Skill = {
      name: "s",
      trigger: { kind: "always" },
      tasks: () => [{ command: "echo out && echo err >&2" }],
    };
    const turns = await runSkills([skill], "anything");
    expect(turns).toHaveLength(1);
    const probe = turns[0];
    if (probe?.kind !== "probe") throw new Error("expected probe");
    expect(probe.output).toContain("out");
    expect(probe.output).toContain("err");
  });

  test("non-zero exit (e.g. `false`) drops the pair silently", async () => {
    const skill: Skill = {
      name: "s",
      trigger: { kind: "always" },
      tasks: () => [{ command: "false" }],
    };
    const turns = await runSkills([skill], "anything");
    expect(turns).toEqual([]);
  });

  test("command exceeding the 1s timeout is killed and drops the pair", async () => {
    const skill: Skill = {
      name: "s",
      trigger: { kind: "always" },
      tasks: () => [{ command: "sleep 5" }],
    };
    const start = performance.now();
    const turns = await runSkills([skill], "anything");
    const elapsed = performance.now() - start;
    expect(turns).toEqual([]);
    expect(elapsed).toBeLessThan(1500);
  });

  test("TS `run` task exceeding the 1s timeout drops the pair", async () => {
    const skill: Skill = {
      name: "s",
      trigger: { kind: "always" },
      tasks: () => [
        {
          command: "slow",
          run: () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ output: "late", exitCode: 0 }), 5000);
            }),
        },
      ],
    };
    const start = performance.now();
    const turns = await runSkills([skill], "anything");
    const elapsed = performance.now() - start;
    expect(turns).toEqual([]);
    expect(elapsed).toBeLessThan(1500);
  });
});

describe("Trigger × ordering interaction", () => {
  test("non-matching skills are filtered without disturbing the order of matching ones", async () => {
    const a: Skill = {
      name: "a",
      trigger: { kind: "always" },
      tasks: () => [{ command: "a", run: async () => ({ output: "a-out", exitCode: 0 }) }],
    };
    const b: Skill = {
      name: "b",
      trigger: { kind: "match", pattern: /nope/ },
      tasks: () => [{ command: "b", run: async () => ({ output: "b-out", exitCode: 0 }) }],
    };
    const c: Skill = {
      name: "c",
      trigger: { kind: "always" },
      tasks: () => [{ command: "c", run: async () => ({ output: "c-out", exitCode: 0 }) }],
    };
    const turns = await runSkills([a, b, c], "anything");
    expect(turns.map((t) => t.command)).toEqual(["a", "c"]);
  });
});

describe("Ordering", () => {
  test("emits probes in skill order, then task order within each skill", async () => {
    const skillA: Skill = {
      name: "a",
      trigger: { kind: "always" },
      tasks: () => [
        { command: "a1", run: async () => ({ output: "a1-out", exitCode: 0 }) },
        { command: "a2", run: async () => ({ output: "a2-out", exitCode: 0 }) },
      ],
    };
    const skillB: Skill = {
      name: "b",
      trigger: { kind: "always" },
      tasks: () => [{ command: "b1", run: async () => ({ output: "b1-out", exitCode: 0 }) }],
    };
    const turns = await runSkills([skillA, skillB], "anything");
    expect(turns).toHaveLength(3);
    expect(turns.map((t) => t.command)).toEqual(["a1", "a2", "b1"]);
    expect(turns.map((t) => t.skill)).toEqual(["a", "a", "b"]);
  });
});
