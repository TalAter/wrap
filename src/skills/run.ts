import { getConfig } from "../config/store.ts";
import { truncateMiddle } from "../core/truncate.ts";
import type { ProbeTurn } from "../logging/entry.ts";
import type { Skill, SkillTask, Trigger } from "./types.ts";

const TIMEOUT_MS = 1000;
// Grace so the inner shell-exec timeout (which kills the proc) wins the race
// against the outer task.run timeout (which has no kill action) when both are
// armed for the same physical work. See `runTask`.
const OUTER_TIMEOUT_GRACE_MS = 100;

type TaskResult = { output: string; exitCode: number } | null;

function triggerMatches(trigger: Trigger, userPrompt: string): boolean {
  if (trigger.kind === "always") return true;
  return trigger.pattern.test(userPrompt);
}

// 1s hard cap, applied uniformly to shell tasks and `run` tasks. `onTimeout`
// is the side effect for the shell path (process kill); the timer is unref'd
// so a forgotten promise never holds the event loop open.
function withTimeout<T>(
  work: Promise<T>,
  onTimeout: () => void,
  timeoutMs: number = TIMEOUT_MS,
): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      onTimeout();
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

export async function execTaskInShell(command: string): Promise<TaskResult> {
  const shell = process.env.SHELL || "sh";
  // No `-i` — skill probes are Wrap-controlled, not user-typed, so they
  // shouldn't pick up user rc files (aliases, prompt setup, etc).
  const proc = (() => {
    try {
      return Bun.spawn([shell, "-c", command], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        env: process.env as Record<string, string>,
      });
    } catch {
      return null;
    }
  })();
  if (!proc) return null;
  // Drain pipes concurrently with exit. OS pipe buffers are ~64KB; if we
  // awaited `proc.exited` before reading, a command writing more than that
  // would block on write and never exit, forcing the 1s timeout to fire as
  // a false misfire.
  const stdoutP = new Response(proc.stdout).text();
  const stderrP = new Response(proc.stderr).text();
  const exitCode = await withTimeout(proc.exited, () => {
    try {
      proc.kill();
    } catch {}
  });
  if (exitCode === null) return null;
  const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);
  let output = stdout;
  if (stderr.trim()) output += (output.trim() ? "\n" : "") + stderr;
  return { output, exitCode };
}

async function runTask(task: SkillTask): Promise<TaskResult> {
  if (task.run) {
    return withTimeout(
      task.run().catch(() => null),
      () => {},
      TIMEOUT_MS + OUTER_TIMEOUT_GRACE_MS,
    );
  }
  return execTaskInShell(task.command);
}

export async function runSkills(
  skills: readonly Skill[],
  userPrompt: string,
): Promise<ProbeTurn[]> {
  const maxCapturedOutput = getConfig().maxCapturedOutputChars;
  const out: ProbeTurn[] = [];
  for (const skill of skills) {
    if (!triggerMatches(skill.trigger, userPrompt)) continue;
    const tasks = skill.tasks();
    const results = await Promise.all(tasks.map(runTask));
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const result = results[i];
      if (!task || !result || result.exitCode !== 0) continue;
      out.push({
        kind: "probe",
        skill: skill.name,
        command: task.command,
        output: truncateMiddle(result.output, maxCapturedOutput),
      });
    }
  }
  return out;
}
