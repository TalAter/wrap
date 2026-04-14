import { SETTINGS, type Setting } from "../config/settings.ts";
import { helpCmd } from "./help.ts";
import { logCmd } from "./log.ts";
import type { Command, Option } from "./types.ts";
import { versionCmd } from "./version.ts";

function settingToOption(id: string, s: Setting): Option {
  if (!s.flag || s.flag.length === 0) {
    throw new Error(`SETTINGS.${id} has no flag — not eligible as a CLI option.`);
  }
  const [primary, ...aliases] = s.flag;
  return {
    kind: "option",
    flag: primary as string,
    aliases: aliases.length > 0 ? [...aliases] : undefined,
    id,
    takesValue: s.type !== "boolean",
    description: s.description,
    usage: s.usage ?? `w ${primary}`,
    help: s.help,
    env: s.env ? [...s.env] : undefined,
  };
}

export const commands: Command[] = [logCmd, helpCmd, versionCmd];

export const options: Option[] = (Object.entries(SETTINGS) as [string, Setting][])
  .filter(([, s]) => s.flag && s.flag.length > 0)
  .map(([id, s]) => settingToOption(id, s));
