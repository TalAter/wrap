import { formatSize } from "../fs/temp.ts";
import type { Memory } from "../memory/types.ts";

export type FormatContextParams = {
  memory: Memory;
  cwd: string;
  piped?: boolean;
  attachedInputPath?: string;
  attachedInputSize?: number;
  attachedInputPreview?: string;
  attachedInputTruncated?: boolean;
  constants: {
    sectionSystemFacts: string;
    sectionFactsAbout: string;
    sectionAttachedInput: string;
    pipedOutputInstruction: string;
  };
};

/**
 * Build the context string from memory + piped flag + attached input. Pure.
 * cwd path, cwd files, and tool watchlist are emitted by the discovery skill
 * as transcript turns rather than the context block — keeping `formatContext`
 * focused on knowledge (memory facts, piped instruction) instead of probed
 * observations.
 */
export function formatContext(params: FormatContextParams): string {
  const {
    memory,
    cwd,
    piped,
    attachedInputPath,
    attachedInputSize,
    attachedInputPreview,
    attachedInputTruncated,
    constants,
  } = params;
  const sections: string[] = [];

  if (attachedInputPreview !== undefined) {
    const lines: string[] = [constants.sectionAttachedInput];
    if (attachedInputPath !== undefined) {
      const sizeStr = attachedInputSize !== undefined ? ` (${formatSize(attachedInputSize)})` : "";
      lines.push(`Path: ${attachedInputPath}${sizeStr}`);
    }
    if (attachedInputTruncated) {
      lines.push("Preview truncated — the file on disk carries the full original bytes.");
    }
    lines.push("");
    lines.push(attachedInputPreview);
    sections.push(lines.join("\n"));
  }

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

  if (piped) {
    sections.push(constants.pipedOutputInstruction);
  }

  return sections.join("\n\n");
}
