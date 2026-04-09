# Coordinator Architecture

> Five-layer session architecture: a generator-driven round runner, a pure reducer over a tagged-union app state, a dialog that's a function of state, a coordinator (`runSession`) that orchestrates I/O, and a typed notification bus with a routing layer that replaces the old output sink.

> **Status:** Built. Source of truth: `src/core/{transcript,round,runner,notify}.ts` and `src/session/{state,reducer,session,dialog-host,notification-router}.ts`. This spec keeps the *why*, the architectural commitments, and the invariants future specs (multi-step in particular) inherit.

> **Related specs:**
> - `specs/follow-up.md` — user-visible follow-up behaviour this architecture preserves.
> - `specs/multi-step.md` — lands against the forward-compat hooks below.
> - `specs/ARCHITECTURE.md` — module layout overview.

---

## Why this shape

The follow-up branch was correct but convoluted. Six structural problems all resolved into the same architectural fix:

1. **Three actors shared four mutable bags by reference.** The old `runQuery` built `LoopState`, `input.messages`, a log `entry`, and a `CurrentCommand = { response, round }` and handed all of them to a `createFollowupHandler` closure. Dialog submit called the closure; the closure mutated all four in place; the dialog mirrored part into its own React state. No single source of truth for "the current command" — at least four, kept in lockstep by convention.

2. **The round loop re-entered through a closure that needed message-history hygiene.** The loop pushed `lastRoundInstruction` and refused-probe pairs into `input.messages` mid-call; those pushes outlived the call; `stripStaleInstructions` cleaned them up before re-entry. Cleanup that worked because someone remembered the loop left debris.

3. **A global single-slot output sink.** `output-sink.ts` was an `interceptOutput`/`release` channel that threw on double-claim. The chrome spinner reached into it via `isOutputIntercepted()` to silence itself. The dialog subscribed to chrome events through a prop AND gated the subscription on `dialogState === "processing-followup"` to drop zombie events. Each local fix was right; the bug *class* was emergent.

4. **Two spinners, one global flag.** A stderr-direct chrome spinner and a React-driven dialog bottom-border spinner shared constants but had separate lifecycles, coupled by `isOutputIntercepted()`.

5. **A circular dep broken by a third module.** `core/followup-types.ts` existed only because the dialog needed `FollowupResult` and `query.ts` needed `FollowupHandler`. When you invent a third module to break a cycle, the cycle is telling you the two modules are doing each other's jobs.

6. **The dialog had React `useState` for application state.** `command`, `riskLevel`, `explanation` were seeded from `initial*` props and pinned to NOT overwrite on re-render. The dance existed because `showDialog` returned a Promise — the parent had no handle to push new props after mount.

One architectural shape fixes all six.

---

## The five layers

