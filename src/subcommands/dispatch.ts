import { subcommands } from "./registry.ts";

function stderr(msg: string) {
  process.stderr.write(`${msg}\n`);
}

export async function dispatch(flag: string, rawArg: string | null): Promise<void> {
  const cmd = subcommands.find((c) => c.flag === flag);

  if (!cmd) {
    stderr(`Unknown flag: ${flag}`);
    process.exit(1);
    return;
  }

  if (cmd.arg?.required && rawArg === null) {
    stderr(`Missing argument: ${cmd.flag} requires <${cmd.arg.name}>.`);
    stderr(`Usage: ${cmd.usage}`);
    process.exit(1);
    return;
  }

  if (rawArg !== null && cmd.arg) {
    if (cmd.arg.type === "number") {
      const n = Number.parseInt(rawArg, 10);
      if (Number.isNaN(n) || n < 0) {
        stderr(`Invalid argument: ${cmd.flag} expects a number.`);
        stderr(`Usage: ${cmd.usage}`);
        process.exit(1);
        return;
      }
      return cmd.run(n);
    }
    return cmd.run(rawArg);
  }

  if (rawArg !== null && !cmd.arg) {
    stderr(`${cmd.flag} does not take an argument.`);
    process.exit(1);
    return;
  }

  return cmd.run(null);
}
