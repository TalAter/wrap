/**
 * Wrap's bridge from its own provider resolution + env contract to core's
 * `createLlm`. This is the one place wrap's test-provider env convention
 * (`WRAP_TEST_RESPONSE` / `WRAP_TEST_RESPONSES`) lives going forward — core
 * deliberately names no env vars (test-provider *selection* is consumer
 * policy; playback is core mechanics). The legacy provider machinery in
 * `providers/test.ts` still reads the same vars until the main query loop
 * flips to core and the old machinery is deleted.
 */

import {
  createLlm,
  type Llm,
  type LlmConfig,
  LlmConfigError,
  type TestResponses,
} from "wrap-core/llm";
import type { ResolvedProvider } from "./types.ts";

/**
 * Build core's `LlmConfig` from wrap's env contract + a `ResolvedProvider`.
 *
 * Precedence mirrors the legacy test provider: a non-empty
 * `WRAP_TEST_RESPONSES` (JSON — normally an array, one entry per physical
 * call) wins; otherwise a set `WRAP_TEST_RESPONSE` is a single response
 * taken verbatim (it repeats across calls); otherwise the resolved real
 * provider carries over field-for-field.
 */
export function buildLlmConfig(
  resolved: ResolvedProvider,
  env: Record<string, string | undefined> = process.env,
): LlmConfig {
  const responsesJson = env.WRAP_TEST_RESPONSES;
  if (responsesJson) {
    let responses: TestResponses;
    try {
      responses = JSON.parse(responsesJson) as TestResponses;
    } catch {
      throw new Error("Config error: WRAP_TEST_RESPONSES contains invalid JSON.");
    }
    return { name: "test", responses };
  }
  if (env.WRAP_TEST_RESPONSE !== undefined) {
    return { name: "test", responses: env.WRAP_TEST_RESPONSE };
  }

  const config: LlmConfig = { name: resolved.name };
  if (resolved.model !== undefined) config.model = resolved.model;
  if (resolved.apiKey !== undefined) config.apiKey = resolved.apiKey;
  if (resolved.baseURL !== undefined) config.baseURL = resolved.baseURL;
  return config;
}

/**
 * `buildLlmConfig` + `createLlm`, with core's bare `LlmConfigError` messages
 * surfaced in wrap's voice ("Config error: …") — voice is content, so the
 * prefix is applied here, at wrap's surfacing site.
 */
export function initLlm(
  resolved: ResolvedProvider,
  env: Record<string, string | undefined> = process.env,
): Llm {
  const config = buildLlmConfig(resolved, env);
  try {
    return createLlm(config);
  } catch (e) {
    if (e instanceof LlmConfigError) throw new Error(`Config error: ${e.message}`);
    throw e;
  }
}

/**
 * Transitional (old/new coexistence): drop the first `count` entries from
 * the `WRAP_TEST_RESPONSES` list in `env`.
 *
 * Memory init consumes canned responses through its own core test provider,
 * while the legacy query loop's test provider keeps a separate cursor over
 * the same env list — shifting the list after init keeps both machineries
 * reading one shared playback in order. No-op unless `WRAP_TEST_RESPONSES`
 * holds a JSON array (a single `WRAP_TEST_RESPONSE` repeats indefinitely
 * and needs no coordination). Dies with the legacy loop.
 */
export function advanceTestResponses(
  count: number,
  env: Record<string, string | undefined> = process.env,
): void {
  const responsesJson = env.WRAP_TEST_RESPONSES;
  if (!responsesJson) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(responsesJson);
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) return;
  env.WRAP_TEST_RESPONSES = JSON.stringify(parsed.slice(count));
}
