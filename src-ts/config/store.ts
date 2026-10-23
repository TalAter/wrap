import type { Config, ResolvedConfig } from "./config.ts";

let store: ResolvedConfig | null = null;

export function setConfig(config: ResolvedConfig): void {
  store = config;
}

/** Throws if called before `setConfig`. */
export function getConfig(): ResolvedConfig {
  if (!store) throw new Error("Config accessed before initialization");
  return store;
}

/**
 * Shallow-merge a patch into the current config. Skips keys whose value is
 * `undefined` so a patch can't silently clear a required field.
 */
export function updateConfig(patch: Partial<Config>): void {
  if (!store) throw new Error("Config accessed before initialization");
  const next: Record<string, unknown> = { ...store };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) next[k] = v;
  }
  store = next as ResolvedConfig;
}
