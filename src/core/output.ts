export function isTTY(): boolean {
  return !!process.stdout.isTTY;
}

export function hasJq(): boolean {
  return !!Bun.which("jq");
}
