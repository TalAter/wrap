export type Input =
  | { type: "prompt"; prompt: string }
  | { type: "flag"; flag: string; args: string[] }
  | { type: "none" };

export type Modifiers = { verbose: boolean };

const KNOWN_MODIFIERS: Record<string, keyof Modifiers> = {
  "--verbose": "verbose",
};

/**
 * Parse process.argv into modifiers and input.
 * Strips the runtime/script prefix, extracts modifiers, then parses the rest.
 */
export function parseArgs(argv: string[]): { modifiers: Modifiers; input: Input } {
  const { modifiers, remaining } = extractModifiers(argv.slice(2));
  return { modifiers, input: parseInput(remaining) };
}

/**
 * Extract modifier flags from leading positions.
 * Only leading args that are known modifiers are consumed;
 * the first non-modifier stops extraction.
 */
export function extractModifiers(args: string[]): {
  modifiers: Modifiers;
  remaining: string[];
} {
  const modifiers: Modifiers = { verbose: false };
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) break;
    const key = KNOWN_MODIFIERS[arg];
    if (key === undefined) break;
    modifiers[key] = true;
    i++;
  }
  return { modifiers, remaining: args.slice(i) };
}

/** Parse user args into an Input. */
export function parseInput(args: string[]): Input {
  if (args.length === 0) return { type: "none" };

  const first = args[0];
  if (first?.startsWith("-")) {
    return { type: "flag", flag: first, args: args.slice(1) };
  }

  return { type: "prompt", prompt: args.join(" ") };
}
