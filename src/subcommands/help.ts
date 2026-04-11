import { bold, dim, fg, gradient, SHOW_CURSOR } from "../core/ansi.ts";
import { chrome, chromeRaw, isTTY } from "../core/output.ts";
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
const ART_LINE_COUNT = 1 + LOGO.length + 1; // bar + logo + bar

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

export function renderStyled(commands: CLIFlag[], options: CLIFlag[]): string {
  const lines: string[] = [
    "",
    gradient(BAR, SPECTRUM),
    ...LOGO.map((l) => gradient(l, SPECTRUM)),
    gradient(BAR, SPECTRUM),
    "",
    `  ${dim("natural language shell commands")}`,
    "",
    `  ${bold("Usage:")} w <prompt>`,
    "",
    `  ${bold("Commands:")}`,
    ...formatFlags(commands, (f) => fg(f, ...FLAG_COLOR)),
    "",
    `  ${bold("Options:")}`,
    ...formatFlags(options, (f) => fg(f, ...FLAG_COLOR)),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function renderArtFrame(shinePos: number): string {
  const lines = [
    gradient(BAR, SPECTRUM, shinePos),
    ...LOGO.map((l) => gradient(l, SPECTRUM, shinePos)),
    gradient(BAR, SPECTRUM, shinePos),
  ];
  return `${lines.join("\n")}\n`;
}

async function renderAnimated(commands: CLIFlag[], options: CLIFlag[]): Promise<void> {
  const styled = renderStyled(commands, options);
  // Cursor row after writing = number of \n chars in styled
  const cursorRow = styled.split("\n").length - 1;
  const artStart = 1; // art begins after leading blank line
  const artEnd = artStart + ART_LINE_COUNT;
  const frames = 12;
  const frameDelay = 25;

  // Write full output first so all content is visible immediately
  process.stdout.write(styled);

  const showCursor = () => chromeRaw(SHOW_CURSOR);
  const onSigint = () => {
    showCursor();
    // During sleep, cursor is at artEnd — move to bottom before exiting
    process.stdout.write(`\x1b[${cursorRow - artEnd}B\n`);
    process.exit(130);
  };
  process.on("SIGINT", onSigint);

  chromeRaw("\x1b[?25l");
  try {
    // Move cursor from end of output up to art section
    process.stdout.write(`\x1b[${cursorRow - artStart}A`);

    for (let frame = 0; frame < frames; frame++) {
      const shinePos = Math.round((frame / (frames - 1)) * (LOGO_WIDTH + 8)) - 4;
      process.stdout.write(renderArtFrame(shinePos));
      // Cursor is now at artEnd
      await Bun.sleep(frameDelay);

      if (frame < frames - 1) {
        process.stdout.write(`\x1b[${ART_LINE_COUNT}A`);
      }
    }

    // Move cursor back to end
    process.stdout.write(`\x1b[${cursorRow - artEnd}B`);
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
  help: "You already know this. You're here.\n\nRun it with a command name for help on that command, e.g. w --help log",
  run: async (args) => {
    const { commands, options } = await import("./registry.ts");

    if (args.length === 0) {
      if (isTTY()) {
        await renderAnimated(commands, options);
      } else {
        process.stdout.write(renderPlain(commands, options));
      }
      return;
    }

    if (args.length > 1) {
      chrome("--help takes at most one argument.");
      process.exit(1);
      return;
    }

    const name = (args[0] as string).replace(/^--/, "");
    const allFlags: CLIFlag[] = [...commands, ...options];
    const flag = allFlags.find((f) => f.flag === `--${name}`);
    if (!flag) {
      chrome(`Unknown flag: ${args[0]}`);
      process.exit(1);
      return;
    }

    process.stdout.write(renderFlagHelp(flag));
  },
};
