export type Trigger = { kind: "always" } | { kind: "match"; pattern: RegExp };

// `run` is the escape hatch for tasks whose output is computed in TS (e.g.
// mtime-sorted file listings). Returning null or throwing is a misfire and
// drops the turn pair, matching how non-zero exit drops a shell task.
export type SkillTask = {
  command: string;
  run?: () => Promise<{ output: string; exitCode: number } | null>;
};

export type Skill = {
  name: string;
  trigger: Trigger;
  tasks: SkillTask[];
};
