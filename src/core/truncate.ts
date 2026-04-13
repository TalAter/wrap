/**
 * Truncate a string to roughly `maxChars`, keeping head and tail with
 * an indicator in the middle. Splits at newline boundaries when possible.
 * Returns the string unchanged if it fits.
 *
 * `maxChars` is approximate — the output may exceed it by up to ~80 chars
 * due to the indicator line. Fine for LLM context budgets where ±80 chars
 * on a 200K limit is negligible.
 */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const total = text.length;

  // Reserve space for the indicator line.
  // Indicator: "\n[…truncated, showing first X and last Y of Z chars]\n"
  // Worst-case ~80 chars. When maxChars is tiny, just ensure some content.
  const indicatorOverhead = 80;
  const budget = Math.max(20, maxChars - indicatorOverhead);

  const headBudget = Math.ceil(budget / 2);
  const tailBudget = budget - headBudget;

  // Find head: take up to headBudget chars, snap back to last newline.
  let headEnd = Math.min(headBudget, total);
  const lastNewline = text.lastIndexOf("\n", headEnd);
  if (lastNewline > 0) headEnd = lastNewline;

  // Find tail: take up to tailBudget chars from end, snap forward to next newline.
  let tailStart = Math.max(total - tailBudget, headEnd);
  const nextNewline = text.indexOf("\n", tailStart);
  if (nextNewline !== -1 && nextNewline < total) tailStart = nextNewline + 1;

  // Ensure tail doesn't overlap head.
  if (tailStart <= headEnd) tailStart = total;

  const head = text.slice(0, headEnd);
  const tail = tailStart < total ? text.slice(tailStart) : "";

  const indicator = `\n[…truncated, showing first ${head.length} and last ${tail.length} of ${total} chars]\n`;

  return head + indicator + tail;
}
