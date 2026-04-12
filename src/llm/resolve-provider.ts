import type { Config } from "../config/config.ts";
import { isKnownProvider, validateProviderEntry } from "./providers/registry.ts";
import { isTestProviderSelected, TEST_RESOLVED_PROVIDER } from "./providers/test.ts";
import type { ResolvedProvider } from "./types.ts";

const NO_LLM_ERROR = "Config error: no LLM configured. Edit ~/.wrap/config.jsonc.";

/**
 * Resolve a merged `Config` plus an optional override string into the final
 * `ResolvedProvider` used by `initProvider`. See
 * `specs/llm.md` for the full resolution rules.
 *
 * `override` is the raw value from `--model`/`--provider` or `WRAP_MODEL` —
 * caller picks one (CLI wins over env).
 *
 * `env` is consulted only for the test-sentinel short-circuit
 * (`WRAP_TEST_RESPONSE` / `WRAP_TEST_RESPONSES`). Everything else flows from
 * `config` and `override`.
 */
export function resolveProvider(
  config: Config,
  override: string | undefined,
  env: Record<string, string | undefined> = process.env,
): ResolvedProvider {
  if (isTestProviderSelected(env)) return TEST_RESOLVED_PROVIDER;

  const providers = config.providers ?? {};
  const defaultProvider = config.defaultProvider;
  const hasOverride = override !== undefined;

  let providerName: string | undefined;
  let transientModel: string | undefined;

  if (hasOverride) {
    const trimmed = override.trim();
    if (trimmed === "" || trimmed === ":") {
      throw new Error("Config error: --model value is empty.");
    }
    if (trimmed.includes(":")) {
      const colonIdx = trimmed.indexOf(":");
      const namePart = trimmed.slice(0, colonIdx);
      const modelPart = trimmed.slice(colonIdx + 1);
      providerName = namePart === "" ? defaultProvider : namePart;
      transientModel = modelPart === "" ? undefined : modelPart;
    } else if (trimmed in providers) {
      providerName = trimmed;
    } else {
      const modelMatches = Object.entries(providers).filter(([, entry]) => entry.model === trimmed);
      const [firstMatch] = modelMatches;
      if (firstMatch && modelMatches.length === 1) {
        providerName = firstMatch[0];
      } else if (modelMatches.length > 1) {
        throw new Error(
          `Config error: model "${trimmed}" is configured for multiple providers; use provider:model.`,
        );
      } else if (isKnownProvider(trimmed)) {
        throw new Error(`Config error: provider "${trimmed}" not found in config.`);
      } else {
        providerName = defaultProvider;
        transientModel = trimmed;
      }
    }
  } else {
    providerName = defaultProvider;
  }

  function fail(specific: string): never {
    throw new Error(hasOverride ? specific : NO_LLM_ERROR);
  }

  if (!providerName) throw new Error(NO_LLM_ERROR);

  const entry = providers[providerName];
  if (!entry) fail(`Config error: provider "${providerName}" not found in config.`);

  // Per-entry validation runs *before* the no-model check so a structurally
  // invalid entry (e.g. ollama without baseURL) reports the actionable error
  // even when other fields are also missing.
  const validationError = validateProviderEntry(providerName, entry);
  if (validationError) throw new Error(validationError);

  const model = transientModel ?? entry.model;
  if (!model) fail(`Config error: provider "${providerName}" has no model set in config.`);

  return {
    name: providerName,
    model,
    apiKey: entry.apiKey,
    baseURL: entry.baseURL,
  };
}
