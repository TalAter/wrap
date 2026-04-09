# Follow-up

Refine a command from inside the dialog by typing follow-up text. The LLM receives the full transcript plus the follow-up as a new round and returns an updated command. The dialog stays mounted (no alt-screen flicker) and updates in place.

> **Status:** Implemented. Entry points: `src/session/session.ts`, `src/session/reducer.ts`, `src/session/state.ts`, `src/core/runner.ts`, `src/core/transcript.ts`, `src/tui/dialog.tsx`. Glossary lives in `specs/SPEC.md` § TUI.

Depends on: `tui.md`, `session.md`

## Example flow

```
$ w delete all markdown files
╭─────────────────────────── ⚠ medium risk ──╮
│                                             │
│  rm -rf *.md                                │
│                                             │
│  Deletes all markdown files recursively     │
│                                             │
│                                             │
│  Run command?  No  Yes  │  Describe  Edit  Follow-up  Copy  │
╰─────────────────────────────────────────────╯

User presses f → composing state:

╭─────────────────────────── ⚠ medium risk ──╮
│  rm -rf *.md                                │
│  Deletes all markdown files recursively     │
│  actually...█                               │
│     ⏎ to send  │  Esc to discard            │
╰─────────────────────────────────────────────╯

User submits → processing state:

╭─────────────────────────── ⚠ medium risk ──╮
│  rm -rf *.md                                │
│  Deletes all markdown files recursively     │
│  actually dont touch node_modules           │
│     Esc to cancel                           │
╰─ ⢎ Reticulating splines... ────────────────╯

LLM returns → confirming state with updated command shown in place.
```

## State machine

The session is an event-driven state machine (`src/session/reducer.ts`) — a pure reducer over `AppState` + `AppEvent`. The dialog is mounted iff the state tag is `confirming | editing | composing | processing` (see `isDialogTag`).

```
   thinking ── loop-final{command, non-low} ──► confirming
      │                                          │  ▲
      │                                          │  │ loop-final{command}
      │                                  key:f / │  │
      │                                   key:e  │  │
      │                                          ▼  │
      │                                       composing
      │                                          │  ▲
      │                                          │  │ key-esc (abort)
      │                                submit-   │  │
      │                                followup  ▼  │
      │                                      processing
      │                                          │
      └───────────► exiting ◄───────────────────┘
              (run / answer / cancel / exhausted / blocked / error)
```

| Tag | Content | Action bar slot | Active keys |
|-----|---------|-----------------|-------------|
| **confirming** | Command strip + explanation | Full action bar | `y` `n` `q` `Esc` `e` `f` `←` `→` `⏎` |
| **editing** | TextInput prefilled with command | `⏎ to run  │  Esc to discard changes` | edit keys, `⏎` `Esc` |
| **composing** | Command strip + explanation + TextInput (placeholder `actually...`) | `⏎ to send  │  Esc to discard` | edit keys, `⏎` `Esc` |
| **processing** | Command strip + explanation + follow-up text (read-only) | `Esc to cancel` + animated border status | `Esc` |

Key transitions of note:
- `composing` → `processing` on `submit-followup`. Empty submissions are a no-op at the dialog layer.
- `processing` → `composing` on `key-esc`: the in-flight loop is aborted by the coordinator **before** the reducer runs (see § Abort ordering), and `state.draft` is preserved so the user can edit-and-resubmit.
- `processing` → `confirming` on `loop-final{command}`. Even a low-risk command from a follow-up stays in the dialog (the user explicitly asked for refinement — they want to see the result before running). This is asymmetric with `thinking` → `confirming`, where low-risk auto-execs and skips the dialog entirely.
- A late-arriving `loop-final{aborted}` in `composing` is dropped defensively.

## State shape

`ConfirmingState`, `EditingState`, `ComposingState`, and `ProcessingState` all carry `{ response: CommandResponse, round: Round }`. Command / risk / explanation are **not** separate fields — they are derived from `response.content`, `response.risk_level`, `response.explanation`. This is load-bearing:

- A follow-up that swaps to a new command just constructs a new `confirming` state with the new `response`/`round`. No `setCommand`/`setRiskLevel` wiring.
- The `exiting{run}` outcome carries the same `response` reference, which `finaliseOutcome` reads to tell `source: "model"` from `source: "user_override"` (edited draft).
- The `round` reference is the same object `addRound` appended to `entry.rounds`, so `finaliseOutcome` mutates `exec_ms`/`execution` after exec and the JSONL flush picks it up.

