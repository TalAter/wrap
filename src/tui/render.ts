import type { RiskLevel } from "../command-response.schema.ts";
import { ENTER_ALT_SCREEN, EXIT_ALT_SCREEN, SHOW_CURSOR } from "../core/ansi.ts";
import type { FollowupHandler } from "../core/followup-types.ts";
import { chrome, chromeRaw } from "../core/output.ts";
import { type ChromeHandler, interceptOutput, type SubscribeChrome } from "../core/output-sink.ts";
import type { DialogOutput } from "./dialog.tsx";

// Dialog outputs everything except `blocked`; that variant comes from
// showDialog when there's no TTY and the dialog never mounts.
export type DialogResult = DialogOutput | { type: "blocked"; command: string };

type ShowDialogOptions = {
  command: string;
  riskLevel: RiskLevel;
  onFollowup: FollowupHandler;
  explanation?: string;
};

/**
 * Show the dialog for a command. Blocks until the user resolves it.
 * Returns `{ type: "blocked" }` immediately if no TTY is available.
 */
export async function showDialog({
  command,
  riskLevel,
  onFollowup,
  explanation,
}: ShowDialogOptions): Promise<DialogResult> {
  if (!process.stderr.isTTY) {
    chrome(`Command requires confirmation (no TTY available): ${command}`);
    return { type: "blocked", command };
  }

  // TODO: When piped input lands, open /dev/tty for Ink's stdin (specs/tui-approach.md §2).

  const [{ render }, { createElement }, { Dialog }] = await Promise.all([
    import("ink"),
    import("react"),
    import("./dialog.tsx"),
  ]);

  let captured: DialogResult = { type: "cancel", command };

  // Single-slot listener registry. The dialog's useEffect installs/removes
  // its setter via subscribeChrome; output-sink events fan out through it.
  // Wrapping interceptOutput rather than calling it from the dialog keeps
  // alt-screen timing in this module and lets the dialog stay output-sink
  // unaware beyond the event shape.
  let dialogListener: ChromeHandler | null = null;
  const subscribeChrome: SubscribeChrome = (listener) => {
    dialogListener = listener;
    return () => {
      if (dialogListener === listener) dialogListener = null;
    };
  };
  // Held outside try/finally so the finally can release unconditionally
  // even if `interceptOutput` or the subsequent render() throws.
  let release: (() => void) | null = null;

  try {
    // Isolate TUI rendering in alternate screen so resize redraw artifacts never corrupt main scrollback.
    chromeRaw(ENTER_ALT_SCREEN);
    // Lifecycle ordering is load-bearing — see comment at top of output-sink.ts.
    release = interceptOutput((event) => {
      dialogListener?.(event);
    });

    const app = render(
      createElement(Dialog, {
        initialCommand: command,
        initialRiskLevel: riskLevel,
        initialExplanation: explanation,
        onResult: (r: DialogOutput) => {
          captured = r;
        },
        onFollowup,
        subscribeChrome,
      }),
      { stdout: process.stderr, patchConsole: false },
    );

    await app.waitUntilExit();
  } finally {
    chromeRaw(`${EXIT_ALT_SCREEN}${SHOW_CURSOR}`);
    // Null before invoking so a future code path that calls release
    // outside the finally can't trigger output-sink's double-release throw.
    const r = release;
    release = null;
    r?.();
  }

  return captured;
}
