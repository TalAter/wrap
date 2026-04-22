import type { CommandResponse } from "../command-response.schema.ts";
import type { Notification } from "../core/notify.ts";
import type { LoopReturn } from "../core/runner.ts";
import type { Round } from "../logging/entry.ts";

/** All states the session can be in. The dialog is mounted iff `tag` is one
 *  of the dialog tags (confirming, editing, composing-followup, processing-followup,
 *  composing-interactive, processing-interactive, executing-step).
 *  `editor-handoff` is transient: the dialog is unmounted for terminal-owning
 *  editors so the child process can own the TTY. */
export type AppState =
  | ThinkingState
  | ConfirmingState
  | EditingState
  | ComposingState
  | ProcessingState
  | ComposingInteractiveState
  | ProcessingInteractiveState
  | EditorHandoffState
  | ExecutingStepState
  | ExitingState;

/** Pre-dialog: chrome spinner is showing while we wait for the LLM's first
 *  final-form response. Initial state of every session. */
export type ThinkingState = { tag: "thinking" };

/** Dialog mounted, user choosing what to do.
 *
 * `command`, `risk`, and `explanation` are NOT separate fields — they are
 * derived from `response.content`, `response.risk_level`, and
 * `response.explanation`. The dialog reads them via `state.response.*`;
 * the reducer threads `response` and `round` through every transition. */
export type ConfirmingState = {
  tag: "confirming";
  /** The full LLM response. The dialog reads command/risk/explanation off
   *  this. The exiting{run} hook reads it for `SessionOutcome.run.response`
   *  — both `source: "model"` (where the executed command equals
   *  `response.content`) and `source: "user_override"` (which records both
   *  the executed bytes and the original model response) need it. */
  response: CommandResponse;
  /** The eagerly-logged round for this command — kept on state so the
   *  exiting{run} hook can mutate `exec_ms`/`execution` on it after exec. */
  round: Round;
  /** Last step's captured output (post-truncation), rendered in the output
   *  slot between the top border and the command strip. Persists across
   *  transitions within one dialog lifecycle — reset only when the dialog
   *  unmounts. Undefined before any step has run. */
  outputSlot?: string;
};

/** User editing the command in place. */
export type EditingState = {
  tag: "editing";
  response: CommandResponse;
  round: Round;
  /** Live edit buffer. The "discard to original" Esc behaviour reads from
   *  `response.content` (no separate `original` field needed). */
  draft: string;
  outputSlot?: string;
};

/** User typing a follow-up. */
export type ComposingState = {
  tag: "composing-followup";
  response: CommandResponse;
  round: Round;
  /** Live follow-up text. Preserved into processing-followup and back. */
  draft: string;
  outputSlot?: string;
};

/** Follow-up call in flight, dialog visible with status. */
export type ProcessingState = {
  tag: "processing-followup";
  response: CommandResponse;
  round: Round;
  /** The follow-up text the user submitted; preserved so Esc → composing-followup keeps it. */
  draft: string;
  /** Latest chrome line, shown in the bottom border. */
  status?: string;
  outputSlot?: string;
};

/**
 * User typing the very first prompt into the interactive composer (triggered
 * when `w` is invoked with no args on a TTY). Distinct from
 * `composing-followup` because the transcript is empty — there is no
 * preceding command response to preserve.
 */
export type ComposingInteractiveState = {
  tag: "composing-interactive";
  /** Live compose buffer. Preserved into processing-interactive and back on Esc. */
  draft: string;
};

/**
 * First LLM round in flight after `submit-interactive`. Mirror of
 * `processing-followup` but for the bootstrap case — the coordinator
 * pushes `draft` as the first user turn when this state is entered.
 */
export type ProcessingInteractiveState = {
  tag: "processing-interactive";
  /** The submitted prompt; preserved so Esc → composing-interactive keeps it. */
  draft: string;
  /** Latest chrome line, shown in the bottom border. */
  status?: string;
};

/**
 * Transient state while a terminal-owning external editor holds the TTY.
 * The dialog is unmounted; the coordinator owns the spawn lifecycle and
 * dispatches `editor-done` when the child exits. On return the reducer
 * restores the origin state with the new draft (or preserved draft on null).
 * GUI editors bypass this state — their spawn is dialog-local.
 */
