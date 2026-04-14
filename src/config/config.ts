import { type ParseError, parse } from "jsonc-parser";
import { getWrapHome, readWrapFile } from "../fs/home.ts";

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
  maxPipedInputChars?: number;
  verbose?: boolean;
  noAnimation?: boolean;
  nerdFonts?: boolean;
  appearance?: "auto" | "dark" | "light";
};

/**
 * Config after the resolver has materialized every SETTINGS default. The
 * store only holds ResolvedConfigs; the store API enforces this at the type
 * level so `getConfig()` can honestly claim these fields are defined.
 *
 * Callers building a ResolvedConfig go through `resolveSettings()` — there's
 * no other legal path. Tests use the `seedTestConfig()` helper for the same
 * reason.
 *
 * Drift check: every SETTINGS entry with a `default` must appear as a
 * required field here. A runtime test in tests/settings.test.ts asserts the
 * two stay in sync.
 */
export type ResolvedConfig = Config & {
  verbose: boolean;
  noAnimation: boolean;
  nerdFonts: boolean;
  maxRounds: number;
  maxCapturedOutputChars: number;
  maxPipedInputChars: number;
};

// Compile-time drift check: every SETTINGS entry with a `default` must be a
// required (non-optional) field in ResolvedConfig. Adding a defaulted setting
// without updating ResolvedConfig — or vice versa — fails to typecheck.
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

function loadFileConfig(wrapHome: string): Config {
  const raw = readWrapFile(CONFIG_FILENAME, wrapHome);
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

export function loadConfig(envOverrides: Record<string, string | undefined> = {}): Config {
  const env = { ...process.env, ...envOverrides };
  const wrapHome = getWrapHome(env);
  const fileConfig = loadFileConfig(wrapHome);
  const envConfig = loadEnvConfig(env);

  if (envConfig === undefined) return fileConfig;

  // Shallow merge: env overrides top-level keys, nested objects replaced entirely
  return { ...fileConfig, ...envConfig };
}
