export type SpawnResult = {
  stdout: string;
  stderr: string;
  exit_code: number;
};

/**
 * Run a subprocess with a piped stdin payload and read all three streams.
 * Non-zero exit is returned, not thrown — callers decide whether to raise
 * or (for wire capture) persist the failed run.
 */
export async function spawnAndRead(
  cmd: string[],
  prompt: string,
  opts?: { cwd?: string },
): Promise<SpawnResult> {
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
  return { stdout, stderr, exit_code: exitCode };
}
