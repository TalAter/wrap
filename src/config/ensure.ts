import { chrome } from "../core/output.ts";
import { fetchCached } from "../fs/cache.ts";
import { getWrapHome, readWrapFile, writeWrapFile } from "../fs/home.ts";
import { CLI_PROVIDERS } from "../llm/providers/registry.ts";
import {
  mountConfigWizardDialog,
  preloadDialogModules,
  type WizardResult,
} from "../session/dialog-host.ts";
import type { ModelsDevData } from "../wizard/models-filter.ts";
import { writeWizardConfig } from "../wizard/write-config.ts";
import configSchema from "./config.schema.json" with { type: "json" };
import { CONFIG_FILENAME, type Config, loadConfig } from "./config.ts";

const MODELS_URL = "https://models.dev/api.json";
const MODELS_CACHE_PATH = "cache/models.dev.json";
const MODELS_TTL_MS = 24 * 60 * 60 * 1000;

async function fetchModels(): Promise<ModelsDevData> {
  try {
    const { content } = await fetchCached({
      url: MODELS_URL,
      path: MODELS_CACHE_PATH,
      ttlMs: MODELS_TTL_MS,
    });
    return JSON.parse(content);
  } catch {
    throw new Error(
      `Config error: could not load model list from ${MODELS_URL}. Check your connection and try again.`,
    );
  }
}

function probeCliBinaries(): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const [name, entry] of Object.entries(CLI_PROVIDERS)) {
    result[name] = Bun.which(entry.probeCmd) !== null;
  }
  return result;
}

function writeSchema(home: string): void {
  writeWrapFile("config.schema.json", JSON.stringify(configSchema, null, 2), home);
}

/**
 * Options for `ensureConfig`. Production callers pass env overrides;
 * tests pass `_testWizardResult` to bypass the interactive wizard.
 */
export type EnsureConfigOptions = {
  WRAP_HOME?: string;
  /** Test-only: bypass wizard UI. `null` simulates cancel. */
  _testWizardResult?: WizardResult | null;
};

/**
 * If `config.jsonc` exists, load and return it. Otherwise launch the
 * interactive wizard, write the result, and return the fresh config.
 * On user cancel, exits with code 0.
 */
export async function ensureConfig(opts: EnsureConfigOptions = {}): Promise<Config> {
  const env = opts.WRAP_HOME ? { ...process.env, WRAP_HOME: opts.WRAP_HOME } : process.env;
  const home = getWrapHome(env);

  const envOverrides = opts.WRAP_HOME ? { WRAP_HOME: opts.WRAP_HOME } : {};

  // Skip wizard when config exists on disk or was injected via WRAP_CONFIG.
  const existing = readWrapFile(CONFIG_FILENAME, home);
  if (existing !== null || env.WRAP_CONFIG) {
    return loadConfig(envOverrides);
  }

  let result: WizardResult | null;
  if ("_testWizardResult" in opts) {
    result = opts._testWizardResult ?? null;
  } else {
    await preloadDialogModules();
    result = await mountConfigWizardDialog({
      fetchModels,
      probeCliBinaries,
    });
  }

  if (!result) {
    process.exit(0);
    throw new Error("unreachable"); // satisfy TS return type
  }

  writeWizardConfig(result, home);
  writeSchema(home);
  chrome("Configuration saved", "🧠");
  return loadConfig(envOverrides);
}
