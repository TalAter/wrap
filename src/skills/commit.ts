import { execTaskInShell } from "./run.ts";
import type { Skill, SkillTask } from "./types.ts";

// Drop the pair on empty output. In a clean repo, the diff commands exit 0
// with no stdout — emitting "I ran X, got nothing" pairs would waste the
// round the skill is meant to save and risks anchoring the LLM on a
// misleading state.
function gitProbe(command: string): SkillTask {
  return {
    command,
    run: async () => {
      const result = await execTaskInShell(command);
      if (result?.exitCode !== 0 || result.output.trim() === "") return null;
      return result;
    },
  };
}

// `git diff` omits untracked files, so a new file gets only a one-line `??`
// mention in status with no content — the LLM commits the tracked changes and
// silently leaves it behind. Enumerate untracked files (honoring .gitignore;
// this also expands an untracked dir like `?? scripts/` into its files) and
// show each as an addition. `diff --no-index` exits 1 when files differ, which
// runSkills would otherwise drop — normalize to 0 and drop on empty output
// instead. stderr is suppressed so a non-repo yields no output (and drops)
// rather than emitting a fatal message.
function untrackedProbe(): SkillTask {
  const command =
    "git ls-files --others --exclude-standard -z 2>/dev/null | " +
    "xargs -0 -I{} git --no-pager diff --no-index --no-color -- /dev/null {} 2>/dev/null";
  return {
    command,
    run: async () => {
      const result = await execTaskInShell(command);
      if (!result || result.output.trim() === "") return null;
      return { output: result.output, exitCode: 0 };
    },
  };
}

export const commitSkill: Skill = {
  name: "commit",
  trigger: { kind: "match", pattern: /\bcommit\b/i },
  // Both diffs (not `git diff HEAD`): the LLM needs to tell staged from
  // unstaged for partial-commit workflows (`git add -p`).
  tasks: () => [
    gitProbe("git status --short"),
    gitProbe("git diff --cached"),
    gitProbe("git diff"),
    untrackedProbe(),
  ],
};
