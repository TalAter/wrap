import { CONFIG_FILENAME, type Config, type ProviderEntry } from "../config/config.ts";
import { writeWrapFile } from "../fs/home.ts";
import { validateProviderEntry } from "../llm/providers/registry.ts";

/**
 * Pre-write `validateProviderEntry` pass — cheap insurance against wizard
 * bugs producing a file that `resolveProvider` would immediately reject.
 */
export function buildConfig(
  entries: Record<string, ProviderEntry>,
  defaultProvider: string,
): Config {
  for (const [name, entry] of Object.entries(entries)) {
    const err = validateProviderEntry(name, entry);
    if (err) throw new Error(err);
  }
  return { providers: entries, defaultProvider };
}

export function serializeConfig(config: Config): string {
  return JSON.stringify({ $schema: "./config.schema.json", ...config }, null, 2);
}

export function writeWizardConfig(
  entries: Record<string, ProviderEntry>,
  defaultProvider: string,
  home?: string,
): void {
  const config = buildConfig(entries, defaultProvider);
  writeWrapFile(CONFIG_FILENAME, serializeConfig(config), home);
}
