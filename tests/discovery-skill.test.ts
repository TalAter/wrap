import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverySkill, listCwdFiles } from "../src/skills/discovery.ts";
import { runSkills } from "../src/skills/index.ts";
import { seedTestConfig } from "./helpers.ts";
import { TEST_HOME } from "./wrap-home-preload.ts";

describe("discovery skill", () => {
  let tmpDir: string;
  let prevCwd: string;

  beforeEach(() => {
    seedTestConfig();
    prevCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), "wrap-discovery-"));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("trigger is always", () => {
    expect(discoverySkill.trigger).toEqual({ kind: "always" });
  });

  test("emits a pwd turn pair", async () => {
    const turns = await runSkills([discoverySkill], "anything");
    const pwdStep = turns.find((t) => t.kind === "step" && t.command === "pwd");
    expect(pwdStep).toBeDefined();
    if (pwdStep?.kind !== "step") throw new Error("expected step");
    // macOS prepends /private to tmpdir paths via realpath, so just check the suffix
    expect(pwdStep.output.trim().endsWith(tmpDir) || pwdStep.output.trim() === tmpDir).toBe(true);
  });

  test("ls task emits assistant with `ls` command and step with formatted listing", async () => {
    await writeFile(join(tmpDir, "alpha.txt"), "");
    await utimes(join(tmpDir, "alpha.txt"), new Date("2024-01-01"), new Date("2024-01-01"));
    await writeFile(join(tmpDir, "beta.txt"), "");
    await utimes(join(tmpDir, "beta.txt"), new Date("2024-01-02"), new Date("2024-01-02"));

    const turns = await runSkills([discoverySkill], "anything");
    const lsIdx = turns.findIndex((t) => t.kind === "assistant" && t.response?.content === "ls");
    expect(lsIdx).toBeGreaterThanOrEqual(0);
    const lsStep = turns[lsIdx + 1];
    if (lsStep?.kind !== "step") throw new Error("expected step after ls assistant");
    expect(lsStep.command).toBe("ls");
    expect(lsStep.output).toBe("alpha.txt\nbeta.txt");
  });

  test("ls task drops the pair when cwd has no entries", async () => {
    const turns = await runSkills([discoverySkill], "anything");
    const hasLs = turns.some((t) => t.kind === "assistant" && t.response?.content === "ls");
    expect(hasLs).toBe(false);
  });

  test("which task probes PROBED_TOOLS plus watchlist additions", async () => {
    const watchlistPath = join(TEST_HOME, "tool-watchlist.json");
    writeFileSync(
      watchlistPath,
      JSON.stringify([{ tool: "watchlist-extra", added: "2026-05-21" }]),
    );

    const turns = await runSkills([discoverySkill], "anything");
    const whichAssistant = turns.find(
      (t) => t.kind === "assistant" && t.response?.content.startsWith("which "),
    );
    expect(whichAssistant).toBeDefined();
    if (whichAssistant?.kind !== "assistant") throw new Error("expected assistant");
    // Default PROBED_TOOLS tool + the watchlist entry both appear.
    expect(whichAssistant.response?.content).toContain("git");
    expect(whichAssistant.response?.content).toContain("watchlist-extra");
  });

  test("which task is present even when watchlist is empty (PROBED_TOOLS make it non-empty)", async () => {
    const turns = await runSkills([discoverySkill], "anything");
    const hasWhich = turns.some(
      (t) => t.kind === "assistant" && t.response?.content.startsWith("which "),
    );
    expect(hasWhich).toBe(true);
  });

  test("which task injects only tool names that pass VALID_TOOL_NAME", async () => {
    const watchlistPath = join(TEST_HOME, "tool-watchlist.json");
    // loadWatchlist already filters via VALID_TOOL_NAME, so we add a valid one
    // and assert the malicious-looking string never appears in the command.
    writeFileSync(
      watchlistPath,
      JSON.stringify([
        { tool: "valid-tool", added: "2026-05-21" },
        { tool: "; rm -rf /", added: "2026-05-21" },
      ]),
    );
    const turns = await runSkills([discoverySkill], "anything");
    const whichAssistant = turns.find(
      (t) => t.kind === "assistant" && t.response?.content.startsWith("which "),
    );
    if (whichAssistant?.kind !== "assistant") throw new Error("expected assistant");
    expect(whichAssistant.response?.content).toContain("valid-tool");
    expect(whichAssistant.response?.content).not.toContain("rm -rf");
  });

  test("which task rejects tool names with shell-metachar prefix (`; legit`)", async () => {
    // Defense-in-depth: VALID_TOOL_NAME must reject the *entire* string, not
    // match somewhere inside. A name like "; legit" has an alphanumeric body
    // but a leading `;` — if the regex weren't anchored, the `;` would end
    // the `which` invocation and run attacker-controlled commands after.
    const watchlistPath = join(TEST_HOME, "tool-watchlist.json");
    writeFileSync(watchlistPath, JSON.stringify([{ tool: "; legit", added: "2026-05-21" }]));
    const turns = await runSkills([discoverySkill], "anything");
    const whichAssistant = turns.find(
      (t) => t.kind === "assistant" && t.response?.content.startsWith("which "),
    );
    if (whichAssistant?.kind !== "assistant") throw new Error("expected assistant");
    expect(whichAssistant.response?.content).not.toContain("; legit");
    expect(whichAssistant.response?.content).not.toContain("legit");
  });

  test("all turns carry the discovery skill source marker", async () => {
    await writeFile(join(tmpDir, "a"), "");

    const turns = await runSkills([discoverySkill], "anything");
    for (const turn of turns) {
      if (turn.kind === "assistant" || turn.kind === "step") {
        expect(turn.source).toEqual({ kind: "skill", name: "discovery" });
      }
    }
  });
});

