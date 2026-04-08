import type { ProviderEntry } from "../../config/config.ts";

/**
 * Provider taxonomy — the single source of truth for which built-in provider
 * names Wrap recognizes and how each one is handled. Adding a built-in means
 * adding one entry here. Adding a brand-new SDK family (e.g. a third
 * `kind`) means extending the union, the `initProvider` dispatch, and the
 * factory file — all in one obvious place.
 *
 * `kind` distinguishes the runtime SDK family:
 *  - `anthropic`     → AI SDK Anthropic factory
 *  - `openai-compat` → AI SDK OpenAI factory (also covers ollama and any
 *                     unknown OpenAI-compatible endpoint)
 *  - `claude-code`   → `claude` CLI subprocess
 *
 * `validate` (optional) runs at config-resolution time. It returns a
 * Wrap-prefixed error message if the entry is structurally invalid for this
 * provider, or `null` if it's fine.
 */
export type ProviderKind = "anthropic" | "openai-compat" | "claude-code";

export type ProviderRegistration = {
  kind: ProviderKind;
  validate?: (entry: ProviderEntry) => string | null;
};

export const KNOWN_PROVIDERS: Record<string, ProviderRegistration> = {
  anthropic: { kind: "anthropic" },
  openai: { kind: "openai-compat" },
  ollama: {
    kind: "openai-compat",
    validate: (entry) =>
      entry.baseURL ? null : 'Config error: provider "ollama" requires baseURL.',
  },
  "claude-code": { kind: "claude-code" },
};

/**
 * Get the registration for a provider name. Unknown names default to
 * `openai-compat` — they're treated as user-defined OpenAI-compatible
 * endpoints (groq, together, fireworks, …).
 */
export function getRegistration(name: string): ProviderRegistration {
  return KNOWN_PROVIDERS[name] ?? { kind: "openai-compat" };
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
  const known = KNOWN_PROVIDERS[name];
  if (known) return known.validate?.(entry) ?? null;
  if (!entry.baseURL || !entry.apiKey || !entry.model) {
    return `Config error: provider "${name}" requires baseURL, apiKey, and model.`;
  }
  return null;
}
