# Coordinator Refactor

> Replace the follow-up branch's "two control loops sharing mutable state through a closure and a global side channel" with a five-layer architecture: a generator-driven round runner, a pure reducer over a tagged-union app state, a dialog that's a function of state, a coordinator (`runSession`) that owns all I/O, and a typed notification bus that replaces the output sink.

> **Status:** Planned — ready to implement.

> **Prerequisites:**
> - Read `specs/follow-up.md` first — this spec uses its vocabulary (`confirming` / `editing-command` / `composing-followup` / `processing-followup`, the four-state dialog machine, "follow-up handler", `LoopState`, `LoopResult`) and assumes the same UX. The follow-up feature is fully implemented; this spec only changes how it's structured.
> - Read `specs/multi-step.md` after this — multi-step lands NEXT, against the architecture this spec produces. Three details in this spec exist to make multi-step land cleanly. They are called out in § Forward compatibility for multi-step.
> - Skim `specs/ARCHITECTURE.md` for the existing module layout.
> - Read `CLAUDE.md` for the runtime/test/lint conventions (Bun, Biome, `bun run check`, TDD).

> **Scope discipline.** Do not implement multi-step or scratchpad in this refactor. Do not change the response schema. Do not change the LLM prompt. Do not introduce any feature beyond what the follow-up branch already does. The end state must be observably identical to the follow-up branch from a user's perspective — same dialog, same keys, same outputs, same logs. The change is structural.

---

## Why this refactor

The follow-up branch is correct but architecturally convoluted. The structural problems, with file:line references for the implementer:

1. **Three actors share four mutable bags by reference.** `runQuery` (`src/core/query.ts:439`) builds `LoopState`, `input.messages`, the `entry` log, and `CurrentCommand = { response, round }` and hands them all to `createFollowupHandler` (`src/core/query.ts:393`). The closure captures them, hands itself to `showDialog`, which hands it to `Dialog`. When the user submits a follow-up, the dialog calls the closure, the closure mutates `current.response`/`current.round`/`state.budgetRemaining`/`input.messages` in place, the dialog then mirrors part of that mutation into its own React `useState`, and *after* the dialog exits, `runQuery` reads from the mutated `current` to execute. There is no single source of truth for "the current command" — there are at least four kept in lockstep by convention. Test pin: `tests/followup.test.ts` (the entire `createFollowupHandler` describe).

2. **The round loop is re-entered through a closure that needs message-history hygiene.** `runRoundsUntilFinal` pushes `lastRoundInstruction` and refused-probe pairs into `input.messages` mid-call (`src/core/query.ts:198-204, 268-271`). Those pushes outlive the call. `stripStaleInstructions` (`src/core/query.ts:348`) exists only to clean them up before the closure re-enters the loop. This is a maintenance trap: the cleanup function only works because someone remembers the loop leaves debris.

3. **A global single-slot output sink with three modules reaching into it.** `src/core/output-sink.ts` is a single-slot `interceptOutput`/`release` channel that throws on double-claim. `src/core/spinner.ts:63` reaches into it via `isOutputIntercepted()` to silence itself when the dialog is up. `src/tui/dialog.tsx:105-111` subscribes to chrome events through a `subscribeChrome` callback prop AND gates the subscription on `dialogState === "processing-followup"` to drop "zombie events" from a still-emitting aborted call. Each one is the correct local fix for a real bug; the bug class is emergent from the architecture.

4. **Two spinners, one global flag.** `src/core/spinner.ts` writes raw `\r` frames to stderr. `src/tui/spinner.ts` drives the dialog bottom border via React. They share frame constants but have separate lifecycles. The chrome spinner is started inside `runRoundsUntilFinal` for *every* LLM call and silently no-ops via `isOutputIntercepted()` when the dialog is up. The dialog independently starts its own spinner via the React hook.

5. **A circular dep we had to invent a third module to break.** `src/core/followup-types.ts` exists only because the dialog needs to know `FollowupResult` and `query.ts` needs to know `FollowupHandler`, and putting either in `tui/` or `core/` would cycle. When you have to invent a third module to break a cycle, the cycle is the message: those two modules are doing each other's jobs.

6. **The dialog has React `useState` for application state.** `command`, `riskLevel`, `explanation` are seeded from `initial*`-prefixed props and a test pin (`tests/dialog.test.tsx:42-66`) ensures re-render with new `initial*` props does NOT overwrite the state. The whole dance exists because `showDialog` returns a Promise — the parent has no handle to push new props after mount, so local state was the only escape hatch.

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
- `Transcript` (in `src/core/transcript.ts`) — the conversation history as a list of *semantic* turns (`user_request`, `followup`, `probe`, `candidate_command`, `answer`), NOT a provider-shaped `PromptInput`. The transcript is the durable state; `PromptInput` is built fresh from it on every LLM call. There is no `stripStaleInstructions` because there are no stale instructions to strip — meta-directives (`lastRoundInstruction`, refused-probe retry) live only inside the local scope of one `runRound` call.
- `runRound(provider, transcript, system, options) → Round` — a single LLM call with in-round retries (parse-failure retry, probe-risk retry). No logging, no chrome, no spinner. Calls `buildPromptInput(transcript, system, attemptDirectives)` internally to produce the messages array. The transcript is read-only inside `runRound`; the loop pushes new turns AFTER each round.
- `runLoop(provider, transcript, system, state, options) → AsyncGenerator<LoopEvent, LoopReturn>` — drives `runRound` repeatedly, executes probes inline, pushes `probe` turns to the transcript after each probe runs, yields lifecycle events (`round-complete`, `step-running`, `step-output`), returns a final-form discriminated union.

**Layer B — Application state machine.** A pure reducer over a tagged union:
- `AppState` lives in `src/session/state.ts`. Tags: `thinking`, `confirming`, `editing`, `composing`, `processing`, `exiting`. Each tag is a self-contained record — no shared base type, no class hierarchy. Adding fields (for multi-step) is additive.
- `AppEvent` is a union of everything that can happen: loop events, key events, draft changes, notifications, exits.
- `reduce(state, event) → AppState` is pure. No I/O. Defined in `src/session/reducer.ts`. Every (state, event) pair has a defined transition (most "wrong" pairs are no-ops returning the same state by reference).

**Layer C — Dialog.** A function of state. `Dialog({ state, dispatch })` in `src/tui/dialog.tsx`. Zero React `useState` for application state. The only local state allowed is layout (`borderCount` from `measureElement`) and the cursor position inside text inputs. Inputs dispatch `draft-change` / `submit-edit` / `submit-followup` / `key-action` / `key-esc` and let the reducer own the rest.

**Layer D — Coordinator.** `runSession(prompt, provider, options) → Promise<exitCode>` in `src/session/session.ts`. The ONLY thing with side effects:
1. Builds the initial state (`{ tag: "thinking" }`), the log entry, the input, the loop state, the notification bus subscription, the dialog host.
2. Spawns the loop generator and pumps its events.
3. Receives dialog events through a `dispatch` closure passed to the dialog as a prop.
4. After every dispatch, syncs the dialog (mount / rerender / unmount based on state tag) and triggers side effects (restart loop on `processing`, abort loop on `key-esc`, finalise on `exiting`).
5. On exit, runs the final side effect (run command with inherit, print answer, etc.) and returns the exit code.

**Layer E — Notification bus.** Typed event emitter in `src/core/notify.ts` (deliberately in `core/`, not `session/`, so `chrome()` and `verbose()` can import it without `core/` reaching across into `session/`). Replaces `output-sink.ts`. `chrome()` and `verbose()` emit notifications. With no listener subscribed, the bus writes a default-formatted line to stderr. With a listener subscribed (the session), the listener decides what to do — buffer for later flush, dispatch to reducer for live display, or both. No claim/release lifecycle. No throws on double-claim. No `isOutputIntercepted()` flag.

---

## Module layout

### Created

```
src/
  core/
    transcript.ts       # Transcript + TranscriptTurn + buildPromptInput + pushTurn
    round.ts            # runRound + helpers (callWithRetry, isStructuredOutputError, extractFailedText)
    runner.ts           # runLoop async generator + LoopState + LoopEvent + LoopReturn types
    notify.ts           # NotificationBus + the singleton + Notification type
                        # (in core/, not session/, so chrome/verbose can import it
                        #  without core depending on session)
  session/
    state.ts            # AppState + AppEvent + SessionOutcome (LoopReturn re-imported from core/runner.ts)
    reducer.ts          # reduce(state, event) → AppState  (pure)
    session.ts          # runSession(prompt, provider, options) → Promise<exitCode>
    dialog-host.ts      # mountDialog / rerenderDialog / unmountDialog
```

