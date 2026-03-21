import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ParseError, parse } from "jsonc-parser";

export type ProviderConfig = { type: string };

export type ClaudeCodeProviderConfig = ProviderConfig & {
  type: "claude-code";
  model?: string;
};

export type TestProviderConfig = ProviderConfig & {
  type: "test";
};

export type Config = {
  provider?: ProviderConfig;
};

const CONFIG_FILENAME = "config.jsonc";

function resolveConfigDir(env: Record<string, string | undefined>): string {
  return env.WRAP_HOME ?? join(homedir(), ".wrap");
}

function loadFileConfig(configDir: string): Config {
  const path = join(configDir, CONFIG_FILENAME);
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
  const configDir = resolveConfigDir(env);
  const fileConfig = loadFileConfig(configDir);
  const envConfig = loadEnvConfig(env);

  if (envConfig === undefined) return fileConfig;

  // Shallow merge: env overrides top-level keys, nested objects replaced entirely
  return { ...fileConfig, ...envConfig };
}
