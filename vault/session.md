---
name: session
description: Five-layer session architecture — runner generator, pure reducer, state-driven dialog, coordinator, notification bus
Source: src/core/, src/session/
Last-synced: 0a22f2a
---

# Session

Five layers, each with a narrow job. Split lets us test the LLM loop without Ink and the dialog without the LLM.

## Runner (core)

- **Transcript** — conversation history as semantic turns (user, assistant step, confirmed step, candidate command, answer). Not provider-shaped messages. Projected to a per-round prompt input. Meta-directives (last-round, retry pairs) live only inside one projection call — no stale-instruction cleanup needed.
- **Round** — single LLM call with in-round retries (parse failure, probe risk, scratchpad required). Owns its own spinner. Throws an error carrying the partial round on failure.
- **Loop** — async generator. Drives rounds, executes non-final low-risk steps inline, yields lifecycle events, returns a typed outcome (`command | answer | exhausted | aborted`).

## State machine

Pure reducer over app state. Each state tag (`thinking`, `confirming`, `editing`, `composing`, `processing`, `executing-step`, `exiting`) is a self-contained object literal — no shared base type, adding fields is additive. Wrong (state, event) pairs return state by reference so the coordinator short-circuits.

Dialog states carry the response and round; command/risk/explanation derive from the response, not duplicated.

## Dialog

Pure function of state. Zero React state for app concerns. Local React state only for transient UI bits (selection, dimensions, spinner frame, cursor position).

## Coordinator

Owns transcript, loop state, current `AbortController`, dialog mount, notification router. Pumps generator events into the reducer; post-transition hooks observe new states and either push a follow-up turn, run a confirmed step, or finalize the outcome. Reconciles the Ink mount on every state change.

## Notification bus + router

Typed emitter in core so chrome callsites don't reach into session. With no listener it falls back to stderr.

The session's listener is **the single source of truth for "is a dialog up?"** Coordinator never tracks its own copy.

Routing while a dialog is mounted: chrome buffers (alt-screen would eat direct stderr writes); chrome during processing also feeds the dialog's bottom-border status. On teardown, unmount **then** flush — order is load-bearing so flushed lines land in real scrollback, not the alt buffer about to disappear.

## Invariants

- **Wrap disappears during exec.** Dialog unmounted, raw mode released, child gets inherited stdio. `vim`, `top`, `ssh`, `sudo` work because Wrap is gone. Teeing child output would break TTY detection, strip colors, mangle interactive commands — any future "watch output" feature must not violate this.
- **Notification bus is the only stderr sink while a dialog is mounted.** Direct writes vanish in alt-screen.
- **Orphan-turn prevention.** Runner re-checks the abort signal after every await. Aborted runs don't push turns.
- **Pre-transition abort.** Esc during processing fires `abort()` before the reducer runs.
- **Spinner per LLM call, not per loop.** Chrome between iterations lands on clean stderr.
- **Eager-log-then-throw.** Errors carry the partial round; the round-complete event fires before the error surfaces, so the round logs.
- **Low-risk asymmetry.** Initial final-low → auto-exec (skip dialog). Final-low when a dialog is already up → confirming (user is mid-refinement, expects to see).

## Outcome source

Exit carries a `source`. Running the model's command is `model`. Running an edited command is `user_override` — risk/explanation carry through from the model response; log records both for audit.

## Decisions

- **Semantic transcript, not messages array.** Meta-instructions never pollute persistent state. New turn kinds are one-line additions.
- **Generator for the loop.** Yield events; consumer dispatches. Avoids callback tangle.
- **Object literals per state tag, no base type.** Additive fields without ceremony.
- **Post-transition hooks, not callbacks.** Follow-up and confirmed-step are parallel branches that push a turn and restart the loop.
- **Event vocabulary is neutral.** `step-running` / `step-output`, never `probe-*`. Don't name events or state fields with the word "probe."
