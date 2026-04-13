import type { Config } from "./config.ts";

let store: Config | null = null;

/** Replace the global config. Idempotent — safe to call multiple times. */
export function setConfig(config: Config): void {
  store = config;
}

/** Read the global config. Throws if called before setConfig(). */
export function getConfig(): Config {
  if (!store) throw new Error("Config accessed before initialization");
  return store;
}

/** Shallow-merge a partial update into the current config. */
export function updateConfig(patch: Partial<Config>): void {
  if (!store) throw new Error("Config accessed before initialization");
  store = { ...store, ...patch };
}