### Deleted

```
src/core/query.ts            # functions distributed to round.ts, runner.ts, session.ts
src/core/output-sink.ts      # replaced by session/notify.ts
src/core/followup-types.ts   # no longer needed (no circular dep to break)
src/tui/render.ts            # showDialog gone; dialog mounting moves to session/dialog-host.ts
```

### Modified

```
src/core/output.ts       # chrome() emits to notify bus (was: writeLine sink)
src/core/verbose.ts      # verbose() emits to notify bus (was: writeLine sink)
src/core/spinner.ts      # delete isOutputIntercepted() short-circuit
src/main.ts              # import runSession from session/session.ts (was: runQuery)
src/tui/dialog.tsx       # rewrite as (state, dispatch) → JSX with no application useState
```

### Untouched (file-level)

Everything not in the three lists above. See § Things explicitly not touched below for the concept-level list.

---

## Type contracts

The implementer should write these out exactly, then fill in the bodies. They ARE the architecture.

### `src/core/transcript.ts`

```ts
import type { CommandResponse } from "../command-response.schema.ts";
import type { PromptInput } from "../llm/types.ts";

/**
 * The conversation between the user and the LLM, recorded as semantic turns
 * rather than as a provider-shaped `PromptInput`. This is the durable state
 * that the session, the runner, and the coordinator all read and write.
 *
 * Why semantic turns instead of `input.messages`:
 *   - Today's loop pushes meta-instructions (`lastRoundInstruction`,
 *     refused-probe pairs) into `input.messages` mid-call. Those pushes
 *     outlive the call and require `stripStaleInstructions` cleanup before
 *     re-entry. With a semantic transcript, meta-instructions never enter
 *     the persistent state — they live only in the local scope of one
 *     `runRound` call, applied during `buildPromptInput` and discarded.
 *   - The transcript is the natural place to add new turn kinds for
 *     multi-step (a confirmed step is a turn; the next round's prompt
 *     renders it as assistant echo + user output). No `projectForEcho`
 *     helper needed — the transcript IS the projection.
 */
export type Transcript = TranscriptTurn[];

export type TranscriptTurn =
  /** The initial query, the first turn of every transcript. */
  | { kind: "user_request"; text: string }
  /** A free-text follow-up the user typed into the dialog. */
  | { kind: "followup"; text: string }
  /**
   * A non-final command the loop executed inline. Carries the full LLM
   * response (so subsequent rounds can echo it as an assistant turn) plus
   * the captured output and exit code (rendered as a user turn).
   */
  | { kind: "probe"; response: CommandResponse; output: string; exitCode: number }
  /**
   * A final-form command the LLM proposed. Pushed by the loop just before
   * returning. Subsequent calls (e.g., after a follow-up) need it as an
   * assistant turn so the LLM sees its own previous answer.
   */
  | { kind: "candidate_command"; response: CommandResponse }
  /**
   * A final-form answer. Pushed by the loop just before returning. Rarely
   * needed in subsequent calls (answers usually exit the session) but
   * included for completeness — multi-step's `reply` shape will reuse it.
   */
  | { kind: "answer"; content: string };

/** Append a turn. Always mutates in place — there is one transcript per session. */
export function pushTurn(transcript: Transcript, turn: TranscriptTurn): void;

/**
 * Ephemeral attempt-scoped directives that the builder applies for ONE call
 * only. Never persisted in the transcript.
 */
export type AttemptDirectives = {
  /** Append `lastRoundInstruction` as the final user turn. */
  isLastRound?: boolean;
  /**
   * For the in-round probe-risk retry: echo the rejected response as an
   * assistant turn and append `probeRiskInstruction` as the user turn so
   * the LLM can correct itself. Only used inside `runRound`'s retry block;
   * never in the persistent transcript.
   */
  probeRiskRetry?: { rejectedResponse: CommandResponse };
};

/**
 * Build a `PromptInput` (provider-shaped messages array) from a transcript
 * plus the system prompt plus optional ephemeral directives. Pure function:
 * does not mutate the transcript.
 *
 * Rendering rules:
 *   - `user_request` → `{ role: "user", content: text }`
 *   - `followup` → `{ role: "user", content: text }`
 *   - `probe` → `{ role: "assistant", content: JSON.stringify(response) }`,
 *     then `{ role: "user", content: sectionCapturedOutput + "\n" + output }`
 *     (with the same truncation/exit-code formatting today's loop applies)
 *   - `candidate_command` → `{ role: "assistant", content: JSON.stringify(response) }`
 *   - `answer` → `{ role: "assistant", content: JSON.stringify(response) }`
 *     (only relevant when an answer turn is followed by a follow-up)
 *   - directives.isLastRound → append `{ role: "user", content: lastRoundInstruction }`
 *   - directives.probeRiskRetry → append rejected echo + probeRiskInstruction
 */
export function buildPromptInput(
  transcript: Transcript,
  system: string,
  directives?: AttemptDirectives,
): PromptInput;
```

Implementation notes:
- The transcript is the SINGLE source of truth for "what the conversation looks like." The runner, the session, and the reducer all read from it; only the runner and the session's `submit-followup` post-transition hook write to it.
- `assembleCommandPrompt` (currently in `src/llm/context.ts`) splits in two: the system-prompt portion stays as `assembleSystemPrompt(systemContext)` returning a string; the messages portion is replaced by `buildPromptInput`. The session calls `assembleSystemPrompt` once at startup and pushes the initial `user_request` turn to the transcript.
- `stripStaleInstructions` does NOT exist in the new architecture. Multi-step's `projectForEcho` is also unnecessary — the transcript-to-PromptInput rendering does the projection.

### `src/core/round.ts`

```ts
import type { CommandResponse } from "../command-response.schema.ts";
import type { Provider } from "../llm/types.ts";
import type { Round } from "../logging/entry.ts";
import type { Transcript } from "./transcript.ts";

/** A successful round, ready to be addRound'd into the entry. */
export type RoundResult = Round;

export type RunRoundOptions = {
  isLastRound: boolean;
};

/**
 * Run a single LLM round. Handles in-round retries:
 *   - structured-output parse failures (retried once with the broken text echoed
 *     back so the model can self-correct)
 *   - probe risk-level violations (a probe with risk_level !== "low" is retried
 *     once with the existing probeRiskInstruction text)
 *
 * Reads the transcript via `buildPromptInput(transcript, system, directives)`.
 * Does NOT mutate the transcript — that's the caller's job (the loop pushes
 * `probe`/`candidate_command`/`answer` turns based on the returned round's
 * `parsed` field). Meta-directives like `isLastRound` and the probe-risk
 * retry pair live ONLY inside the local `directives` arg passed to
 * `buildPromptInput` — they never enter the persistent transcript, so there
 * is nothing to clean up after the call returns.
 *
 * Throws on network errors, empty responses, or parse failures that survive
 * the in-round retry. The thrown error contains the model label so the user
 * can tell which provider rejected what.
 */
export async function runRound(
  provider: Provider,
  transcript: Transcript,
  system: string,
  options: RunRoundOptions,
): Promise<RoundResult>;

/** Used as the constant text for the probe-risk retry's user turn.
 *  TEMPORARY: deleted entirely by `specs/multi-step.md` (which removes the
 *  probe concept). Kept on the post-refactor surface only because the refactor
 *  preserves the current behaviour. */
export const REFUSED_PROBE_INSTRUCTION: string;
```

Implementation notes:
- Move `callWithRetry`, `isStructuredOutputError`, `extractFailedText`, and `REFUSED_PROBE_INSTRUCTION` from `src/core/query.ts`. They keep their current behaviour.
- `stripStaleInstructions` is GONE. The semantic transcript makes it impossible for stale meta-instructions to leak across calls — they live only inside `directives` for the call that uses them.
- The `Round` returned has `parsed`, `llm_ms`, and (on error) `provider_error` populated. Memory updates and watchlist additions are NOT runRound's job — they're side effects of the loop and are handled in `runner.ts`.

### `src/core/runner.ts`