export type EditorHandoffState = {
  tag: "editor-handoff";
  /** The dialog state to restore once the editor exits. */
  origin: "composing-interactive" | "composing-followup" | "editing";
  /** Buffer the user had when Ctrl-G was pressed. Preserved verbatim if the
   *  editor exits non-zero or writes nothing. */
  draft: string;
  /** Threaded for origins that carry a response/round (composing-followup, editing). */
  response?: CommandResponse;
  round?: Round;
  outputSlot?: string;
};

/**
 * A non-final medium/high step the user confirmed is running in capture
 * mode. The dialog stays mounted: spinner on, previous output slot still
 * visible, new step-output notifications replace `outputSlot`. The
 * submit-step-confirm post-transition hook kicks off the capture + re-
 * enters pumpLoop when the state lands on this tag.
 */
export type ExecutingStepState = {
  tag: "executing-step";
  response: CommandResponse;
  round: Round;
  outputSlot?: string;
};

/** Terminal: about to do the side-effect (run / print / fail) and exit. */
export type ExitingState = {
  tag: "exiting";
  outcome: SessionOutcome;
};

export type SessionOutcome =
  /**
   * A command was confirmed. The session will exec it with inherit stdio.
   *
   * `source` distinguishes the model's command from a user-edited override.
   * `model`         — exactly what the LLM produced; `command === response.content`.
   * `user_override` — the user opened Edit, modified the text, and ran it.
   *                   `command !== response.content`. The log records both
   *                   `command` (what ran) and `response.content` (what the
   *                   model said) so audits can tell them apart.
   */
  | {
      kind: "run";
      command: string;
      response: CommandResponse;
      round: Round;
      source: "model" | "user_override";
    }
  /** A reply/answer was returned (initial or via follow-up). Print to stdout. */
  | { kind: "answer"; content: string }
  /** User cancelled. Exit code 0 — user-initiated abort is graceful. */
  | { kind: "cancel" }
  /** No TTY, can't show the dialog. Exit code 1 with a chrome line explaining. */
  | { kind: "blocked"; command: string }
  /** Round budget hit zero without a final response. Exit code 1. */
  | { kind: "exhausted" }
  /** Loop or session error. Throws after appendLogEntry runs. */
  | { kind: "error"; message: string };

/** Action IDs used by the action bar in `confirming`. */
export type ActionId = "run" | "cancel" | "edit" | "followup" | "copy";

/** Everything the reducer accepts. */
export type AppEvent =
  // ──── from the loop generator (relayed by the coordinator) ────
  | { type: "loop-final"; result: LoopReturn }
  | { type: "loop-error"; error: Error }
  /**
   * Dispatched by the coordinator when it would otherwise mount the dialog
   * but `process.stderr.isTTY` is false. Carries the command that would
   * have been confirmed so the reducer can route to `exiting{blocked}`.
   */
  | { type: "block"; command: string }
  // ──── from the notification bus (relayed by the coordinator while in `processing-followup`) ────
  | { type: "notification"; notification: Notification }
  // ──── from the dialog ────
  | { type: "key-action"; action: ActionId }
  | { type: "key-esc" }
  | { type: "submit-edit"; text: string }
  | { type: "submit-followup"; text: string }
  | { type: "submit-interactive"; text: string }
  | { type: "draft-change"; text: string }
  /** Dispatched from any of the three origin dialogs (composing-interactive,
   *  composing-followup, editing) when the user hits Ctrl-G on a
   *  terminal-owning editor. Reducer transitions to `editor-handoff`; the
   *  coordinator runs the spawn and dispatches `editor-done` on exit. */
  | { type: "enter-editor"; draft: string }
  /** Dispatched by the coordinator after the editor child exits. `text: string`
   *  replaces the buffer; `text: null` preserves it (editor exited non-zero or
   *  wrote an empty file). */
  | { type: "editor-done"; text: string | null };

/** True if the session state should have a dialog mounted.
 *  `editor-handoff` is deliberately excluded — terminal-owning editors
 *  require Ink to be unmounted so the child owns the TTY. */
export function isDialogTag(tag: AppState["tag"]): boolean {
  return (
    tag === "confirming" ||
    tag === "editing" ||
    tag === "composing-followup" ||
    tag === "processing-followup" ||
    tag === "composing-interactive" ||
    tag === "processing-interactive" ||
    tag === "executing-step"
  );
}

/**
 * Add a `submit-step-confirm` event to the reducer surface? No — the
 * confirmation event is the existing `key-action run` on `confirming`
 * with a non-final med/high `response`. The reducer distinguishes that
 * case and transitions to `executing-step`; the coordinator drives the
 * capture + re-pump via a post-transition hook parallel to
 * `submit-followup`.
 */
