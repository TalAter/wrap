import type { RiskLevel } from "../command-response.schema.ts";
import { ENTER_ALT_SCREEN, EXIT_ALT_SCREEN, SHOW_CURSOR } from "../core/ansi.ts";
import { chrome, chromeRaw } from "../core/output.ts";

export type ConfirmChoice = "run" | "cancel";
export type ConfirmResult = { result: ConfirmChoice | "blocked"; command: string };

/**
 * Show a confirmation panel for a command.
 * Returns "run" if confirmed, "cancel" if the user declines,
 * or "blocked" if no TTY is available to show the panel.
 */
export async function confirmCommand(
  command: string,
  riskLevel: RiskLevel,
  explanation?: string,
): Promise<ConfirmResult> {
  if (!process.stderr.isTTY) {
    chrome(`Command requires confirmation (no TTY available): ${command}`);
    return { result: "blocked", command };
  }

  // TODO: When piped input lands, open /dev/tty for Ink's stdin (specs/tui-approach.md §2).

  const [{ render }, { createElement }, { ConfirmPanel }] = await Promise.all([
    import("ink"),
    import("react"),
    import("./confirm.tsx"),
  ]);

  let choice: ConfirmChoice = "cancel";
  let resultCommand = command;

  try {
    // Isolate TUI rendering in alternate screen so resize redraw artifacts never corrupt main scrollback.
    chromeRaw(ENTER_ALT_SCREEN);

    const app = render(
      createElement(ConfirmPanel, {
        initialCommand: command,
        initialRiskLevel: riskLevel,
        initialExplanation: explanation,
        onChoice: (c: ConfirmChoice, cmd: string) => {
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
