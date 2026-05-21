import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitSkill } from "../src/skills/commit.ts";
import { runSkills } from "../src/skills/index.ts";
import { seedTestConfig } from "./helpers.ts";

async function execIn(cwd: string, command: string): Promise<void> {
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: process.env as Record<string, string>,
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`setup command failed (${exitCode}): ${command}\n${stderr}`);
  }
}

async function initGitRepo(cwd: string): Promise<void> {
  await execIn(cwd, "git init -q");
  await execIn(cwd, "git config user.email test@example.com");
  await execIn(cwd, "git config user.name test");
}

describe("commit skill — trigger", () => {
  test("trigger matches case-insensitive whole-word, rejects substrings", () => {
    if (commitSkill.trigger.kind !== "match") throw new Error("expected match trigger");
    const p = commitSkill.trigger.pattern;
    for (const ok of ["commit my changes", "Commit it", "COMMIT now", "pls commit"]) {
      expect(p.test(ok)).toBe(true);
    }
    for (const no of [
      "list files",
      "her commitment is firm",
      "I committed yesterday",
      "uncommit",
    ]) {
      expect(p.test(no)).toBe(false);
    }
  });
});

describe("commit skill — execution", () => {
  let tmpDir: string;
  let prevCwd: string;

  beforeEach(() => {
    seedTestConfig();
    prevCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), "wrap-commit-exec-"));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("clean repo (nothing staged, nothing modified) drops all pairs", async () => {
    await initGitRepo(tmpDir);
    await writeFile(join(tmpDir, "tracked.txt"), "x\n");
    await execIn(tmpDir, "git add tracked.txt");
    await execIn(tmpDir, "git commit -q -m init");

    const turns = await runSkills([commitSkill], "commit my changes");
    expect(turns).toEqual([]);
  });

  test("staged + unstaged changes emit status, both diffs, in order", async () => {
    await initGitRepo(tmpDir);
    // Initial commit so `git diff` (working tree vs index) has a tracked file to diff.
    await writeFile(join(tmpDir, "tracked.txt"), "base\n");
    await execIn(tmpDir, "git add tracked.txt");
    await execIn(tmpDir, "git commit -q -m init");
    await writeFile(join(tmpDir, "tracked.txt"), "base\nstaged-line\n");
    await execIn(tmpDir, "git add tracked.txt");
    await writeFile(join(tmpDir, "tracked.txt"), "base\nstaged-line\nunstaged-line\n");

    const turns = await runSkills([commitSkill], "commit my changes");

    const commands = turns
      .filter((t) => t.kind === "assistant")
      .map((t) => t.kind === "assistant" && t.response?.content);
    expect(commands).toEqual(["git status --short", "git diff --cached", "git diff"]);

    expect(turns).toHaveLength(6);
    const steps = turns.filter((t) => t.kind === "step");
    if (steps[0]?.kind !== "step" || steps[1]?.kind !== "step" || steps[2]?.kind !== "step")
      throw new Error("expected three step turns");
    expect(steps[0].output).toContain("tracked.txt");
    expect(steps[1].output).toContain("staged-line");
    expect(steps[2].output).toContain("unstaged-line");
  });

  test("staged only: unstaged diff drops, status + cached emit", async () => {
    await initGitRepo(tmpDir);
    await writeFile(join(tmpDir, "hello.txt"), "hello\n");
    await execIn(tmpDir, "git add hello.txt");

    const turns = await runSkills([commitSkill], "commit my changes");
    const commands = turns
      .filter((t) => t.kind === "assistant")
      .map((t) => t.kind === "assistant" && t.response?.content);
    expect(commands).toEqual(["git status --short", "git diff --cached"]);
  });

  test("unstaged only: cached drops, status + unstaged diff emit", async () => {
    await initGitRepo(tmpDir);
    await writeFile(join(tmpDir, "tracked.txt"), "x\n");
    await execIn(tmpDir, "git add tracked.txt");
    await execIn(tmpDir, "git commit -q -m init");
    await writeFile(join(tmpDir, "tracked.txt"), "x\nmore\n");

    const turns = await runSkills([commitSkill], "commit my changes");
    const commands = turns
      .filter((t) => t.kind === "assistant")
      .map((t) => t.kind === "assistant" && t.response?.content);
    expect(commands).toEqual(["git status --short", "git diff"]);
  });
});

describe("commit skill — registration", () => {
  test("appears in SKILLS after the discovery skill", async () => {
    const { SKILLS } = await import("../src/skills/index.ts");
    const names = SKILLS.map((s) => s.name);
    expect(names).toContain("discovery");
    expect(names).toContain("commit");
    expect(names.indexOf("commit")).toBeGreaterThan(names.indexOf("discovery"));
  });
});
