import type { CommandResponse, RiskLevel } from "../../src/command-response.schema.ts";
import type { Round } from "../../src/logging/entry.ts";
import type {
  ComposingInteractiveState,
  ComposingState,
  ConfirmingState,
  EditingState,
  EditorHandoffState,
  ExecutingStepState,
  ProcessingInteractiveState,
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
    tag: "composing-followup",
    response,
    round: overrides.round ?? makeRound(response),
    draft: overrides.draft ?? "",
    outputSlot: overrides.outputSlot,
  };
}

export function makeProcessing(overrides: Partial<ProcessingState> = {}): ProcessingState {
  const response = overrides.response ?? makeResponse();
  return {
    tag: "processing-followup",
    response,
    round: overrides.round ?? makeRound(response),
    draft: overrides.draft ?? "be safer",
    status: overrides.status,
    outputSlot: overrides.outputSlot,
  };
}

export function makeComposingInteractive(
  overrides: Partial<ComposingInteractiveState> = {},
): ComposingInteractiveState {
  return {
    tag: "composing-interactive",
    draft: overrides.draft ?? "",
  };
}

export function makeProcessingInteractive(
  overrides: Partial<ProcessingInteractiveState> = {},
): ProcessingInteractiveState {
  return {
    tag: "processing-interactive",
    draft: overrides.draft ?? "find typescript files",
    status: overrides.status,
  };
}

export function makeEditorHandoff(
  overrides: Partial<EditorHandoffState> = {},
): EditorHandoffState {
  return {
    tag: "editor-handoff",
    origin: overrides.origin ?? "composing-interactive",
    draft: overrides.draft ?? "",
    response: overrides.response,
    round: overrides.round,
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
