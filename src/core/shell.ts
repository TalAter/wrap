import { closeSync, openSync } from "node:fs";
import { ensureTempDir } from "../fs/temp.ts";

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
 * Stdin handling: `chooseChildStdin` picks one of: "inherit" when the parent
 * has a TTY; a numeric fd (freshly opened `/dev/tty`) when it doesn't, so
 * interactive children like vim and sudo still read keystrokes even when wrap
 * itself was piped into; or "ignore" when no controlling terminal exists
 * (headless contexts). Opened fds are closed in a `finally` after the child
 * exits — that's why the stdin resolver's numeric return is tracked.
 *
 * Piped-input bytes are not streamed to children here. They live at
 * `$WRAP_TEMP_DIR/input` on disk; commands consume them via shell redirection
 * (`cmd < $WRAP_TEMP_DIR/input`) or file arguments (`vim $WRAP_TEMP_DIR/input`).
 */
/** Choose the child stdin disposition for each spawn. Dependency-injected for tests. */
export function chooseChildStdin(deps?: {
  isTTY?: boolean | undefined;
  tryOpenTty?: () => number;
}): "inherit" | "ignore" | number {
  const isTTY = deps?.isTTY ?? process.stdin.isTTY;
  if (isTTY) return "inherit";
  const open = deps?.tryOpenTty ?? (() => openSync("/dev/tty", "r"));
  try {
    return open();
  } catch {
    return "ignore";
  }
}

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
};

export function executeShellCommand(
  command: string,
  options: { mode: "capture" },
): Promise<CaptureResult>;
export function executeShellCommand(
  command: string,
  options: { mode: "inherit" },
): Promise<InheritResult>;
export async function executeShellCommand(
  command: string,
  options: ShellExecOptions,
): Promise<CaptureResult | InheritResult> {
  const shell = process.env.SHELL || "sh";
  // Create $WRAP_TEMP_DIR on demand. The spawned shell inherits process.env,
  // so setting it here is enough — no need to pass it explicitly.
  ensureTempDir();
  const start = performance.now();

  const stdin = chooseChildStdin();
  try {
    if (options.mode === "capture") {
      const proc = Bun.spawn([shell, "+m", "-ic", command], {
        stdout: "pipe",
        stderr: "pipe",
        stdin,
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
      stdin,
      env: process.env as Record<string, string>,
    });
    const exitCode = await proc.exited;
    return {
      exitCode,
      exec_ms: Math.round(performance.now() - start),
      shell,
    };
  } finally {
    if (typeof stdin === "number") closeSync(stdin);
  }
}
