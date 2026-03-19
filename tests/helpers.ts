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

export async function wrapMock(input: string) {
  const config = JSON.stringify({ provider: { type: "test" } });
  return wrap(input, { WRAP_CONFIG: config });
}
