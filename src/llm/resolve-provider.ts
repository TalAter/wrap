import type { Config, ProviderEntry } from "../config/config.ts";
import { getRegistration, isKnownProvider, validateProviderEntry } from "./providers/registry.ts";
import { isTestProviderSelected, TEST_RESOLVED_PROVIDER } from "./providers/test.ts";
import type { ResolvedProvider } from "./types.ts";

const NO_LLM_ERROR = "Config error: no LLM configured. Edit ~/.wrap/config.jsonc.";

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
 * Resolve a merged `Config` into the final `ResolvedProvider` used by
 * `initProvider`. See `specs/llm.md` for the full resolution rules.
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
  // even when other fields are also missing.
  const validationError = validateProviderEntry(providerName, entry);
  if (validationError) throw new Error(validationError);

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
