/**
 * WRAP_HOME isolation preload — wired FIRST in `bunfig.toml` → `[test] preload`.
 *
 * `wrap/src/fs/home.ts` constructs `wrapFs = createAppHome({ app: "wrap" })`
 * at module load — `wrapFs.root` is captured once and never re-read. Any
 * test that imports a wrap module without WRAP_HOME pre-set would point at
 * the developer's real `~/.wrap`. Setting `process.env.WRAP_HOME` at the
 * top of a test file does NOT work: ES module imports are hoisted, so the
 * wrap import (and therefore wrapFs construction) runs BEFORE the env-var
 * assignment.
 *
 * Preload modules run before any test file's imports, so setting WRAP_HOME
 * here pins it in time. Test files that need to read/write under WRAP_HOME
 * import `TEST_HOME` from here. Bun runs test files serially in a shared
 * process, so TEST_HOME is one temp dir for the whole run; each test file
 * cleans up its own paths in `beforeEach`/`afterEach`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEST_HOME = mkdtempSync(join(tmpdir(), "wrap-test-home-"));
process.env.WRAP_HOME = TEST_HOME;
