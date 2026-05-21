import type { Skill } from "./types.ts";

export { runSkills } from "./run.ts";
export type { Skill, SkillTask, Trigger } from "./types.ts";

/** Bundled skills. Populated in later steps (discovery, commit). */
export const SKILLS: readonly Skill[] = [];
