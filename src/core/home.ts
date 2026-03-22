import { homedir } from "node:os";
import { join } from "node:path";

/** Returns the Wrap home directory (default: ~/.wrap, override: WRAP_HOME env var). */
export function getWrapHome(env: Record<string, string | undefined> = process.env): string {
  return env.WRAP_HOME || join(homedir(), ".wrap");
}
