import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Create an isolated temp dir for WRAP_HOME without spawning a subprocess. */
export function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "wrap-test-"));
}

export async function wrap(input?: string, env?: Record<string, string>) {
  const args = input ? input.split(" ") : [];
  // Always isolate from the real ~/.wrap/ config
  const isolatedEnv = {
    ...process.env,
    WRAP_HOME: tmpHome(),
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
    wrapHome: isolatedEnv.WRAP_HOME,
  };
}

/** Pre-seed memory.json so ensureMemory doesn't trigger init during tests. */
function seedMemory(wrapHome: string) {
  writeFileSync(join(wrapHome, "memory.json"), '{"/":[{"fact":"test"}]}');
}

export async function wrapMock(
  prompt: string,
  response: object | object[],
  config?: Record<string, unknown>,
) {
  const wrapHome = tmpHome();
  seedMemory(wrapHome);
  const fullConfig = JSON.stringify({ provider: { type: "test" }, ...config });
  const env: Record<string, string> = {
    WRAP_HOME: wrapHome,
    WRAP_CONFIG: fullConfig,
  };
  if (Array.isArray(response)) {
    env.WRAP_TEST_RESPONSES = JSON.stringify(response);
  } else {
    env.WRAP_TEST_RESPONSE = JSON.stringify(response);
  }
  return wrap(prompt, env);
}
