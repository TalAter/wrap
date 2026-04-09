import type { CommandResponse, RiskLevel } from "../../src/command-response.schema.ts";
import type {
  ComposingState,
  ConfirmingState,
  EditingState,
  ProcessingState,
} from "../../src/session/state.ts";
import type { Round } from "../../src/logging/entry.ts";

export function makeResponse(
  overrides: Partial<CommandResponse> = {},
): CommandResponse {
  return {
    type: "command",
    content: "ls -la",
    risk_level: "medium" as RiskLevel,
    ...overrides,
  } as CommandResponse;
}

export function makeRound(parsed?: CommandResponse): Round {
  return { parsed: parsed ?? makeResponse(), llm_ms: 12 };
}

export function makeConfirming(overrides: Partial<ConfirmingState> = {}): ConfirmingState {
  const response = overrides.response ?? makeResponse();
  return {
    tag: "confirming",
    response,
    round: overrides.round ?? makeRound(response),
  };
}

export function makeEditing(overrides: Partial<EditingState> = {}): EditingState {
  const response = overrides.response ?? makeResponse();
  return {
    tag: "editing",
    response,
    round: overrides.round ?? makeRound(response),
    draft: overrides.draft ?? response.content,
  };
}

export function makeComposing(overrides: Partial<ComposingState> = {}): ComposingState {
  const response = overrides.response ?? makeResponse();
  return {
    tag: "composing",
    response,
    round: overrides.round ?? makeRound(response),
    draft: overrides.draft ?? "",
  };
}

export function makeProcessing(overrides: Partial<ProcessingState> = {}): ProcessingState {
  const response = overrides.response ?? makeResponse();
  return {
    tag: "processing",
    response,
    round: overrides.round ?? makeRound(response),
    draft: overrides.draft ?? "be safer",
    status: overrides.status,
  };
}
