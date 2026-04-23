import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countCwdFiles, listCwdFiles } from "../src/discovery/cwd-files.ts";

describe("listCwdFiles", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wrap-cwd-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  test("returns undefined for empty directory", async () => {
    const result = await listCwdFiles(tmpDir);
    expect(result).toBeUndefined();
  });

  test("returns undefined for nonexistent directory", async () => {
    const result = await listCwdFiles("/nonexistent/path/xyz");
    expect(result).toBeUndefined();
  });

  test("returns files sorted by mtime ascending", async () => {
    await writeFile(join(tmpDir, "b.txt"), "");
    await utimes(join(tmpDir, "b.txt"), new Date("2024-01-02"), new Date("2024-01-02"));
    await writeFile(join(tmpDir, "a.txt"), "");
    await utimes(join(tmpDir, "a.txt"), new Date("2024-01-01"), new Date("2024-01-01"));
    await writeFile(join(tmpDir, "c.txt"), "");
    await utimes(join(tmpDir, "c.txt"), new Date("2024-01-03"), new Date("2024-01-03"));

    const result = await listCwdFiles(tmpDir);
    expect(result).toBe("a.txt\nb.txt\nc.txt");
  });

  test("appends / to directories", async () => {
    await mkdir(join(tmpDir, "src"));
    await utimes(join(tmpDir, "src"), new Date("2024-01-02"), new Date("2024-01-02"));
    await writeFile(join(tmpDir, "file.txt"), "");
    await utimes(join(tmpDir, "file.txt"), new Date("2024-01-01"), new Date("2024-01-01"));

    const result = await listCwdFiles(tmpDir);
    expect(result).toBe("file.txt\nsrc/");
  });

  test("includes dotfiles", async () => {
    await writeFile(join(tmpDir, ".gitignore"), "");
    await utimes(join(tmpDir, ".gitignore"), new Date("2024-01-01"), new Date("2024-01-01"));
    await writeFile(join(tmpDir, "readme.md"), "");
    await utimes(join(tmpDir, "readme.md"), new Date("2024-01-02"), new Date("2024-01-02"));

    const result = await listCwdFiles(tmpDir);
    expect(result).toContain(".gitignore");
    expect(result).toContain("readme.md");
  });

  test("does not crash on broken symlinks", async () => {
    await writeFile(join(tmpDir, "good.txt"), "");
    await utimes(join(tmpDir, "good.txt"), new Date("2024-01-01"), new Date("2024-01-01"));
    await symlink("/nonexistent/target", join(tmpDir, "broken-link"));

    const result = await listCwdFiles(tmpDir);
    expect(result).toContain("good.txt");
  });

  test("returns all entries sorted by mtime when 50 or fewer", async () => {
    for (let i = 0; i < 50; i++) {
      const name = `file-${String(i).padStart(3, "0")}.txt`;
      await writeFile(join(tmpDir, name), "");
      await utimes(join(tmpDir, name), new Date(2024, 0, i + 1), new Date(2024, 0, i + 1));
    }

    const result = await listCwdFiles(tmpDir);
    expect(result).toBeDefined();
    const lines = (result as string).split("\n");
    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe("file-000.txt");
    expect(lines[49]).toBe("file-049.txt");
    expect(result).not.toContain("showing");
  });

  test("caps at 50: oldest 20 + newest 30, with count", async () => {
    for (let i = 0; i < 73; i++) {
      const name = `file-${String(i).padStart(3, "0")}.txt`;
      await writeFile(join(tmpDir, name), "");
      await utimes(join(tmpDir, name), new Date(2024, 0, i + 1), new Date(2024, 0, i + 1));
    }

    const result = await listCwdFiles(tmpDir);
    expect(result).toBeDefined();
    const lines = (result as string).split("\n");
    expect(lines).toHaveLength(52); // 50 entries + gap line + count line

    // First 20 = oldest
    expect(lines[0]).toBe("file-000.txt");
    expect(lines[19]).toBe("file-019.txt");

    // Gap indicator
    expect(lines[20]).toBe("... (23 entries omitted) ...");

    // Next 30 = newest
    expect(lines[21]).toBe("file-043.txt");
    expect(lines[50]).toBe("file-072.txt");

    // Count line
    expect(lines[51]).toBe("(showing 50 of 73 entries)");
  });

  test("exactly 51 entries triggers truncation", async () => {
    for (let i = 0; i < 51; i++) {
      const name = `file-${String(i).padStart(3, "0")}.txt`;
      await writeFile(join(tmpDir, name), "");
      await utimes(join(tmpDir, name), new Date(2024, 0, i + 1), new Date(2024, 0, i + 1));
    }

    const result = await listCwdFiles(tmpDir);
    expect(result).toBeDefined();
    const lines = (result as string).split("\n");
    expect(lines).toHaveLength(52); // 50 entries + gap line + count line
    // Oldest 20
    expect(lines[0]).toBe("file-000.txt");
    expect(lines[19]).toBe("file-019.txt");

    // Gap indicator
    expect(lines[20]).toBe("... (1 entries omitted) ...");

    // Newest 30
    expect(lines[21]).toBe("file-021.txt");
    expect(lines[50]).toBe("file-050.txt");

    // Count line
    expect(lines[51]).toBe("(showing 50 of 51 entries)");
  });
});

describe("countCwdFiles", () => {
  test("counts plain file lines", () => {
    expect(countCwdFiles("foo.txt\nbar/\nbaz.md")).toBe(3);
  });

  test("excludes omission and summary marker lines", () => {
    const listing = [
      "old-1.txt",
      "old-2.txt",
      "... (40 entries omitted) ...",
      "new-1.txt",
      "new-2.txt",
      "(showing 50 of 90 entries)",
    ].join("\n");
    expect(countCwdFiles(listing)).toBe(4);
  });
});
