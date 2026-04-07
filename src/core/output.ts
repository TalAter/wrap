import { writeLine } from "./output-sink.ts";

export function isTTY(): boolean {
  return !!process.stdout.isTTY;
}

export function hasJq(): boolean {
  return !!Bun.which("jq");
}

/**
 * Routes through the output sink so the confirm dialog can intercept chrome
 * lines during alt-screen rendering. Optional icon is shown as a prefix.
 */
export function chrome(text: string, icon?: string): void {
  const line = icon ? `${icon} ${text}\n` : `${text}\n`;
  writeLine(line, { text, icon });
}

/** Write raw chrome output to stderr — no trailing newline. For ANSI escapes, partial writes. */
export function chromeRaw(msg: string): void {
  process.stderr.write(msg);
}
