import { getConfig } from "../config/store.ts";
import type { AppEvent, AppState } from "./state.ts";

/**
 * Pure state machine. No I/O. Every (state, event) pair has a defined
 * transition; "wrong" pairs return `state` by reference (===) so the
 * coordinator can short-circuit.
 *
 * Side effects (aborting an in-flight loop, restarting the loop, mounting
 * the dialog, executing the command) are NOT here. They live in the
 * coordinator, which observes state changes and triggers them.
 *
 * One non-state input: `getConfig().yolo` is read in `reduceThinking` to
 * bypass the confirmation dialog. Config is set once at startup and never
 * mutates during a session, so transitions remain deterministic per run.
 */
export function reduce(state: AppState, event: AppEvent): AppState {
  switch (state.tag) {
    case "thinking":
      return reduceThinking(state, event);
    case "confirming":
      return reduceConfirming(state, event);
    case "editing":
      return reduceEditing(state, event);
    case "composing-followup":
      return reduceComposing(state, event);
    case "processing-followup":
      return reduceProcessing(state, event);
    case "composing-interactive":
      return reduceComposingInteractive(state, event);
    case "processing-interactive":
      return reduceProcessingInteractive(state, event);
    case "editor-handoff":
      return reduceEditorHandoff(state, event);
    case "executing-step":
      return reduceExecutingStep(state, event);
    case "exiting":
      return state;
  }
}

/** True if a non-final response needs the user-confirmation dialog. */
function isNonFinalConfirm(response: { final: boolean; risk_level: string }): boolean {
  return response.final === false && response.risk_level !== "low";
}

function reduceThinking(state: AppState & { tag: "thinking" }, event: AppEvent): AppState {
  if (event.type === "loop-final") {
    const r = event.result;
    if (r.type === "command") {
      // Initial final-low: skip the dialog and exec straight away. The
      // `final` check guards against a non-final low ever reaching the
      // reducer — runLoop handles those inline, but asserting it here
      // keeps the asymmetric-dialog invariant honest. Yolo joins this
      // path at any risk level — the user opted out of the gate.
      const autoExec = r.response.risk_level === "low" || getConfig().yolo;
      if (autoExec && r.response.final !== false) {
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
        // Non-final med/high: the user is confirming an intermediate step,
        // not a terminal action. Route to `executing-step` so the dialog
        // stays mounted while the coordinator captures output and re-
        // enters the loop. The `submit-step-confirm` hook drives this.
        if (isNonFinalConfirm(state.response)) {
          return {
            tag: "executing-step",
            response: state.response,
            round: state.round,
            outputSlot: state.outputSlot,
          };
        }
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
          outputSlot: state.outputSlot,
        };
      case "followup":
        return {
          tag: "composing-followup",
          response: state.response,
          round: state.round,
          draft: "",
          outputSlot: state.outputSlot,
        };
      case "copy":
        // Deferred action — no-op for now.
        return state;
    }
  }
  if (event.type === "key-esc") {
    return { tag: "exiting", outcome: { kind: "cancel" } };
  }
  if (event.type === "notification" && event.notification.kind === "step-output") {
    // A late step-output arriving after we already transitioned to
    // confirming (e.g. a racing notification flush) still lands in the
    // slot so the dialog keeps showing the latest step output.
    return { ...state, outputSlot: event.notification.text };
  }
  return state;
}

