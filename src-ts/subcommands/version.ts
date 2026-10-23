import pkg from "../../package.json";
import { chrome } from "../core/output.ts";
import type { Command } from "./types.ts";

export const versionCmd: Command = {
  kind: "command",
  flag: "--version",
  aliases: ["-v"],
  id: "version",
  description: "Show version",
  usage: "w --version",
  run: async (args) => {
    if (args.length > 0) {
      chrome("--version does not take an argument.");
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${pkg.version}\n`);
  },
};
