/**
 * Shared shell-execution helper used by both the probe path (which captures
 * stdout/stderr) and the final-command path (which inherits stdio so the user
 * sees the real output).
 *
 * Both paths share two non-obvious requirements:
 *
 * 1. The shell must be invoked with `+m` to disable monitor mode (job control).
 *    Without `+m`, an interactive (`-i`) shell calls `tcsetpgrp()` to seize the
 *    foreground process group. It never restores the parent's foreground, so
 *    any later `tcsetattr()` (e.g. Bun's exit cleanup after Ink's setRawMode)
 *    sends SIGTTOU to the whole process group and suspends the parent.
 *
 * 2. `-i` is needed so the spawned shell sources the user's rc files (aliases,
 *    PATH additions, functions). Probes and commands should run in an
 *    environment that matches what the user would type at their own prompt.
 *
 * Stdin handling: when a `stdinBlob` is provided, the shell reads from it.
 * Without a `stdinBlob`: capture mode closes stdin (probes shouldn't read from
 * the user's terminal), while inherit mode passes through the parent's stdin
 * so interactive commands (vim, less, etc.) still work.
 */
type ShellExecBase = {
  exitCode: number;
  /** Wall-clock duration in milliseconds, rounded to an integer. */
  exec_ms: number;
  /** The shell that was used (e.g. `/bin/zsh`). */
  shell: string;
};

export type CaptureResult = ShellExecBase & {
  stdout: string;
  stderr: string;
};

export type InheritResult = ShellExecBase;

export type ShellExecOptions = {
  mode: "capture" | "inherit";
  /** Optional input to pipe into the command's stdin. */
  stdinBlob?: Blob;
};

export function executeShellCommand(
  command: string,
  options: { mode: "capture"; stdinBlob?: Blob },
): Promise<CaptureResult>;
export function executeShellCommand(
  command: string,
  options: { mode: "inherit"; stdinBlob?: Blob },
): Promise<InheritResult>;
export async function executeShellCommand(
  command: string,
  options: ShellExecOptions,
): Promise<CaptureResult | InheritResult> {
  const shell = process.env.SHELL || "sh";
  const start = performance.now();

  if (options.mode === "capture") {
    const proc = Bun.spawn([shell, "+m", "-ic", command], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: options.stdinBlob,
      env: process.env as Record<string, string>,
    });
    const [exitCode, stdoutText, stderrText] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return {
      exitCode,
      exec_ms: Math.round(performance.now() - start),
      shell,
      stdout: stdoutText,
      stderr: stderrText,
    };
  }

  // mode === "inherit"
  const proc = Bun.spawn([shell, "+m", "-ic", command], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: options.stdinBlob ?? "inherit",
    env: process.env as Record<string, string>,
  });
  const exitCode = await proc.exited;
  return {
    exitCode,
    exec_ms: Math.round(performance.now() - start),
    shell,
  };
}
