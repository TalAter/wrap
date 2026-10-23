export type Fact = { fact: string };
export type FactScope = string;
export type Memory = Record<FactScope, Fact[]>;

export function countFacts(memory: Memory): number {
  return Object.values(memory).reduce((sum, facts) => sum + facts.length, 0);
}
