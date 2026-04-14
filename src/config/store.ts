import type { Config, ResolvedConfig } from "./config.ts";

let store: ResolvedConfig | null = null;

/**
 * Replace the global config with a post-resolver snapshot. Callers must go
 * through `resolveSettings()` to produce a ResolvedConfig — there is no path
 * that stores a raw partial. Tests use the `seedTestConfig()` helper.
 */
export function setConfig(config: ResolvedConfig): void {
  store = config;
}

/**
 * Read the global config. Throws if called before `setConfig`. Returns a
 * ResolvedConfig — every SETTINGS-with-default field is guaranteed defined
 * because the only way to get into the store is via `resolveSettings`.
 */
export function getConfig(): ResolvedConfig {
  if (!store) throw new Error("Config accessed before initialization");
  return store;
}

/**
 * Shallow-merge a patch into the current resolved config. Used by the config
 * wizard which builds up user choices incrementally on top of a seeded base.
 *
 * Keys whose patch value is `undefined` are skipped so a patch can't silently
 * clear a required field and corrupt the store's ResolvedConfig invariant.
 */
export function updateConfig(patch: Partial<Config>): void {
  if (!store) throw new Error("Config accessed before initialization");
  const next: Record<string, unknown> = { ...store };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) next[k] = v;
  }
  store = next as ResolvedConfig;
}