describe("discovery skill wire-in (main.ts)", () => {
  test("skill turns are spliced before the user prompt in the logged transcript", async () => {
    const { readFileSync } = await import("node:fs");
    const { wrapMock } = await import("./helpers.ts");

    const result = await wrapMock("list files", {
      type: "reply",
      content: "ok",
      risk_level: "low",
    });
    const log = readFileSync(`${result.wrapHome}/logs/wrap.jsonl`, "utf-8").trim();
    const entry = JSON.parse(log) as {
      turns: Array<{ kind: string; source?: unknown; text?: string }>;
    };
    const userIdx = entry.turns.findIndex((t) => t.kind === "user");
    // All skill-emitted turns come BEFORE the first user turn — this is the
    // trust-fence invariant.
    const skillBefore = entry.turns
      .slice(0, userIdx)
      .filter(
        (t) =>
          (t.kind === "assistant" || t.kind === "step") &&
          typeof t.source === "object" &&
          t.source !== null &&
          (t.source as { kind?: string }).kind === "skill",
      );
    expect(skillBefore.length).toBeGreaterThan(0);
    const skillAfter = entry.turns
      .slice(userIdx)
      .filter(
        (t) =>
          (t.kind === "assistant" || t.kind === "step") &&
          typeof t.source === "object" &&
          t.source !== null &&
          (t.source as { kind?: string }).kind === "skill",
      );
    expect(skillAfter.length).toBe(0);
  });
});

describe("listCwdFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wrap-cwd-mv-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns undefined for empty directory", async () => {
    expect(await listCwdFiles(tmpDir)).toBeUndefined();
  });

  test("returns undefined for nonexistent directory", async () => {
    expect(await listCwdFiles("/nonexistent/path/xyz")).toBeUndefined();
  });

  test("sorts entries by mtime ascending", async () => {
    await writeFile(join(tmpDir, "b"), "");
    await utimes(join(tmpDir, "b"), new Date("2024-01-02"), new Date("2024-01-02"));
    await writeFile(join(tmpDir, "a"), "");
    await utimes(join(tmpDir, "a"), new Date("2024-01-01"), new Date("2024-01-01"));
    expect(await listCwdFiles(tmpDir)).toBe("a\nb");
  });

  test("appends / to directories", async () => {
    await mkdir(join(tmpDir, "src"));
    await utimes(join(tmpDir, "src"), new Date("2024-01-02"), new Date("2024-01-02"));
    await writeFile(join(tmpDir, "file.txt"), "");
    await utimes(join(tmpDir, "file.txt"), new Date("2024-01-01"), new Date("2024-01-01"));
    expect(await listCwdFiles(tmpDir)).toBe("file.txt\nsrc/");
  });

  test("includes dotfiles", async () => {
    await writeFile(join(tmpDir, ".gitignore"), "");
    await writeFile(join(tmpDir, "readme.md"), "");
    const result = await listCwdFiles(tmpDir);
    expect(result).toContain(".gitignore");
    expect(result).toContain("readme.md");
  });

  test("does not crash on broken symlinks", async () => {
    await writeFile(join(tmpDir, "good.txt"), "");
    await symlink("/nonexistent/target", join(tmpDir, "broken-link"));
    const result = await listCwdFiles(tmpDir);
    expect(result).toContain("good.txt");
  });

  test("returns all entries sorted by mtime when 50 or fewer", async () => {
    await Promise.all(
      Array.from({ length: 50 }, async (_, i) => {
        const name = `file-${String(i).padStart(3, "0")}.txt`;
        await writeFile(join(tmpDir, name), "");
        await utimes(join(tmpDir, name), new Date(2024, 0, i + 1), new Date(2024, 0, i + 1));
      }),
    );
    const result = await listCwdFiles(tmpDir);
    const lines = (result as string).split("\n");
    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe("file-000.txt");
    expect(lines[49]).toBe("file-049.txt");
    expect(result).not.toContain("showing");
  });

  test("caps at 50: oldest 20 + newest 30, with omission + count markers", async () => {
    await Promise.all(
      Array.from({ length: 73 }, async (_, i) => {
        const name = `file-${String(i).padStart(3, "0")}.txt`;
        await writeFile(join(tmpDir, name), "");
        await utimes(join(tmpDir, name), new Date(2024, 0, i + 1), new Date(2024, 0, i + 1));
      }),
    );
    const result = await listCwdFiles(tmpDir);
    const lines = (result as string).split("\n");
    expect(lines).toHaveLength(52);
    expect(lines[0]).toBe("file-000.txt");
    expect(lines[19]).toBe("file-019.txt");
    expect(lines[20]).toBe("... (23 entries omitted) ...");
    expect(lines[21]).toBe("file-043.txt");
    expect(lines[50]).toBe("file-072.txt");
    expect(lines[51]).toBe("(showing 50 of 73 entries)");
  });

  test("exactly 51 entries triggers truncation", async () => {
    await Promise.all(
      Array.from({ length: 51 }, async (_, i) => {
        const name = `file-${String(i).padStart(3, "0")}.txt`;
        await writeFile(join(tmpDir, name), "");
        await utimes(join(tmpDir, name), new Date(2024, 0, i + 1), new Date(2024, 0, i + 1));
      }),
    );
    const result = await listCwdFiles(tmpDir);
    const lines = (result as string).split("\n");
    expect(lines).toHaveLength(52);
    expect(lines[20]).toBe("... (1 entries omitted) ...");
    expect(lines[51]).toBe("(showing 50 of 51 entries)");
  });
});
