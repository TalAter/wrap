import { bold, dim, fgCode, gradient, gradientCells, SHOW_CURSOR } from "../core/ansi.ts";
import {
  chrome,
  chromeRaw,
  type ColorLevel,
  colorLevel,
  shouldAnimate,
  supportsColor,
} from "../core/output.ts";
import type { Subcommand } from "./types.ts";

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

function formatFlags(cmds: Subcommand[], colorize?: (text: string) => string): string[] {
  return cmds.map((c) => {
    // Derive display hint from usage string: "w --flag [args]" → "--flag [args]"
    const hint = c.usage.replace(/^w\s+/, "");
    const flag = `  ${hint}`;
    const padding = " ".repeat(Math.max(1, 24 - flag.length));
    return `${colorize ? colorize(flag) : flag}${padding}${c.description}`;
  });
}

export function renderPlain(cmds: Subcommand[]): string {
  const lines = [
    "wrap - natural language shell commands",
    "",
    "Usage: w <prompt>         Run a natural language query",
    "",
    "Flags:",
    ...formatFlags(cmds),
  ];
  return `${lines.join("\n")}\n`;
}

export function renderStyled(cmds: Subcommand[], level: ColorLevel = colorLevel()): string {
  const flagPrefix = fgCode(...FLAG_COLOR, level);
  const flagReset = flagPrefix ? "\x1b[0m" : "";
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
    `  ${bold("Flags:")}`,
    ...formatFlags(cmds, (f) => `${flagPrefix}${f}${flagReset}`),
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
 * Emit only the cells that differ from `prev` for each row in `curr`,
 * moving the cursor the minimum distance each time. Saves both bytes
 * on the wire and the per-frame repaint flicker that full rewrites
 * produce on slower terminals.
 *
 * Invariant: cursor enters and exits at column 0 of the first art row.
 */
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

async function renderAnimated(cmds: Subcommand[]): Promise<void> {
  const level = colorLevel();
  const styled = renderStyled(cmds, level);

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

export function renderSubcommandHelp(cmd: Subcommand): string {
  const lines = [cmd.usage, "", `  ${cmd.description}`];
  if (cmd.help) {
    lines.push("", cmd.help);
  }
  return `${lines.join("\n")}\n`;
}

export const helpCmd: Subcommand = {
  flag: "--help",
  aliases: ["-h"],
  description: "Show this help",
  usage: "w --help [subcommand]",
  help: "With a subcommand name, show detailed help for that subcommand.",
  run: async (args) => {
    const { subcommands } = await import("./registry.ts");

    const animationEnabled = !args.includes("--no-animation");
    const rest = args.filter((a) => a !== "--no-animation");

    if (rest.length === 0) {
      if (shouldAnimate({ enabled: animationEnabled })) {
        await renderAnimated(subcommands);
      } else if (supportsColor()) {
        process.stdout.write(renderStyled(subcommands));
      } else {
        process.stdout.write(renderPlain(subcommands));
      }
      return;
    }

    if (rest.length > 1) {
      chrome("--help takes at most one argument.");
      process.exit(1);
      return;
    }

    const name = (rest[0] as string).replace(/^--/, "");
    const cmd = subcommands.find((c) => c.flag === `--${name}`);
    if (!cmd) {
      chrome(`Unknown subcommand: ${rest[0]}`);
      process.exit(1);
      return;
    }

    process.stdout.write(renderSubcommandHelp(cmd));
  },
};
