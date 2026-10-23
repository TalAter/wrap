import { validateProviderEntry } from "wrap-core/llm";
import { CONFIG_FILENAME, type Config, type ProviderEntry } from "../config/config.ts";
import { wrapFs } from "../fs/home.ts";
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
    // Core's validator messages are bare plain language — wrap's category
    // prefix is applied here, at the surfacing site.
    const err = validateProviderEntry(name, entry);
    if (err) throw new Error(`Config error: ${err}`);
  }
  return { providers: entries, defaultProvider, nerdFonts: nerdFonts ?? false };
}

export function serializeConfig(config: Config): string {
  return JSON.stringify({ $schema: "./config.schema.json", ...config }, null, 2);
}

export function writeWizardConfig(result: WizardResult): void {
  const config = buildConfig(result.entries, result.defaultProvider, result.nerdFonts);
  wrapFs.write(CONFIG_FILENAME, serializeConfig(config));
}