```
                  ┌─────────────────────────────────┐
                  │           runSession            │   ← coordinator
                  │       (orchestration I/O)       │     (src/session/session.ts)
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

**Layer A — Round runner.** Three primitives in `src/core/`:
- **`Transcript`** (`transcript.ts`) — conversation history as *semantic* turns (`user`, `probe`, `candidate_command`, `answer`), NOT a provider-shaped `PromptInput`. The transcript is durable state; `PromptInput` is rebuilt fresh from it on every LLM call via `buildPromptInput`. There is no `stripStaleInstructions` because there are no stale instructions to strip — meta-directives (`isLastRound`, the probe-risk retry pair) live only inside the `AttemptDirectives` arg of one `buildPromptInput` call.
- **`runRound`** (`round.ts`) — a single LLM call with in-round retries (parse-failure, probe-risk). Owns its spinner (per call, not per loop). On failure throws a typed `RoundError` carrying the partial `Round`.
- **`runLoop`** (`runner.ts`) — async generator that drives `runRound` repeatedly, executes probes inline, pushes turns to the transcript AFTER each probe runs, yields lifecycle events (`round-complete`, `step-running`, `step-output`), returns a `LoopReturn` discriminated union (`command` / `answer` / `exhausted` / `aborted`).

**Layer B — Application state machine.** A pure reducer over a tagged union (`src/session/{state,reducer}.ts`):
- `AppState` tags: `thinking`, `confirming`, `editing`, `composing`, `processing`, `exiting`. Each tag is a self-contained object literal. **No shared base type, no class hierarchy.** Adding fields (for multi-step) is additive.
- `AppEvent` is a union of everything that can happen: loop events, key events, draft changes, notifications, no-TTY block dispatch.
- `reduce(state, event) → AppState` is pure. "Wrong" (state, event) pairs return `state` by reference (`===`) so the coordinator can short-circuit.

**Layer C — Dialog.** A function of state. `Dialog({ state, dispatch })` in `src/tui/dialog.tsx`. Zero React `useState` for application state. Local state is limited to: action-bar selection (presentation only, reset on tag change), `borderCount` from `measureElement`, terminal dimensions, spinner frame, and `TextInput` cursor position. Inputs dispatch `draft-change` / `submit-edit` / `submit-followup` / `key-action` / `key-esc`; the reducer owns the rest.

**Layer D — Coordinator.** `runSession(prompt, provider, options) → Promise<exitCode>` in `src/session/session.ts`. The only orchestrator: touches the dialog, owns abort/restart of the loop, decides exit, writes the final log entry. Other layers have narrow I/O of their own — the runner spawns probe processes and writes memory/watchlist, the notification bus emits to stderr, the LLM provider makes network calls. The coordinator is not the only thing with I/O — it's the only thing making routing decisions across layers.

**Layer E — Notification bus + router.** `src/core/notify.ts` is a typed event emitter (deliberately in `core/` so `chrome()` and `verbose()` can import it without `core/` reaching into `session/`). With no listener, the bus writes a default-formatted line to stderr. With a listener, the listener decides what to do. No claim/release lifecycle, no throws, no `isOutputIntercepted()` flag.

`src/session/notification-router.ts` is the session's listener. It holds the dialog handle and the buffer and is the **single source of truth for "is the dialog up?"** — the coordinator reads `router.isDialogMounted()` / `router.getDialog()` rather than tracking its own copy. See § Notification routing below.

---

## Module layout

```
src/
  core/
    transcript.ts        # Transcript + TranscriptTurn + buildPromptInput + AttemptDirectives
    round.ts             # runRound + RoundError + callWithRetry + REFUSED_PROBE_INSTRUCTION
    runner.ts            # runLoop async generator + LoopState + LoopEvent + LoopReturn
    notify.ts            # emit/subscribe/Notification + writeNotificationToStderr
  session/
    state.ts             # AppState + AppEvent + SessionOutcome + ActionId + isDialogTag
    reducer.ts           # reduce(state, event) → AppState  (pure)
    session.ts           # runSession + pumpLoop + finaliseOutcome
    dialog-host.ts       # preloadDialogModules + mountDialog + DialogHost
    notification-router.ts  # createNotificationRouter — dialog handle + buffer + routing
