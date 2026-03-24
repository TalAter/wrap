import type { Subcommand } from "./types.ts";

export const versionCmd: Subcommand = {
  flag: "--version",
  description: "Show version",
  usage: "w --version",
  run: async () => {
    const pkg = await Bun.file(new URL("../../package.json", import.meta.url)).json();
    process.stdout.write(`${pkg.version}\n`);
  },
};
