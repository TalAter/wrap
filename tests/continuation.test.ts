/**
 * Continuation (`-c` / `--continue`) end-to-end behavior.
 *
 * Drives the real binary via `Bun.spawn`, sharing a `WRAP_HOME` across a
 * parent + child invocation so the JSONL log links them via `parent_id`.
 *
 * Per-PPID scope and the global-newest fallback are unit-tested in
 * `tests/logging-lookup.test.ts` — cross-process PPID isolation can't be
 * simulated from inside a single test process.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type RunOpts = {
  wrapHome: string;
  cwd?: string;
  responses?: object[];
  stdin?: string;
  env?: Record<string, string>;
};

const REPO_ROOT = process.cwd();
const ENTRY = join(REPO_ROOT, "src/index.ts");

async function run(input: string, opts: RunOpts) {
  const args = input.split(" ").filter(Boolean);
  const { WRAP_TEMP_DIR: _drop, ...parentEnv } = process.env;
  const env: Record<string, string | undefined> = {
    ...parentEnv,
    WRAP_HOME: opts.wrapHome,
    WRAP_CONFIG: JSON.stringify({}),
    TMPDIR: mkdtempSync(join(tmpdir(), "wrap-continuation-tmp-")),
    ...opts.env,
  };
  if (opts.responses) env.WRAP_TEST_RESPONSES = JSON.stringify(opts.responses);
  const proc = Bun.spawn(["bun", "run", ENTRY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: new Blob([opts.stdin ?? ""]),
    cwd: opts.cwd,
    env: env as Record<string, string>,
  });
  const exitCode = await proc.exited;
  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "wrap-continuation-home-"));
  // Pre-seed memory so ensureMemory doesn't trigger an init round.
  writeFileSync(join(home, "memory.json"), '{"/":[{"fact":"test"}]}');
  return home;
}

function readEntries(wrapHome: string): Array<Record<string, unknown>> {
  const path = join(wrapHome, "logs", "wrap.jsonl");
  const content = readFileSync(path, "utf-8").trimEnd();
  if (!content) return [];
  return content.split("\n").map((l) => JSON.parse(l));
}

describe("continuation — basic chain", () => {
  test("child's parent_id points at parent; child's own turns are not duplicated", async () => {
    const wrapHome = freshHome();
    const parent = await run("how do I deploy", {
      wrapHome,
      responses: [{ type: "reply", content: "you run deploy.sh", risk_level: "low" }],
    });
    expect(parent.exitCode).toBe(0);

    const child = await run("-c ok do it", {
      wrapHome,
      responses: [{ type: "command", content: "echo deploying", risk_level: "low" }],
    });
    expect(child.exitCode).toBe(0);

    const [parentEntry, childEntry] = readEntries(wrapHome);
    expect(parentEntry).toBeDefined();
    expect(childEntry?.parent_id).toBe(parentEntry?.id as string);
    // Child stores only its own invocation's turns — chain walk is at replay
    // time, not write time. Probe turns filtered so this pins the model trajectory.
    const kinds = (childEntry?.turns as Array<{ kind: string }>)
      .filter((t) => t.kind !== "probe")
      .map((t) => t.kind);
    expect(kinds).toEqual(["user", "assistant", "final"]);
  });

  test("3-deep chain: each link stores only its own turns, parent_id walks the chain", async () => {
    const wrapHome = freshHome();
    await run("how do I deploy", {
      wrapHome,
      responses: [{ type: "reply", content: "deploy.sh", risk_level: "low" }],
    });
    await run("-c ok do it", {
      wrapHome,
      responses: [{ type: "command", content: "echo go", risk_level: "low" }],
    });
    await run("-c what about staging", {
      wrapHome,
      responses: [{ type: "command", content: "echo staging", risk_level: "low" }],
    });

    const entries = readEntries(wrapHome);
    expect(entries).toHaveLength(3);
    const [a, b, c] = entries;
    expect(b?.parent_id).toBe(a?.id as string);
    expect(c?.parent_id).toBe(b?.id as string);
    // Each link's own turns[] is only its invocation's turns — never accumulates.
    // Probe turns filtered so the structural count pins the model trajectory.
    const modelTurnCounts = entries.map(
      (e) => (e.turns as Array<{ kind: string }>).filter((t) => t.kind !== "probe").length,
    );
    expect(modelTurnCounts).toEqual([2, 3, 3]);
  });
});

describe("continuation — refusal", () => {
  test("empty log: exit 1 with Continue error", async () => {
    const wrapHome = freshHome();
    const child = await run("-c hi", {
      wrapHome,
      // Provider should never get called — the lookup throws first.
      responses: [],
    });
    expect(child.exitCode).toBe(1);
    expect(child.stderr).toContain("Continue error: no previous wrap run found");
  });

  test("parent had piped input: exit 1 with Continue error", async () => {
    const wrapHome = freshHome();
    await run("explain this", {
      wrapHome,
      stdin: "some piped payload\n",
      responses: [{ type: "reply", content: "looks fine", risk_level: "low" }],
    });
    const child = await run("-c more", {
      wrapHome,
      responses: [],
    });
    expect(child.exitCode).toBe(1);
    expect(child.stderr).toContain(
      "Continue error: previous run had piped input that's no longer available",
    );
  });
});

describe("continuation — truncated chain", () => {
  test("missing parent_id reference does not crash; child still completes", async () => {
    const wrapHome = freshHome();
    // Hand-craft a log with an entry whose parent_id refers to a non-existent
    // entry. The chain walk should treat this entry as the chain root.
    const orphan = {
      id: "the-orphan",
      timestamp: "2026-01-01T00:00:00.000Z",
      version: "test",
      cwd: "/tmp",
      ppid: 999_999,
      parent_id: "missing-ancestor",
      provider: { name: "test", model: "test" },
      prompt_hash: "h",
      turns: [
        { kind: "user", text: "orphan prompt" },
        { kind: "assistant", attempts: [], source: "model" },
      ],
      outcome: "success",
    };
    const path = join(wrapHome, "logs", "wrap.jsonl");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(wrapHome, "logs"), { recursive: true });
    writeFileSync(path, `${JSON.stringify(orphan)}\n`);

    const child = await run("-c keep going", {
      wrapHome,
      responses: [{ type: "reply", content: "ok", risk_level: "low" }],
    });
    expect(child.exitCode).toBe(0);

    const entries = readEntries(wrapHome);
    const childEntry = entries[entries.length - 1];
    expect(childEntry?.parent_id).toBe("the-orphan");
  });
});