Both `composing` and `processing` carry `draft`. On `composing` it's the live edit buffer; on `processing` it's the submitted text, preserved across the composing↔processing boundary so abort restores it verbatim.

## Transcript and the round loop

The persistent conversation state is `Transcript` (`src/core/transcript.ts`) — an array of semantic turns (`user | probe | candidate_command | answer`), not provider-shaped messages. `buildPromptInput` projects the transcript into a `PromptInput` per round, applying ephemeral `AttemptDirectives` (`isLastRound`, `probeRiskRetry`) for one call only.

The two reasons the transcript is semantic rather than a `messages` array:
- Meta-instructions (`lastRoundInstruction`, `probeRiskInstruction`) live **only** in the local scope of one `runRound` call. They never pollute persistent state, so there is no "strip stale instructions" step when a follow-up loop restarts.
- New turn kinds are a small change here; everywhere else is oblivious.

`runLoop(provider, transcript, scaffold, state, options)` in `src/core/runner.ts` is an async generator. It drives rounds until a final-form response, exhaustion, or abort, yielding `round-complete | step-running | step-output` and returning `LoopReturn` (`command | answer | exhausted | aborted`). It does **not** execute final commands — the session does that in `finaliseOutcome`. Probes are executed inline because they're part of "until final".

The runner is oblivious to follow-ups. It takes a transcript and drains its round budget. A follow-up is just "the coordinator bumps `budgetRemaining` back up, appends a new user turn, and starts a new `runLoop`".

## Session coordinator (`runSession`)

`runSession` in `src/session/session.ts` owns the mutable world: the transcript, `LoopState`, the current `AbortController`, the dialog mount, and the notification router. It is the **only** place where side effects happen; the reducer is pure.

The coordinator loop:
1. Seed `transcript` with the initial user turn and create `loopState = { budgetRemaining: maxRounds, roundNum: 0 }`.
2. `startPumpLoop({ isInitialLoop: true, followupText: undefined })` — fresh `AbortController`, spawn `pumpLoop`.
3. `pumpLoop` drains `runLoop`'s events, re-emitting them as `AppEvent`s via `dispatch`. The final `LoopReturn` becomes a `loop-final` event.
4. `dispatch` runs the reducer, then observes the new state:
   - If we just entered `processing` (i.e. `submit-followup` landed), push the follow-up text as a new `user` turn onto the transcript, reset `budgetRemaining = maxRounds`, and `startPumpLoop` again.
   - If we entered `exiting`, resolve `exitDeferred` with the outcome.
   - Otherwise, `syncDialog` reconciles the mount (mount / rerender / teardown).
5. After `exitDeferred` resolves, unmount the dialog and `finaliseOutcome` executes the side effect (run command, print answer, etc).

### Abort ordering (load-bearing)

In `dispatch`, `key-esc` in `processing` aborts the current `AbortController` **before** the reducer runs. This ensures an in-flight LLM call is cancelled even if its result was about to land in the same tick. The runner checks `signal.aborted` at the top of each iteration and immediately after every `runRound` await, returning `{ type: "aborted" }` without pushing the partial turn — no orphan turns in the transcript.

A late `loop-final` that arrives after the user already Esc'd is dropped by `reduceProcessing` (it runs in `composing`, which ignores `loop-final`).

### Round budget lifecycle

`LoopState = { budgetRemaining, roundNum }` is a single object shared across all loops in a session. `budgetRemaining` is reset by the coordinator on every follow-up; `roundNum` is monotonic and never resets.

The runner checks `budgetRemaining === 0` (post-decrement) as its "last round" sentinel rather than comparing `roundNum` to `maxRounds` — otherwise "last round" would trigger once for the whole session instead of once per call. Example with `maxRounds=5`:

- Rounds 1–2: initial probe + command (budget: 3 → 0 via the in-between)
- User follows up → budget resets to 5
- Rounds 3–6: follow-up probes + new command
- User follows up → budget resets to 5
- Rounds 7+: …

Unlimited chaining falls out of this for free.

### Conversation shape after a follow-up

When the follow-up path runs, the transcript already contains a `candidate_command` turn (pushed by the previous `runLoop` before returning). The coordinator appends `user:{followupText}` on top of it, so the next call sees `[..., candidate_command, user]` — no message-history hygiene needed. The `buildPromptInput` projection renders `candidate_command` as an assistant turn automatically.

## Logging

Each `Round` records the parsed response, execution details, and timing — not the transcript. Follow-up rounds are structurally indistinguishable from any other round.

