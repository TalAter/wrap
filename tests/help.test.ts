import { describe, expect, test } from "bun:test";
import { stripAnsi } from "../src/core/ansi.ts";
import {
  animationFits,
  buildDiffEscape,
  renderFlagHelp,
  renderPlain,
  renderStyled,
} from "../src/subcommands/help.ts";
import type { CLIFlag } from "../src/subcommands/types.ts";
import { wrap } from "./helpers.ts";

const testCmds: CLIFlag[] = [
  {
    kind: "command",
    flag: "--foo",
    id: "foo",
    description: "Do foo",
    usage: "w --foo",
    run: async () => {},
  },
  {
    kind: "command",
    flag: "--bar",
    id: "bar",
    description: "Do bar",
    usage: "w --bar [n]",
    run: async () => {},
  },
];

const testOpts: CLIFlag[] = [
  {
    kind: "option",
    flag: "--baz",
    id: "baz",
    description: "Do baz",
    usage: "w --baz <val>",
    takesValue: true,
  },
];

describe("renderPlain", () => {
  test("returns text without ANSI escape codes", () => {
    const result = renderPlain(testCmds, testOpts);
    expect(result).not.toContain("\x1b[");
  });

  test("includes commands from provided list", () => {
    const result = renderPlain(testCmds, testOpts);
    expect(result).toContain("--foo");
    expect(result).toContain("--bar [n]");
  });

  test("includes options from provided list", () => {
    const result = renderPlain(testCmds, testOpts);
    expect(result).toContain("--baz <val>");
    expect(result).toContain("Do baz");
  });

  test("includes command and option descriptions", () => {
    const result = renderPlain(testCmds, testOpts);
    expect(result).toContain("Do foo");
    expect(result).toContain("Do bar");
  });

  test("includes usage line", () => {
    const result = renderPlain(testCmds, testOpts);
    expect(result).toContain("Usage:");
    expect(result).toContain("w <prompt>");
  });

  test("includes Commands and Options section headers", () => {
    const result = renderPlain(testCmds, testOpts);
    expect(result).toContain("Commands:");
    expect(result).toContain("Options:");
  });
});

