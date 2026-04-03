import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ParseError, parse } from "jsonc-parser";
import { getWrapHome } from "../core/home.ts";
import type { ProviderConfig } from "../llm/types.ts";

export type Config = {
  provider?: ProviderConfig;
  maxRounds?: number;
  maxProbeOutputChars?: number;
  verbose?: boolean;
};

export const DEFAULT_MAX_ROUNDS = 5;
export const DEFAULT_MAX_PROBE_OUTPUT_CHARS = 200_000;

const CONFIG_FILENAME = "config.jsonc";

function loadFileConfig(wrapHome: string): Config {
  const path = join(wrapHome, CONFIG_FILENAME);
  if (!existsSync(path)) return {};

  const raw = readFileSync(path, "utf-8");
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
