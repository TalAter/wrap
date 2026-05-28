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

export const commitSkill: Skill = {
  name: "commit",
  trigger: { kind: "match", pattern: /\bcommit\b/i },
  // Both diffs (not `git diff HEAD`): the LLM needs to tell staged from
  // unstaged for partial-commit workflows (`git add -p`).
  tasks: () => [
    gitProbe("git status --short"),
    gitProbe("git diff --cached"),
    gitProbe("git diff"),
  ],
};
