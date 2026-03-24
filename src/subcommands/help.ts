import type { Subcommand } from "./types.ts";

export const helpCmd: Subcommand = {
  flag: "--help",
  description: "Show this help",
  usage: "w --help",
  run: async () => {
    const { subcommands } = await import("./registry.ts");

    const lines = [
      "wrap - natural language shell commands",
      "",
      "Usage: w <prompt>         Run a natural language query",
      "",
      "Flags:",
    ];

    const flagLines = subcommands.map((c) => {
      const argHint = c.arg ? (c.arg.required ? ` <${c.arg.name}>` : ` [${c.arg.name}]`) : "";
      const left = `  ${c.flag}${argHint}`;
      return `${left.padEnd(24)}${c.description}`;
    });

    lines.push(...flagLines);
    process.stdout.write(`${lines.join("\n")}\n`);
  },
};
