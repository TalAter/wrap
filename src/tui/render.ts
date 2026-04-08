import type { RiskLevel } from "../command-response.schema.ts";
import { ENTER_ALT_SCREEN, EXIT_ALT_SCREEN, SHOW_CURSOR } from "../core/ansi.ts";
import { chrome, chromeRaw } from "../core/output.ts";

export type DialogChoice = "run" | "cancel";
export type DialogResult = { result: DialogChoice | "blocked"; command: string };

/**
 * Show the dialog for a command. Blocks until the user resolves it.
 * Returns `{ result: "blocked" }` immediately if no TTY is available.
 */
export async function showDialog(
  command: string,
  riskLevel: RiskLevel,
  explanation?: string,
): Promise<DialogResult> {
  if (!process.stderr.isTTY) {
    chrome(`Command requires confirmation (no TTY available): ${command}`);
    return { result: "blocked", command };
  }

  // TODO: When piped input lands, open /dev/tty for Ink's stdin (specs/tui-approach.md §2).

  const [{ render }, { createElement }, { Dialog }] = await Promise.all([
    import("ink"),
    import("react"),
    import("./dialog.tsx"),
  ]);

  let choice: DialogChoice = "cancel";
  let resultCommand = command;

  try {
    // Isolate TUI rendering in alternate screen so resize redraw artifacts never corrupt main scrollback.
    chromeRaw(ENTER_ALT_SCREEN);

    const app = render(
      createElement(Dialog, {
        initialCommand: command,
        initialRiskLevel: riskLevel,
        initialExplanation: explanation,
        onChoice: (c: DialogChoice, cmd: string) => {
          choice = c;
          resultCommand = cmd;
        },
      }),
      { stdout: process.stderr, patchConsole: false },
    );

    await app.waitUntilExit();
  } finally {
    chromeRaw(`${EXIT_ALT_SCREEN}${SHOW_CURSOR}`);
  }

  return { result: choice, command: resultCommand };
}