describe("renderStyled", () => {
  test("returns text with truecolor ANSI escape codes at level 3", () => {
    const result = renderStyled(testCmds, testOpts, 3);
    expect(result).toContain("\x1b[38;2;");
  });

  test("returns 256-color indexed codes at level 2", () => {
    const result = renderStyled(testCmds, testOpts, 2);
    expect(result).toContain("\x1b[38;5;");
    expect(result).not.toContain("\x1b[38;2;");
  });

  test("returns basic 16-color codes at level 1", () => {
    const result = renderStyled(testCmds, testOpts, 1);
    expect(result).not.toContain("\x1b[38;2;");
    expect(result).not.toContain("\x1b[38;5;");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape
    expect(result).toMatch(/\x1b\[3[0-7]m|\x1b\[9[0-7]m/);
  });

  test("includes flags when stripped", () => {
    const result = renderStyled(testCmds, testOpts, 3);
    const plain = stripAnsi(result);
    expect(plain).toContain("--foo");
    expect(plain).toContain("--bar [n]");
    expect(plain).toContain("--baz <val>");
  });

  test("includes block character art", () => {
    const result = renderStyled(testCmds, testOpts, 3);
    const plain = stripAnsi(result);
    expect(plain).toContain("█");
  });

  test("includes gradient bar", () => {
    const result = renderStyled(testCmds, testOpts, 3);
    const plain = stripAnsi(result);
    expect(plain).toContain("─");
  });

  test("includes tagline", () => {
    const result = renderStyled(testCmds, testOpts, 3);
    const plain = stripAnsi(result);
    expect(plain).toContain("natural language shell commands");
  });

  test("contains same flags as renderPlain", () => {
    const plain = renderPlain(testCmds, testOpts);
    const styled = stripAnsi(renderStyled(testCmds, testOpts, 3));
    const flagLines = plain.split("\n").filter((l) => l.match(/^ {2}--/));
    expect(flagLines.length).toBe(testCmds.length + testOpts.length);
    for (const line of flagLines) {
      expect(styled).toContain(line);
    }
  });
});

describe("renderFlagHelp", () => {
  test("includes usage and description", () => {
    const cmd: CLIFlag = {
      kind: "command",
      flag: "--foo",
      id: "foo",
      description: "Do foo",
      usage: "w --foo [bar]",
      run: async () => {},
    };
    const result = renderFlagHelp(cmd);
    expect(result).toContain("w --foo [bar]");
    expect(result).toContain("Do foo");
  });

  test("includes help text when present", () => {
    const cmd: CLIFlag = {
      kind: "command",
      flag: "--foo",
      id: "foo",
      description: "Do foo",
      usage: "w --foo",
      help: "Extra details here.",
      run: async () => {},
    };
    const result = renderFlagHelp(cmd);
    expect(result).toContain("Extra details here.");
  });

  test("omits help section when absent", () => {
    const cmd: CLIFlag = {
      kind: "command",
      flag: "--foo",
      id: "foo",
      description: "Do foo",
      usage: "w --foo",
      run: async () => {},
    };
    const lines = renderFlagHelp(cmd).trimEnd().split("\n");
    expect(lines.length).toBe(3); // usage, blank, description
  });

  test("works for option flags", () => {
    const opt: CLIFlag = {
      kind: "option",
      flag: "--baz",
      id: "baz",
      description: "Do baz",
      usage: "w --baz <val>",
      help: "Baz details.",
      takesValue: true,
    };
    const result = renderFlagHelp(opt);
    expect(result).toContain("w --baz <val>");
    expect(result).toContain("Baz details.");
  });
});

describe("buildDiffEscape", () => {
  test("identical frames emit no paints, cursor returns to origin", () => {
    const frame = [["a", "b", "c"]];
    const out = buildDiffEscape(frame, frame);
    expect(out).toBe("\r");
  });

  test("null baseline paints every differing cell on changed rows", () => {
    const curr = [
      ["a", "b"],
      ["c", "d"],
    ];
    const out = buildDiffEscape(null, curr);
    expect(out).toContain("a");
    expect(out).toContain("d");
    expect(out.endsWith("\r")).toBe(true);
  });

  test("only emits cells within the min/max diff range of each row", () => {
    const prev = [["x", "x", "x", "x", "x"]];
    const curr = [["x", "x", "Y", "x", "x"]];
    const out = buildDiffEscape(prev, curr);
    expect(out).not.toContain("x");
    expect(out).toContain("Y");
  });

  test("skips unchanged rows entirely, no cursor motion for them", () => {
    const prev = [
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
    ];
    const curr = [
      ["a", "b"],
      ["c", "X"],
      ["e", "f"],
    ];
    const out = buildDiffEscape(prev, curr);
    expect(out).toContain("X");
    expect(out).toContain("\x1b[1B");
    expect(out).toContain("\x1b[1A");
    expect(out).not.toContain("\x1b[2B");
  });
});

describe("animationFits", () => {
  test("true when content fits in terminal", () => {
    expect(animationFits(20, 40)).toBe(true);
  });

  test("true when content equals terminal height", () => {
    expect(animationFits(40, 40)).toBe(true);
  });

  test("false when content taller than terminal", () => {
    expect(animationFits(41, 40)).toBe(false);
  });

  test("true when terminal rows unknown", () => {
    expect(animationFits(100, undefined)).toBe(true);
    expect(animationFits(100, 0)).toBe(true);
  });
});

describe("--help", () => {
  test("prints help to stdout and exits 0", async () => {
    const { exitCode, stdout, stderr } = await wrap("--help");
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("wrap");
    expect(stdout).toContain("Usage:");
  });

  test("includes all registered commands", async () => {
    const { stdout } = await wrap("--help");
    expect(stdout).toContain("--log");
    expect(stdout).not.toContain("--log-pretty");
    expect(stdout).toContain("--help");
    expect(stdout).toContain("--version");
  });

  test("includes options", async () => {
    const { stdout } = await wrap("--help");
    expect(stdout).toContain("--model");
    expect(stdout).toContain("--verbose");
  });

  test("shows Commands and Options sections", async () => {
    const { stdout } = await wrap("--help");
    expect(stdout).toContain("Commands:");
    expect(stdout).toContain("Options:");
  });

  test("shows flag descriptions", async () => {
    const { stdout } = await wrap("--help");
    expect(stdout).toContain("Show version");
    expect(stdout).toContain("Show this help");
  });

  test("shows subcommand help for --help --log", async () => {
    const { exitCode, stdout, stderr } = await wrap("--help --log");
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("--log");
    expect(stdout).toContain("Show log entries");
  });

  test("shows subcommand help without -- prefix", async () => {
    const { exitCode, stdout } = await wrap("--help log");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--log");
  });

  test("shows subcommand help for --version", async () => {
    const { exitCode, stdout } = await wrap("--help --version");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--version");
    expect(stdout).toContain("Show version");
  });

  test("shows help for option flags", async () => {
    const { exitCode, stdout } = await wrap("--help --model");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--model");
    expect(stdout).toContain("Override LLM provider/model");
  });

  test("shows subcommand help for --help itself", async () => {
    const { exitCode, stdout } = await wrap("--help --help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("help");
  });

  test("errors on unknown flag", async () => {
    const { exitCode, stderr } = await wrap("--help --nope");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown flag");
  });

  test("errors with too many arguments", async () => {
    const { exitCode } = await wrap("--help --log extra");
    expect(exitCode).toBe(1);
  });

  test("--no-animation suppresses animation but still prints help", async () => {
    const { exitCode, stdout } = await wrap("--help --no-animation");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("--help");
  });

  test("NO_COLOR yields plain output", async () => {
    const { exitCode, stdout } = await wrap("--help", { NO_COLOR: "1" });
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("\x1b[");
    expect(stdout).toContain("Usage:");
  });

  test("-h shows subcommand help", async () => {
    const { exitCode, stdout } = await wrap("-h --log");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--log");
  });
});
