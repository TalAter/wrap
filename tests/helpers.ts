import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config/config.ts";
import { resolveSettings } from "../src/config/resolve.ts";
import { setConfig } from "../src/config/store.ts";

/**
 * Seed the global config store through the resolver so SETTINGS-declared
 * defaults (maxRounds, maxCapturedOutputChars, etc.) are materialized.
 *
 * Use this in tests that drive runSession/runLoop — raw `setConfig({...})`
 * leaves those fields undefined and the runner has no fallback anymore.
 */
export function seedTestConfig(overrides: Config = {}): void {
  const empty = { flags: new Set<string>(), values: new Map<string, string>() };
  setConfig(resolveSettings(empty, {}, overrides));
}

/** Create an isolated temp dir for WRAP_HOME without spawning a subprocess. */
export function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "wrap-test-"));
}

export async function wrap(input?: string, env?: Record<string, string>, stdin?: string) {
  const args = input ? input.split(" ") : [];
  // Always isolate from the real ~/.wrap/ config. WRAP_TEMP_DIR must not
  // leak from the test process — other tests (shell.test.ts,
  // fs-temp.test.ts) lazily create one via ensureTempDir, and if we inherit
  // it every subprocess points at the same (possibly removed) dir.
  const { WRAP_TEMP_DIR: _drop, ...parentEnv } = process.env;
  const isolatedEnv = {
    ...parentEnv,
    WRAP_HOME: tmpHome(),
    ...env,
  };
  const proc = Bun.spawn(["bun", "run", "src/index.ts", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: new Blob([stdin ?? ""]),
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
  stdin?: string,
) {
  const wrapHome = tmpHome();
  seedMemory(wrapHome);
  // The test sentinel (WRAP_TEST_RESPONSE) short-circuits resolveProvider, so
  // no providers map is needed in the config.
  const env: Record<string, string> = {
    WRAP_HOME: wrapHome,
    WRAP_CONFIG: JSON.stringify(config ?? {}),
  };
  if (Array.isArray(response)) {
    env.WRAP_TEST_RESPONSES = JSON.stringify(response);
  } else {
    env.WRAP_TEST_RESPONSE = JSON.stringify(response);
  }
  return wrap(prompt, env, stdin);
}
