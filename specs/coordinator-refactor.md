# Coordinator Refactor

> Replaced the follow-up branch's "two control loops sharing mutable state through a closure and a global side channel" with a five-layer architecture: a generator-driven round runner, a pure reducer over a tagged-union app state, a dialog that's a function of state, a coordinator (`runSession`) that owns all I/O, and a typed notification bus that replaces the output sink.

> **Status:** Implemented. The code at `src/core/transcript.ts`, `src/core/round.ts`, `src/core/runner.ts`, `src/core/notify.ts`, `src/session/{state,reducer,session,dialog-host}.ts`, and `src/tui/dialog.tsx` is the source of truth for the surface; this spec keeps the *why* and the architectural commitments that future specs (multi-step in particular) inherit.

> **Prerequisites:**
> - `specs/follow-up.md` — vocabulary (`confirming` / `editing-command` / `composing-followup` / `processing-followup`, the dialog state machine, the LoopState shape) and the user-visible behaviour the refactor preserves.
> - `specs/multi-step.md` — landing NEXT against the architecture this refactor produced. Three details below in § Forward compatibility for multi-step exist for that landing.
> - `specs/ARCHITECTURE.md` — module layout overview.

---

## Why this refactor

The follow-up branch was correct but architecturally convoluted. Six structural problems all had the same fix:

1. **Three actors shared four mutable bags by reference.** The old `runQuery` built `LoopState`, `input.messages`, the `entry` log, and a `CurrentCommand = { response, round }` and handed all of them to a `createFollowupHandler` closure. The dialog called the closure on submit; the closure mutated all four in place; the dialog mirrored part of that into its own React `useState`; after the dialog exited, `runQuery` read from the mutated `current` to execute. There was no single source of truth for "the current command" — there were at least four kept in lockstep by convention.

2. **The round loop re-entered through a closure that needed message-history hygiene.** The loop pushed `lastRoundInstruction` and refused-probe pairs into `input.messages` mid-call. Those pushes outlived the call. `stripStaleInstructions` existed only to clean them up before the closure re-entered the loop. A maintenance trap: cleanup that worked because someone remembered the loop left debris.

3. **A global single-slot output sink with three modules reaching into it.** `output-sink.ts` was a single-slot `interceptOutput`/`release` channel that threw on double-claim. The chrome spinner reached into it via `isOutputIntercepted()` to silence itself when the dialog was up. The dialog subscribed to chrome events through a `subscribeChrome` callback prop AND gated the subscription on `dialogState === "processing-followup"` to drop "zombie events" from a still-emitting aborted call. Each was the correct local fix for a real bug; the bug *class* was emergent from the architecture.

4. **Two spinners, one global flag.** A stderr-direct `\r`-frame chrome spinner and a React-driven dialog bottom-border spinner shared frame constants but had separate lifecycles. The chrome spinner was started inside the loop for *every* LLM call and silently no-op'd via `isOutputIntercepted()` when the dialog was up.

5. **A circular dep we had to invent a third module to break.** `core/followup-types.ts` existed only because the dialog needed `FollowupResult` and `query.ts` needed `FollowupHandler`, and putting either in `tui/` or `core/` would cycle. When you have to invent a third module to break a cycle, the cycle is the message: those two modules are doing each other's jobs.

6. **The dialog had React `useState` for application state.** `command`, `riskLevel`, `explanation` were seeded from `initial*`-prefixed props and a test pinned that re-render with new `initial*` props did NOT overwrite the state. The whole dance existed because `showDialog` returned a Promise — the parent had no handle to push new props after mount, so local state was the only escape hatch.

The independent fix to all six is the same architectural shape, described next.

---

## Target architecture

Five layers, one direction of data flow.

