import type { ProviderEntry } from "../../config/config.ts";

/**
 * Provider taxonomy — the single source of truth for which built-in provider
 * names Wrap recognizes and how each one is handled. Adding a built-in means
 * adding one entry to `API_PROVIDERS` or `CLI_PROVIDERS`. Adding a brand-new
 * SDK family (e.g. a third `kind`) means extending the union, the
 * `initProvider` dispatch, and the factory file.
 *
 * Two separate maps instead of one flat registry: API providers carry
 * API-key metadata the wizard needs (key URL, placeholder, recommendation
 * regex); CLI providers carry a `probeCmd` used to detect whether the
 * binary is installed. Co-locating wizard metadata with runtime metadata
 * keeps "add a provider" a single-file change.
 *
 * `kind` distinguishes the runtime SDK family:
 *  - `anthropic`     → AI SDK Anthropic factory
 *  - `openai-compat` → AI SDK OpenAI factory (also covers ollama and any
 *                     unknown OpenAI-compatible endpoint)
 *  - `claude-code`   → `claude` CLI subprocess
 */
export type ProviderKind = "anthropic" | "openai-compat" | "claude-code";

export type ProviderRegistration = {
  kind: ProviderKind;
  validate?: (entry: ProviderEntry) => string | null;
};

export type ApiProvider = {
  displayName: string;
  kind: ProviderKind;
  validate?: (entry: ProviderEntry) => string | null;
  /** URL where the user gets an API key. Shown on the wizard's API-key screen. */
  apiKeyUrl?: string;
  /** Placeholder text shown in the API-key TextInput. */
  apiKeyPlaceholder?: string;
  /**
   * Fallback baseURL when models.dev has no `api` field for this provider
   * (e.g. ollama). The wizard writes this into the config entry verbatim;
   * runtime does not consult this field.
   */
  baseURL?: string;
  /**
   * Matches recommended model names (latest flagship). The wizard pre-picks
   * the newest match in the filtered models.dev list and marks it with a
   * recommendation star.
   */
  recommendedModelRegex?: RegExp;
};

export type CliProvider = {
  displayName: string;
  kind: ProviderKind;
  /** Name of the CLI binary. Wizard probes via `Bun.which(probeCmd)`. */
  probeCmd: string;
};

/**
 * openai-compat providers that use a non-default endpoint need an explicit
 * `baseURL` on their entry — otherwise `@ai-sdk/openai` would dispatch to
 * api.openai.com with a wrong API key and produce confusing errors.
 */
function requiresBaseURL(providerName: string) {
  return (entry: ProviderEntry): string | null =>
    entry.baseURL
      ? null
      : `Config error: provider "${providerName}" requires baseURL.`;
}

/**
 * `Record<string, T>` object-literal key order is stable in modern JS/TS, so
 * the declared order here doubles as the display order on the wizard's
 * provider-selection screen.
 */
export const API_PROVIDERS: Record<string, ApiProvider> = {
  anthropic: {
    displayName: "Anthropic",
    kind: "anthropic",
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    apiKeyPlaceholder: "sk-ant-api03-",
    recommendedModelRegex: /^claude-sonnet-\d+-\d+$/,
  },
  openai: {
    displayName: "OpenAI",
    kind: "openai-compat",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    apiKeyPlaceholder: "sk-proj-",
    recommendedModelRegex: /^gpt-5(\.\d+)?$/,
  },
  // TODO: enable once @ai-sdk/google is bundled and a `kind: "google"` branch
  // lands in this file + ai-sdk.ts. See specs/config-wizard.md Future work.
  // google: {
  //   displayName: "Google (Gemini)",
  //   kind: "google",
  //   apiKeyUrl: "https://aistudio.google.com/apikey",
  //   recommendedModelRegex: /^gemini-\d+(\.\d+)?-pro$/,
  // },
  openrouter: {
    displayName: "OpenRouter",
    kind: "openai-compat",
    apiKeyUrl: "https://openrouter.ai/keys",
    apiKeyPlaceholder: "sk-or-v1-",
    baseURL: "https://openrouter.ai/api/v1",
    validate: requiresBaseURL("openrouter"),
  },
  groq: {
    displayName: "Groq",
    kind: "openai-compat",
    apiKeyUrl: "https://console.groq.com/keys",
    apiKeyPlaceholder: "gsk_",
    validate: requiresBaseURL("groq"),
  },
  mistral: {
    displayName: "Mistral",
    kind: "openai-compat",
    apiKeyUrl: "https://console.mistral.ai/api-keys",
    validate: requiresBaseURL("mistral"),
  },
  ollama: {
    displayName: "Ollama (local)",
    kind: "openai-compat",
    baseURL: "http://localhost:11434/v1",
    validate: requiresBaseURL("ollama"),
  },
};

export const CLI_PROVIDERS: Record<string, CliProvider> = {
  "claude-code": {
    displayName: "Claude Code",
    kind: "claude-code",
    probeCmd: "claude",
  },
};

/** True when `name` has a built-in registration in either map. */
export function isKnownProvider(name: string): boolean {
  return name in API_PROVIDERS || name in CLI_PROVIDERS;
}

/**
 * Get the registration for a provider name. Unknown names default to
 * `openai-compat` — they're treated as user-defined OpenAI-compatible
 * endpoints.
 */
export function getRegistration(name: string): ProviderRegistration {
  const api = API_PROVIDERS[name];
  if (api) return { kind: api.kind, validate: api.validate };
  const cli = CLI_PROVIDERS[name];
  if (cli) return { kind: cli.kind };
  return { kind: "openai-compat" };
}

/**
 * Validate a provider entry. Returns a Wrap-prefixed error message if the
 * entry is structurally invalid for this provider, or `null` if it's fine.
 *
 * Known providers consult their per-entry validator (if any). Unknown
 * providers must supply baseURL, apiKey, and model — without an apiKey, the
 * call would silently send a placeholder string against a real billed
 * endpoint, which is worse than erroring early.
 */
export function validateProviderEntry(name: string, entry: ProviderEntry): string | null {
  if (isKnownProvider(name)) {
    return getRegistration(name).validate?.(entry) ?? null;
  }
  if (!entry.baseURL || !entry.apiKey || !entry.model) {
    return `Config error: provider "${name}" requires baseURL, apiKey, and model.`;
  }
  return null;
}
