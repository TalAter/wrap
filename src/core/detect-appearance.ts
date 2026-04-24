import { openSync } from "node:fs";
import { ReadStream } from "node:tty";
import { readWrapFile, writeWrapFile } from "../fs/home.ts";

export type Appearance = "dark" | "light";

const CACHE_PATH = "cache/appearance.json";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Parse an OSC 11 response string and return the detected appearance.
 * Response format: \x1b]11;rgb:RRRR/GGGG/BBBB(\x07|\x1b\\)
 * Each channel is 16-bit hex; we use only the high byte (first 2 chars).
 */
export function parseOsc11Response(raw: string): Appearance | null {
  const match = raw.match(/\]11;rgb:([0-9a-fA-F]{2,4})\/([0-9a-fA-F]{2,4})\/([0-9a-fA-F]{2,4})/);
  if (!match) return null;

  // Take first 2 hex chars of each channel (high byte of 16-bit value)
  const r = Number.parseInt((match[1] as string).slice(0, 2), 16) / 255;
  const g = Number.parseInt((match[2] as string).slice(0, 2), 16) / 255;
  const b = Number.parseInt((match[3] as string).slice(0, 2), 16) / 255;

  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;

  // WCAG relative luminance
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.5 ? "light" : "dark";
}

/** Read cached appearance from disk. Returns null if missing or expired. */
export function getCachedAppearance(home?: string): Appearance | null {
  const raw = readWrapFile(CACHE_PATH, home);
  if (raw === null) return null;

  try {
    const data = JSON.parse(raw) as { appearance?: string; ts?: number };
    if (data.appearance !== "dark" && data.appearance !== "light") return null;
    if (typeof data.ts !== "number") return null;
    if (data.ts + CACHE_TTL_MS < Date.now()) return null;
    return data.appearance;
  } catch {
    return null;
  }
}

/** Write detected appearance to disk cache. */
export function cacheAppearance(appearance: Appearance, home?: string): void {
  writeWrapFile(CACHE_PATH, JSON.stringify({ appearance, ts: Date.now() }), home);
}

/**
 * Query the terminal background color via OSC 11. Writes the query to
 * stderr and reads the response from /dev/tty on a dedicated fd — never
 * touches process.stdin, so Ink dialogs mounted concurrently keep full
 * ownership of stdin raw mode.
 *
 * Returns null on timeout or if the terminal doesn't respond.
 */
export async function queryTerminalBackground(timeoutMs = 50): Promise<Appearance | null> {
  if (!process.stderr.isTTY) return null;

  let fd: number;
  try {
    fd = openSync("/dev/tty", "r");
  } catch {
    // No controlling terminal (detached process, CI, Windows cmd/PowerShell).
    return null;
  }

  return new Promise<Appearance | null>((resolve) => {
    let settled = false;
    let buf = "";
    const stream = new ReadStream(fd);

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        stream.setRawMode(false);
      } catch {
        // ignore
      }
      stream.destroy();
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    stream.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes("\x07") || buf.includes("\x1b\\")) {
        cleanup();
        resolve(parseOsc11Response(buf));
      }
    });

    stream.on("error", () => {
      cleanup();
      resolve(null);
    });

    try {
      stream.setRawMode(true);
      process.stderr.write("\x1b]11;?\x07");
    } catch {
      cleanup();
      resolve(null);
    }
  });
}

/**
 * Resolve appearance using the full precedence chain:
 * 1. WRAP_THEME env var (instant)
 * 2. Config appearance field — "dark" or "light" (instant)
 * 3. Disk cache if fresh (instant)
 * 4. Synchronous OSC 11 probe (up to ~50ms); cache result.
 * 5. Fallback "dark".
 *
 * The probe is awaited rather than fire-and-forget: its setRawMode toggles
 * the terminal's termios, which would otherwise race with any Ink dialog
 * mounting concurrently — cleanup's setRawMode(false) would leave the
 * terminal cooked while Ink still thought it was raw, and keys would echo
 * to the shell instead of the dialog.
 */
export async function resolveAppearance(
  configAppearance: "auto" | "dark" | "light" | undefined,
): Promise<Appearance> {
  const envTheme = process.env.WRAP_THEME;
  if (envTheme === "dark" || envTheme === "light") return envTheme;

  if (configAppearance === "dark" || configAppearance === "light") return configAppearance;

  const cached = getCachedAppearance();
  if (cached) return cached;

  const detected = await queryTerminalBackground().catch(() => null);
  if (detected) {
    cacheAppearance(detected);
    return detected;
  }
  return "dark";
}