```
                  ┌─────────────────────────────────┐
                  │           runSession            │   ← coordinator
                  │  (only thing with side effects) │     (src/session/session.ts)
                  └────────┬───────────────┬────────┘
                           │               │
                  drives   │               │  awaits user input
                           ▼               ▼
                  ┌─────────────┐    ┌─────────────┐
                  │   runLoop   │    │   Dialog    │
                  │  generator  │    │ (state, d)  │
                  └─────┬───────┘    └─────┬───────┘
                        │                  │
                        │   events         │  events
                        └───────┬──────────┘
                                ▼
                       ┌─────────────────┐
                       │     reduce      │   ← pure
                       │ (state, event)  │     (src/session/reducer.ts)
                       │   → state       │
                       └────────┬────────┘
                                ▼
                            AppState
```

**Layer A — Round runner.** Three pure-ish primitives in `src/core/`:
- **`Transcript`** (`transcript.ts`) — the conversation history as a list of *semantic* turns (`user`, `probe`, `candidate_command`, `answer`), NOT a provider-shaped `PromptInput`. The transcript is the durable state; `PromptInput` is built fresh from it on every LLM call via `buildPromptInput`. There is no `stripStaleInstructions` because there are no stale instructions to strip — meta-directives (`isLastRound`, the probe-risk retry pair) live only inside the local `AttemptDirectives` arg of one `buildPromptInput` call.
- **`runRound`** (`round.ts`) — a single LLM call with in-round retries (parse-failure, probe-risk). Reads the transcript via `buildPromptInput(transcript, scaffold, directives)`. Owns its own spinner (per LLM call, not per loop, so chrome lines emitted between rounds land on a clean stderr row). On failure throws a typed `RoundError` carrying the partial `Round`.
- **`runLoop`** (`runner.ts`) — async generator that drives `runRound` repeatedly, executes probes inline, pushes turns to the transcript AFTER each probe runs, yields lifecycle events (`round-complete`, `step-running`, `step-output`), returns a `LoopReturn` discriminated union (`command` / `answer` / `exhausted` / `aborted`).

**Layer B — Application state machine.** A pure reducer over a tagged union (`src/session/state.ts`, `src/session/reducer.ts`):
- `AppState` tags: `thinking`, `confirming`, `editing`, `composing`, `processing`, `exiting`. Each tag is a self-contained record. **No shared base type, no class hierarchy.** Adding fields (for multi-step) is additive.
- `AppEvent` is a union of everything that can happen: loop events, key events, draft changes, notifications, the no-TTY block dispatch.
- `reduce(state, event) → AppState` is pure. No I/O. Every (state, event) pair has a defined transition; "wrong" pairs return `state` by reference (`===`) so the coordinator can short-circuit.

**Layer C — Dialog.** A function of state. `Dialog({ state, dispatch })` in `src/tui/dialog.tsx`. Zero React `useState` for application state. Local state is limited to: action-bar selection (presentation only, reset on tag change), `borderCount` from `measureElement`, terminal dimensions, the spinner frame, and the cursor position inside `TextInput`. Inputs dispatch `draft-change` / `submit-edit` / `submit-followup` / `key-action` / `key-esc` and let the reducer own the rest.

