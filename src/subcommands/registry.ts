import { helpCmd } from "./help.ts";
import { logCmd } from "./log.ts";
import type { Subcommand } from "./types.ts";
import { versionCmd } from "./version.ts";

export const subcommands: Subcommand[] = [logCmd, helpCmd, versionCmd];
