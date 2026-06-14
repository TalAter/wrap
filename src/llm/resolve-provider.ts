import { resolveProvider as coreResolveProvider, type ResolvedProvider } from "wrap-core/config";
import { isKnownProvider, LlmConfigError } from "wrap-core/llm";
import type { Config, ProviderEntry } from "../config/config.ts";

const NO_LLM_ERROR = "Config error: no LLM configured. Edit ~/.wrap/config.jsonc.";

/** Final state after override resolution — what `initLlm` builds core's
 *  `LlmConfig` from, and what the log entry records as `provider`. Re-exported
 *  from core (`wrap-core/config`) so there's a single definition; other wrap
 *  files keep importing it from this module. */
export type { ResolvedProvider };

/**
 * Sentinel `ResolvedProvider` for the test provider. Not user-facing — it's
 * selected by the `WRAP_TEST_RESPONSE`/`WRAP_TEST_RESPONSES` env vars and
 * bypasses the providers map entirely. Test-provider *selection* is wrap
 * policy (core names no env vars); the same env vars that select this
 * sentinel also make `buildLlmConfig` emit core's canned-playback test
 * config. No `model` — the env-selected config has none.
 */
export const TEST_RESOLVED_PROVIDER: ResolvedProvider = { name: "test" };

/** True when one of the test-provider env vars is set, regardless of value. */
export function isTestProviderSelected(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.WRAP_TEST_RESPONSE !== undefined || env.WRAP_TEST_RESPONSES !== undefined;
}

/**
 * Parse a `--model`/`WRAP_MODEL` override string into the provider + optional
 * transient model it targets. See `specs/llm.md` for the resolution rules.
 *
 * Formats:
 * - `provider:model` → that provider, that model
 * - `provider` (matches a configured key) → that provider's stored model
 * - `:model` → default provider, different model
 * - bare value → smart match: unique configured model, then known-provider
 *   diagnostic, then fall through to default provider with transient model
 *
 * Throws on empty/whitespace input and on ambiguous/unknown-builtin cases.
 * Returns `providerName: undefined` when neither the override nor the file
 * config names a provider — caller surfaces the generic NO_LLM_ERROR later.
 */
export function parseModelOverride(
  override: string,
  providers: Record<string, ProviderEntry>,
  defaultProvider: string | undefined,
): { providerName: string | undefined; transientModel: string | undefined } {
  const trimmed = override.trim();
  if (trimmed === "" || trimmed === ":") {
    throw new Error("Config error: --model value is empty.");
  }
  if (trimmed.includes(":")) {
    const colonIdx = trimmed.indexOf(":");
    const namePart = trimmed.slice(0, colonIdx);
    const modelPart = trimmed.slice(colonIdx + 1);
    return {
      providerName: namePart === "" ? defaultProvider : namePart,
      transientModel: modelPart === "" ? undefined : modelPart,
    };
  }
  if (trimmed in providers) {
    return { providerName: trimmed, transientModel: undefined };
  }
  const modelMatches = Object.entries(providers).filter(([, entry]) => entry.model === trimmed);
  const [firstMatch] = modelMatches;
  if (firstMatch && modelMatches.length === 1) {
    return { providerName: firstMatch[0], transientModel: undefined };
  }
  if (modelMatches.length > 1) {
    throw new Error(
      `Config error: model "${trimmed}" is configured for multiple providers; use provider:model.`,
    );
  }
  if (isKnownProvider(trimmed)) {
    throw new Error(`Config error: provider "${trimmed}" not found in config.`);
  }
  return { providerName: defaultProvider, transientModel: trimmed };
}

/**
 * Resolve a merged `Config` into the final `ResolvedProvider` that
 * `initLlm` builds core's `LlmConfig` from. See `specs/llm.md` for the
 * full resolution rules.
 *
 * Assumes any `--model`/`WRAP_MODEL` override has already been normalized
 * into `config.defaultProvider` and `config.providers[name].model` by
 * `applyModelOverride` (in `src/config/resolve.ts`).
 *
 * `env` is consulted only for the test-sentinel short-circuit
 * (`WRAP_TEST_RESPONSE` / `WRAP_TEST_RESPONSES`).
 */
export function resolveProvider(
  config: Config,
  env: Record<string, string | undefined> = process.env,
): ResolvedProvider {
  if (isTestProviderSelected(env)) return TEST_RESOLVED_PROVIDER;

  // The missing-defaultProvider case keeps wrap's generic NO_LLM_ERROR with its
  // ~/.wrap remediation — core throws a bare "no LLM configured." for the same
  // case, so wrap short-circuits it here before delegating. Real-provider
  // resolution (entry existence, per-entry validation, no-model) is core's;
  // core's bare `LlmConfigError` messages are dressed in wrap's voice here.
  if (!config.defaultProvider) throw new Error(NO_LLM_ERROR);

  try {
    return coreResolveProvider(config);
  } catch (e) {
    if (e instanceof LlmConfigError) throw new Error(`Config error: ${e.message}`);
    throw e;
  }
}