To make follow-ups visible in logs (and to support `w --followup`), `Round` carries `followup_text?: string` (`src/logging/entry.ts`). `pumpLoop` stamps it on the **first** `round-complete` of each non-initial loop, even if that round is a probe and the command lands several rounds later. Subsequent rounds in the same call leave it unset. The first user turn of an entry is **not** a follow-up — it lives on `LogEntry.prompt`.

The reason logs stay per-round instead of storing the full transcript: (a) system prompt / memory / context would duplicate across every entry, and (b) per-round shape is what eval and feedback-signal extraction consume today. `followup_text` gives the same attribution without the bloat.

## Notification routing

Chrome and verbose output flow through a notification bus (`src/core/notify.ts`, replacing the old output-sink). Producers call `emit({kind, …})`. With no listener, `emit` writes a default-formatted line to stderr (byte-identical to legacy `chrome()`). With a listener — the session's `notification-router` — chrome events during `processing` are dispatched as `{type: "notification"}` events, which the reducer lands in `ProcessingState.status` for live display in the bottom border. Outside `processing`, chrome still goes to stderr via the default formatter.

Only chrome lines (and step-running) reach the border; verbose is debug noise that would clutter the dialog.

## TextInput

`src/tui/text-input.tsx` is a single generic input used by both editing (command edit buffer) and composing (follow-up draft). The discriminated union of editable vs read-only props makes it impossible to pass no-op handlers in read-only mode; the read-only inner path skips `useInput` entirely. `Esc` is handled by the parent state, not `TextInput`, so each state owns its own escape transition.

The visual-parity argument is why it's one component: any future styling change must propagate to both uses.

## Spinner

Two consumers, two modules:

- `src/tui/spinner.ts` — frames + interval constants + React `useSpinner(active)` hook, drives `bottomBorderSegments` during `processing`.
- `src/core/spinner.ts` — `startChromeSpinner(text)` for stderr animation outside Ink (used for the pre-dialog LLM wait).

```ts
export const SPINNER_FRAMES = ["⢎ ", "⠎⠁", "⠊⠑", "⠈⠱", " ⡱", "⢀⡰", "⢄⡠", "⢆⡀"];
export const SPINNER_INTERVAL = 80; // ms
```

Frames are 2 cells wide — pinned because `bottomBorderSegments` reserves a fixed slot and a variable-width frame would shift the trailing dashes. The chrome spinner installs a one-shot exit / SIGINT / SIGTERM handler to restore the cursor if the process dies mid-animation, and short-circuits while a dialog is mounted (the dialog's own border spinner takes over).

## Low-risk dialogs

A follow-up may swap in a low-risk command. The dialog stays open and the risk badge updates to low (green gradient). `src/tui/border.ts` keeps risk metadata in a single `RISK` table keyed by `low | medium | high`, with `{ stops, badge }` per level, so `topBorderSegments` reads `badge.icon`/`badge.label` rather than templating strings. `DialogProps.riskLevel` widens to all three.

The badge math depends on `⚠` and `✔` having identical `string-width`; pinned by `tests/border.test.ts`.

Low-risk dialogs only appear via follow-up. Initial low-risk commands auto-execute without ever opening a dialog — see `reduceThinking`.

## Bottom border status

`bottomBorderSegments(totalWidth, status?)` accepts an optional status string. When present, it embeds a near-white status segment (`STATUS_COLOR = "#d2d2e1"`) flanked by dim dashes. The white segment is split out so the dim border colour doesn't drown the spinner + label. If the visible label plus ellipsis wouldn't fit at the requested width, the function falls back to a plain border.

## Not in scope

- Describe action implementation
- Copy action implementation
- Syntax highlighting in command display

## TODO: `w --followup` subcommand

A planned subcommand that reopens a dialog for the last log entry, letting the user continue refining a command after the initial invocation has ended.

```
$ w list all markdown files here   # runs `find . -name '*.md'`
$ w --followup                     # opens dialog in composing state with prior command shown
```

Design considerations:
- The log entry doesn't capture full runtime context (probe outputs, raw transcript). `Round.followup_text` is the first step toward replayable logs; the full picture needs more.
- In-session follow-up (this spec) and `w --followup` should share the `composing` / `processing` states and the same transcript+runLoop machinery, so the reconstructed conversation plugs into the same flow.
- Auto-executed low-risk commands still need command + description in the log to re-render in the dialog.

Glossary note: `SPEC.md` defines **continuation** as "resuming a previous conversation thread in a new invocation". That's what `w --followup` is. The in-dialog refinement documented above is a **follow-up**, which is a dialog action within one invocation. Keep the distinction.