```ts
import type { CommandResponse, RiskLevel } from "../command-response.schema.ts";
import type { Provider } from "../llm/types.ts";
import type { Round } from "../logging/entry.ts";
import type { Transcript } from "./transcript.ts";

export type LoopState = {
  /** Remaining round budget. Decremented per iteration. Reset on follow-up by the coordinator. */
  budgetRemaining: number;
  /** Monotonic round counter. Never reset. */
  roundNum: number;
};

export type LoopOptions = {
  cwd: string;
  wrapHome: string;
  /** Display label for the active provider, e.g. "anthropic / claude-sonnet-4-6". */
  model: string;
  maxRounds: number;
  maxCapturedOutput: number;
  pipedInput?: string;
  signal?: AbortSignal;
  /**
   * User text that triggered this loop call. The runner sets `round.followup_text`
   * on the FIRST round of the call (consume-once), then leaves it unset on
   * subsequent rounds in the same call. Set by the coordinator's restart-loop
   * primitive when re-entering after a follow-up; absent on the initial call.
   */
  followupText?: string;
};

export type LoopEvent =
  /**
   * Yielded immediately after a successful LLM round. The Round object is the
   * one the consumer should `addRound(entry, round)` — same reference, so any
   * later mutation by the consumer (exec_ms / execution after final exec)
   * lands in the entry too. The runner is responsible for setting
   * `round.followup_text` from `LoopOptions.followupText` on the FIRST round
   * of the call only.
   */
  | { type: "round-complete"; round: Round }
  /**
   * Yielded just before executing a probe. The consumer is expected to surface
   * this as a chrome line (or to the dialog's status slot if a dialog is up).
   * The runner does NOT call chrome() itself.
   */
  | { type: "step-running"; explanation: string; icon: string }
  /**
   * Yielded after a probe finishes, with the post-truncated output that was
   * pushed back to the LLM. (Step output for multi-step will reuse this event
   * unchanged.)
   */
  | { type: "step-output"; text: string };

export type LoopReturn =
  | { type: "command"; response: CommandResponse; round: Round }
  | { type: "answer"; content: string }
  | { type: "exhausted" };

/**
 * Drive the round loop until a final-form response, exhaustion, or abort.
 *
 * Per iteration:
 *   1. Check options.signal — if aborted, return the sentinel `{ type: "exhausted" }`.
 *      The consumer's `ctrl.signal.aborted` guard drops it before acting on it.
 *   2. Call runRound(provider, transcript, system, { isLastRound }). On the
 *      FIRST iteration of the call, set `round.followup_text = options.followupText`
 *      (consume-once via a local variable cleared after the first round).
 *   3. yield round-complete with the produced Round.
 *   4. Apply side effects of the parsed response:
 *        - memory updates → write to disk + emit `notifications.emit({ kind: "chrome", ..., icon: "🧠" })`
 *        - watchlist additions → write to disk
 *   5. Route by response type:
 *        - answer  → pushTurn(transcript, { kind: "answer", content }), return { type: "answer", ... }
 *        - command → pushTurn(transcript, { kind: "candidate_command", response }), return { type: "command", response, round }
 *        - probe   → execute inline:
 *            a) yield step-running with explanation + icon (fetchesUrl heuristic)
 *            b) executeShellCommand in capture mode
 *            c) post-process output (combine stdout+stderr, truncate, prepend
 *               sectionCapturedOutput header, fall back to capturedNoOutput on empty)
 *            d) yield step-output with the post-processed text
 *            e) pushTurn(transcript, { kind: "probe", response, output, exitCode })
 *            f) continue loop
 *   6. When budget reaches zero, return { type: "exhausted" }.
 *
 * Throws if runRound throws. The consumer's try/catch sees the throw AFTER
 * all previously yielded events have been processed, so partial round logs
 * survive. The errored Round is yielded via round-complete BEFORE the throw
 * propagates (mirroring today's eager-log-then-throw guarantee).
 *
 * The function does NOT log rounds (the consumer does, in response to
 * `round-complete` events). Does NOT start a spinner. May call
 * `notifications.emit` directly for memory-update chrome lines (these route
 * through the bus the same way the consumer-emitted ones do).
 */
export async function* runLoop(
  provider: Provider,
  transcript: Transcript,
  system: string,
  state: LoopState,
  options: LoopOptions,
): AsyncGenerator<LoopEvent, LoopReturn>;

/** Pick 🌐 over 🔍 for URL-fetching probes. Moved here from query.ts. */
export function fetchesUrl(content: string): boolean;
```

Implementation notes:
- Replace the current `runRoundsUntilFinal` body with this generator. The semantics are identical for all three `LoopReturn` cases (`command`, `answer`, `exhausted`). The change is that probe-running, probe-output, memory-update, and round-completion events become `yield`s instead of direct `chrome()`/`addRound()` calls.
- The `aborted` `LoopResult` variant from the current code is GONE. The generator handles abort by returning a sentinel `{ type: "exhausted" }` (via `if (signal.aborted) return { type: "exhausted" };`). The consumer guards on `ctrl.signal.aborted` BEFORE acting on the return value, so the sentinel is dropped — it exists only to satisfy the typed `AsyncGenerator<LoopEvent, LoopReturn>` return type. A bare `return;` would make the inferred return type `LoopReturn | undefined`.

### `src/core/notify.ts`

```ts
/** Pre-formatted lines emitted by chrome producers. */
export type Notification =
  | { kind: "chrome"; text: string; icon?: string }
  | { kind: "verbose"; line: string }   // already formatted with timestamp prefix
  | { kind: "step-output"; text: string };

export type NotificationListener = (n: Notification) => void;

/**
 * Typed event bus. Replaces output-sink.ts.
 *
 * - Producers (chrome, verbose, runner memory-update emits) call `emit(n)`.
 * - With NO listener subscribed: emit() writes a formatted line to stderr.
 *   This is the path used outside any session (during main.ts setup, in tests,
 *   in subcommand dispatch).
 * - With a listener subscribed: emit() invokes the listener and skips the
 *   stderr write. The session subscribes a listener that buffers + optionally
 *   forwards to the dialog.
 *
 * In practice there is one subscriber at a time (the active session), so
 * the bus behaves like the old single-slot sink minus the failure modes.
 * Differences from the old output-sink:
 *   - Subscribe/unsubscribe via add/remove on a Set (no claim/release lifecycle)
 *   - Never throws (no double-claim error class)
 *   - Listener exceptions are swallowed; producers can never crash from a
 *     buggy listener
 *   - Multiple simultaneous subscribers are supported (used by tests; not
 *     exercised in production)
 */
class NotificationBus {
  emit(n: Notification): void;
  subscribe(listener: NotificationListener): () => void;
  /** Test-only reset. */
  reset(): void;
}

export const notifications: NotificationBus;

/** Format-and-write a notification to stderr. Used as the default fallback. */
export function writeNotificationToStderr(n: Notification): void;
```

Implementation notes:
- The default fallback (no listener) is just `writeNotificationToStderr` called inline.
- The session's listener buffers raw `Notification` objects (not formatted strings) and on unmount calls `writeNotificationToStderr` for each in original order.
- `chrome(text, icon?)` becomes one line: `notifications.emit({ kind: "chrome", text, icon })`.
- `verbose(text)` becomes: `if (!enabled) return; notifications.emit({ kind: "verbose", line: prefix() + dim(text) })`.
- `verboseHighlight` similarly: builds the line, emits as `verbose`.
- The bus singleton lives at `src/core/notify.ts` and is imported by `src/core/output.ts`, `src/core/verbose.ts`, `src/core/runner.ts`, and `src/session/session.ts`. Lives in `core/` deliberately so the chrome/verbose producers don't have to reach across into `session/`.

### `src/session/state.ts`

