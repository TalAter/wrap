import type { CommandResponse } from "../command-response.schema.ts";
import type { Notification } from "../core/notify.ts";
import type { LoopReturn } from "../core/runner.ts";
import type { Round } from "../logging/entry.ts";

/** All states the session can be in. The dialog is mounted iff `tag` is one
 *  of the dialog tags (confirming, editing, composing, processing). */
export type AppState =
  | ThinkingState
  | ConfirmingState
  | EditingState
  | ComposingState
  | ProcessingState
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
};

/** User editing the command in place. */
export type EditingState = {
  tag: "editing";
  response: CommandResponse;
  round: Round;
  /** Live edit buffer. The "discard to original" Esc behaviour reads from
   *  `response.content` (no separate `original` field needed). */
  draft: string;
};

/** User typing a follow-up. */
export type ComposingState = {
  tag: "composing";
  response: CommandResponse;
  round: Round;
  /** Live follow-up text. Preserved into processing and back. */
  draft: string;
};

/** Follow-up call in flight, dialog visible with status. */
export type ProcessingState = {
  tag: "processing";
  response: CommandResponse;
  round: Round;
  /** The follow-up text the user submitted; preserved so Esc → composing keeps it. */
  draft: string;
  /** Latest chrome line, shown in the bottom border. */
  status?: string;
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
  /** User cancelled. Exit code 1. */
  | { kind: "cancel" }
  /** No TTY, can't show the dialog. Exit code 1 with a chrome line explaining. */
  | { kind: "blocked"; command: string }
  /** Round budget hit zero without a final response. Exit code 1. */
  | { kind: "exhausted" }
  /** Loop or session error. Throws after appendLogEntry runs. */
  | { kind: "error"; message: string };

/** Action IDs used by the action bar in `confirming`. */
export type ActionId = "run" | "cancel" | "edit" | "followup" | "describe" | "copy";

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
  // ──── from the notification bus (relayed by the coordinator while in `processing`) ────
  | { type: "notification"; notification: Notification }
  // ──── from the dialog ────
  | { type: "key-action"; action: ActionId }
  | { type: "key-esc" }
  | { type: "submit-edit"; text: string }
  | { type: "submit-followup"; text: string }
  | { type: "draft-change"; text: string };

/** True if the session state should have a dialog mounted. */
export function isDialogTag(tag: AppState["tag"]): boolean {
  return tag === "confirming" || tag === "editing" || tag === "composing" || tag === "processing";
}
