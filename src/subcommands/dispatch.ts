import { chrome } from "../core/output.ts";
import { commands } from "./registry.ts";

export async function dispatch(flag: string, args: string[]): Promise<void> {
  const cmd = commands.find((c) => c.flag === flag || c.aliases?.includes(flag));

  if (!cmd) {
    chrome(`Unknown flag: ${flag}`);
    // Set exitCode instead of hard-exiting so the event loop can drain —
    // in particular, the async OSC 11 appearance probe (fire-and-forget
    // from resolveAppearance) needs to read its /dev/tty reply before we
    // exit, otherwise the reply leaks into the parent shell.
    process.exitCode = 1;
    return;
  }

  return cmd.run(args);
}
