export async function wrap(input?: string, env?: Record<string, string>) {
  const args = input ? input.split(" ") : [];
  const proc = Bun.spawn(["bun", "run", "src/index.ts", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: env ? { ...process.env, ...env } : undefined,
  });
  const exitCode = await proc.exited;
  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

export async function wrapMock(input: string) {
  const config = JSON.stringify({ provider: { type: "test" } });
  return wrap(input, { WRAP_CONFIG: config });
}