**Layer D — Coordinator.** `runSession(prompt, provider, options) → Promise<exitCode>` in `src/session/session.ts`. The ONLY layer that touches the dialog, owns abort/restart of the loop, decides exit, and writes the final log entry. (Other layers have narrow I/O of their own — the runner spawns probe processes and writes memory/watchlist, the notification bus emits to stderr, the LLM provider makes network calls. The coordinator is not the only thing with I/O — it's the only orchestrator.)

The honest division of labour: the runner does *narrow* I/O (LLM calls, probe execution, memory writes, notification emits) within its own scope. It does NOT touch the dialog, does NOT make routing decisions, does NOT mutate any state outside the transcript and the LogEntry. The coordinator does *orchestration* I/O — anything that requires knowing what the user is doing or what the dialog looks like. The reducer is pure.

**Layer E — Notification bus.** Typed event emitter in `src/core/notify.ts` (deliberately in `core/`, not `session/`, so `chrome()` and `verbose()` can import it without `core/` reaching across into `session/`). Replaced `output-sink.ts`. With no listener subscribed, the bus writes a default-formatted line to stderr. With a listener subscribed (the session), the listener decides what to do — buffer for later flush, dispatch to reducer for live display, or both. **No claim/release lifecycle. No throws on double-claim. No `isOutputIntercepted()` flag.**

---

## Module layout

```
src/
  core/
    transcript.ts       # Transcript + TranscriptTurn + buildPromptInput + AttemptDirectives
    round.ts            # runRound + RoundError + callWithRetry + REFUSED_PROBE_INSTRUCTION
    runner.ts           # runLoop async generator + LoopState + LoopEvent + LoopReturn + fetchesUrl
    notify.ts           # emit/subscribe/Notification + writeNotificationToStderr
  session/
    state.ts            # AppState + AppEvent + SessionOutcome + ActionId + isDialogTag
    reducer.ts          # reduce(state, event) → AppState  (pure)
    session.ts          # runSession(prompt, provider, options) → Promise<exitCode>
    dialog-host.ts      # preloadDialogModules + mountDialog + DialogHost
```

`src/core/query.ts`, `src/core/output-sink.ts`, `src/core/followup-types.ts`, and `src/tui/render.ts` are deleted. `src/core/output.ts` and `src/core/verbose.ts` route through the notification bus instead of `writeLine`. `src/core/spinner.ts` no longer reads the output-sink flag — the session passes `showSpinner: false` to follow-up loops, so the chrome spinner can never run while the dialog owns the alt screen.

---

## Load-bearing invariants

Things the implementation does that the next person editing this code MUST preserve. These are the parts that broke the old branch and that future changes are most likely to regress.

### Orphan-turn prevention (runner)

The runner re-checks `options.signal?.aborted` IMMEDIATELY after every await (`runRound` and `executeShellCommand`) and returns `{ type: "aborted" }` without pushing any transcript turn or yielding any event past the await. Without these post-await checks, a slow provider that doesn't honour AbortSignal in flight, plus a user who Esc-resubmits during the drain window, would leave an orphan `candidate_command` (or `answer` or `probe`) turn in the transcript that the new pumpLoop's LLM call would see and treat as live conversation.

The two extra `if` statements close this race entirely; nothing else is needed. Pinned in `tests/runner.test.ts` as the "orphan-turn race" tests.

### Concurrent pumpLoop drain (coordinator)

When the user presses Esc during `processing` and immediately resubmits, a previous `pumpLoop` may still be draining (its `await generator.next()` is held by a provider that hasn't honoured the AbortSignal yet). Both pumpLoops can briefly coexist. The coordinator's identity check —

```ts
if (currentLoopAbort === ctrl) currentLoopAbort = null;
```

— in pumpLoop's `finally` prevents the stale loop from clobbering the new pumpLoop's controller. The stale one's `if (ctrl.signal.aborted) return;` guard drops its `loop-final` dispatch.

### Eager-log-then-throw

`runRound` throws `RoundError` carrying the partial `Round`. `runLoop` catches it, yields `round-complete` with the partial round (so the consumer logs it), then re-throws. The consumer's `addRound(entry, round)` runs as it processes the yielded `round-complete` event BEFORE control returns to `await generator.next()`. The throw then surfaces on the next `.next()` call, by which time the partial round is already in `entry.rounds`. This preserves the eager-log-then-throw guarantee with an explicit mechanism, not a comment.

### Spinner is per LLM call, not per loop

The chrome spinner is started at the top of `runRound` and stopped in its `finally`. Doing it per LLM call (rather than once around the whole loop) means the spinner is stopped between iterations, so chrome notifications emitted by the loop (memory updates, step explanations) land on a clean stderr row instead of racing the spinner's `\r`-rewritten frame.

The session passes `showSpinner: true` for the initial loop in `thinking` and `false` for follow-up loops in `processing` (where the dialog has its own bottom-border spinner). The chrome spinner can never run while the alt screen is active.

### Dialog mount race + first-mount lazy import

`mountDialog` requires `preloadDialogModules()` to have resolved at least once. The session kicks off the lazy import in parallel with the first LLM call so the await before the first dialog mount is free in practice.

`syncDialog` is async only for the very first mount. A `mountInProgress` flag gates a second `dispatch → syncDialog` call from racing into the mount branch and creating two Ink apps. After the in-flight mount completes, the closure re-syncs to apply any state changes that happened during the await.

A failed dynamic import is captured by a `.catch` that dispatches `loop-error`, so a broken import surfaces as a clean session error instead of an unbounded hang on the exit deferred.

### Notification routing rules (coordinator listener)

```ts
notifications.subscribe((n) => {
  if (hostRef.current === null) {
    writeNotificationToStderr(n);   // path A: no dialog → straight to stderr
    return;
  }
  buffered.push(n);                  // path B: dialog up → buffer for replay
  if (state.tag === "processing" && n.kind === "chrome") {
    dispatch({ type: "notification", notification: n });   // and live-update the bottom border
  }
});
```

- Notifications from the no-dialog phases (`thinking`, `exiting`, post-unmount) go straight to stderr — chrome lines from the initial loop's probes/memory updates land in real scrollback as they happen.
- Notifications during the alt-screen phase are buffered. Without buffering, stderr writes during alt-screen would land in the alt buffer and disappear on exit.
- The buffer is flushed AFTER `dialogHost.unmount()` (which itself happens after `EXIT_ALT_SCREEN` is written). Order is load-bearing: flushed lines must land in real scrollback, not the alt buffer that's about to disappear.
- The listener stays subscribed through `finaliseOutcome`, so verbose/chrome lines emitted during the run-side-effect (exec'd command output is via inherited stdio, but `verbose("Executing command...")` and `verbose("Command exited (...)")` go through the bus) still route correctly.

### Pre-transition abort

For `key-esc` while in `processing`, the coordinator aborts `currentLoopAbort` BEFORE calling the reducer. Any in-flight LLM call gets cancelled even if its result was about to land. Loop events emitted AFTER an abort are dropped by the `if (ctrl.signal.aborted) return;` check inside `pumpLoop`. The reducer doesn't have to know about abort epochs.

### Source of truth for the current command

Dialog states (`ConfirmingState`, `EditingState`, `ComposingState`, `ProcessingState`) carry `response: CommandResponse` and `round: Round` as type fields. The reducer threads them through every transition. The coordinator reads `state.response` when building the `SessionOutcome.run` (so the run outcome carries both the executed bytes and the original model response, supporting `source: "user_override"` audits). The follow-up post-transition hook does NOT read `state.response` — it just pushes a `user` turn; the prior `candidate_command` turn already in the transcript provides the LLM context. There is one source of truth (state for outcome data, transcript for conversation history) and no separate `CurrentCommand` bag.

### `source: "model"` vs `source: "user_override"`

- `key-action run` from `confirming` → `source: "model"`. The executed bytes equal `response.content`.
- `submit-edit text` from `editing` → `source: "user_override"`. The executed bytes are user-authored; risk and explanation carry through from the model's response. The log records both `command` (what ran) and `response.content` (what the model said) so audits can tell them apart.

Pinned in `tests/session-reducer.test.ts`.

### `thinking` vs `processing` low-risk asymmetry

- `thinking → loop-final command low` → `exiting{run, source: "model"}` (skip the dialog, exec straight away).
- `processing → loop-final command low` → `confirming` (open the dialog in the low-risk gradient — the user is in the middle of refining and the dialog is already mounted).

This asymmetry is the user-visible difference between "the LLM nailed it on the first shot" and "the LLM produced something low-risk after a follow-up clarification" — the first should never block the user; the second should still confirm because the user is already engaged. Pinned in the reducer tests.

---

## Forward compatibility for multi-step

These constraints exist so `specs/multi-step.md` can land cleanly against this architecture without rework.

### 1. Vocabulary is neutral, not probe-specific

Event names in `LoopEvent` are `step-running` / `step-output` rather than `probe-running` / `probe-output`. Today they only fire for low-risk probes (the only thing the loop runs inline). Multi-step generalises "non-final low" — the events keep their names, the runner branch keeps its meaning. **Do not name an event `probe-*` or a state field `probe`.** The word "probe" appears today only in things multi-step deletes (`REFUSED_PROBE_INSTRUCTION`, `probeRiskRetry`) and in the schema (which multi-step migrates).

### 2. The coordinator's loop-restart primitive is parameterised

Today the coordinator restarts the loop after `submit-followup`. Multi-step adds a second restart trigger: after the user confirms a non-final medium/high command (`onConfirmStep` in the multi-step spec). Both will push different turns to the transcript (a `user` turn vs a `step` turn) and then call the same `pumpLoop()` primitive.

**Implementation directive:** keep the turn-pushing logic OUT of `pumpLoop`. Push the turn at the dispatch site (the `submit-followup` post-transition hook), then call `pumpLoop()`. Multi-step will add a `submit-step-confirm` post-transition hook that pushes its own turn and calls `pumpLoop()` the same way. If you bake follow-up-specific turn assembly into `pumpLoop`, multi-step will fork it.

`pumpLoop` takes no arguments. It reads `state` to decide whether the current pump is the initial loop (showSpinner=true) or a follow-up loop (showSpinner=false), and reads `transcript` directly. The post-transition hook is the only thing that pushes turns and resets the budget.

### 3. State fields are additive

`AppState`'s tag types are object literals. Adding `outputSlot?: string` to the dialog states (for multi-step's "tail-3-rows of last captured step output" display) must be a one-line change to each tag, not a restructuring. **Do not introduce a shared base type or class hierarchy** for the dialog states. Each tag is its own object literal.

Same for `plan?: string` (multi-step). Same for `executing-step` — multi-step adds it as a new tag in the union; it slots in next to `processing` without touching existing tags.

If the implementer is tempted to "DRY up" the dialog states with a shared base, resist. The duplication is the design.

### 4. The post-transition hook for "loop-restart from a new state tag" must be addable

Multi-step adds an `executing-step` reducer tag and a parallel coordinator hook (`submit-step-confirm`) that pushes a `step` turn (the new turn kind multi-step adds to the transcript) and calls `pumpLoop()`. The structure mirrors today's `submit-followup` post-transition hook (the `if (state.tag === "processing")` branch in `dispatch`). Multi-step will add a similar branch: `if (state.tag === "executing-step")`.

### 5. The semantic transcript subsumes `projectForEcho`

Multi-step's `projectForEcho` helper exists to strip user-facing fields (`explanation`, `_scratchpad`) when echoing a `CommandResponse` back to the LLM. With the semantic transcript, this becomes `buildPromptInput`'s rendering rule for `candidate_command` and `probe` turns: render only the model-facing fields. The implementer of multi-step should add the projection logic INSIDE `buildPromptInput`, not as a separate helper. The transcript stores full responses; the builder decides which fields to expose to the LLM.

---

## Renames in scope

Applied as part of this refactor (mechanical, behaviour-preserving, reduce churn for `specs/multi-step.md`):

| Old name | New name | File |
|---|---|---|
| `DEFAULT_MAX_PROBE_OUTPUT_CHARS` | `DEFAULT_MAX_CAPTURED_OUTPUT_CHARS` | `src/config/config.ts` |
| `Config.maxProbeOutputChars` | `maxCapturedOutputChars` | `src/config/config.ts` |
| `maxProbeOutputChars` (JSON Schema) | `maxCapturedOutputChars` | `src/config/config.schema.json` |
| `RoundsOptions.maxProbeOutput` | `LoopOptions.maxCapturedOutput` | `src/core/runner.ts` |
| `sectionProbeOutput` | `sectionCapturedOutput` (`"## Captured output"`) | `src/prompt.constants.json` |
| `probeNoOutput` | `capturedNoOutput` | `src/prompt.constants.json` |
| `runQuery` | `runSession` | function name |
| `core/query.ts` | `session/session.ts` | path |
| `RoundsOptions` | `LoopOptions` | type name |
| `runRoundsUntilFinal` | `runLoop` (now a generator) | function name |

The config-file rename is a breaking change for any user with `maxProbeOutputChars` in `~/.wrap/config.jsonc`. Per `CLAUDE.md` ("pre-release; single user accepts churn"), no shim. The user manually updates their config if needed.

Anything not on this list — including the `probe` schema enum, `REFUSED_PROBE_INSTRUCTION`, `probeRiskInstruction`, `probeRiskRefusedPrefix`, the probe-risk retry block — is OUT of scope; multi-step deletes those entirely.

---

## Test plan (high-level)

The new test files cover each layer in isolation:

- `tests/transcript.test.ts` — pure unit tests for `buildPromptInput`: turn rendering, directive application, scaffold prefix messages, no-mutation guarantee, probe-output trimming and the captured-no-output sentinel.
- `tests/round.test.ts` — pure unit tests for `runRound`: success cases, parse-failure retry, probe-risk retry, `RoundError` on empty content + LLM failure, the wrapped error message including the model label, transcript-read-only guarantee.
- `tests/runner.test.ts` — generator unit tests for `runLoop`: single-iteration command/answer, probe → command, exhausted, abort at top-of-iteration, **orphan-turn race during `runRound` await**, eager-throw ordering.
- `tests/notify.test.ts` — bus unit tests: subscribe/unsubscribe, multi-listener fan-out, no-listener stderr fallback, listener-throws-doesn't-crash-emit, reset.
- `tests/session-reducer.test.ts` — one test per row of the transition table, plus purity, by-reference no-op behaviour, the `source: "model"` vs `source: "user_override"` audit pin, the `thinking` vs `processing` low-risk asymmetry.
- `tests/session.test.ts` — coordinator integration tests via `runSession`: initial low-risk, initial answer, exhausted, error throw, no-TTY block, multi-round (probe → answer) eager-logging.
- `tests/dialog.test.tsx` — fixture-driven render tests: each tag renders the right content, key events dispatch the right `AppEvent`s, rerender swaps content without remounting.

The pre-existing `tests/logging.test.ts` integration suite (which spawns the binary as a subprocess) covers the cross-layer outcome → logged-entry mapping.

Tests deleted with the old code: `tests/output-sink.test.ts`, `tests/followup.test.ts`, `tests/rounds.test.ts`, the original `tests/dialog.test.tsx` (which pinned the inverted "initial props are captured as state and ignored on re-render" behaviour).

---

## Things explicitly not touched

- The LLM prompt (no schema changes, no instruction changes, no constants beyond the renames table)
- The `_scratchpad` field (`specs/scratchpad.md` is its own landing)
- Multi-step (`specs/multi-step.md` is the next landing — depends on this refactor)
- The dialog visual design (border gradient, action bar, key hints — unchanged)
- The `Cursor` class and `TextInput` component
- The `executeShellCommand` API and its zsh `+m -ic` invocation
- The logging entry shape (`Round.followup_text` stays)
- The keybindings (`y/n/q/Esc/e/f/d/c/←/→/Enter` — same set)
- The eval pipeline
- The test provider, the AI SDK provider, the claude-code provider
- The init flow (memory, watchlist, config, init probes — unchanged)
- The subcommand dispatch
- The piped input flow

---

## Glossary

- **Pumping the loop** — pulling events from the `runLoop` async generator and dispatching them until it returns or the consumer aborts via the AbortSignal it created. `pumpLoop` in the coordinator (named to disambiguate from `runLoop`, the generator itself).
- **Post-transition hook** — the section of the dispatch closure that runs AFTER `reduce()` produces a new state. Triggers side effects (dialog mount/rerender/unmount, loop restart, exit) based on the new state's tag. Multi-step adds a parallel post-transition hook for `submit-step-confirm`.
- **Orphan turn** — a transcript turn pushed by a `pumpLoop` whose abort signal has fired. The runner's post-await abort checks make these impossible.
