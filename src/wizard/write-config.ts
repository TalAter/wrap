import { CONFIG_FILENAME, type Config, type ProviderEntry } from "../config/config.ts";
import { writeWrapFile } from "../fs/home.ts";
import { validateProviderEntry } from "../llm/providers/registry.ts";
import type { WizardResult } from "../session/dialog-host.ts";

/**
 * Pre-write `validateProviderEntry` pass — cheap insurance against wizard
 * bugs producing a file that `resolveProvider` would immediately reject.
 */
export function buildConfig(
  entries: Record<string, ProviderEntry>,
  defaultProvider: string,
  nerdFonts?: boolean,
): Config {
  for (const [name, entry] of Object.entries(entries)) {
    const err = validateProviderEntry(name, entry);
    if (err) throw new Error(err);
  }
  return { providers: entries, defaultProvider, nerdFonts: nerdFonts ?? false };
}

export function serializeConfig(config: Config): string {
  return JSON.stringify({ $schema: "./config.schema.json", ...config }, null, 2);
}

export function writeWizardConfig(result: WizardResult, home?: string): void {
  const config = buildConfig(result.entries, result.defaultProvider, result.nerdFonts);
  writeWrapFile(CONFIG_FILENAME, serializeConfig(config), home);
}
