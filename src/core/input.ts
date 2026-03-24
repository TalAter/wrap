export type Input =
  | { type: "prompt"; prompt: string }
  | { type: "flag"; flag: string; arg: string | null }
  | { type: "none" };

export function parseInput(argv: string[]): Input {
  const args = argv.slice(2);
  if (args.length === 0) return { type: "none" };

  const first = args[0];
  if (first?.startsWith("--")) {
    return { type: "flag", flag: first, arg: args[1] ?? null };
  }

  return { type: "prompt", prompt: args.join(" ") };
}
