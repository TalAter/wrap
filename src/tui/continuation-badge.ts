const PREFIX = "↳ Continuing: ";
const ELLIPSIS = "…";
const MIN_TERM_COLS = 20;

/**
 * Render the single-line continuation badge shown above the composer input
 * and the processing-dialog spinner.
 *
 * - Collapses runs of whitespace (including newlines from TUI-mode parents)
 *   to a single space so the badge always fits on one line.
 * - Truncates to `max(MIN_TERM_COLS, columns - PREFIX.length - 1)` body chars
 *   with a single-char ellipsis when the body would overflow. The `-1` is a
 *   right-edge gutter — terminals that hide the last column would otherwise
 *   eat the ellipsis.
 * - Returns `""` (no badge) when the terminal is narrower than
 *   `MIN_TERM_COLS` or the parent prompt is blank — callers conditionally
 *   render based on the truthy check.
 */
export function formatContinuationBadge(parentPrompt: string, columns: number): string {
  if (columns < MIN_TERM_COLS) return "";
  const body = parentPrompt.replace(/\s+/g, " ").trim();
  if (body === "") return "";
  const budget = Math.max(MIN_TERM_COLS, columns - PREFIX.length - 1);
  if (body.length <= budget) return `${PREFIX}${body}`;
  return `${PREFIX}${body.slice(0, budget - 1)}${ELLIPSIS}`;
}
