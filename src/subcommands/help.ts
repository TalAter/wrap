import { bold, dim, fgCode, gradient, gradientCells, SHOW_CURSOR } from "../core/ansi.ts";
import {
  type ColorLevel,
  chrome,
  chromeRaw,
  colorLevel,
  shouldAnimate,
  supportsColor,
} from "../core/output.ts";
import type { CLIFlag, Command } from "./types.ts";

// ZX Spectrum rainbow
const SPECTRUM: [number, number, number][] = [
  [255, 51, 51],
  [255, 136, 0],
  [255, 204, 0],
  [51, 204, 51],
  [0, 204, 204],
  [51, 102, 255],
  [204, 51, 255],
];

const FLAG_COLOR = SPECTRUM[5] as [number, number, number];

const LOGO = [
  "  █   █  █▀▀▄  ▄▀▀▄  █▀▀▄",
  "  █ █ █  █▄▄▀  █▄▄█  █▄▄▀",
  "  ▀▀ ▀▀  ▀  ▀  ▀  ▀  ▀   ",
];

const LOGO_WIDTH = (LOGO[0] as string).length;
// 2-space prefix + dashes to match logo width
const BAR = `  ${"─".repeat(LOGO_WIDTH - 2)}`;

function formatFlags(flags: CLIFlag[], colorize?: (text: string) => string): string[] {
  return flags.map((c) => {
    // Derive display hint from usage string: "w --flag [args]" → "--flag [args]"
    const hint = c.usage.replace(/^w\s+/, "");
    const flag = `  ${hint}`;
    const padding = " ".repeat(Math.max(1, 24 - flag.length));
    return `${colorize ? colorize(flag) : flag}${padding}${c.description}`;
  });
}

export function renderPlain(commands: CLIFlag[], options: CLIFlag[]): string {
  const lines = [
    "wrap - natural language shell commands",
    "",
    "Usage: w <prompt>         Run a natural language query",
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
  const flagPrefix = fgCode(...FLAG_COLOR, level);
  const flagReset = flagPrefix ? "\x1b[0m" : "";
  const colorizeFlag = (f: string) => `${flagPrefix}${f}${flagReset}`;
  const lines: string[] = [
    "",
    gradient(BAR, SPECTRUM, undefined, undefined, level),
    ...LOGO.map((l) => gradient(l, SPECTRUM, undefined, undefined, level)),
    gradient(BAR, SPECTRUM, undefined, undefined, level),
    "",
    `  ${dim("natural language shell commands")}`,
    "",
    `  ${bold("Usage:")} w <prompt>`,
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

const ART_LINES = [BAR, ...LOGO, BAR];
const FRAMES = 16;
const FRAME_DELAY = 60;
const SHINE_RADIUS = 4;

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

  // With no color, shine is invisible — skip the animation machinery
  // entirely so we don't hide the cursor or waste ~1s of stdout.
  if (level <= 0) {
    process.stdout.write(styled);
    return;
  }

  const totalRows = styled.split("\n").length - 1;
  const artStart = 1;

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
    "",
    "Pass --no-animation (or set WRAP_NO_MOTION=1) to skip the shine animation.",
  ].join("\n"),
  run: async (args) => {
    const { commands, options } = await import("./registry.ts");

    const animationEnabled = !args.includes("--no-animation");
    const rest = args.filter((a) => a !== "--no-animation");

    if (rest.length === 0) {
      if (shouldAnimate({ enabled: animationEnabled })) {
        await renderAnimated(commands, options);
      } else if (supportsColor()) {
        process.stdout.write(renderStyled(commands, options));
      } else {
        process.stdout.write(renderPlain(commands, options));
      }
      return;
    }

    if (rest.length > 1) {
      chrome("--help takes at most one argument.");
      process.exit(1);
      return;
    }

    const name = (rest[0] as string).replace(/^--/, "");
    const allFlags: CLIFlag[] = [...commands, ...options];
    const flag = allFlags.find((f) => f.flag === `--${name}`);
    if (!flag) {
      chrome(`Unknown flag: ${rest[0]}`);
      process.exit(1);
      return;
    }

    process.stdout.write(renderFlagHelp(flag));
  },
};
