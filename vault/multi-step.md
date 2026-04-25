---
name: multi-step
description: Non-final commands, the final flag, risk × final matrix, temp directory, echo projection
Source: src/command-response.schema.ts, src/core/, src/session/, src/fs/temp.ts
Last-synced: 0a22f2a
---

# Multi-step

Unified command/reply schema with a `final` flag. Non-final commands run as intermediate steps — output captured and fed back to the LLM for the next round. Enables "download → inspect → run the inspected file" flows without sacrificing safety.

## Schema

Two response types: command and reply. `final` controls loop continuation: `true` (default) terminates, `false` is an intermediate step.

A `plan` field sits before `content` so the model commits to multi-step intent before writing the command. `_scratchpad` sits before both — see [[scratchpad]].

## Risk × final matrix

| `final` | risk | output | confirmation | loop |
|---|---|---|---|---|
| true | low | inherit | none initially / dialog if open | exit |
| true | medium/high | inherit | dialog | exit |
| false | low | captured | none | continue inline |
| false | medium/high | captured | dialog | continue via executing-step |

## Dialog-open rule

The dialog either opens or stays closed for the rest of the loop — no flicker. Once open it stays open until exit: subsequent non-final lows run inside its lifecycle; subsequent final lows render confirming with a low-risk gradient instead of auto-executing.

Deliberate asymmetry: initial final-low skips the dialog; final-low after an earlier confirmed step does not.

## Last-round constraint

The prompt forbids `final: false` on the last available round. If the model ignores it, the loop bails as exhausted.

## Temp directory (`$WRAP_TEMP_DIR`)

One per invocation, created at startup. Exported into the env so spawned children inherit it.

**Principle: store artifacts, don't execute arbitrary code from it.** Boundary is "what kind of operation," not "where output lands."

Low-risk: download/copy/extract/clone into the dir.
Not low-risk: install-into, build-in, run-script-from.

A context section listing dir contents refreshes per round (contents mutate mid-invocation). The model sees only the variable name, never the literal path.

No exit-handler cleanup. `$TMPDIR` is temporary by convention; OS cleanup is the backstop.

When a command crosses the invocation boundary (clipboard, shell history), `$WRAP_TEMP_DIR` should be substituted with the literal path — otherwise a replayed command silently expands to `/script.sh` in a fresh shell.

## Echo projection

Prior-round responses replayed to the model strip user-facing fields (explanation), already-actioned fields (memory and watchlist updates), and the scratchpad — each round plans fresh, replaying stale plans encourages anchoring. See [[scratchpad]]. Single place that decides what the model sees across rounds.

## Decisions

- **`final` flag, not separate types.** Dimension is terminality, not kind-of-action. With confirmation gating, this covers everything a separate `probe` type would.
- **Dialog-open rule, no flicker.** Asymmetry is better than open/close churn.
- **Budget resets on confirmed step.** Same as follow-up. Each step gets a full budget.
- **Step output in dialog, not stdout.** Captured output routes through the notification bus to the dialog's output slot.
