export function spawnAndRead(cmd: string[], prompt: string, opts?: { cwd?: string }): string {
  const result = Bun.spawnSync(cmd, {
    stdin: Buffer.from(prompt),
    cwd: opts?.cwd,
  });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new Error(stderr || `${cmd[0]} failed`);
  }
  return result.stdout.toString().trim();
}
