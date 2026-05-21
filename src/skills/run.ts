import { getConfig } from "../config/store.ts";
import { truncateMiddle } from "../core/truncate.ts";
import type { AssistantTurn, StepTurn } from "../logging/entry.ts";
import type { Skill, SkillTask, Trigger } from "./types.ts";

const TIMEOUT_MS = 1000;

type TaskResult = { output: string; exitCode: number } | null;

function triggerMatches(trigger: Trigger, userPrompt: string): boolean {
  if (trigger.kind === "always") return true;
  return trigger.pattern.test(userPrompt);
}

// 1s hard cap, applied uniformly to shell tasks and `run` tasks. `onTimeout`
// is the side effect for the shell path (process kill); the timer is unref'd
// so a forgotten promise never holds the event loop open.
function withTimeout<T>(work: Promise<T>, onTimeout: () => void): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      onTimeout();
      resolve(null);
    }, TIMEOUT_MS);
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

async function execTaskInShell(command: string): Promise<TaskResult> {
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
  const exitCode = await withTimeout(proc.exited, () => {
    try {
      proc.kill();
    } catch {}
  });
  if (exitCode === null) return null;
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  let output = stdout;
  if (stderr.trim()) output += (output.trim() ? "\n" : "") + stderr;
  return { output, exitCode };
}

async function runTask(task: SkillTask): Promise<TaskResult> {
  if (task.run) {
    return withTimeout(
      task.run().catch(() => null),
      () => {},
    );
  }
  return execTaskInShell(task.command);
}

// The assistant turn carries `response.content` so `buildPromptInput` projects
// it as a real LLM message — without `response`, the turn is silently skipped
// from the projected transcript.
export async function runSkills(
  skills: readonly Skill[],
  userPrompt: string,
): Promise<(AssistantTurn | StepTurn)[]> {
  const shell = process.env.SHELL || "sh";
  const maxCapturedOutput = getConfig().maxCapturedOutputChars;
  const out: (AssistantTurn | StepTurn)[] = [];
  for (const skill of skills) {
    if (!triggerMatches(skill.trigger, userPrompt)) continue;
    // Tasks within a skill have no inter-dependencies — run them in parallel.
    // Turn order in the transcript is preserved by iterating the resolved
    // array (zipped with the task list) in declaration order.
    const tasks = skill.tasks();
    const results = await Promise.all(tasks.map(runTask));
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const result = results[i];
      if (!task || !result || result.exitCode !== 0) continue;
      out.push({
        kind: "assistant",
        response: {
          type: "command",
          final: false,
          content: task.command,
          risk_level: "low",
        },
        attempts: [],
        source: { kind: "skill", name: skill.name },
      });
      out.push({
        kind: "step",
        command: task.command,
        exit_code: 0,
        output: truncateMiddle(result.output, maxCapturedOutput),
        shell,
        source: { kind: "skill", name: skill.name },
      });
    }
  }
  return out;
}
