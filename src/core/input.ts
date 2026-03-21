export type Input = {
  prompt: string | null;
};

export function parseInput(argv: string[]): Input {
  const args = argv.slice(2);
  if (args.length === 0) return { prompt: null };
  return { prompt: args.join(" ") };
}
