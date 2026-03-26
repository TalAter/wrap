import { describe, expect, test } from "bun:test";
import { stripAnsi } from "../src/core/ansi.ts";
import { renderPlain, renderStyled, renderSubcommandHelp } from "../src/subcommands/help.ts";
import type { Subcommand } from "../src/subcommands/types.ts";
import { wrap } from "./helpers.ts";

const testCmds: Subcommand[] = [
  { flag: "--foo", description: "Do foo", usage: "w --foo", run: async () => {} },
  { flag: "--bar", description: "Do bar", usage: "w --bar [n]", run: async () => {} },
];

describe("renderPlain", () => {
  test("returns text without ANSI escape codes", () => {
    const result = renderPlain(testCmds);
    expect(result).not.toContain("\x1b[");
  });

  test("includes flags from provided subcommands", () => {
    const result = renderPlain(testCmds);
    expect(result).toContain("--foo");
    expect(result).toContain("--bar [n]");
  });

  test("includes flag descriptions", () => {
    const result = renderPlain(testCmds);
    expect(result).toContain("Do foo");
    expect(result).toContain("Do bar");
  });

  test("includes usage line", () => {
    const result = renderPlain(testCmds);
    expect(result).toContain("Usage:");
    expect(result).toContain("w <prompt>");
  });
});

describe("renderStyled", () => {
  test("returns text with ANSI escape codes", () => {
    const result = renderStyled(testCmds);
    expect(result).toContain("\x1b[38;2;");
  });

  test("includes flags when stripped", () => {
    const result = renderStyled(testCmds);
    const plain = stripAnsi(result);
    expect(plain).toContain("--foo");
    expect(plain).toContain("--bar [n]");
  });

  test("includes block character art", () => {
    const result = renderStyled(testCmds);
    const plain = stripAnsi(result);
    expect(plain).toContain("█");
  });

  test("includes gradient bar", () => {
    const result = renderStyled(testCmds);
    const plain = stripAnsi(result);
    expect(plain).toContain("─");
  });

  test("includes tagline", () => {
    const result = renderStyled(testCmds);
    const plain = stripAnsi(result);
    expect(plain).toContain("natural language shell commands");
  });

  test("contains same flags as renderPlain", () => {
    const plain = renderPlain(testCmds);
    const styled = stripAnsi(renderStyled(testCmds));
    // Every flag line from plain must appear in styled
    const flagLines = plain.split("\n").filter((l) => l.match(/^ {2}--/));
    expect(flagLines.length).toBe(testCmds.length);
    for (const line of flagLines) {
      expect(styled).toContain(line);
    }
  });
});

describe("renderSubcommandHelp", () => {
  test("includes usage and description", () => {
    const cmd: Subcommand = {
      flag: "--foo",
      description: "Do foo",
      usage: "w --foo [bar]",
      run: async () => {},
    };
    const result = renderSubcommandHelp(cmd);
    expect(result).toContain("w --foo [bar]");
    expect(result).toContain("Do foo");
  });

  test("includes help text when present", () => {
    const cmd: Subcommand = {
      flag: "--foo",
      description: "Do foo",
      usage: "w --foo",
      help: "Extra details here.",
      run: async () => {},
    };
    const result = renderSubcommandHelp(cmd);
    expect(result).toContain("Extra details here.");
  });

  test("omits help section when absent", () => {
    const cmd: Subcommand = {
      flag: "--foo",
      description: "Do foo",
      usage: "w --foo",
      run: async () => {},
    };
    const lines = renderSubcommandHelp(cmd).trimEnd().split("\n");
    expect(lines.length).toBe(3); // usage, blank, description
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

  test("includes all registered flags", async () => {
    const { stdout } = await wrap("--help");
    expect(stdout).toContain("--log");
    expect(stdout).not.toContain("--log-pretty");
    expect(stdout).toContain("--help");
    expect(stdout).toContain("--version");
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

  test("shows subcommand help for --help itself", async () => {
    const { exitCode, stdout } = await wrap("--help --help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--help");
  });

  test("errors on unknown subcommand", async () => {
    const { exitCode, stderr } = await wrap("--help --nope");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown subcommand");
  });

  test("errors with too many arguments", async () => {
    const { exitCode } = await wrap("--help --log extra");
    expect(exitCode).toBe(1);
  });

  test("-h shows subcommand help", async () => {
    const { exitCode, stdout } = await wrap("-h --log");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--log");
  });
});