```ts
import type { CommandResponse, RiskLevel } from "../command-response.schema.ts";
import type { Round } from "../logging/entry.ts";
import type { LoopReturn } from "../core/runner.ts";

/** All states the session can be in. The dialog is mounted iff `tag` is one
 *  of the dialog tags (confirming, editing, composing, processing). */
export type AppState =
  | ThinkingState
  | ConfirmingState
  | EditingState
  | ComposingState
  | ProcessingState
  | ExitingState;

/** Pre-dialog: chrome spinner is showing while we wait for the LLM's first
 *  final-form response. Initial state of every session. */
export type ThinkingState = { tag: "thinking" };

/** Dialog mounted, user choosing what to do. */
export type ConfirmingState = {
  tag: "confirming";
  command: string;
  risk: RiskLevel;
  explanation?: string;
  /** The full LLM response. Kept on state so `exiting{run}` can carry it
   *  through to `SessionOutcome.run.response` — both `source: "model"`
   *  (where `command === response.content`) and `source: "user_override"`
   *  (where the audit log records both the executed bytes and the original
   *  model response) need it. The transcript also has it as a
   *  `candidate_command` turn, so the followup hook does NOT read this
   *  field — it just pushes a `followup` turn and lets the builder render
   *  the prior candidate from the transcript. */
  response: CommandResponse;
  /** The eagerly-logged round for this command — kept on state so
   *  `exiting{run}` can mutate `exec_ms`/`execution` on it after exec. */
  round: Round;
  /** Index into ACTION_ITEMS for the keyboard-navigable action bar. */
  selectedAction: number;
};

/** User editing the command in place. */
export type EditingState = {
  tag: "editing";
  /** The command before edits — used to restore on Esc. */
  original: string;
  risk: RiskLevel;
  explanation?: string;
  response: CommandResponse;
  round: Round;
  /** Live edit buffer. */
  draft: string;
};

/** User typing a follow-up. */
export type ComposingState = {
  tag: "composing";
  command: string;
  risk: RiskLevel;
  explanation?: string;
  response: CommandResponse;
  round: Round;
  /** Live follow-up text. Preserved into processing and back. */
  draft: string;
};

/** Follow-up call in flight, dialog visible with status. */
export type ProcessingState = {
  tag: "processing";
  command: string;
  risk: RiskLevel;
  explanation?: string;
  response: CommandResponse;
  round: Round;
  /** The follow-up text the user submitted; preserved so Esc → composing keeps it. */
  draft: string;
  /** Latest chrome line, shown in the bottom border. */
  status?: string;
};

/** Terminal: about to do the side-effect (run / print / fail) and exit. */
export type ExitingState = {
  tag: "exiting";
  outcome: SessionOutcome;
};

export type SessionOutcome =
  /**
   * A command was confirmed. The session will exec it with inherit stdio.
   *
   * `source` distinguishes the model's command from a user-edited override.
   * `model`         — exactly what the LLM produced; `command === response.content`.
   * `user_override` — the user opened Edit, modified the text, and ran it.
   *                   `command !== response.content`. Risk and explanation
   *                   carry through from the model's response, but the
   *                   actual bytes the shell executes are user-authored.
   *                   The log records both `command` (what ran) and
   *                   `response.content` (what the model said) so audits
   *                   can tell them apart.
   */
  | {
      kind: "run";
      command: string;
      response: CommandResponse;
      round: Round;
      source: "model" | "user_override";
    }
  /** A reply/answer was returned (initial or via follow-up). Print to stdout. */
  | { kind: "answer"; content: string }
  /** User cancelled. Exit code 1. */
  | { kind: "cancel" }
  /** No TTY, can't show the dialog. Exit code 1 with a chrome line explaining. */
  | { kind: "blocked"; command: string }
  /** Round budget hit zero without a final response. Exit code 1. */
  | { kind: "exhausted" }
  /** Loop or session error. Throws after appendLogEntry runs. */
  | { kind: "error"; message: string };

/** Action IDs used by the action bar in `confirming`. */
export type ActionId = "run" | "cancel" | "edit" | "followup" | "describe" | "copy";

/** Everything the reducer accepts. */
export type AppEvent =
  // ──── from the loop generator (relayed by the coordinator) ────
  /** Carries the `LoopReturn` shape the generator returns. `state.ts`
   *  re-imports `LoopReturn` from `core/runner.ts`; there is no separate
   *  duplicate type. */
  | { type: "loop-final"; result: LoopReturn }
  | { type: "loop-error"; error: Error }
  // ──── from the notification bus (relayed by the coordinator while in `processing`) ────
  | { type: "notification"; text: string }
  // ──── from the dialog ────
  | { type: "key-action"; action: ActionId }
  | { type: "key-arrow"; direction: "left" | "right" }
  | { type: "key-esc" }
  | { type: "submit-edit"; text: string }
  | { type: "submit-followup"; text: string }
  | { type: "draft-change"; text: string };
```

### `src/session/reducer.ts`

```ts
import type { AppEvent, AppState } from "./state.ts";

/**
 * Pure state machine. No I/O. Every (state, event) pair has a defined
 * transition; "wrong" pairs (e.g., key-action while in `processing`) return
 * `state` by reference (===) so the coordinator can short-circuit.
 *
 * Side effects (aborting an in-flight loop, restarting the loop, mounting/
 * unmounting the dialog, executing the command) are NOT here. They live in
 * the coordinator, which observes state changes and triggers them.
 */
export function reduce(state: AppState, event: AppEvent): AppState;
```

