export const MAX_BUFFER_BYTES = 256 * 1024;

export type ClampResult = { value: string; truncated: boolean };

const encoder = new TextEncoder();

/**
 * Cap `text` at MAX_BUFFER_BYTES UTF-8 bytes, cutting at the last complete
 * code point so truncation never produces mojibake.
 */
export function clampBufferSize(text: string): ClampResult {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= MAX_BUFFER_BYTES) return { value: text, truncated: false };
  let end = MAX_BUFFER_BYTES;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  const value = new TextDecoder("utf-8").decode(bytes.subarray(0, end));
  return { value, truncated: true };
}
