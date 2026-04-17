import { describe, expect, test } from "bun:test";
import { API_PROVIDERS, CLI_PROVIDERS } from "../src/llm/providers/registry.ts";
import {
  completionCmd,
  generateZshCompletion,
  runCompletion,
} from "../src/subcommands/completion.ts";
import { commands, options } from "../src/subcommands/registry.ts";
import type { Command } from "../src/subcommands/types.ts";
import { wrap } from "./helpers.ts";

const providers = [...Object.keys(API_PROVIDERS), ...Object.keys(CLI_PROVIDERS)];

describe("generateZshCompletion", () => {
  const script = generateZshCompletion({ commands, options, providers });

  test("starts with #compdef directive so zsh auto-loads it", () => {
    expect(script.startsWith("#compdef w\n")).toBe(true);
  });

  test("defines _w function", () => {
    expect(script).toContain("_w()");
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
      expect(script).toContain(":provider:_w_providers");
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
    expect(result).toContain("--foo=[Fake]:provider:_w_providers");
  });

  test("--completion exposes the supported-shells list as its value completer", () => {
    expect(script).toContain("--completion=[Print shell completion script]:shell:(zsh)");
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
  test.skipIf(!zshPath)("generated script passes `zsh -n` syntax check", async () => {
    const proc = Bun.spawn([zshPath as string, "-n"], {
      stdin: new Blob([script]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });
});

describe("runCompletion", () => {
  test("returns ok for a supported shell", () => {
    expect(runCompletion(["zsh"])).toBe("ok");
  });

  test("rejects missing shell arg with install-instructions hint", () => {
    const result = runCompletion([]);
    expect(result).not.toBe("ok");
    if (result === "ok") return;
    expect(result.error).toContain("requires a shell name");
    expect(result.error).toContain("w --help completion");
  });

  test("rejects empty-string shell arg", () => {
    const result = runCompletion([""]);
    expect(result).not.toBe("ok");
    if (result === "ok") return;
    expect(result.error).toContain("requires a shell name");
  });

  test("rejects too many args", () => {
    const result = runCompletion(["zsh", "extra"]);
    expect(result).not.toBe("ok");
    if (result === "ok") return;
    expect(result.error).toContain("one argument");
  });

  test("rejects unsupported shell with supported list and hint", () => {
    const result = runCompletion(["bash"]);
    expect(result).not.toBe("ok");
    if (result === "ok") return;
    expect(result.error).toContain("bash");
    expect(result.error).toContain("zsh");
    expect(result.error).toContain("w --help completion");
  });
});

describe("--completion subcommand end-to-end", () => {
  test("prints zsh script to stdout with zero exit", async () => {
    const result = await wrap("--completion zsh");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.startsWith("#compdef w\n")).toBe(true);
    expect(result.stderr).toBe("");
  });

  test("completionCmd is exported and registered with shells completer", () => {
    expect(completionCmd.completion).toBe("shells");
  });
});
