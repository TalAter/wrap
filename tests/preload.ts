/**
 * Global test preload. Wired via `bunfig.toml` → `[test] preload`.
 *
 * Purpose: prevent three categories of test-output leaks without touching
 * production code.
 *
 *   1. Child-shell startup warnings (e.g. zsh "can't change option: zle")
 *      → Pin `SHELL=/bin/sh` so runner-spawned shells are warning-free.
 *   2. `stdio: "inherit"` child output leaking to the test runner's real
 *      fd 1/2 (bypasses any JS-level `process.std{out,err}.write` spy)
 *      → Monkey-patch `Bun.spawn` / `Bun.spawnSync` to rewrite inherit→ignore.
 *      Opt-out per test with `WRAP_TEST_ALLOW_INHERIT=1`.
 *   3. JS-level chrome/verbose fallback writes to stderr when no listener
 *      is subscribed to the notify bus
 *      → Install one `mockStderr` / `mockStdout` at preload time and keep
 *      them for the whole session. Tests assert via `capturedStderr` /
 *      `capturedStdout`; `beforeEach` only clears the buffers.
 *
 * Bun's test reporter writes through its own path (not `process.stderr.write`),
 * so the always-on mocks don't suppress pass/fail/summary output.
 */
import { beforeEach } from "bun:test";
import { mockStderr } from "./helpers/mock-stderr.ts";
import { mockStdout } from "./helpers/mock-stdout.ts";

// 1. Pin shell ────────────────────────────────────────────────────────
process.env.SHELL = "/bin/sh";

// 2. Silence inherit-mode child stdio ─────────────────────────────────
type SpawnOpts = Parameters<typeof Bun.spawn>[1];
type SpawnSyncOpts = Parameters<typeof Bun.spawnSync>[1];

function patchInherit<T extends { stdout?: unknown; stderr?: unknown } | undefined>(opts: T): T {
  if (!opts || process.env.WRAP_TEST_ALLOW_INHERIT) return opts;
  if (opts.stdout !== "inherit" && opts.stderr !== "inherit") return opts;
  const patched = { ...opts };
  if (patched.stdout === "inherit") patched.stdout = "ignore";
  if (patched.stderr === "inherit") patched.stderr = "ignore";
  return patched as T;
}

const realSpawn = Bun.spawn;
Bun.spawn = ((cmd: Parameters<typeof Bun.spawn>[0], opts?: SpawnOpts) => {
  return realSpawn(cmd, patchInherit(opts));
}) as typeof Bun.spawn;

const realSpawnSync = Bun.spawnSync;
Bun.spawnSync = ((cmd: Parameters<typeof Bun.spawnSync>[0], opts?: SpawnSyncOpts) => {
  return realSpawnSync(cmd, patchInherit(opts));
}) as typeof Bun.spawnSync;

// 3. Capture stdout/stderr for the entire session ─────────────────────
export const capturedStderr = mockStderr();
export const capturedStdout = mockStdout();

beforeEach(() => {
  capturedStderr.clear();
  capturedStdout.clear();
});
