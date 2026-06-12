import { getRegistration, isKnownProvider, validateProviderEntry } from "wrap-core/llm";
import type { Config, ProviderEntry } from "../config/config.ts";

const NO_LLM_ERROR = "Config error: no LLM configured. Edit ~/.wrap/config.jsonc.";

/** Final state after override resolution — what `initLlm` builds core's
 *  `LlmConfig` from, and what the log entry records as `provider`. */
export type ResolvedProvider = {
  name: string;
  /**
   * Final model string. Optional because `claude-code` entries may omit it —
   * the `claude` CLI picks its own default when `--model` is not passed.
   * All other providers must have a model by the time they reach runtime.
   */
  model?: string;
  apiKey?: string;
  baseURL?: string;
};

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

  const providers = config.providers ?? {};
  const providerName = config.defaultProvider;

  if (!providerName) throw new Error(NO_LLM_ERROR);

  const entry = providers[providerName];
  if (!entry) {
    // After normalization, defaultProvider could name something missing from
    // the providers map — either a user typo in the config file or a
    // `--model unknown:x` override that wrote the bad name in. Either way,
    // the actionable message is "not found" rather than the generic one.
    throw new Error(`Config error: provider "${providerName}" not found in config.`);
  }

  // Per-entry validation runs before the no-model check so a structurally
  // invalid entry (e.g. ollama without baseURL) reports the actionable error
  // even when other fields are also missing. Core's validator messages are
  // bare plain language — wrap's category prefix is applied here, at the
  // surfacing site.
  const validationError = validateProviderEntry(providerName, entry);
  if (validationError) throw new Error(`Config error: ${validationError}`);

  const model = entry.model;
  if (!model && !getRegistration(providerName).modelOptional) {
    throw new Error(`Config error: provider "${providerName}" has no model set in config.`);
  }

  return {
    name: providerName,
    model,
    apiKey: entry.apiKey,
    baseURL: entry.baseURL,
  };
}
