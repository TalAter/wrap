import { discoverySkill } from "./discovery.ts";
import type { Skill } from "./types.ts";

export { runSkills } from "./run.ts";
export type { Skill, SkillTask, Trigger } from "./types.ts";

/** Bundled skills. Order is preserved — discovery turns precede other skills. */
export const SKILLS: readonly Skill[] = [discoverySkill];
