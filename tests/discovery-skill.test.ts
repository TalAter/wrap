import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIPBOARD_PASTE_TOOLS, CLIPBOARD_TOOLS } from "../src/core/clipboard.ts";
import { discoverySkill, listCwdFiles, PROBED_TOOLS } from "../src/skills/discovery.ts";
import { runSkills } from "../src/skills/index.ts";
import { seedTestConfig } from "./helpers.ts";
import { TEST_HOME } from "./wrap-home-preload.ts";

describe("PROBED_TOOLS drift guard", () => {
  test("every CLIPBOARD_TOOLS / CLIPBOARD_PASTE_TOOLS entry is in PROBED_TOOLS", () => {
    // Drift guard: clipboard.ts owns runtime resolution + per-tool args, but
    // probed-tools.json is the source-of-truth Python reads for promptHash.
    // If they diverge, the LLM is probed for tools the runtime can't use, or
    // vice versa.
    const probed = new Set(PROBED_TOOLS);
    for (const t of [...CLIPBOARD_TOOLS, ...CLIPBOARD_PASTE_TOOLS]) {
      expect(probed.has(t)).toBe(true);
    }
  });
});

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

  test("emits a pwd probe", async () => {
    const turns = await runSkills([discoverySkill], "anything");
    const pwd = turns.find((t) => t.command === "pwd");
    expect(pwd).toBeDefined();
    if (pwd?.kind !== "probe") throw new Error("expected probe");
    expect(pwd.output.trim().endsWith(tmpDir) || pwd.output.trim() === tmpDir).toBe(true);
  });

  test("ls task emits probe with formatted listing", async () => {
    await writeFile(join(tmpDir, "alpha.txt"), "");
    await utimes(join(tmpDir, "alpha.txt"), new Date("2024-01-01"), new Date("2024-01-01"));
    await writeFile(join(tmpDir, "beta.txt"), "");
    await utimes(join(tmpDir, "beta.txt"), new Date("2024-01-02"), new Date("2024-01-02"));

    const turns = await runSkills([discoverySkill], "anything");
    const ls = turns.find((t) => t.command === "ls");
    if (ls?.kind !== "probe") throw new Error("expected probe");
    expect(ls.output).toBe("alpha.txt\nbeta.txt");
  });

  test("ls task drops the probe when cwd has no entries", async () => {
    const turns = await runSkills([discoverySkill], "anything");
    const hasLs = turns.some((t) => t.command === "ls");
    expect(hasLs).toBe(false);
  });

  test("which task probes PROBED_TOOLS plus watchlist additions", async () => {
    const watchlistPath = join(TEST_HOME, "tool-watchlist.json");
    writeFileSync(
      watchlistPath,
      JSON.stringify([{ tool: "watchlist-extra", added: "2026-05-21" }]),
    );

    const turns = await runSkills([discoverySkill], "anything");
    const which = turns.find((t) => t.command.startsWith("which "));
    expect(which).toBeDefined();
    if (which?.kind !== "probe") throw new Error("expected probe");
    expect(which.command).toContain("git");
    expect(which.command).toContain("watchlist-extra");
  });

  test("which task is present even when watchlist is empty (PROBED_TOOLS make it non-empty)", async () => {
    const turns = await runSkills([discoverySkill], "anything");
    const hasWhich = turns.some((t) => t.command.startsWith("which "));
    expect(hasWhich).toBe(true);
  });

  test("which task injects only tool names that pass VALID_TOOL_NAME", async () => {
    const watchlistPath = join(TEST_HOME, "tool-watchlist.json");
    writeFileSync(
      watchlistPath,
      JSON.stringify([
        { tool: "valid-tool", added: "2026-05-21" },
        { tool: "; rm -rf /", added: "2026-05-21" },
      ]),
    );
    const turns = await runSkills([discoverySkill], "anything");
    const which = turns.find((t) => t.command.startsWith("which "));
    if (which?.kind !== "probe") throw new Error("expected probe");
    expect(which.command).toContain("valid-tool");
    expect(which.command).not.toContain("rm -rf");
  });

  test("which task rejects tool names with shell-metachar prefix (`; legit`)", async () => {
    const watchlistPath = join(TEST_HOME, "tool-watchlist.json");
    writeFileSync(watchlistPath, JSON.stringify([{ tool: "; legit", added: "2026-05-21" }]));
    const turns = await runSkills([discoverySkill], "anything");
    const which = turns.find((t) => t.command.startsWith("which "));
    if (which?.kind !== "probe") throw new Error("expected probe");
    expect(which.command).not.toContain("; legit");
    expect(which.command).not.toContain("legit");
  });

  test("all turns carry the discovery skill name", async () => {
    await writeFile(join(tmpDir, "a"), "");

    const turns = await runSkills([discoverySkill], "anything");
    for (const turn of turns) {
      expect(turn.skill).toBe("discovery");
    }
  });
});

describe("discovery skill wire-in (main.ts)", () => {
  test("probe turns are spliced before the user prompt in the logged transcript", async () => {
    const { readFileSync } = await import("node:fs");
    const { wrapMock } = await import("./helpers.ts");

    const result = await wrapMock("list files", {
      type: "reply",
      content: "ok",
      risk_level: "low",
    });
    const log = readFileSync(`${result.wrapHome}/logs/wrap.jsonl`, "utf-8").trim();
    const entry = JSON.parse(log) as {
      turns: Array<{ kind: string }>;
    };
    const userIdx = entry.turns.findIndex((t) => t.kind === "user");
    const probesBefore = entry.turns.slice(0, userIdx).filter((t) => t.kind === "probe");
    expect(probesBefore.length).toBeGreaterThan(0);
    const probesAfter = entry.turns.slice(userIdx).filter((t) => t.kind === "probe");
    expect(probesAfter.length).toBe(0);
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
