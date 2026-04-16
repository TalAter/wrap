---
name: session
description: Five-layer session architecture — runner generator, pure reducer, state-driven dialog, coordinator, notification bus
Source: src/core/transcript.ts, src/core/round.ts, src/core/runner.ts, src/core/notify.ts, src/session/
Last-synced: c54a1a5
---

# Session

Five layers, each with a narrow job.

## Runner (src/core/)

- **Transcript** — conversation history as semantic turns (`user`, `step`, `confirmed_step`, `candidate_command`, `answer`). Not provider-shaped messages. `buildPromptInput` projects it to `PromptInput` per round. Meta-directives (`isLastRound`, retry pairs) live only inside one `buildPromptInput` call's `AttemptDirectives` — no stale-instruction cleanup.
- **runRound** — single LLM call with in-round retries (parse failure, probe risk, scratchpad required). Owns its spinner (per call, not per loop). Throws `RoundError` carrying the partial `Round`.
- **runLoop** — async generator. Drives `runRound` repeatedly, executes non-final low-risk steps inline, yields lifecycle events (`round-complete`, `step-running`, `step-output`), returns `LoopReturn` (`command | answer | exhausted | aborted`).

## State machine

Pure reducer over `AppState` + `AppEvent` in `src/session/{state,reducer}.ts`.

Tags: `thinking`, `confirming`, `editing`, `composing`, `processing`, `executing-step`, `exiting`. Each tag is a self-contained object literal — no shared base type. Wrong (state, event) pairs return state by reference so the coordinator short-circuits.

Dialog states carry `{ response: CommandResponse, round: Round }`. Command, risk, explanation derive from response — no separate fields.

## Dialog

`Dialog({ state, dispatch })` — pure function of state. Zero React `useState` for app state. Local state: action-bar selection, box metrics, terminal dimensions, spinner frame, cursor position.

## Coordinator

`runSession` in `src/session/session.ts`. Owns transcript, `LoopState`, current `AbortController`, dialog mount, notification router.

Loop: seed transcript → `startPumpLoop` (fresh AbortController, drain generator events via `pumpLoop`, dispatch as `AppEvent`s) → post-transition hooks observe new state:
- `processing` → push follow-up user turn, reset budget, restart loop.
- `executing-step` → run confirmed step, push turn, restart loop.
- `exiting` → resolve exit, finalize outcome.

`syncDialog` reconciles the Ink mount on every state change.

## Notification bus + router

`src/core/notify.ts` — typed emitter in `core/` so `chrome()` and `verbose()` import without reaching into `session/`. No listener → default stderr write. With listener → listener decides.

`src/session/notification-router.ts` — session's listener. **Single source of truth for "is dialog up?"** Coordinator reads `router.isDialogMounted()`, never tracks its own copy.

Routing:
- No dialog → stderr directly.
- Dialog mounted → buffer (stderr writes during alt-screen vanish on exit).
- Dialog mounted + processing + chrome kind → also dispatch to reducer for bottom-border status.

`teardownDialog()` unmounts THEN flushes buffer. Order is load-bearing: flushed lines must land in real scrollback, not the alt buffer about to disappear.

## Invariants

- **Wrap disappears during exec.** Dialog unmounted, raw mode released, child gets inherited stdio. No spinner, no chrome overlay. `vim`, `top`, `ssh`, `sudo` work because Wrap is gone. Teeing the child's output would break TTY detection, strip colors, and mangle interactive commands — any future "watch output" feature must not violate this.
- **Notification bus is the only stderr sink while dialog is mounted.** Direct `stderr.write` vanishes in alt-screen.
- **Orphan-turn prevention.** Runner re-checks `signal.aborted` after every await. Returns `aborted` without pushing turns.
- **Pre-transition abort.** `key-esc` in `processing` calls `abort()` BEFORE the reducer runs.
- **Spinner per LLM call, not per loop.** Chrome between iterations lands on clean stderr.
- **Eager-log-then-throw.** `RoundError` carries partial `Round`. Generator yields `round-complete` before re-throwing — round is logged before error surfaces.
- **Low-risk asymmetry.** `thinking` + final low → auto-exec (skip dialog). `processing` + final low → `confirming` (user mid-refinement, dialog already open).

## Outcome source

`exiting{run}` carries a `source`:
- `key-action run` from `confirming` → `source: "model"`. Executed bytes = `response.content`.
- `submit-edit` from `editing` → `source: "user_override"`. Executed bytes are user-authored; risk/explanation carry through from model response. Log records both for audit.

## Decisions

- **Semantic transcript, not messages array.** Meta-instructions never pollute persistent state. New turn kinds are one-line additions.
- **Generator for the loop.** `runLoop` yields events; consumer dispatches them. No callback tangle.
- **Object literals per tag, no base type.** Adding fields (`outputSlot`, `plan`) is additive.
- **Post-transition hooks, not callbacks.** Follow-up and confirmed-step are parallel `if (state.tag === ...)` branches that push a turn and restart the loop. Turn-pushing stays in hooks, not in `pumpLoop`.
- **Event vocabulary is neutral.** `step-running` / `step-output`, never `probe-*`. Do not name events or state fields with the word "probe."
