import type { Modifiers } from "../core/input.ts";
import { parseModelOverride } from "../llm/resolve-provider.ts";
import type { Config, ResolvedConfig } from "./config.ts";
import { SETTINGS, type Setting } from "./settings.ts";

/**
 * Merge CLI modifiers, environment, and file config into a final `Config`.
 *
 * Precedence per setting: CLI > env > file > default.
 *
 * The resolver always rebuilds from layers — never incremental-merges onto an
 * existing store. Callers pass the file config as the baseline and the output
 * is a complete Config. File fields not in SETTINGS (e.g. `providers`) pass
 * through untouched.
 *
 * `model` is special: its value doesn't become a `config.model` field because
 * an override like `anthropic:claude-opus` normalizes into two existing
 * fields — `defaultProvider` and `providers[name].model`. That normalization
 * needs a populated `providers` map, so it lives in `applyModelOverride`
 * (called from the session path in `main.ts`, not the pre-dispatch seed).
 */
export function resolveSettings(
  modifiers: Modifiers,
  env: Record<string, string | undefined>,
  fileConfig: Config,
): ResolvedConfig {
  const result: Record<string, unknown> = { ...fileConfig };

  for (const [key, setting] of Object.entries(SETTINGS) as [string, Setting][]) {
    if (key === "model") continue;

    const value = resolveOne(key, setting, modifiers, env, fileConfig);
    if (value !== undefined) {
      result[key] = value;
    }
  }

  // Env-wide capability signals force noAnimation regardless of the per-setting
  // layers: CI redraw logs are garbage, dumb terminals can't move the cursor,
  // and NO_COLOR users generally want a quiet terminal.
  if (isAnimationDisabledByEnv(env)) {
    result.noAnimation = true;
  }

  // Every SETTINGS-with-default has contributed a value above, so the
  // ResolvedConfig required-field contract is satisfied.
  return result as ResolvedConfig;
}

function isAnimationDisabledByEnv(env: Record<string, string | undefined>): boolean {
  return isCiActive(env) || env.TERM === "dumb" || "NO_COLOR" in env;
}

// CI is presence-ish but `CI=false` / `CI=0` is a real convention in shells
// that inherit the var outside of an actual CI run.
function isCiActive(env: Record<string, string | undefined>): boolean {
  const v = env.CI;
  if (v === undefined) return false;
  return !FALSY.has(v.trim().toLowerCase());
}

function resolveOne(
  key: string,
  setting: Setting,
  modifiers: Modifiers,
  env: Record<string, string | undefined>,
  fileConfig: Config,
): boolean | number | string | undefined {
  // CLI layer
  if (setting.type === "boolean") {
    if (modifiers.flags.has(key)) return true;
  } else {
    const v = modifiers.values.get(key);
    if (v !== undefined) return coerce(setting.type, v, key);
  }

  // Env layer
  for (const name of setting.env ?? []) {
    const v = env[name];
    if (v === undefined) continue;
    if (setting.type === "boolean") return coerceBoolean(v, name);
    return coerce(setting.type, v, name);
  }

  // File layer
  const fileValue = (fileConfig as Record<string, unknown>)[key];
  if (fileValue !== undefined) return fileValue as boolean | number | string;

  // Default
  return setting.default;
}

function coerce(type: "string" | "number", raw: string, source: string): string | number {
  if (type === "string") return raw;
  const n = Number(raw);
  if (Number.isNaN(n)) {
    throw new Error(`Config error: ${source} expected a number, got "${raw}".`);
  }
  return n;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off", ""]);

function coerceBoolean(raw: string, source: string): boolean {
  const v = raw.trim().toLowerCase();
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  throw new Error(
    `Config error: ${source} expected 1/true/yes/on or 0/false/no/off, got "${raw}".`,
  );
}

/**
 * Resolve the `--model`/`WRAP_MODEL` override (via SETTINGS.model sources) and
 * normalize it into the config's `defaultProvider` and
 * `providers[name].model` fields.
 *
 * Returns the input unchanged when no override is present. Throws on bad
 * overrides (empty, ambiguous, unknown built-in) via `parseModelOverride`.
 *
 * Generic over Config vs ResolvedConfig: the function only touches fields
 * that exist on bare `Config`, so callers that have a ResolvedConfig get one
 * back and callers that have a Config get a Config back — no casts needed.
 */
export function applyModelOverride<T extends Config>(
  config: T,
  modifiers: Modifiers,
  env: Record<string, string | undefined>,
): T {
  const override = readModelOverride(modifiers, env);
  if (override === undefined) return config;

  const providers = config.providers ?? {};
  const { providerName, transientModel } = parseModelOverride(
    override,
    providers,
    config.defaultProvider,
  );

  if (providerName === undefined) {
    // `--model :x` or similar with no defaultProvider to attach the transient
    // model to. Surface a specific message rather than letting resolveProvider
    // throw the generic NO_LLM_ERROR downstream.
    throw new Error(
      `Config error: --model "${override}" has no provider to target. Set defaultProvider in config or use provider:model.`,
    );
  }

  const next: T = { ...config, defaultProvider: providerName };
  if (transientModel !== undefined) {
    next.providers = {
      ...providers,
      [providerName]: { ...providers[providerName], model: transientModel },
    };
  }
  return next;
}

/** Walk SETTINGS.model sources (CLI > env), treating empty env values as absent. */
function readModelOverride(
  modifiers: Modifiers,
  env: Record<string, string | undefined>,
): string | undefined {
  const cli = modifiers.values.get("model");
  if (cli !== undefined) return cli;
  for (const name of SETTINGS.model.env ?? []) {
    const v = env[name];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}
