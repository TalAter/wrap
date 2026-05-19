import { type ParseError, parse } from "jsonc-parser";
import { wrapFs } from "../fs/home.ts";

/** One entry in the providers map — see specs/llm.md. */
export type ProviderEntry = {
  apiKey?: string;
  baseURL?: string;
  model?: string;
};

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

function loadFileConfig(): Config {
  const raw = wrapFs.read(CONFIG_FILENAME);
  if (raw === null) return {};

  const errors: ParseError[] = [];
  const parsed = parse(raw, errors, { allowTrailingComma: true });

  if (errors.length > 0) {
    throw new Error(`Config error: ${CONFIG_FILENAME} contains invalid JSON.`);
  }

  return parsed ?? {};
}

function loadEnvConfig(env: Record<string, string | undefined>): Config | undefined {
  const raw = env.WRAP_CONFIG?.trim();
  if (!raw) return undefined;

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Config error: WRAP_CONFIG contains invalid JSON.");
  }
}

/**
 * Load the on-disk config (under `wrapFs.root`) and merge in any
 * `WRAP_CONFIG` env override.
 *
 * `envOverrides` exists for the `WRAP_CONFIG` test/CI override only —
 * `WRAP_HOME` is resolved at startup by `wrapFs` and cannot be overridden
 * here. Defaults to `process.env`.
 */
export function loadConfig(envOverrides: Record<string, string | undefined> = {}): Config {
  const env = { ...process.env, ...envOverrides };
  const fileConfig = loadFileConfig();
  const envConfig = loadEnvConfig(env);

  if (envConfig === undefined) return fileConfig;

  // Shallow merge: env overrides top-level keys, nested objects replaced entirely
  return { ...fileConfig, ...envConfig };
}
