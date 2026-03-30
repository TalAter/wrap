import type { Memory } from "../memory/types.ts";

export type FormatContextParams = {
  memory: Memory;
  toolsOutput?: string;
  cwdFiles?: string;
  cwd: string;
  piped?: boolean;
  constants: {
    sectionSystemFacts: string;
    sectionFactsAbout: string;
    sectionDetectedTools: string;
    sectionCwdFiles: string;
    cwdPrefix: string;
    pipedOutputInstruction: string;
  };
};

/** Build the context string from memory, tools, piped flag, and cwd. Pure function. */
export function formatContext(params: FormatContextParams): string {
  const { memory, toolsOutput, cwdFiles, cwd, piped, constants } = params;
  const sections: string[] = [];

  const cwdSlash = cwd.endsWith("/") ? cwd : `${cwd}/`;
  for (const scope of Object.keys(memory)) {
    const scopeSlash = scope.endsWith("/") ? scope : `${scope}/`;
    if (!cwdSlash.startsWith(scopeSlash)) continue;
    const facts = memory[scope];
    if (!facts || facts.length === 0) continue;
    const header =
      scope === "/" ? constants.sectionSystemFacts : `${constants.sectionFactsAbout} ${scope}`;
    sections.push(`${header}\n${facts.map((f) => `- ${f.fact}`).join("\n")}`);
  }

  if (toolsOutput) {
    sections.push(`${constants.sectionDetectedTools}\n${toolsOutput}`);
  }

  if (piped) {
    sections.push(constants.pipedOutputInstruction);
  }

  if (cwdFiles) {
    sections.push(`${constants.sectionCwdFiles}\n${cwdFiles}`);
  }

  sections.push(`${constants.cwdPrefix} ${cwd}`);

  return sections.join("\n\n");
}