Transition table (the implementer's exhaustive reference; `*` means "any"):

| state | event | next state | notes |
|---|---|---|---|
| `thinking` | `loop-final command low` | `exiting{run}` | initial low-risk: skip dialog, exec straight away |
| `thinking` | `loop-final command medium/high` | `confirming` | mount dialog |
| `thinking` | `loop-final answer` | `exiting{answer}` | print to stdout |
| `thinking` | `loop-final exhausted` | `exiting{exhausted}` | |
| `thinking` | `loop-error` | `exiting{error}` | |
| `confirming` | `key-action run` | `exiting{run, source: "model"}` | unmount + exec the model's command unchanged |
| `confirming` | `key-action cancel` | `exiting{cancel}` | |
| `confirming` | `key-action edit` | `editing{ original=command, draft=command }` | |
| `confirming` | `key-action followup` | `composing{ draft="" }` | |
| `confirming` | `key-action describe/copy` | `state` (no-op, deferred actions) | |
| `confirming` | `key-arrow left/right` | `confirming` with `selectedAction` bumped | clamped |
| `confirming` | `key-esc` | `exiting{cancel}` | Esc in confirming = cancel |
| `editing` | `key-esc` | `confirming` (with `command = original`) | discard edits |
| `editing` | `submit-edit text` | `exiting{run, command: text, source: "user_override"}` | run the user's edited text; risk/explanation/response carry through from the model's original |
| `editing` | `draft-change text` | `editing` with new `draft` | |
| `composing` | `key-esc` | `confirming` (drop draft) | |
| `composing` | `draft-change text` | `composing` with new `draft` | |
| `composing` | `submit-followup text` | `processing{ draft=text, status=undefined }` | coordinator restarts loop |
| `processing` | `key-esc` | `composing{ draft }` | coordinator aborts loop |
| `processing` | `notification text` | `processing` with new `status` | live border update |
| `processing` | `loop-final command *` | `confirming` with new command/risk/explanation | swap in place |
| `processing` | `loop-final answer` | `exiting{answer}` | |
| `processing` | `loop-final exhausted` | `exiting{exhausted}` | |
| `processing` | `loop-error` | `exiting{error}` | |

Default for any (state, event) pair not listed above: return `state` by reference (no-op). The reducer JSDoc captures this rule; the table only enumerates real transitions.

Reducer rules to pin in tests (`tests/session-reducer.test.ts`):
- Pure: same `(state, event)` always returns the same next state.
- Returns `state` by reference (===) for any no-op transition.
- `key-esc` in `confirming` cancels; in `editing`/`composing` returns to `confirming`; in `processing` returns to `composing` with the draft preserved.
- `loop-final command low` from `thinking` skips the dialog (sets `exiting{run, source: "model"}`); from `processing` opens the dialog in `confirming` (low-risk gradient). Pin both — this is the key asymmetry from `specs/follow-up.md` § Low-risk dialog.
- `key-action run` from `confirming` produces `source: "model"`; `submit-edit` from `editing` produces `source: "user_override"`. Pin both — this is what makes audit logs trustworthy when an edited command goes wrong.

### `src/session/session.ts`

```ts
import type { ResolvedProvider, Provider } from "../llm/types.ts";
import type { ToolProbeResult } from "../discovery/init-probes.ts";
import type { Memory } from "../memory/types.ts";

export type SessionOptions = {
  memory?: Memory;
  cwd: string;
  resolvedProvider: ResolvedProvider;
  tools?: ToolProbeResult | null;
  cwdFiles?: string;
  pipedInput?: string;
  maxRounds?: number;
  maxCapturedOutputChars?: number;
  maxPipedInputChars?: number;
};

/**
 * Run a single user query end-to-end. Returns the process exit code.
 * Caller is responsible for `process.exit()`.
 *
 * Replaces the old `runQuery`. Same external contract (same arguments, same
 * exit codes, same log entries, same behaviour).
 */
export async function runSession(
  prompt: string,
  provider: Provider,
  options: SessionOptions,
): Promise<number>;
```

Coordinator pseudocode (the implementer should follow this shape; type errors will guide details):

```ts
export async function runSession(prompt, provider, options): Promise<number> {
  // 1. Setup
  const wrapHome = getWrapHome();
  const entry = createLogEntry({...});
  const system: string = assembleSystemPrompt({ memory, tools, cwd, ... });
  const transcript: Transcript = [];
  pushTurn(transcript, { kind: "user_request", text: prompt });
  const loopState: LoopState = { budgetRemaining: maxRounds, roundNum: 0 };
  const loopOptions: LoopOptions = {...};

  // Lazy-load Ink in parallel with the first LLM call so the await before
  // the first dialog mount is free in practice (LLM call dominates wall time).
  // The promise is null when stderr is not a TTY — we'll never need a dialog.
  const inkReady = process.stderr.isTTY
    ? import("./dialog-host.ts").then((m) => m.preloadDialogModules())
    : null;

  let state: AppState = { tag: "thinking" };
  let dialogHost: DialogHost | null = null;
  let currentLoopAbort: AbortController | null = null;
  const buffered: Notification[] = [];

  const exitDeferred = createDeferred<SessionOutcome>();

  // 2. Dispatch closure — pre-transition hook handles abort, reducer applies,
  //    post-transition hook handles dialog sync + loop restart + exit.
  //    Returns void (fire-and-forget). The async syncDialog call may extend
  //    past the dispatch return; that's fine because (a) the lazy import
  //    is essentially instant after the first call, (b) reentrant dispatch
  //    calls during the await go through the same closure with no shared
  //    intermediate state.
  const dispatch = (event: AppEvent): void => {
    // Pre-transition: side effects that must precede reduce()
    if (event.type === "key-esc" && state.tag === "processing") {
      currentLoopAbort?.abort();
    }
    const next = reduce(state, event);
    if (next === state) return;
    state = next;
    // Post-transition: side effects that follow from the new state
    void syncDialog();
    if (state.tag === "exiting") {
      exitDeferred.resolve(state.outcome);
      return;
    }
    if (state.tag === "processing" && currentLoopAbort === null) {
      // submit-followup just transitioned us; the coordinator restarts the loop.
      // Push a `followup` turn to the transcript and reset the budget. The
      // previous candidate_command turn is already in the transcript (the
      // loop pushed it before returning), so the LLM will see [..., candidate, followup].
      // No stripStaleInstructions, no JSON.stringify, no message-history hygiene.
      pushTurn(transcript, { kind: "followup", text: state.draft });
      loopState.budgetRemaining = loopOptions.maxRounds;
      void driveLoop({ followupText: state.draft });
    }
  };

  // 3. Dialog sync — mount, rerender, or unmount based on state tag.
  // Async ONLY for the very first mount (to await the lazy import). Every
  // subsequent rerender/unmount is sync. The dispatch caller awaits this
  // when it returns a promise; otherwise treats it as sync.
  async function syncDialog(): Promise<void> {
    const wantsDialog = isDialogTag(state.tag);
    if (wantsDialog && !dialogHost) {
      // No TTY: dispatch a `blocked` outcome instead of mounting.
      if (!process.stderr.isTTY || !inkReady) {
        dispatch({ type: "loop-error", error: new NoTtyError(state.command) });
        return;
      }
      // First mount: await the lazy-loaded Ink modules (in practice already
      // resolved because the LLM call took longer), then mount synchronously.
      await inkReady;
      dialogHost = mountDialog({ state, dispatch });
    } else if (wantsDialog && dialogHost) {
      dialogHost.rerender({ state, dispatch });
    } else if (!wantsDialog && dialogHost) {
      // Unmount: exit alt screen, unmount Ink, flush buffered notifications
      dialogHost.unmount();
      dialogHost = null;
      flushBuffered();
    }
  }

  // 4. Loop driver — pumps the generator's events through dispatch
  async function driveLoop(opts?: { followupText?: string }): Promise<void> {
    const ctrl = new AbortController();
    currentLoopAbort = ctrl;
    let chromeSpin: (() => void) | null = null;
    if (state.tag === "thinking") chromeSpin = startChromeSpinner(SPINNER_TEXT);

    // Stop the chrome spinner BEFORE dispatching loop-final, not in finally.
    // syncDialog() runs synchronously inside dispatch and may mount the alt
    // screen, and a still-running chrome spinner would write \r frames into
    // the alt buffer. Doing it here ensures no overlap window exists.
    const stopSpin = (): void => { chromeSpin?.(); chromeSpin = null; };

    try {
      const generator = runLoop(provider, transcript, system, loopState, {
        ...loopOptions,
        signal: ctrl.signal,
        followupText: opts?.followupText,
      });
      let final: LoopReturn | undefined;
      while (true) {
        const { value, done } = await generator.next();
        if (ctrl.signal.aborted) { stopSpin(); return; }
        if (done) { final = value; break; }
        handleLoopEvent(value);
      }
      stopSpin();
      if (!ctrl.signal.aborted && final) {
        dispatch({ type: "loop-final", result: final });
      }
    } catch (e) {
      stopSpin();
      if (ctrl.signal.aborted) return;
      dispatch({ type: "loop-error", error: toError(e) });
    } finally {
      stopSpin();
      if (currentLoopAbort === ctrl) currentLoopAbort = null;
    }
  }

  // 5. Loop event handler — turns generator events into addRound calls + notifications
  function handleLoopEvent(event: LoopEvent): void {
    switch (event.type) {
      case "round-complete":
        addRound(entry, event.round);
        return;
      case "step-running":
        notifications.emit({ kind: "chrome", text: event.explanation, icon: event.icon });
        return;
      case "step-output":
        notifications.emit({ kind: "step-output", text: event.text });
        return;
    }
  }

  // 6. Notification listener — buffers everything, forwards chrome to the
  //    reducer while in `processing`.
  const unsubscribe = notifications.subscribe((n) => {
    buffered.push(n);
    if (state.tag === "processing" && n.kind === "chrome") {
      dispatch({ type: "notification", text: n.text });
    }
  });

  // 7. Run!
  let outcome: SessionOutcome;
  try {
    void driveLoop();             // initial loop in `thinking`
    outcome = await exitDeferred.promise;
  } finally {
    unsubscribe();
    if (dialogHost) {
      dialogHost.unmount();
      dialogHost = null;
      flushBuffered();
    }
    appendLogEntryIgnoreErrors(wrapHome, entry);
  }

  // 8. Final side effect for the outcome
  return await finaliseOutcome(outcome, entry, options.pipedInput);
}
```

Key invariants the coordinator MUST preserve:
- **`appendLogEntry` runs in `finally`**, so logs survive any throw.
- **The chrome spinner only runs in `thinking`**. The dialog has its own bottom-border spinner via `useSpinner`. There is no overlap window, so the `isOutputIntercepted` short-circuit is no longer needed.
- **The notification buffer is flushed AFTER `dialogHost.unmount()`**, which itself happens after `EXIT_ALT_SCREEN` is written. Flushed lines must land in real scrollback, not the alt buffer that's about to disappear. This is the same lifecycle ordering as today's `output-sink.ts` comment, just relocated.
- **The abort happens BEFORE the reducer transitions** for `key-esc` in `processing`, so any in-flight LLM call gets cancelled even if its result was about to land.
- **Loop events emitted AFTER an abort are dropped** by the `if (ctrl.signal.aborted) return;` check inside `driveLoop`. The reducer doesn't have to know about abort epochs.
- **`loop-final` produced by an aborted loop is dropped** by the same check. The reducer never sees stale results.
- **Round logging happens in `handleLoopEvent`** as soon as a round-complete event arrives. This preserves today's eager-log guarantee: if `runRound` throws, every round emitted before the throw is already in `entry.rounds` because the throw happens AFTER the yield.

"Current command" location: the dialog states (`ConfirmingState`, `EditingState`, `ComposingState`, `ProcessingState`) carry `response: CommandResponse` and `round: Round` as type fields. The reducer threads them through every transition (e.g., `confirming → composing` copies `response`/`round` along with `command`/`risk`/`explanation`). The coordinator reads `state.response` directly in the `submit-followup` post-transition hook to echo it into `input.messages`. There is one source of truth — the state — and no separate `CurrentCommand` bag.

### `src/session/dialog-host.ts`

```ts
import type { AppEvent, AppState } from "./state.ts";

export type DialogHost = {
  rerender(props: { state: AppState; dispatch: (e: AppEvent) => void }): void;
  unmount(): void;
};

/**
 * Lazy-load the Ink + React + Dialog modules. Idempotent — first call does
 * the dynamic imports and caches them; subsequent calls resolve immediately.
 * The session calls this once at startup (in parallel with the first LLM
 * call) so by the time the first dialog mount is needed, the modules are
 * already loaded. Allows `mountDialog` itself to be synchronous.
 */
export function preloadDialogModules(): Promise<void>;

/**
 * Synchronously mount the Ink dialog. Enters alt screen, renders, returns
 * a host handle. Caller (the session) owns the lifecycle.
 *
 * MUST be called only after `preloadDialogModules()` has resolved at least
 * once — throws otherwise. The session enforces this via the `inkReady`
 * promise it awaits before the first mount.
 *
 * The session is responsible for the no-TTY case BEFORE calling — it checks
 * `process.stderr.isTTY` in `syncDialog` and dispatches a `blocked` outcome
 * instead of mounting.
 */
export function mountDialog(props: {
  state: AppState;
  dispatch: (e: AppEvent) => void;
}): DialogHost;
```

Implementation notes:
- The lazy imports (`ink`, `react`, `./dialog.tsx`) live inside `preloadDialogModules`. A module-level `let cached: { ink, react, Dialog } | null = null;` holds the result; `mountDialog` reads from `cached` and throws if it's null.
- `mountDialog` writes `ENTER_ALT_SCREEN` to stderr, calls Ink's `render()` (which is synchronous), and returns a `DialogHost` wrapping `app.rerender(...)` and a custom unmount that does `app.unmount()` then writes `EXIT_ALT_SCREEN + SHOW_CURSOR`.
- The session calls `flushBuffered()` AFTER `unmount` returns — that ordering is load-bearing (flushed lines must land in real scrollback, not the alt buffer).

### `src/tui/dialog.tsx`

```tsx
import type { AppEvent, AppState } from "../session/state.ts";

type DialogProps = {
  state: AppState;
  dispatch: (event: AppEvent) => void;
};

export function Dialog({ state, dispatch }: DialogProps): JSX.Element;
```

Rewrite rules:
- ZERO `useState` for `command`/`risk`/`explanation`/`draft`/`borderStatus`/`dialogState`. Read everything from `state` props.
- ZERO `subscribeChrome` prop. Border status comes from `state.status` (only present in `processing`).
- ZERO `abortControllerRef`. Esc dispatches `key-esc` and the coordinator handles abort.
- ZERO `useEffect` for stdin draining. Stale keys can no longer leak into the wrong state because every key press goes through `dispatch`, and the reducer is the only thing that decides what each state does with each event.

Allowed local state in the dialog:
- `borderCount` from `useLayoutEffect` + `measureElement` (this is purely visual, not application state).
- `useRenderSize` for terminal dimensions (visual).
- `useSpinner(state.tag === "processing")` for the bottom border frame (visual).

Input handling:
- One `useInput` block per dialog tag, gated on `state.tag`. Same as today, but every handler dispatches an event instead of mutating local state.
- `editing` and `composing` states use `<TextInput value={state.draft} onChange={(t) => dispatch({ type: "draft-change", text: t })} onSubmit={(t) => dispatch({ type: state.tag === "editing" ? "submit-edit" : "submit-followup", text: t })} />`.
- `processing` uses `<TextInput value={state.draft} readOnly />`.
- `confirming` renders the command + explanation + the navigable action bar; key handler maps `y/n/q/Esc/e/f/d/c/←/→/Enter` to `dispatch({ type: "key-action", action })` / `dispatch({ type: "key-arrow", ... })` / `dispatch({ type: "key-esc" })`.

Width/height calculation: same as today. The `command`/`explanation`/`draft` reads come from `state` instead of `useState`, but the layout math is unchanged.

### `src/main.ts`

One-line change:
```ts
// Before:
import { runQuery } from "./core/query.ts";
// After:
import { runSession } from "./session/session.ts";
// Before:
process.exit(await runQuery(prompt, provider, { ... }));
// After:
process.exit(await runSession(prompt, provider, { ... }));
```

The `SessionOptions` shape mirrors the old `runQuery` options shape (with `maxProbeOutputChars` renamed; see § Renames in scope). No other main.ts changes.

---

## Renames in scope

The following pure renames are part of this refactor. They are mechanical, do not change behaviour, and reduce churn for `specs/multi-step.md` (which would otherwise rename them later). Anything not on this list — including the `probe` schema enum, `REFUSED_PROBE_INSTRUCTION`, `probeRiskInstruction`, `probeRiskRefusedPrefix`, the probe-risk retry block — is OUT of scope; multi-step deletes those entirely and renaming them to a temporary name first would be churn.

| Old name | New name | File |
|---|---|---|
| `DEFAULT_MAX_PROBE_OUTPUT_CHARS` | `DEFAULT_MAX_CAPTURED_OUTPUT_CHARS` | `src/config/config.ts` |
| `Config.maxProbeOutputChars` | `maxCapturedOutputChars` | `src/config/config.ts` |
| `maxProbeOutputChars` (JSON Schema property) | `maxCapturedOutputChars` (description: "Maximum characters of captured intermediate command output sent to the LLM. Longer output is truncated. Default: 200000 (~200KB).") | `src/config/config.schema.json` |
| `RoundsOptions.maxProbeOutput` | `LoopOptions.maxCapturedOutput` | `src/core/runner.ts` (was query.ts) |
| `sectionProbeOutput` | `sectionCapturedOutput` | `src/prompt.constants.json` (value: `"## Captured output"`) |
| `probeNoOutput` | `capturedNoOutput` | `src/prompt.constants.json` (value unchanged: `"(no output)"`) |
| `runQuery` | `runSession` | function name (export) |
| `core/query.ts` | `session/session.ts` (function moves; file deleted) | path |
| `RoundsOptions` | `LoopOptions` | type name |
| `runRoundsUntilFinal` | `runLoop` (now a generator) | function name |

`maxRounds`'s description in `config.schema.json` keeps its current parenthetical for now; multi-step rewrites it. Same for everything else.

Update `tests/config.test.ts`, `tests/helpers/loop-fixtures.ts`, `specs/SPEC.md`, `specs/discovery.md`, `specs/piped-input.md`, and `specs/multi-step.md` to use the new names. (Do NOT touch `specs/follow-up.md`'s code references — that spec is already implemented and the old names appear there only in `> Status:` blocks describing what was. See § Forward compatibility for multi-step for the multi-step.md update procedure.)

The config-file rename is a breaking change for any user with `maxProbeOutputChars` in `~/.wrap/config.jsonc`. Per `CLAUDE.md` ("pre-release; single user accepts churn"), no shim. The user manually updates their config if needed.

---

## Forward compatibility for multi-step

Three constraints exist so `specs/multi-step.md` can land cleanly against this refactor without rework. Do not implement multi-step here, but do not violate these constraints either.

### 1. Vocabulary is neutral, not probe-specific

Event names in `LoopEvent` use `step-running` / `step-output` rather than `probe-running` / `probe-output`. Today they only fire for low-risk probes (the only thing the loop runs inline). Multi-step generalises "non-final low" — the events keep their names, the runner branch keeps its meaning. **Do not name an event `probe-*` or a state field `probe`.** The word "probe" appears today only in things multi-step deletes (`REFUSED_PROBE_INSTRUCTION`, `fetchesUrl` is fine — it's a tactical helper), and in the schema (which multi-step migrates).

### 2. The coordinator's loop-restart primitive is parameterised

Today the coordinator restarts the loop after `submit-followup`. Multi-step adds a second restart trigger: after the user confirms a non-final medium/high command (`onConfirmStep` in the multi-step spec). Both will push different message-history mutations (text turn vs assistant echo + captured-output turn) and then call the same `driveLoop({ followupText? })` primitive.

**Implementation directive:** keep the message-pushing logic OUT of `driveLoop`. Push the messages at the dispatch site (the `submit-followup` post-transition hook), then call `driveLoop` with the followupText. Multi-step will add a `submit-step-confirm` post-transition hook that pushes its own messages and calls `driveLoop` the same way. If you bake follow-up-specific message assembly into `driveLoop`, multi-step will fork it.

Concretely: `driveLoop` only takes generator options. The `followupText` parameter is passed through as `LoopOptions.followupText`. Anything else (which messages get pushed, what budget reset behaviour) is the post-transition hook's job.

### 3. State fields are additive

`AppState`'s tag types are object literals. Adding `outputSlot?: string` to the dialog states (for multi-step's "tail-3-rows of last captured step output" display) must be a one-line change to each tag, not a restructuring. **Do not introduce a shared base type or class hierarchy** for the dialog states. Each tag is its own object literal.

Same for `plan?: string` (multi-step).

Same for `executing-step` — multi-step adds it as a new tag in the union; it slots in next to `processing` without touching existing tags.

If the implementer is tempted to "DRY up" the dialog states with a shared base, resist. The duplication is the design.

### 4. The post-transition hook for "loop-restart from a new state tag" must be addable

Multi-step adds an `executing-step` reducer tag and a parallel coordinator hook (`submit-step-confirm`) that pushes a `step` turn (the new turn kind multi-step adds to the transcript) and calls `driveLoop`. The structure mirrors today's `submit-followup` post-transition hook (the `if (state.tag === "processing" && currentLoopAbort === null)` branch in `dispatch`). Multi-step will add a similar branch: `if (state.tag === "executing-step" && currentLoopAbort === null)`.

**Implementation directive:** when writing the `submit-followup` branch, write it in a shape that makes adding `submit-step-confirm` mechanical. Concretely: extract the body (push the followup turn, reset budget, drive loop) into a small helper if it's more than ~10 lines. Don't try to abstract over the turn-pushing — that's intentionally hook-specific per constraint 2.

### 5. The semantic transcript subsumes `projectForEcho`

Multi-step's `projectForEcho` helper exists to strip user-facing fields (`explanation`, `_scratchpad`) when echoing a `CommandResponse` back to the LLM. With the semantic transcript, this becomes `buildPromptInput`'s rendering rule for `candidate_command` and `probe` turns: render only the model-facing fields. The implementer of multi-step should add the projection logic INSIDE `buildPromptInput`, not as a separate `projectForEcho` helper. The transcript stores full responses; the builder decides which fields to expose to the LLM.

---

## Migration

The torch is in hand: this is one refactor, not a sequence of incremental landings. The implementer SHOULD:

1. **Write the new files first**, with all their tests passing in isolation:
   - `src/core/transcript.ts` (Transcript + TranscriptTurn + pushTurn + buildPromptInput + AttemptDirectives)
   - `src/core/round.ts` (lift `callWithRetry`, `isStructuredOutputError`, `extractFailedText`, `REFUSED_PROBE_INSTRUCTION` from `query.ts`; add `runRound` taking `transcript` + `system` + `options`. `stripStaleInstructions` is NOT lifted — the transcript model deletes it)
   - `src/core/runner.ts` (rewrite `runRoundsUntilFinal` as the `runLoop` async generator taking `transcript` + `system`; add `LoopState` / `LoopOptions` / `LoopEvent` / `LoopReturn` types; lift `fetchesUrl`)
   - `src/core/notify.ts` (the bus + Notification type + writeNotificationToStderr)
   - `src/session/state.ts` (AppState + AppEvent + SessionOutcome + ActionId; re-imports `LoopReturn` from `core/runner.ts`)
   - `src/session/reducer.ts` (the reducer)
   - `src/session/dialog-host.ts` (mountDialog)
   - `src/session/session.ts` (runSession)
   - Split `src/llm/context.ts` if needed: extract `assembleSystemPrompt(systemContext): string` from the existing `assembleCommandPrompt`. The session calls it once at startup; the messages portion is now built per-call by `buildPromptInput`.

2. **Rewrite `src/tui/dialog.tsx`** to take `state` and `dispatch` props with no application `useState`.

3. **Switch `src/main.ts`** to import `runSession`.

4. **Switch chrome producers** (`src/core/output.ts`, `src/core/verbose.ts`) to emit through `notifications`.

5. **Rewrite the affected tests AND delete the old files in one step** (see § Test plan). The old test files import directly from `src/core/query.ts` (`tests/rounds.test.ts`, `tests/followup.test.ts`) and `src/core/output-sink.ts` (`tests/spinner-core.test.ts` line 4, `tests/output-sink.test.ts`). Deleting the modules without rewriting the tests at the same time leaves the tree red. Do both in one commit:
   - Delete `src/core/query.ts`, `src/core/output-sink.ts`, `src/core/followup-types.ts`, `src/tui/render.ts`.
   - Delete `tests/output-sink.test.ts`, `tests/followup.test.ts`, `tests/rounds.test.ts`, the existing `tests/dialog.test.tsx`.
   - Delete the `interceptOutput` test in `tests/spinner-core.test.ts` (the "no-op while output is intercepted" test that imports `interceptOutput`/`resetOutputSink` from `output-sink.ts`).
   - Write the new test files listed in § Test plan.

6. **Run `bun run check`** until clean. Then run the dialog manually with a real provider for a smoke test of the four flows: low-risk auto-exec, medium-risk confirm, follow-up refine, follow-up-then-cancel.

The implementer MAY do steps 1–6 in any order that makes their tests easier to write. The end state is what matters. Each commit should leave the tree green.

---

## Test plan

### What gets deleted

- `tests/output-sink.test.ts` — module deleted
- `tests/followup.test.ts` — entirely about `createFollowupHandler` and `stripStaleInstructions`'s refused-probe branch. The `stripStaleInstructions` tests for `lastRoundInstruction` are GONE entirely (the constant is push/popped within `runRound` itself, so the cleanup function no longer handles it). The `createFollowupHandler` tests are replaced by reducer + coordinator integration tests (see below). The refused-probe pair-stripping behaviour is preserved and re-tested in `tests/round.test.ts`.
- `tests/rounds.test.ts` — replaced by `tests/runner.test.ts` (new file, generator-shaped tests for the same surface).
- `tests/dialog.test.tsx` — current file is mostly about local state behaviour and `subscribeChrome` events. Replace with a smaller fixture-driven render test (see below).
- The first test in the OLD `tests/dialog.test.tsx` (`"initial props are captured as state and ignored on re-render"`) is deleted permanently — it pinned a behaviour the refactor inverts.
- The "no-op while output is intercepted" test in `tests/spinner-core.test.ts` (the test that imports `interceptOutput`/`resetOutputSink` from `output-sink.ts`). The rest of `tests/spinner-core.test.ts` stays — only this single test goes.

### What gets written

**`tests/transcript.test.ts`** — pure unit tests for `buildPromptInput` and `pushTurn`:
- `buildPromptInput` of an empty transcript with system="x" → `{ system: "x", messages: [] }`.
- `buildPromptInput` of `[user_request]` → messages with one user turn.
- `buildPromptInput` of `[user_request, probe(p1, "out1", 0)]` → user turn + assistant turn (`JSON.stringify(p1)`) + user turn (`sectionCapturedOutput\nout1`).
- `buildPromptInput` of `[user_request, candidate_command(c1), followup("hmm")]` → user turn + assistant turn (`JSON.stringify(c1)`) + user turn ("hmm").
- `buildPromptInput` with `directives.isLastRound: true` appends a final user turn with `lastRoundInstruction`.
- `buildPromptInput` with `directives.probeRiskRetry: { rejectedResponse }` appends assistant echo + user `probeRiskInstruction`.
- `buildPromptInput` is pure: calling it twice with the same args returns equal output, the transcript is not mutated.
- `pushTurn` mutates in place and returns void.

**`tests/round.test.ts`** — pure unit tests for `runRound`:
- Returns a `Round` with `parsed` set on a successful command.
- Returns a `Round` with `parsed` set on a successful answer.
- With `isLastRound: true`, the LLM sees `lastRoundInstruction` in the messages (asserted by capturing the provider's `runPrompt` call args). The transcript is unchanged before vs after the call.
- Retries once on a parse-failure error and succeeds on the retry.
- Retries once on a non-low probe (the second call's messages contain the probe-risk retry directive) and succeeds.
- Throws on empty response.
- Throws with the model label in the error message when the LLM call fails.
- The transcript is read-only inside `runRound` — no `pushTurn` calls happen inside it.

**`tests/runner.test.ts`** — generator unit tests for `runLoop`:
- Single-iteration command: yields `round-complete`, pushes a `candidate_command` turn to the transcript, returns `{ type: "command", ... }`.
- Single-iteration answer: yields `round-complete`, pushes an `answer` turn to the transcript, returns `{ type: "answer", ... }`.
- Probe → command: yields `round-complete`, `step-running`, `step-output`, `round-complete`. After the probe, asserts the transcript has a new `probe` turn (with `response`/`output`/`exitCode`). After the final command, asserts the transcript has a new `candidate_command` turn. Returns `{ type: "command", ... }`.
- Probe-risk retry inside a round: with the test provider returning a non-low probe first and a low probe second, asserts that `runRound` is called once (the retry is in-round), the second LLM call's messages contain the retry directive, and the transcript ends up with one `probe` turn (the final accepted one). No refused-probe pair leaks into the transcript.
- Exhaustion: returns `{ type: "exhausted" }` when budget hits zero.
- Abort: caller aborts mid-iteration; the next iteration check sees the abort and the generator returns the sentinel `{ type: "exhausted" }`. Caller drops it via the signal guard.
- Generator throws if `runRound` throws; the error propagates AFTER the previously-yielded events have been consumed.
- `followupText` from `LoopOptions` is stamped on the `round.followup_text` field of the FIRST round only. A two-round call (probe → command) has `followup_text` on the probe round, undefined on the command round.

**`tests/notify.test.ts`** — notification bus:
- Subscribe → emit → listener called with the notification.
- Unsubscribe → emit → listener not called.
- Multi-listener: emit fans out to all subscribed.
- No listener subscribed → emit writes to stderr (assert via mocked stderr).
- Listener throws → emit doesn't crash; other listeners still receive.
- Reset clears all listeners (test-only).

**`tests/session-reducer.test.ts`** — pure reducer tests. One per row of the transition table in § Type contracts. Plus:
- Pure: same input → same output, called repeatedly.
- Returns `state` by reference for any no-op transition.

**`tests/session.test.ts`** — coordinator integration tests using the test provider stub from `tests/helpers/loop-fixtures.ts` (renamed `RoundsOptions` → `LoopOptions`):
- Initial low-risk command: provider returns one low-risk command; session runs it and exits 0; no dialog mount.
- Initial medium-risk command: provider returns one medium command; dialog mounts in `confirming`; we synthetically dispatch `key-action run`; session executes the command and exits.
- User cancels: dialog in `confirming`; dispatch `key-esc`; exit 1; outcome `cancel`; log entry's `outcome` is `cancelled`.
- User edits then runs: dialog in `confirming`; dispatch `key-action edit` → `editing` → `submit-edit "echo overridden"`; outcome is `{ kind: "run", source: "user_override", command: "echo overridden", response: <original LLM response> }`. Assert `command !== response.content`. Assert the log round records both the executed bytes and the original model response.
- User runs without editing: outcome is `{ kind: "run", source: "model", command: response.content }`. `command === response.content`. Pin alongside the override case so both branches stay covered.
- Follow-up refine: provider returns medium command, then a different medium command; dispatch `key-action followup`, `submit-followup "..."`; coordinator restarts loop; reducer transitions to `confirming` with the new command; dispatch `key-action run`; verify entry has both rounds and the second has `followup_text`.
- Follow-up abort race: identical to today's `tests/followup.test.ts` "aborts mid-flight" case but expressed at the session level. The follow-up provider's promise is held; we dispatch `key-esc` while in `processing`; the loop's late-arriving result is dropped; state is back in `composing` with the draft preserved; the orphan round is in `entry.rounds` (eager logging guarantee).
- Follow-up exhausted: provider returns probes forever; budget runs out; reducer transitions to `exiting{exhausted}`; chrome line printed; exit 1.
- Follow-up answer: provider returns an answer in response to a follow-up; reducer transitions to `exiting{answer}`; stdout has the content.
- Notification routing: chrome producer fires `chrome("hello")` while session is in `processing`; reducer's `state.status` updates.
- Notification flushing: chrome producer fires while dialog is up; on unmount, the line lands in stderr scrollback (assert via mocked stderr).
- No TTY: `process.stderr.isTTY = false`; medium command produces `exiting{blocked}`; exit 1; chrome line explains.

**`tests/dialog.test.tsx`** — fixture-driven render snapshots only:
- Renders command from `state.command`.
- Renders risk badge for low/medium/high.
- Renders explanation when present.
- Renders the action bar in `confirming` and the right key hints in each non-confirming tag.
- Renders the follow-up text input in `composing` (editable) and `processing` (read-only).
- Renders the bottom-border status from `state.status` in `processing`.
- Re-render with new state props swaps the displayed command without remounting (verify by checking that a non-state `useRef` value is preserved across rerenders — this pins the "no remount on prop change" behaviour without going through the deleted `initial*` indirection).
- Key dispatch: synthetic key press → assert `dispatch` is called with the right event.
- **Cursor position preservation across keystroke rerenders.** Mount a `composing` state with `draft = "abc"`. Position cursor at index 1 (between `a` and `b`). Trigger a synthetic keystroke that results in a `draft-change` dispatch → state mutation → `dialogHost.rerender(...)`. Assert: cursor index is still 1 (or 2, if the keystroke inserted a char) — NOT reset to end-of-text. This pins the assumption that Ink's `rerender()` reconciles instead of remounting the `TextInput` subtree, which would otherwise cause cursor loss on every keystroke and make text input unusable.

Test fixtures:
- `tests/helpers/loop-fixtures.ts` is renamed in spirit but stays at the same path; rename `makeOptions` to return `LoopOptions` instead of `RoundsOptions`. Update `maxProbeOutput` → `maxCapturedOutput`.
- Add a new `tests/helpers/state-fixtures.ts` with `makeConfirming(opts?)`, `makeProcessing(opts?)`, etc., for the reducer and dialog tests.

### What stays untouched

- `tests/border.test.ts` — borders unchanged
- `tests/text-input.test.tsx` — text input unchanged
- `tests/spinner.test.tsx` — useSpinner hook unchanged
- `tests/dispatch.test.ts`, `tests/build-prompt.test.ts`, etc. — orthogonal to this refactor
- All LLM provider tests — orthogonal

### Tests that need updating but not rewriting

- `tests/config.test.ts` — update `maxProbeOutputChars` → `maxCapturedOutputChars`
- `tests/spinner-core.test.ts` — drop the `isOutputIntercepted` test, drop the `interceptOutput`/`resetOutputSink` imports; everything else stays
- `tests/output.test.ts` — chrome producer routes through the bus now; update assertions
- `tests/verbose.test.ts` — same
- `tests/ensure-memory.test.ts` — only if it touches the renamed config field
- `tests/helpers/loop-fixtures.ts` — rename `RoundsOptions` → `LoopOptions`, `maxProbeOutput` → `maxCapturedOutput`

---

## Things explicitly not touched

- The LLM prompt (no schema changes, no instruction changes, no constants beyond the simple renames)
- The `_scratchpad` field (`specs/scratchpad.md` is its own landing — independent of this refactor)
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

If the implementer finds themselves touching any of these, stop and ask: this refactor is structural only.

---

## Open questions for the implementer

1. **Does Ink's `app.rerender()` re-trigger `useInput` registration?** The dialog has multiple `useInput` blocks gated on state tag. After a rerender that changes the tag, Ink should switch which block is active. Verify this works as expected before relying on it; if not, add a stable wrapper hook that takes the tag as a parameter and dispatches based on it.

2. **Should `dispatch` be reentrant?** The dispatch closure has post-transition side effects that themselves call `dispatch` (e.g., the loop driver dispatches `loop-final`). This is reentrant. Verify the pattern works without surprising you (it should — JavaScript is single-threaded and the reducer is sync — but the `void syncDialog()` introduces an awaited segment that completes after dispatch returns, so reentrant calls during that gap would interleave).

3. **The `notification` event is currently described as carrying just `text`.** If the implementer finds it useful to carry the icon too (so the dialog could render a small icon next to the status line), broaden it to `{ type: "notification"; text: string; icon?: string }`. Not required for parity with today's branch.

4. **Should `source: "user_override"` re-run model risk assessment before exec?** Today, the user can edit a command to anything and run it; the model never sees the edited bytes. Risk and explanation in the log come from the model's original response, which may not match what actually ran. Two options:
   - **Trust the user.** Edit means "I know what I'm doing." Carry the model's risk through unchanged. (Today's behavior. Simplest.)
   - **Re-rate the edited command.** Before exec, fire one more LLM call asking the model to assess the edited bytes. Adds latency to every edited command and adds a round the user didn't ask for. Caught me by surprise risk: if the model rates it lower than the original (`high → medium`), do we re-show the dialog?
   - **Recommendation: trust the user, but mark the round explicitly.** Out of scope for this refactor — the source field makes it visible in logs without forcing a behavior change. Multi-step or a future safety pass can decide.

---

## Out of scope

- Multi-step features (`specs/multi-step.md` is next)
- Scratchpad field (`specs/scratchpad.md` is independent)
- Anything that changes user-visible behaviour beyond removing two small things: (a) the chrome spinner that currently fires under the dialog and silently no-ops — we just stop firing it; (b) the `subscribeChrome` interception that currently buffers chrome lines through a sink — replaced by the notification bus, same observable behaviour.
- Performance optimisation (Ink rerender frequency, memoisation of dialog subtrees) — only if the smoke test reveals visible lag

---

## Glossary

- **Driving the loop** — pumping the generator's events through `dispatch` until it returns or the consumer aborts via the AbortSignal it created. `driveLoop` in the coordinator pseudocode.
- **Post-transition hook** — the section of the dispatch closure that runs AFTER `reduce()` produces a new state. Triggers side effects (dialog mount/rerender/unmount, loop restart, exit) based on the new state's tag. Multi-step adds a parallel post-transition hook for `submit-step-confirm`.
