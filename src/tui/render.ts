import { SHOW_CURSOR } from "../core/ansi.ts";
import { chrome, chromeRaw } from "../core/output.ts";

export type ConfirmResult = "run" | "cancel" | "blocked";

/**
 * Show a confirmation panel for a medium/high-risk command.
 * Returns "run" if confirmed, "cancel" if the user declines,
 * or "blocked" if no TTY is available to show the panel.
 */
export async function confirmCommand(
  command: string,
  riskLevel: "medium" | "high",
  explanation?: string,
): Promise<ConfirmResult> {
  if (!process.stderr.isTTY) {
    chrome(`Command requires confirmation (no TTY available): ${command}`);
    return "blocked";
  }

  // TODO: When piped input lands, open /dev/tty for Ink's stdin (specs/tui-approach.md §2).

  const [{ render }, { createElement }, { ConfirmPanel }] = await Promise.all([
    import("ink"),
    import("react"),
    import("./confirm.tsx"),
  ]);

  let result: ConfirmResult = "cancel";

  const app = render(
    createElement(ConfirmPanel, {
      command,
      riskLevel,
      explanation,
      onChoice: (choice: ConfirmResult) => {
        result = choice;
      },
    }),
    { stdout: process.stderr, patchConsole: false },
  );

  await app.waitUntilExit();

  // Restore cursor visibility (bun#26642 workaround)
  chromeRaw(SHOW_CURSOR);

  return result;
}
