import { bold, dim, fgCode, gradient, gradientCells, SHOW_CURSOR } from "../core/ansi.ts";
import { LOGO, LOGO_WIDTH } from "../core/logo.ts";
import {
  type ColorLevel,
  chrome,
  chromeRaw,
  colorLevel,
  shouldAnimate,
  supportsColor,
} from "../core/output.ts";
import { getTheme } from "../core/theme.ts";
import type { CLIFlag, Command } from "./types.ts";

// ZX Spectrum rainbow — decorative, stays the same in both themes
const SPECTRUM: [number, number, number][] = [
  [255, 51, 51],
  [255, 136, 0],
  [255, 204, 0],
  [51, 204, 51],
  [0, 204, 204],
  [51, 102, 255],
  [204, 51, 255],
];
const INDENT = "  ";
const INDENTED_LOGO = LOGO.map((l) => `${INDENT}${l}`);
const BAR = `${INDENT}${"─".repeat(LOGO_WIDTH)}`;

function formatFlags(flags: CLIFlag[], colorize?: (text: string) => string): string[] {
  return flags.map((c) => {
    // Derive display hint from usage string: "w --flag [args]" → "--flag [args]"
    const hint = c.usage.replace(/^w\s+/, "");
    const flag = `  ${hint}`;
    const padding = " ".repeat(Math.max(1, 24 - flag.length));
    return `${colorize ? colorize(flag) : flag}${padding}${c.description}`;
  });
}

const EXAMPLES_PLAIN: string[] = [
  "Examples:",
  "  wrap copy the contents of my .env file to clipboard, mask any IP addresses",
  "      wrap writes the shell command for your request and runs it after",
  "      you confirm",
  "  wrap",
  "      launch interactive mode — compose a multiline prompt in a friendly",
  "      editor",
];

export function renderPlain(commands: CLIFlag[], options: CLIFlag[]): string {
  const lines = [
    "wrap - natural language shell commands",
    "",
    "Usage: w <prompt>         Run a natural language query",
    "",
    ...EXAMPLES_PLAIN,
    "",
    "Commands:",
    ...formatFlags(commands),
    "",
    "Options:",
    ...formatFlags(options),
  ];
  return `${lines.join("\n")}\n`;
}

