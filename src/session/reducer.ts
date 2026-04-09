import type { AppEvent, AppState } from "./state.ts";

/**
 * Pure state machine. No I/O. Every (state, event) pair has a defined
 * transition; "wrong" pairs return `state` by reference (===) so the
 * coordinator can short-circuit.
 *
 * Side effects (aborting an in-flight loop, restarting the loop, mounting
 * the dialog, executing the command) are NOT here. They live in the
 * coordinator, which observes state changes and triggers them.
 */
export function reduce(state: AppState, event: AppEvent): AppState {
  switch (state.tag) {
    case "thinking":
      return reduceThinking(state, event);
    case "confirming":
      return reduceConfirming(state, event);
    case "editing":
      return reduceEditing(state, event);
    case "composing":
      return reduceComposing(state, event);
    case "processing":
      return reduceProcessing(state, event);
    case "exiting":
      return state;
  }
}

function reduceThinking(state: AppState & { tag: "thinking" }, event: AppEvent): AppState {
  if (event.type === "loop-final") {
    const r = event.result;
    if (r.type === "command") {
      // Initial low-risk: skip the dialog and exec straight away.
      if (r.response.risk_level === "low") {
        return {
          tag: "exiting",
          outcome: {
            kind: "run",
            command: r.response.content,
            response: r.response,
            round: r.round,
            source: "model",
          },
        };
      }
      return { tag: "confirming", response: r.response, round: r.round };
    }
    if (r.type === "answer") {
      return { tag: "exiting", outcome: { kind: "answer", content: r.content } };
    }
    if (r.type === "exhausted") {
      return { tag: "exiting", outcome: { kind: "exhausted" } };
    }
    // r.type === "aborted" — unreachable from `thinking` (no abort source).
    // Defensive no-op.
    return state;
  }
  if (event.type === "loop-error") {
    return {
      tag: "exiting",
      outcome: { kind: "error", message: event.error.message },
    };
  }
  if (event.type === "block") {
    return { tag: "exiting", outcome: { kind: "blocked", command: event.command } };
  }
  return state;
}

function reduceConfirming(state: AppState & { tag: "confirming" }, event: AppEvent): AppState {
  if (event.type === "key-action") {
    switch (event.action) {
      case "run":
        return {
          tag: "exiting",
          outcome: {
            kind: "run",
            command: state.response.content,
            response: state.response,
            round: state.round,
            source: "model",
          },
        };
      case "cancel":
        return { tag: "exiting", outcome: { kind: "cancel" } };
      case "edit":
        return {
          tag: "editing",
          response: state.response,
          round: state.round,
          draft: state.response.content,
        };
      case "followup":
        return {
          tag: "composing",
          response: state.response,
          round: state.round,
          draft: "",
        };
      case "describe":
      case "copy":
        // Deferred actions — no-op for now.
        return state;
    }
  }
  if (event.type === "key-esc") {
    return { tag: "exiting", outcome: { kind: "cancel" } };
  }
  return state;
}

function reduceEditing(state: AppState & { tag: "editing" }, event: AppEvent): AppState {
  if (event.type === "key-esc") {
    return { tag: "confirming", response: state.response, round: state.round };
  }
  if (event.type === "submit-edit") {
    return {
      tag: "exiting",
      outcome: {
        kind: "run",
        command: event.text,
        response: state.response,
        round: state.round,
        source: "user_override",
      },
    };
  }
  if (event.type === "draft-change") {
    return { ...state, draft: event.text };
  }
  return state;
}

function reduceComposing(state: AppState & { tag: "composing" }, event: AppEvent): AppState {
  if (event.type === "key-esc") {
    return { tag: "confirming", response: state.response, round: state.round };
  }
  if (event.type === "draft-change") {
    return { ...state, draft: event.text };
  }
  if (event.type === "submit-followup") {
    return {
      tag: "processing",
      response: state.response,
      round: state.round,
      draft: event.text,
      status: undefined,
    };
  }
  return state;
}

function reduceProcessing(state: AppState & { tag: "processing" }, event: AppEvent): AppState {
  if (event.type === "key-esc") {
    return {
      tag: "composing",
      response: state.response,
      round: state.round,
      draft: state.draft,
    };
  }
  if (event.type === "notification") {
    if (event.notification.kind === "chrome") {
      return { ...state, status: event.notification.text };
    }
    return state;
  }
  if (event.type === "loop-final") {
    const r = event.result;
    if (r.type === "command") {
      // From processing, even a low-risk command opens the dialog —
      // distinct from `thinking` where low-risk skips the dialog. The
      // dialog is already mounted; the user is in the middle of refining.
      return { tag: "confirming", response: r.response, round: r.round };
    }
    if (r.type === "answer") {
      return { tag: "exiting", outcome: { kind: "answer", content: r.content } };
    }
    if (r.type === "exhausted") {
      return { tag: "exiting", outcome: { kind: "exhausted" } };
    }
    // r.type === "aborted" — the user's Esc already transitioned us to
    // composing; the late-arriving aborted return is dropped here.
    return state;
  }
  if (event.type === "loop-error") {
    return {
      tag: "exiting",
      outcome: { kind: "error", message: event.error.message },
    };
  }
  return state;
}
