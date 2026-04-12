import { type ParseError, parse } from "jsonc-parser";
import { getWrapHome } from "../core/home.ts";
import { readWrapFile } from "../core/home-dir.ts";

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
};

export const DEFAULT_MAX_ROUNDS = 5;
export const DEFAULT_MAX_CAPTURED_OUTPUT_CHARS = 200_000;
export const DEFAULT_MAX_PIPED_INPUT_CHARS = 200_000;

const CONFIG_FILENAME = "config.jsonc";

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
