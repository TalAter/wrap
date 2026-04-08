import type { RiskLevel } from "../command-response.schema.ts";

/**
 * Result the dialog passes back to runQuery via the follow-up handler.
 * Defined in core/ rather than tui/ so query.ts can depend on it without
 * pulling tui/ into core's dependency graph.
 */
export type FollowupResult =
  | { type: "command"; command: string; riskLevel: RiskLevel; explanation?: string }
  | { type: "answer"; content: string }
  | { type: "exhausted" }
  // Returned when the inner LLM loop bailed via the AbortSignal. The dialog
  // drops it; the user is already back in composing-followup via the
  // signal-check guard. This variant exists so the closure's return type
  // stays exhaustive without forcing a throw.
  | { type: "aborted" }
  | { type: "error"; message: string };

export type FollowupHandler = (text: string, signal: AbortSignal) => Promise<FollowupResult>;
