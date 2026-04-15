import { SETTINGS, type Setting } from "../config/settings.ts";
import { helpCmd } from "./help.ts";
import { logCmd } from "./log.ts";
import type { Command, Option } from "./types.ts";
import { versionCmd } from "./version.ts";

type FlaggedSetting = Setting & { flag: readonly [string, ...string[]] };

function hasFlag(entry: [string, Setting]): entry is [string, FlaggedSetting] {
  return !!entry[1].flag && entry[1].flag.length > 0;
}

function settingToOption(id: string, s: FlaggedSetting): Option {
  const [primary, ...aliases] = s.flag;
  return {
    kind: "option",
    flag: primary,
    aliases: aliases.length > 0 ? aliases : undefined,
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
  .filter(hasFlag)
  .map(([id, s]) => settingToOption(id, s));
