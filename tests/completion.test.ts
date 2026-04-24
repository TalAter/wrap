import { describe, expect, test } from "bun:test";
import { API_PROVIDERS, CLI_PROVIDERS } from "../src/llm/providers/registry.ts";
import {
  generateBashCompletion,
  generateCompletion,
  generateFishCompletion,
  generateZshCompletion,
  runCompletion,
} from "../src/subcommands/completion.ts";
import { commands, options } from "../src/subcommands/registry.ts";
import type { Command } from "../src/subcommands/types.ts";
import { wrap } from "./helpers.ts";

const providers = [...Object.keys(API_PROVIDERS), ...Object.keys(CLI_PROVIDERS)];

async function assertSyntax(bin: string, flag: string, script: string): Promise<void> {
  const proc = Bun.spawn([bin, flag], {
    stdin: new Blob([script]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
}

describe("generateZshCompletion", () => {
  const script = generateZshCompletion({ commands, options, providers });

  test("starts with #compdef directive so zsh auto-loads it", () => {
    expect(script.startsWith("#compdef wrap\n")).toBe(true);
  });

  test("defines _wrap function by default", () => {
    expect(script).toContain("_wrap()");
  });

  test("parametrizes command name into every identifier and directive", () => {
    const custom = generateZshCompletion({ commands, options, providers }, "foo");
    expect(custom.startsWith("#compdef foo\n")).toBe(true);
    expect(custom).toContain("_foo()");
    expect(custom).toContain("_foo_providers()");
    expect(custom).toContain(":provider:_foo_providers");
    expect(custom).toContain('_foo "$@"');
    // No leak of the default name into the parametrized script.
    expect(custom).not.toContain("_wrap");
    expect(custom).not.toContain("#compdef wrap");
  });

  test("includes every command flag and alias from the registry", () => {
    for (const cmd of commands) {
      expect(script).toContain(cmd.flag);
      for (const alias of cmd.aliases ?? []) expect(script).toContain(alias);
    }
  });

  test("includes every option flag and alias from the registry", () => {
    for (const opt of options) {
      expect(script).toContain(opt.flag);
      for (const alias of opt.aliases ?? []) expect(script).toContain(alias);
    }
  });

  test("attaches description to each flag", () => {
    for (const flag of [...commands, ...options]) {
      expect(script).toContain(`[${flag.description}]`);
    }
  });

  test("flags with aliases emit zsh exclusion list so one hides the other", () => {
    const flagsWithAliases = [...commands, ...options].filter(
      (f) => f.aliases && f.aliases.length > 0,
    );
    expect(flagsWithAliases.length).toBeGreaterThan(0);
    for (const flag of flagsWithAliases) {
      const names = [flag.flag, ...(flag.aliases ?? [])];
      const exclusion = `(${names.join(" ")})`;
      for (const name of names) {
        expect(script).toContain(`'${exclusion}${name}`);
      }
    }
  });

  test("single-name flags do not emit an exclusion list", () => {
    const standalone = [...commands, ...options].filter(
      (f) => !f.aliases || f.aliases.length === 0,
    );
    for (const flag of standalone) {
      // No `(...)` immediately before the flag in its spec line
      expect(script).toMatch(new RegExp(`'${flag.flag}[=\\[]`));
    }
  });

  test("options with completion=providers reference the providers completer", () => {
    // Driven by the setting's `completion: "providers"` field, not by flag id.
    const withProviders = options.filter((o) => o.completion === "providers");
    expect(withProviders.length).toBeGreaterThan(0);
    for (const opt of withProviders) {
      expect(script).toContain(":provider:_wrap_providers");
      expect(script).toMatch(new RegExp(`${opt.flag}=\\[`));
    }
  });

  test("completion=providers is not hardcoded to the id 'model'", () => {
    // Synthesize an option with a different id; generator must still wire it up.
    const fake: Command = {
      kind: "command",
      flag: "--foo",
      id: "totally-not-model",
      description: "Fake",
      usage: "w --foo",
      completion: "providers",
      run: async () => {},
    };
    const result = generateZshCompletion({ commands: [fake], options: [], providers });
    expect(result).toContain("--foo=[Fake]:provider:_wrap_providers");
  });

  test("--completion exposes the supported-shells list as its value completer", () => {
    expect(script).toContain("--completion=[Print shell completion script]:shell:(zsh bash fish)");
  });

  test("boolean options have no value slot", () => {
    const booleans = options.filter((o) => !o.takesValue && !o.completion);
    for (const opt of booleans) {
      expect(script).not.toMatch(new RegExp(`${opt.flag}=\\[`));
    }
  });

  test("includes all known providers in the value completer", () => {
    for (const name of providers) {
      expect(script).toContain(name);
    }
  });

  test("providers completer uses autoremovable colon suffix", () => {
    // `-S ':' -q` — colon inserted, auto-stripped on space/enter
    expect(script).toMatch(/-S ['"]:['"] -q/);
  });

  test("escapes zsh spec specials in descriptions", () => {
    const rogue: Command[] = [
      {
        kind: "command",
        flag: "--rogue",
        id: "rogue",
        description: "It's [dangerous] \\ risky",
        usage: "w --rogue",
        run: async () => {},
      },
    ];
    const rogueScript = generateZshCompletion({ commands: rogue, options: [], providers: [] });
    expect(rogueScript).toContain("It'\\''s [dangerous\\] \\\\ risky");
  });

  const zshPath = Bun.which("zsh");
  test.skipIf(!zshPath)("generated script passes `zsh -n` syntax check", () =>
    assertSyntax(zshPath as string, "-n", script),
  );
});

describe("generateBashCompletion", () => {
  const script = generateBashCompletion({ commands, options, providers });

  test("defines _wrap function and registers via `complete -F _wrap wrap`", () => {
    expect(script).toContain("_wrap()");
    expect(script).toContain("complete -F _wrap wrap");
  });

  test("parametrizes command name", () => {
    const custom = generateBashCompletion({ commands, options, providers }, "w");
    expect(custom).toContain("_w()");
    expect(custom).toContain("complete -F _w w");
    expect(custom).not.toContain("_wrap");
  });

  test("includes every flag and alias in the flag completion word list", () => {
    for (const flag of [...commands, ...options]) {
      expect(script).toContain(flag.flag);
      for (const alias of flag.aliases ?? []) expect(script).toContain(alias);
    }
  });

  test("wires provider completion for options with completion=providers", () => {
    const providerFlags = [...commands, ...options]
      .filter((f) => f.completion === "providers")
      .flatMap((f) => [f.flag, ...(f.aliases ?? [])]);
    expect(providerFlags.length).toBeGreaterThan(0);
    for (const name of providerFlags) {
      expect(script).toContain(name);
    }
    for (const p of providers) expect(script).toContain(`${p}:`);
  });

  test("uses compopt -o nospace for provider colon behavior", () => {
    expect(script).toContain("compopt -o nospace");
  });

  test("wires shell completion for --completion", () => {
    expect(script).toContain("zsh bash fish");
  });

  const bashPath = Bun.which("bash");
  test.skipIf(!bashPath)("passes `bash -n` syntax check", () =>
    assertSyntax(bashPath as string, "-n", script),
  );
});

describe("generateFishCompletion", () => {
  const script = generateFishCompletion({ commands, options, providers });

  test("emits `complete -c wrap` lines by default", () => {
    expect(script).toContain("complete -c wrap");
  });

  test("parametrizes command name", () => {
    const custom = generateFishCompletion({ commands, options, providers }, "w");
    expect(custom).toContain("complete -c w");
    expect(custom).not.toContain("complete -c wrap");
  });

  test("uses -l for long flags and -s for short flags", () => {
    for (const flag of [...commands, ...options]) {
      for (const name of [flag.flag, ...(flag.aliases ?? [])]) {
        if (name.startsWith("--")) expect(script).toContain(`-l ${name.slice(2)}`);
        else if (name.startsWith("-")) expect(script).toContain(`-s ${name.slice(1)}`);
      }
    }
  });

  test("attaches a -d segment on every flag line", () => {
    const lines = script.split("\n");
    for (const flag of [...commands, ...options]) {
      for (const name of [flag.flag, ...(flag.aliases ?? [])]) {
        const token = name.startsWith("--") ? `-l ${name.slice(2)}` : `-s ${name.slice(1)}`;
        const line = lines.find((l: string) => l.includes(` ${token} `) || l.endsWith(` ${token}`));
        expect(line).toBeDefined();
        expect(line).toContain(" -d ");
      }
    }
  });

  test("marks value-taking flags with -x and wires provider/shell lists", () => {
    expect(script).toMatch(/-l model[^\n]*-x[^\n]*-a '[^']*anthropic/);
    expect(script).toMatch(/-l completion[^\n]*-x[^\n]*-a 'zsh bash fish'/);
  });

  test("escapes backslash and apostrophe in descriptions", () => {
    const rogue: Command[] = [
      {
        kind: "command",
        flag: "--rogue",
        id: "rogue",
        description: "It's risky\\",
        usage: "w --rogue",
        run: async () => {},
      },
    ];
    const rogueScript = generateFishCompletion({ commands: rogue, options: [], providers: [] });
    expect(rogueScript).toContain("It\\'s risky\\\\");
  });

  const fishPath = Bun.which("fish");
  test.skipIf(!fishPath)("passes `fish --no-execute` syntax check", () =>
    assertSyntax(fishPath as string, "--no-execute", script),
  );
});

describe("generateCompletion dispatcher", () => {
  const registry = { commands, options, providers };

  test("zsh dispatches to generateZshCompletion", () => {
    expect(generateCompletion("zsh", registry)).toBe(generateZshCompletion(registry));
  });

  test("bash dispatches to generateBashCompletion", () => {
    expect(generateCompletion("bash", registry)).toBe(generateBashCompletion(registry));
  });

  test("fish dispatches to generateFishCompletion", () => {
    expect(generateCompletion("fish", registry)).toBe(generateFishCompletion(registry));
  });
});

describe("runCompletion", () => {
  test("returns ok for a supported shell", () => {
    expect(runCompletion(["zsh"])).toEqual({ ok: true, shell: "zsh", executableName: "wrap" });
  });

  test("rejects missing shell arg with install-instructions hint", () => {
    const result = runCompletion([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("requires a shell name");
    expect(result.error).toContain("wrap --help completion");
  });

  test("rejects empty-string shell arg", () => {
    const result = runCompletion([""]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("requires a shell name");
  });

  test("rejects too many args", () => {
    const result = runCompletion(["zsh", "w", "extra"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("at most two arguments");
  });

  test("accepts optional executable name arg", () => {
    expect(runCompletion(["zsh", "w"])).toEqual({ ok: true, shell: "zsh", executableName: "w" });
    expect(runCompletion(["bash", "myalias"])).toEqual({
      ok: true,
      shell: "bash",
      executableName: "myalias",
    });
  });

  test.each([
    ["bad name", "whitespace"],
    ["1wrap", "leading digit"],
    ["my-wrap", "hyphen (rejected — not valid as bash function identifier)"],
    ["wräp", "non-ASCII letter"],
    ["wrap;rm", "shell metacharacter"],
    ["wrap$(pwd)", "command substitution"],
    ["", "empty string"],
  ])("rejects invalid executable name %p (%s)", (badName) => {
    const result = runCompletion(["zsh", badName]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("executable name");
    expect(result.error).toContain("shell function identifier");
  });

  test("accepts bash and fish", () => {
    expect(runCompletion(["bash"])).toEqual({ ok: true, shell: "bash", executableName: "wrap" });
    expect(runCompletion(["fish"])).toEqual({ ok: true, shell: "fish", executableName: "wrap" });
  });

  test("rejects unsupported shell with supported list and hint", () => {
    const result = runCompletion(["powershell"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("powershell");
    expect(result.error).toContain("zsh");
    expect(result.error).toContain("bash");
    expect(result.error).toContain("fish");
    expect(result.error).toContain("wrap --help completion");
  });
});

describe("--completion subcommand end-to-end", () => {
  // One e2e per subcommand verifies the CLI plumbing (stdout discipline, exit
  // code, no stderr chrome). Per-shell output is covered by the dispatcher
  // unit tests — no need to spawn a subprocess per shell.
  test("prints script to stdout with zero exit and no stderr", async () => {
    const result = await wrap("--completion zsh");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.startsWith("#compdef wrap\n")).toBe(true);
    expect(result.stderr).toBe("");
  });

  test("accepts positional name arg to override the registered command", async () => {
    const result = await wrap("--completion zsh w");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.startsWith("#compdef w\n")).toBe(true);
    expect(result.stdout).toContain("_w()");
    expect(result.stderr).toBe("");
  });

  test("unsupported shell writes error to stderr, empty stdout, non-zero exit", async () => {
    const result = await wrap("--completion bogusshell");
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unsupported shell");
    expect(result.stderr).toContain("bogusshell");
    expect(result.exitCode).not.toBe(0);
  });
});
