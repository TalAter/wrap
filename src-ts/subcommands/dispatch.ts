import { chrome } from "../core/output.ts";
import { commands } from "./registry.ts";

export async function dispatch(flag: string, args: string[]): Promise<void> {
  const cmd = commands.find((c) => c.flag === flag || c.aliases?.includes(flag));

  if (!cmd) {
    chrome(`Unknown flag: ${flag}`);
    process.exitCode = 1;
    return;
  }

  return cmd.run(args);
}