function reduceEditing(state: AppState & { tag: "editing" }, event: AppEvent): AppState {
  if (event.type === "key-esc") {
    return {
      tag: "confirming",
      response: state.response,
      round: state.round,
      outputSlot: state.outputSlot,
    };
  }
  if (event.type === "submit-edit") {
    // User-override on a non-final med/high step: route into `executing-step`
    // with a response that carries the edited bytes, so the coordinator
    // captures the same way as a model-authored step. The round's audit log
    // still holds `round.attempts.at(-1).parsed.content` (the original model
    // bytes) and `round.execution.command` (what actually ran), so auditors
    // can tell them apart.
    if (isNonFinalConfirm(state.response)) {
      return {
        tag: "executing-step",
        response: { ...state.response, content: event.text },
        round: state.round,
        outputSlot: state.outputSlot,
      };
    }
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
  if (event.type === "enter-editor") {
    return {
      tag: "editor-handoff",
      origin: "editing",
      draft: event.draft,
      response: state.response,
      round: state.round,
      outputSlot: state.outputSlot,
    };
  }
  return state;
}

function reduceComposing(
  state: AppState & { tag: "composing-followup" },
  event: AppEvent,
): AppState {
  if (event.type === "key-esc") {
    return {
      tag: "confirming",
      response: state.response,
      round: state.round,
      outputSlot: state.outputSlot,
    };
  }
  if (event.type === "draft-change") {
    return { ...state, draft: event.text };
  }
  if (event.type === "submit-followup") {
    return {
      tag: "processing-followup",
      response: state.response,
      round: state.round,
      draft: event.text,
      status: undefined,
      outputSlot: state.outputSlot,
    };
  }
  if (event.type === "enter-editor") {
    return {
      tag: "editor-handoff",
      origin: "composing-followup",
      draft: event.draft,
      response: state.response,
      round: state.round,
      outputSlot: state.outputSlot,
    };
  }
  return state;
}

function reduceProcessing(
  state: AppState & { tag: "processing-followup" },
  event: AppEvent,
): AppState {
  if (event.type === "key-esc") {
    return {
      tag: "composing-followup",
      response: state.response,
      round: state.round,
      draft: state.draft,
      outputSlot: state.outputSlot,
    };
  }
  if (event.type === "notification") {
    if (event.notification.kind === "chrome") {
      return { ...state, status: event.notification.text };
    }
    if (event.notification.kind === "step-output") {
      return { ...state, outputSlot: event.notification.text };
    }
    return state;
  }
  if (event.type === "loop-final") {
    const r = event.result;
    if (r.type === "command") {
      // From processing, even a low-risk command opens the dialog —
      // distinct from `thinking` where low-risk skips the dialog. The
      // dialog is already mounted; the user is in the middle of refining.
      return {
        tag: "confirming",
        response: r.response,
        round: r.round,
        outputSlot: state.outputSlot,
      };
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

function reduceComposingInteractive(
  state: AppState & { tag: "composing-interactive" },
  event: AppEvent,
): AppState {
  if (event.type === "key-esc") {
    return { tag: "exiting", outcome: { kind: "cancel" } };
  }
  if (event.type === "draft-change") {
    return { ...state, draft: event.text };
  }
  if (event.type === "submit-interactive") {
    return { tag: "processing-interactive", draft: event.text, status: undefined };
  }
  if (event.type === "enter-editor") {
    return { tag: "editor-handoff", origin: "composing-interactive", draft: event.draft };
  }
  return state;
}

function reduceProcessingInteractive(
  state: AppState & { tag: "processing-interactive" },
  event: AppEvent,
): AppState {
  if (event.type === "key-esc") {
    return { tag: "composing-interactive", draft: state.draft };
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
      // Dialog is already mounted — even low-risk routes through confirming,
      // mirroring processing-followup. The user is interactively composing,
      // they expect to see the command before it runs.
      return { tag: "confirming", response: r.response, round: r.round };
    }
    if (r.type === "answer") {
      return { tag: "exiting", outcome: { kind: "answer", content: r.content } };
    }
    if (r.type === "exhausted") {
      return { tag: "exiting", outcome: { kind: "exhausted" } };
    }
    // r.type === "aborted" — late arrival after Esc already moved us back
    // to composing-interactive. Drop.
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

/**
 * Transient state while a terminal-owning external editor holds the TTY.
 * `key-esc` is a no-op (the editor owns Esc). `editor-done` returns to the
 * origin dialog with the new or preserved draft.
 */
function reduceEditorHandoff(
  state: AppState & { tag: "editor-handoff" },
  event: AppEvent,
): AppState {
  if (event.type === "editor-done") {
    const newDraft = event.text ?? state.draft;
    switch (state.origin) {
      case "composing-interactive":
        return { tag: "composing-interactive", draft: newDraft };
      case "composing-followup":
        if (!state.response || !state.round) return state;
        return {
          tag: "composing-followup",
          response: state.response,
          round: state.round,
          draft: newDraft,
          outputSlot: state.outputSlot,
        };
      case "editing":
        if (!state.response || !state.round) return state;
        return {
          tag: "editing",
          response: state.response,
          round: state.round,
          draft: newDraft,
          outputSlot: state.outputSlot,
        };
    }
  }
  return state;
}

/**
 * `executing-step` is the mirror of `processing` for the confirmed
 * multi-step branch: the dialog is mounted, the spinner is on, and the
 * coordinator is driving a capture-mode exec of the confirmed command
 * plus the next LLM round. Step-output notifications update the slot.
 * `loop-final` routes the same way as `processing` — command lands back
 * in `confirming`, reply/exhausted exit.
 *
 * Esc bails out to `confirming` so the user can re-review or cancel. The
 * coordinator's Esc handler aborts the in-flight capture via the shared
 * `currentLoopAbort` controller.
 */
function reduceExecutingStep(
  state: AppState & { tag: "executing-step" },
  event: AppEvent,
): AppState {
  if (event.type === "key-esc") {
    return {
      tag: "confirming",
      response: state.response,
      round: state.round,
      outputSlot: state.outputSlot,
    };
  }
  if (event.type === "notification") {
    if (event.notification.kind === "step-output") {
      return { ...state, outputSlot: event.notification.text };
    }
    return state;
  }
  if (event.type === "loop-final") {
    const r = event.result;
    if (r.type === "command") {
      return {
        tag: "confirming",
        response: r.response,
        round: r.round,
        outputSlot: state.outputSlot,
      };
    }
    if (r.type === "answer") {
      return { tag: "exiting", outcome: { kind: "answer", content: r.content } };
    }
    if (r.type === "exhausted") {
      return { tag: "exiting", outcome: { kind: "exhausted" } };
    }
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
