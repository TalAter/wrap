import { chrome } from "../core/output.ts";
import { subcommands } from "./registry.ts";

export async function dispatch(flag: string, args: string[]): Promise<void> {
  const cmd = subcommands.find((c) => c.flag === flag || c.aliases?.includes(flag));

  if (!cmd) {
    chrome(`Unknown flag: ${flag}`);
    process.exit(1);
    return;
  }

  return cmd.run(args);
}
