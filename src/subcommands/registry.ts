import { helpCmd } from "./help.ts";
import { logCmd, logPrettyCmd } from "./log.ts";
import type { Subcommand } from "./types.ts";
import { versionCmd } from "./version.ts";

export const subcommands: Subcommand[] = [logCmd, logPrettyCmd, helpCmd, versionCmd];
