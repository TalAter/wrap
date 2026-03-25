import { chrome } from "../core/output.ts";
import type { Subcommand } from "./types.ts";

export const versionCmd: Subcommand = {
  flag: "--version",
  description: "Show version",
  usage: "w --version",
  run: async (args) => {
    if (args.length > 0) {
      chrome("--version does not take an argument.");
      process.exit(1);
      return;
    }
    const pkg = await Bun.file(new URL("../../package.json", import.meta.url)).json();
    process.stdout.write(`${pkg.version}\n`);
  },
};
