export type Input =
  | { type: "prompt"; prompt: string }
  | { type: "flag"; flag: string; args: string[] }
  | { type: "none" };

/**
 * Describes one modifier the parser should recognize. The caller defines
 * specs — `input.ts` has no built-in knowledge of which modifiers exist.
 */
export type ModifierSpec = {
  /** Canonical key written into the resulting `Modifiers`. */
  name: string;
  /** CLI flags that map to this modifier (e.g. `["--model", "--provider"]`). */
  flags: readonly string[];
  /** True for `--flag value` / `--flag=value`; false for boolean toggles. */
  takesValue: boolean;
};

/**
 * Extracted modifiers, split by kind so the type is honest about what each
 * key holds. Booleans live in `flags`; value-taking modifiers in `values`.
 */
export type Modifiers = {
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
};

/**
 * Parse process.argv into modifiers and input.
 * Strips the runtime/script prefix, extracts modifiers, then parses the rest.
 */
export function parseArgs(
  argv: string[],
  specs: readonly ModifierSpec[],
): { modifiers: Modifiers; input: Input } {
  const { modifiers, remaining } = extractModifiers(argv.slice(2), specs);
  return { modifiers, input: parseInput(remaining) };
}

/**
 * Extract modifier flags from leading positions.
 * Only leading args matching a spec are consumed; the first non-match stops
 * extraction. Value-taking modifiers accept both `--flag value` and
 * `--flag=value` forms.
 */
export function extractModifiers(
  args: string[],
  specs: readonly ModifierSpec[],
): { modifiers: Modifiers; remaining: string[] } {
  const flagToSpec = new Map<string, ModifierSpec>();
  for (const spec of specs) {
    for (const flag of spec.flags) flagToSpec.set(flag, spec);
  }

  const flags = new Set<string>();
  const values = new Map<string, string>();
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) break;

    const eqIdx = arg.indexOf("=");
    const flagName = eqIdx > 0 ? arg.slice(0, eqIdx) : arg;
    const spec = flagToSpec.get(flagName);
    if (spec === undefined) break;

    if (!spec.takesValue) {
      if (eqIdx > 0) {
        throw new Error(`Config error: ${flagName} does not take a value.`);
      }
      flags.add(spec.name);
      i++;
      continue;
    }

    if (eqIdx > 0) {
      values.set(spec.name, arg.slice(eqIdx + 1));
      i++;
    } else {
      const next = args[i + 1];
      // Treat the next arg as missing if it's itself a known modifier flag —
      // otherwise `--model --verbose` would silently consume `--verbose` as the
      // model value.
      if (next === undefined || flagToSpec.has(next)) {
        throw new Error(`Config error: ${arg} requires a value.`);
      }
      values.set(spec.name, next);
      i += 2;
    }
  }
  return { modifiers: { flags, values }, remaining: args.slice(i) };
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