```

Deleted with the refactor: `src/core/query.ts`, `src/core/output-sink.ts`, `src/core/followup-types.ts`, `src/tui/render.ts`. `src/core/output.ts` and `src/core/verbose.ts` route through the notification bus. `src/core/spinner.ts` no longer reads any global flag — the session passes `showSpinner: false` to follow-up loops, so the chrome spinner can never run while the dialog owns the alt screen.

---

## Load-bearing invariants

Things the implementation does that future edits MUST preserve. These are the parts that broke the old branch and are most likely to regress.

### Orphan-turn prevention (runner)

`runLoop` re-checks `options.signal?.aborted` IMMEDIATELY after every await (`runRound` and `executeShellCommand`) and returns `{ type: "aborted" }` without pushing any transcript turn or yielding any event past the await. Without these post-await checks, a slow provider that doesn't honour `AbortSignal` in flight, plus a user who Esc-resubmits during the drain window, would leave an orphan `candidate_command` (or `answer` or `probe`) turn in the transcript that the next pump's LLM call would see and treat as live conversation.

The two extra `if` statements close this race entirely. Pinned in `tests/runner.test.ts` as the "orphan-turn race" tests.

### Eager-log-then-throw

`runRound` throws `RoundError` carrying the partial `Round`. `runLoop` catches it, yields `round-complete` with the partial round, then re-throws. The consumer's `addRound(entry, round)` runs as it processes the yielded `round-complete` event BEFORE control returns to `await generator.next()`. The throw then surfaces on the next `.next()`, by which time the partial round is already in `entry.rounds`. Eager-log-then-throw is an explicit mechanism, not a comment.

### Spinner is per LLM call, not per loop

The chrome spinner starts at the top of `runRound` and stops in its `finally`. Per-call (not once around the whole loop) means the spinner is stopped between iterations, so chrome notifications emitted by the loop (memory updates, step explanations) land on a clean stderr row instead of racing the spinner's `\r`-rewritten frame.

The session passes `showSpinner: true` for the initial loop (`thinking`) and `false` for follow-up loops (`processing`, where the dialog has its own bottom-border spinner). The chrome spinner can never run while the alt screen is active.

### Dialog mount race + first-mount lazy import

`mountDialog` requires `preloadDialogModules()` to have resolved at least once. The session kicks off the lazy import in parallel with the first LLM call so the await before the first dialog mount is free in practice.

`syncDialog` is async only for the very first mount. A `mountInProgress` flag gates a second `dispatch → syncDialog` from racing into the mount branch and creating two Ink apps. After the in-flight mount completes, the closure re-syncs to apply any state changes that happened during the await.

A failed dynamic import is captured by a `.catch` that dispatches `loop-error`, so a broken import surfaces as a clean session error rather than an unbounded hang on `exitDeferred`.

### Notification routing (the router's job)

The router subscribes to the bus and routes each notification based on whether a dialog handle is set:

- **No dialog mounted** → write straight to stderr. Covers `thinking`, `exiting`, and the post-unmount exec phase. Chrome lines from the initial loop's probes/memory updates land in real scrollback as they happen.
- **Dialog mounted** → buffer for replay. Without buffering, stderr writes during alt-screen would land in the alt buffer and disappear on exit.
- **Dialog mounted AND `isProcessing()` AND `kind === "chrome"`** → also call `onProcessingChrome(n)`, which the coordinator wires to `dispatch({ type: "notification", ... })` so the reducer updates the bottom-border status live.

`router.teardownDialog()` unmounts the dialog (which writes `EXIT_ALT_SCREEN`) and THEN flushes the buffer. Order is load-bearing: flushed lines must land in real scrollback, not the alt buffer that's about to disappear. Teardown is idempotent and is called both before exec and in the `finally`, so the session survives a mid-flight throw without leaving the alt screen up.

The listener stays subscribed through `finaliseOutcome`, so `verbose("Executing command...")` and `verbose("Command exited (...)")` from the exec phase still route correctly.

**The router owns `dialog === null` as the single source of truth.** The coordinator does not keep its own `host` variable; it reads `router.isDialogMounted()` / `router.getDialog()`. `isProcessing` is a *pull* callback (not pushed state) so the router never has to mirror the coordinator's state machine.

### Pre-transition abort

For `key-esc` while in `processing`, the coordinator calls `currentLoopAbort.abort()` BEFORE invoking the reducer. Any in-flight LLM call gets cancelled even if its result was about to land. Loop events emitted AFTER an abort are dropped by the `if (signal.aborted) return;` check inside `pumpLoop`. The reducer never has to know about abort epochs.

### Source of truth for the current command

Dialog states (`ConfirmingState`, `EditingState`, `ComposingState`, `ProcessingState`) carry `response: CommandResponse` and `round: Round` as type fields. The reducer threads them through every transition. The coordinator reads `state.response` when building `SessionOutcome.run` (so the run outcome carries both the executed bytes and the original model response, supporting `source: "user_override"` audits). The follow-up post-transition hook does NOT read `state.response` — it just pushes a `user` turn; the prior `candidate_command` turn already in the transcript provides LLM context. One source of truth (state for outcome data, transcript for conversation history), no separate `CurrentCommand` bag.

### `source: "model"` vs `source: "user_override"`

- `key-action run` from `confirming` → `source: "model"`. Executed bytes equal `response.content`.
- `submit-edit text` from `editing` → `source: "user_override"`. Executed bytes are user-authored; risk and explanation carry through from the model's response. The log records both `command` (what ran) and `response.content` (what the model said) so audits can tell them apart.

Pinned in `tests/session-reducer.test.ts`.

### `thinking` vs `processing` low-risk asymmetry

- `thinking → loop-final command low` → `exiting{run, source: "model"}` (skip the dialog, exec straight away).
- `processing → loop-final command low` → `confirming` (open the dialog in the low-risk gradient — the user is in the middle of refining and the dialog is already mounted).

The asymmetry is the user-visible difference between "the LLM nailed it first try" and "the LLM produced something low-risk after a follow-up clarification" — the first should never block the user; the second should still confirm because the user is already engaged. Pinned in the reducer tests.

---

## Forward compatibility for multi-step

Constraints that exist so `specs/multi-step.md` can land cleanly without rework.

### 1. Vocabulary is neutral, not probe-specific

`LoopEvent` uses `step-running` / `step-output`, not `probe-running` / `probe-output`. Today they only fire for low-risk probes (the only thing the loop runs inline). Multi-step generalises "non-final low" — events keep their names, the runner branch keeps its meaning. **Do not name an event `probe-*` or a state field `probe`.** The word "probe" appears today only in things multi-step deletes (`REFUSED_PROBE_INSTRUCTION`, `probeRiskRetry`) and in the schema (which multi-step migrates).

### 2. The loop-restart primitive is parameterised

Today the coordinator restarts the loop after `submit-followup`. Multi-step adds a second trigger: after the user confirms a non-final medium/high command. Both push different turns (a `user` turn vs a `step` turn) and then call the same `startPumpLoop` → `pumpLoop` primitive.

**Implementation directive:** keep turn-pushing OUT of `pumpLoop`. Push the turn at the dispatch site (the `state.tag === "processing"` post-transition hook today), then call `startPumpLoop`. Multi-step will add a parallel post-transition branch that pushes its own turn and calls `startPumpLoop` the same way. If you bake follow-up-specific turn assembly into `pumpLoop`, multi-step will fork it.

`pumpLoop` takes its transcript and loop state as args and uses `isInitialLoop` to pick `showSpinner`. It does not push turns and does not reset the budget — the post-transition hook does both.

### 3. State fields are additive

`AppState`'s tag types are object literals. Adding `outputSlot?: string` (for multi-step's "tail-3-rows of last captured step output" display) or `plan?: string` must be a one-line change to each tag, not a restructuring. **Do not introduce a shared base type or class hierarchy** for the dialog states. The duplication is the design. `executing-step` slots in next to `processing` as a new tag without touching existing tags.

### 4. A new loop-restart post-transition hook must be addable

Multi-step adds an `executing-step` reducer tag and a parallel post-transition branch (`if (state.tag === "executing-step")`) that pushes a `step` turn and calls `startPumpLoop`. The structure mirrors today's `if (state.tag === "processing")` branch in `dispatch`.

### 5. The semantic transcript subsumes `projectForEcho`

Multi-step's `projectForEcho` helper exists to strip user-facing fields (`explanation`, `_scratchpad`) when echoing a `CommandResponse` back to the LLM. With the semantic transcript, this becomes `buildPromptInput`'s rendering rule for `candidate_command` and `probe` turns: render only the model-facing fields. The projection logic belongs INSIDE `buildPromptInput`, not as a separate helper. The transcript stores full responses; the builder decides what to expose.

---

## Things explicitly not touched

- The LLM prompt (no schema changes, no instruction changes)
- The `_scratchpad` field (`specs/scratchpad.md` is its own landing)
- The dialog visual design (border gradient, action bar, key hints)
- The `Cursor` class and `TextInput` component
- The `executeShellCommand` API and its zsh `+m -ic` invocation
- The logging entry shape (`Round.followup_text` stays)
- The keybindings (`y/n/q/Esc/e/f/d/c/←/→/Enter`)
- The eval pipeline
- The test provider, the AI SDK provider, the claude-code provider
- The init flow (memory, watchlist, config, init probes)
- The subcommand dispatch
- The piped input flow

---

## Glossary

- **Pumping the loop** — draining the `runLoop` async generator and dispatching its events until it returns or the consumer aborts. `pumpLoop` in `src/session/session.ts` (named to disambiguate from `runLoop`, the generator itself).
- **Post-transition hook** — the section of the dispatch closure that runs AFTER `reduce()` produces a new state and triggers side effects (dialog mount/rerender/unmount, loop restart, exit) based on the new state's tag. Multi-step adds a parallel hook for `executing-step`.
- **Orphan turn** — a transcript turn that would be pushed by a pump whose abort signal has fired. The runner's post-await abort checks make these impossible.
- **Notification router** — the session-side listener on the notification bus. Holds the dialog handle and the buffer; the single source of truth for whether the dialog is mounted.
