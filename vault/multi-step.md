---
name: multi-step
description: Non-final commands, the final flag, risk × final matrix, temp directory, echo projection
Source: src/command-response.schema.ts, src/core/runner.ts, src/core/transcript.ts, src/session/reducer.ts, src/session/session.ts, src/fs/temp.ts
Last-synced: c54a1a5
---

# Multi-step

Unified `command`/`reply` schema with a `final` flag. Non-final commands run as intermediate steps — output captured and fed back to the LLM for the next round. Enables "download → inspect → run the inspected file" and similar flows without sacrificing safety.

## Schema

Two response types: `command` (shell command) and `reply` (text). `final` controls loop continuation: `true` (default) = terminal, `false` = intermediate step.

`plan` field sits before `content` so the model commits to multi-step intent before writing the command. `_scratchpad` before both — see [[scratchpad]].

## Risk × final matrix

| `final` | `risk_level` | Output | Confirmation | Loop |
|---|---|---|---|---|
| `true` | `low` | inherit | none *(initial)* / dialog *(if open)* | exit |
| `true` | `medium`/`high` | inherit | dialog | exit |
| `false` | `low` | captured | none | continue (inline in `runLoop`) |
| `false` | `medium`/`high` | captured | dialog | continue (via `executing-step`) |

## Dialog-open rule

The dialog either opens or stays closed for the rest of the loop — no flicker. Opens the first time anything needs confirmation. Once open, stays open until exit: subsequent non-final lows run inside its lifecycle, subsequent final lows render in `confirming` with low-risk gradient rather than auto-executing.

Deliberate asymmetry: initial final-low skips dialog; final-low after an earlier confirmed step does not.

## Control flow

- **Non-final low** — handled inline in `runLoop`. Capture output, push `step` turn, yield `step-output`, continue. Never returns to consumer.
- **Non-final medium/high** — returns to coordinator. Dialog confirms → `executing-step` state → `runConfirmedStep` runs capture, pushes `confirmed_step` turn, resets budget, restarts loop. Esc in `executing-step` → back to `confirming`.
- **Final any-risk** — returns to coordinator. Normal execution gate.
- **Last-round constraint.** `lastRoundInstruction` forbids `final: false` on the last available round. If the LLM ignores it and returns non-final-low on the last round, `runLoop` bails with `exhausted`.

## Temp directory (`$WRAP_TEMP_DIR`)

One per invocation, created at startup via `mkdtempSync`. Exported into `process.env` — `Bun.spawn` needs explicit `env: process.env` pass-through.

**Principle: the temp dir is for storing artifacts, not executing arbitrary code.** The boundary is "what kind of operation," not "where output lands."

Low-risk: `curl -o $WRAP_TEMP_DIR/file`, `cp`, `tar -xf`, `git clone`, `aws s3 cp`.
Not low-risk: `pip install --target`, `npm install --prefix`, `make -C`, `bash $WRAP_TEMP_DIR/script.sh`.

Context section included every round (listing refreshes per round because dir mutates mid-invocation). LLM told only the variable name, never the literal path.

No exit-handler cleanup. `$TMPDIR` is temporary by convention; OS cleanup is backstop.

When a command crosses the invocation boundary (clipboard, shell history), `$WRAP_TEMP_DIR` should be substituted with the literal path — without this, a replayed command silently expands to `/script.sh` in a fresh shell. Substitution is planned for the copy action; not yet built.

## Echo projection

`buildPromptInput` renders transcript turns via `projectResponseForEcho`:
- **Include:** `type`, `content`, `risk_level`, `final`, `plan` (when set), `pipe_stdin` (when set).
- **Strip:** `explanation` (user-facing, wastes tokens), `memory_updates` / `memory_updates_message` / `watchlist_additions` (already actioned), `_scratchpad` (each round plans fresh — see [[scratchpad]]).

Single place that decides which fields the LLM sees across rounds.

## Decisions

- **`final` flag, not separate types.** The dimension is terminality, not kind-of-action. Non-terminal commands at any risk (with confirmation gating) cover everything a separate `probe` type would.
- **Dialog-open rule, no flicker.** Opening and closing the dialog mid-flow is worse than the asymmetry.
- **Budget resets on confirmed step.** Same as follow-up. Each step gets a full budget.
- **Step output in dialog, not stdout.** Captured output routes through notification bus to `state.outputSlot` (last 3 rows).
