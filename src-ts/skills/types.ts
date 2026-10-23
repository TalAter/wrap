export type Trigger = { kind: "always" } | { kind: "match"; pattern: RegExp };

// `run` overrides "what executes for this task" — used both for output
// computed in TS (e.g. mtime-sorted file listings) and for wrapping a shell
// task with a post-filter (e.g. drop the pair on empty output). Returning
// null or throwing is a misfire and drops the turn pair, matching how
// non-zero exit drops a plain shell task.
export type SkillTask = {
  command: string;
  run?: () => Promise<{ output: string; exitCode: number } | null>;
};

// `tasks` is a thunk so dynamic skills (e.g. discovery re-reading the
// watchlist) can defer their list-build until run time without lying about
// the field's type.
export type Skill = {
  name: string;
  trigger: Trigger;
  tasks: () => SkillTask[];
};
