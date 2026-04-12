export async function spawnAndRead(
  cmd: string[],
  prompt: string,
  opts?: { cwd?: string },
): Promise<string> {
  const proc = Bun.spawn(cmd, {
    stdin: Buffer.from(prompt),
    cwd: opts?.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `${cmd[0]} failed`);
  }
  return stdout.trim();
}
