export function isTTY(): boolean {
  return !!process.stdout.isTTY;
}

export function hasJq(): boolean {
  return !!Bun.which("jq");
}

/** Write a chrome message (Wrap's own UI output) to stderr, with trailing newline. */
export function chrome(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

/** Write raw chrome output to stderr — no trailing newline. For ANSI escapes, partial writes. */
export function chromeRaw(msg: string): void {
  process.stderr.write(msg);
}
