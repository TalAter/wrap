import type { Modifiers } from "../core/input.ts";
import type { Config } from "./config.ts";
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
 * `model` is virtual: its value is resolved separately via `resolveProvider`,
 * so the `model` setting is skipped here and does not appear in the output.
 */
export function resolveSettings(
  modifiers: Modifiers,
  env: Record<string, string | undefined>,
  fileConfig: Config,
): Config {
  const result: Config = { ...fileConfig };

  for (const [key, setting] of Object.entries(SETTINGS) as [string, Setting][]) {
    if (key === "model") continue;

    const value = resolveOne(key, setting, modifiers, env, fileConfig);
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }

  // Env-wide capability signals force noAnimation regardless of the per-setting
  // layers: CI redraw logs are garbage, dumb terminals can't move the cursor,
  // and NO_COLOR users generally want a quiet terminal.
  if (isAnimationDisabledByEnv(env)) {
    result.noAnimation = true;
  }

  return result;
}

function isAnimationDisabledByEnv(env: Record<string, string | undefined>): boolean {
  return "CI" in env || env.TERM === "dumb" || "NO_COLOR" in env;
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
    if (v !== undefined) return coerce(setting.type, v);
  }

  // Env layer
  for (const name of setting.env ?? []) {
    const v = env[name];
    if (v === undefined) continue;
    if (setting.type === "boolean") return true;
    return coerce(setting.type, v);
  }

  // File layer
  const fileValue = (fileConfig as Record<string, unknown>)[key];
  if (fileValue !== undefined) return fileValue as boolean | number | string;

  // Default
  return setting.default;
}

function coerce(type: "string" | "number", raw: string): string | number {
  if (type === "string") return raw;
  const n = Number(raw);
  if (Number.isNaN(n)) {
    throw new Error(`Config error: expected a number, got "${raw}".`);
  }
  return n;
}
