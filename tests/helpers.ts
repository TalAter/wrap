export async function wrap(input?: string, env?: Record<string, string>) {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const args = input ? input.split(" ") : [];
  // Always isolate from the real ~/.wrap/ config
  const isolatedEnv = {
    ...process.env,
    WRAP_HOME: mkdtempSync(join(tmpdir(), "wrap-test-")),
    ...env,
  };
  const proc = Bun.spawn(["bun", "run", "src/index.ts", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: isolatedEnv,
  });
  const exitCode = await proc.exited;
  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

/** Pre-seed memory.json so ensureMemory doesn't trigger init during tests. */
function seedMemory(wrapHome: string) {
  const { writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  writeFileSync(join(wrapHome, "memory.json"), '[{"fact":"test"}]');
}

export async function wrapMock(prompt: string, response: object) {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const wrapHome = mkdtempSync(join(tmpdir(), "wrap-test-"));
  seedMemory(wrapHome);
  const config = JSON.stringify({ provider: { type: "test" } });
  return wrap(prompt, {
    WRAP_HOME: wrapHome,
    WRAP_CONFIG: config,
    WRAP_TEST_RESPONSE: JSON.stringify(response),
  });
}
