import type { CommandResponse, RiskLevel } from "../../src/command-response.schema.ts";
import type { Round } from "../../src/logging/entry.ts";
import type {
  ComposingState,
  ConfirmingState,
  EditingState,
  ExecutingStepState,
  ProcessingState,
} from "../../src/session/state.ts";

export function makeResponse(overrides: Partial<CommandResponse> = {}): CommandResponse {
  return {
    type: "command",
    final: true,
    content: "ls -la",
    risk_level: "medium" as RiskLevel,
    ...overrides,
  } as CommandResponse;
}

export function makeRound(parsed?: CommandResponse): Round {
  return {
    attempts: [{ parsed: parsed ?? makeResponse(), llm_ms: 12 }],
    llm_ms: 12,
  };
}

export function makeConfirming(overrides: Partial<ConfirmingState> = {}): ConfirmingState {
  const response = overrides.response ?? makeResponse();
  return {
    tag: "confirming",
    response,
    round: overrides.round ?? makeRound(response),
    outputSlot: overrides.outputSlot,
  };
}

export function makeEditing(overrides: Partial<EditingState> = {}): EditingState {
  const response = overrides.response ?? makeResponse();
  return {
    tag: "editing",
    response,
    round: overrides.round ?? makeRound(response),
    draft: overrides.draft ?? response.content,
    outputSlot: overrides.outputSlot,
  };
}

export function makeComposing(overrides: Partial<ComposingState> = {}): ComposingState {
  const response = overrides.response ?? makeResponse();
  return {
    tag: "composing",
    response,
    round: overrides.round ?? makeRound(response),
    draft: overrides.draft ?? "",
    outputSlot: overrides.outputSlot,
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
    outputSlot: overrides.outputSlot,
  };
}

export function makeExecutingStep(overrides: Partial<ExecutingStepState> = {}): ExecutingStepState {
  const response = overrides.response ?? makeResponse({ final: false });
  return {
    tag: "executing-step",
    response,
    round: overrides.round ?? makeRound(response),
    outputSlot: overrides.outputSlot,
  };
}
