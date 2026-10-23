import { ConfigError, loadJsoncConfig, type ProviderEntry } from "wrap-core/config";
import { wrapFs } from "../fs/home.ts";

/** One entry in the providers map — see specs/llm.md. Re-exported from core
 *  (`wrap-core/config`) so there's a single definition; wrap consumers keep
 *  importing it from this module. */
export type { ProviderEntry };

export type Config = {
  providers?: Record<string, ProviderEntry>;
  defaultProvider?: string;
  maxRounds?: number;
  maxCapturedOutputChars?: number;
  maxAttachedInputChars?: number;
  verbose?: boolean;
  noAnimation?: boolean;
  nerdFonts?: boolean;
  yolo?: boolean;
  logTraces?: boolean;
  /** Per-invocation only: resume the previous wrap conversation. */
  continue?: boolean;
  appearance?: "auto" | "dark" | "light";
};

/**
 * Config after the resolver has materialized every SETTINGS default. Every
 * SETTINGS entry with a `default` must appear as a required field below.
 */
export type ResolvedConfig = Config & {
  verbose: boolean;
  noAnimation: boolean;
  nerdFonts: boolean;
  yolo: boolean;
  logTraces: boolean;
  continue: boolean;
  maxRounds: number;
  maxCapturedOutputChars: number;
  maxAttachedInputChars: number;
};

// Compile-time drift check: every SETTINGS entry with a `default` must be a
// required field in ResolvedConfig, or typecheck fails.
type _Settings = typeof import("./settings.ts").SETTINGS;
type _KeysWithDefault = {
  [K in keyof _Settings]: _Settings[K] extends { default: unknown } ? K : never;
}[keyof _Settings];
type _RequiredKeys<T> = {
  [K in keyof T]-?: undefined extends T[K] ? never : K;
}[keyof T];
type _AssertTrue<T extends true> = T;
export type _DriftCheck = _AssertTrue<
  _KeysWithDefault extends _RequiredKeys<ResolvedConfig> ? true : false
>;

export const CONFIG_FILENAME = "config.jsonc";

/**
 * Load the on-disk config (under `wrapFs.root`) and merge in any
 * `WRAP_CONFIG` env override.
 *
 * `envOverrides` exists for the `WRAP_CONFIG` test/CI override only —
 * `WRAP_HOME` is resolved at startup by `wrapFs` and cannot be overridden
 * here. Defaults to `process.env`.
 *
 * Delegates file ingestion + env-override folding to `wrap-core/config`. Core
 * takes a COMPLETE env map (it reads `opts.env ?? process.env`, no merge), so
 * wrap does the `{ ...process.env, ...envOverrides }` merge itself. Core's
 * bare `ConfigError` messages are dressed in wrap's "Config error:" voice here.
 */
export function loadConfig(envOverrides: Record<string, string | undefined> = {}): Config {
  try {
    return loadJsoncConfig<Config>(wrapFs, CONFIG_FILENAME, {
      envOverrideVar: "WRAP_CONFIG",
      env: { ...process.env, ...envOverrides },
    });
  } catch (e) {
    if (e instanceof ConfigError) throw new Error(`Config error: ${e.message}`);
    throw e;
  }
}
