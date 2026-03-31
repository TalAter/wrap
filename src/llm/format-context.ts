import type { ToolProbeResult } from "../discovery/init-probes.ts";
import type { Memory } from "../memory/types.ts";

export type FormatContextParams = {
  memory: Memory;
  tools?: ToolProbeResult | null;
  cwdFiles?: string;
  cwd: string;
  piped?: boolean;
  constants: {
    sectionSystemFacts: string;
    sectionFactsAbout: string;
    sectionDetectedTools: string;
    sectionUnavailableTools: string;
    sectionCwdFiles: string;
    cwdPrefix: string;
    pipedOutputInstruction: string;
  };
};

/** Build the context string from memory, tools, piped flag, and cwd. Pure function. */
export function formatContext(params: FormatContextParams): string {
  const { memory, tools, cwdFiles, cwd, piped, constants } = params;
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

  if (tools) {
    if (tools.available.length > 0) {
      sections.push(`${constants.sectionDetectedTools}\n${tools.available.join("\n")}`);
    }
    if (tools.unavailable.length > 0) {
      sections.push(`${constants.sectionUnavailableTools}\n${tools.unavailable.join(", ")}`);
    }
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