export function renderStyled(
  commands: CLIFlag[],
  options: CLIFlag[],
  level: ColorLevel = colorLevel(),
): string {
  const flagColor = getTheme().text.accent;
  const flagPrefix = fgCode(...flagColor, level);
  const flagReset = flagPrefix ? "\x1b[0m" : "";
  const colorizeFlag = (f: string) => `${flagPrefix}${f}${flagReset}`;
  const lines: string[] = [
    "",
    gradient(BAR, SPECTRUM, undefined, undefined, level),
    ...INDENTED_LOGO.map((l) => gradient(l, SPECTRUM, undefined, undefined, level)),
    gradient(BAR, SPECTRUM, undefined, undefined, level),
    "",
    `  ${dim("natural language shell commands")}`,
    "",
    `  ${bold("Usage:")} w <prompt>`,
    "",
    `  ${bold("Examples:")}`,
    `    ${colorizeFlag("wrap copy the contents of my .env file to clipboard, mask any IP addresses")}`,
    `        ${dim("wrap writes the shell command for your request and runs it after")}`,
    `        ${dim("you confirm")}`,
    `    ${colorizeFlag("wrap")}`,
    `        ${dim("launch interactive mode — compose a multiline prompt in a friendly")}`,
    `        ${dim("editor")}`,
    "",
    `  ${bold("Commands:")}`,
    ...formatFlags(commands, colorizeFlag),
    "",
    `  ${bold("Options:")}`,
    ...formatFlags(options, colorizeFlag),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

const ART_LINES = [BAR, ...INDENTED_LOGO, BAR];
const FRAMES = 16;
const FRAME_DELAY = 60;
const SHINE_RADIUS = 4;

/**
 * Animation uses cursor-up to return to the logo after scrolling. When
 * help output is taller than the viewport, the earlier `styled` write
 * scrolls the logo off-screen; cursor-up then clamps at the viewport
 * top and subsequent frames paint over the help text. Skip animation
 * when there isn't enough room.
 */
export function animationFits(contentRows: number, terminalRows: number | undefined): boolean {
  if (!terminalRows || terminalRows <= 0) return true;
  return contentRows <= terminalRows;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function buildFrame(shinePos: number | undefined, level: ColorLevel): string[][] {
  return ART_LINES.map((line) => gradientCells(line, SPECTRUM, shinePos, SHINE_RADIUS, level));
}

/**
 * Emit only the cells that differ from `prev` for each row in `curr`.
 * Saves both bytes on the wire and per-frame flicker that full rewrites
 * produce on slower terminals.
 *
 * Returns the escape string so callers can batch-write it or test it.
 * Invariant: cursor enters and exits at column 0 of the first art row.
 */
export function buildDiffEscape(prev: string[][] | null, curr: string[][]): string {
  let out = "";
  let atRow = 0;
  for (let row = 0; row < curr.length; row++) {
    const currLine = curr[row] as string[];
    const prevLine = prev?.[row];
    let minCol = -1;
    let maxCol = -1;
    for (let c = 0; c < currLine.length; c++) {
      if (!prevLine || prevLine[c] !== currLine[c]) {
        if (minCol === -1) minCol = c;
        maxCol = c;
      }
    }
    if (minCol === -1) continue;

    const dy = row - atRow;
    if (dy > 0) out += `\x1b[${dy}B`;
    out += "\r";
    if (minCol > 0) out += `\x1b[${minCol}C`;
    for (let c = minCol; c <= maxCol; c++) {
      out += currLine[c] as string;
    }
    out += "\x1b[0m";
    atRow = row;
  }
  if (atRow > 0) out += `\x1b[${atRow}A`;
  out += "\r";
  return out;
}

async function renderAnimated(commands: CLIFlag[], options: CLIFlag[]): Promise<void> {
  const level = colorLevel();
  const styled = renderStyled(commands, options, level);

  // Shine needs truecolor to blend white into the gradient; below that we
  // render the signature color solidly and there's nothing to animate.
  if (level < 3) {
    process.stdout.write(styled);
    return;
  }

  const totalRows = styled.split("\n").length - 1;
  const artStart = 1;

  if (!animationFits(totalRows, process.stdout.rows)) {
    process.stdout.write(styled);
    return;
  }

  process.stdout.write(styled);

  const showCursor = () => chromeRaw(SHOW_CURSOR);
  const onSigint = () => {
    showCursor();
    process.stdout.write(`\r\x1b[${totalRows - artStart}B\n`);
    process.exit(130);
  };
  process.on("SIGINT", onSigint);

  chromeRaw("\x1b[?25l");
  try {
    process.stdout.write(`\x1b[${totalRows - artStart}A`);

    // Baseline matches renderStyled's no-shine output, so frame 0 is a
    // no-op diff but still consumes its delay — keeps total duration
    // equal to FRAMES * FRAME_DELAY for predictable pacing.
    let prev = buildFrame(undefined, level);
    for (let frame = 0; frame < FRAMES; frame++) {
      const t = smoothstep(frame / (FRAMES - 1));
      const shinePos = Math.round(t * (LOGO_WIDTH + 2 * SHINE_RADIUS)) - SHINE_RADIUS;
      const curr = buildFrame(shinePos, level);
      process.stdout.write(buildDiffEscape(prev, curr));
      prev = curr;
      await Bun.sleep(FRAME_DELAY);
    }

    process.stdout.write(`\x1b[${totalRows - artStart}B`);
  } finally {
    showCursor();
    process.removeListener("SIGINT", onSigint);
  }
}

export function renderFlagHelp(flag: CLIFlag): string {
  const lines = [flag.usage, "", `  ${flag.description}`];
  if (flag.help) {
    lines.push("", flag.help);
  }
  if (flag.kind === "option" && flag.env && flag.env.length > 0) {
    lines.push("", `  Env: ${flag.env.join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}

export const helpCmd: Command = {
  kind: "command",
  flag: "--help",
  aliases: ["-h"],
  id: "help",
  description: "Show this help",
  usage: "w --help [command]",
  help: [
    "You already know this. You're here.",
    "",
    "Run it with a command name for help on that command, e.g. w --help log",
  ].join("\n"),
  run: async (args) => {
    const { commands, options } = await import("./registry.ts");

    if (args.length === 0) {
      if (shouldAnimate()) {
        await renderAnimated(commands, options);
      } else if (supportsColor()) {
        process.stdout.write(renderStyled(commands, options));
      } else {
        process.stdout.write(renderPlain(commands, options));
      }
      return;
    }

    if (args.length > 1) {
      chrome("--help takes at most one argument.");
      process.exitCode = 1;
      return;
    }

    const name = (args[0] as string).replace(/^--/, "");
    const allFlags: CLIFlag[] = [...commands, ...options];
    const flag = allFlags.find((f) => f.flag === `--${name}`);
    if (!flag) {
      chrome(`Unknown flag: ${args[0]}`);
      process.exitCode = 1;
      return;
    }

    process.stdout.write(renderFlagHelp(flag));
  },
};
