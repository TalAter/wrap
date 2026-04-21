import { describe, expect, test } from "bun:test";
import { spawnAndRead } from "../src/llm/utils.ts";

describe("spawnAndRead", () => {
  test("returns stdout/stderr/exit_code tuple on zero exit", async () => {
    const result = await spawnAndRead(["sh", "-c", "echo hello; echo warn 1>&2"], "");
    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("warn\n");
    expect(result.exit_code).toBe(0);
  });

  test("returns non-zero exit_code without throwing (caller owns the policy)", async () => {
    const result = await spawnAndRead(["sh", "-c", "echo boom 1>&2; exit 7"], "");
    expect(result.exit_code).toBe(7);
    expect(result.stderr).toContain("boom");
  });

  test("pipes stdin to the child process", async () => {
    const result = await spawnAndRead(["cat"], "piped input");
    expect(result.stdout).toBe("piped input");
    expect(result.exit_code).toBe(0);
  });
});
