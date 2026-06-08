import { truncateMiddle } from "./truncate.ts";

type StdinSource = {
  isTTY: boolean | undefined;
  read: () => Promise<Uint8Array>;
};

const defaultStdin: StdinSource = {
  get isTTY() {
    return process.stdin.isTTY;
  },
  read: () => Bun.stdin.bytes(),
};

/**
 * Read stdin as raw bytes. Returns undefined when stdin is a TTY, the pipe
 * carried zero bytes, or every byte is ASCII whitespace. Binary-safe — content
 * is not decoded for callers; callers materialize it to disk and build a
 * separate UTF-8 preview for the LLM. The whitespace guard prevents
 * `echo "" | w help` from being interpreted as a query with attached input.
 * The check runs over raw bytes to avoid a redundant UTF-8 decode before the
 * preview builder does its own.
 */
export async function readAttachedInput(
  stdin: StdinSource = defaultStdin,
): Promise<Uint8Array | undefined> {
  if (stdin.isTTY) return undefined;
  const bytes = await stdin.read();
  if (bytes.byteLength === 0) return undefined;
  if (isAsciiWhitespace(bytes)) return undefined;
  return bytes;
}

function isAsciiWhitespace(bytes: Uint8Array): boolean {
  for (const b of bytes) {
    // ' ', '\t', '\n', '\v', '\f', '\r'
    if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0b && b !== 0x0c && b !== 0x0d) {
      return false;
    }
  }
  return true;
}

export type AttachedInputPreview = {
  preview: string;
  truncated: boolean;
};

/**
 * Decode bytes as UTF-8 and truncate to the preview budget. Non-UTF-8 bytes
 * yield a short summary line instead of mojibake; the file on disk always
 * carries the original bytes.
 */
export function buildAttachedInputPreview(
  bytes: Uint8Array,
  maxChars: number,
): AttachedInputPreview {
  const decoded = safeDecodeUtf8(bytes);
  if (decoded === null) {
    return {
      preview: `Binary content — ${bytes.byteLength} bytes, not previewable.`,
      truncated: false,
    };
  }
  if (decoded.length <= maxChars) {
    return { preview: decoded, truncated: false };
  }
  return { preview: truncateMiddle(decoded, maxChars), truncated: true };
}

function safeDecodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
