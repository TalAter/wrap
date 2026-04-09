# Follow-up

Refine a command from inside the dialog by typing follow-up text. The LLM receives the full conversation + follow-up as a new round and returns an updated command. The dialog stays mounted (no alt-screen flicker) and updates in place.

> **Status:** Implemented. See `src/tui/dialog.tsx`, `src/core/query.ts`, `src/core/output-sink.ts`, `src/tui/spinner.ts`, and `src/core/spinner.ts`. Glossary lives in `specs/SPEC.md` § TUI.

Depends on: `dialog-impl.md`, `tui-approach.md`

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

User presses f → composing-followup state:

╭─────────────────────────── ⚠ medium risk ──╮
│                                             │
│  rm -rf *.md                                │
│                                             │
│  Deletes all markdown files recursively     │
│                                             │
│  actually...█                               │
│                                             │
│     ⏎ to send  │  Esc to discard            │
╰─────────────────────────────────────────────╯

User types "dont touch node_modules", presses Enter → processing-followup state:

╭─────────────────────────── ⚠ medium risk ──╮
│                                             │
│  rm -rf *.md                                │
│                                             │
│  Deletes all markdown files recursively     │
│                                             │
│  actually dont touch node_modules           │
│                                             │
│     Esc to cancel                           │
╰─ ⢎ Reticulating splines... ────────────────╯

LLM returns → confirming state with updated command:

╭─────────────────────────── ⚠ medium risk ──╮
│                                             │
│  find . -name '*.md' -not -path             │
│    './node_modules/*' -delete               │
│                                             │
│  Deletes markdown files, excluding          │
│  node_modules                               │
│                                             │
│  Run command?  No  Yes  │  Describe  Edit  Follow-up  Copy  │
╰─────────────────────────────────────────────╯
```

## Dialog state machine

Four states. Each defines what renders in the content area, the action bar slot, and which keys are active. Each state transition flushes any pending stdin to prevent stray keypresses from leaking across states (safety feature, see `tui-approach.md` § "Input buffer flush").

```
                 ┌───────────────────────────┐
                 │        confirming         │
                 │  action bar navigable     │
                 │  y/n/e/f/←→/⏎/Esc         │
                 └────┬───────────┬──────────┘
                   e  │         f │
          ┌───────────┘    ┌──────┘
          │                │
┌─────────┴────────┐  ┌────┴──────────────┐
│ editing-command  │  │ composing-followup │
│  cmd input       │  │  followup input    │
│  ⏎=run           │  │  ⏎=send            │
│  Esc=confirming  │  │  Esc=confirming    │
└──────────────────┘  └─────────┬─────────┘
                                │ ⏎
                      ┌─────────┴────────────────┐
                      │   processing-followup    │
                      │  spinner                 │
                      │  Esc → composing-followup│
                      │  cmd → confirming        │
                      │  answer → exit           │
                      └──────────────────────────┘
```

| State | Content area | Action bar slot | Border status | Active keys |
|-------|-------------|-----------------|---------------|-------------|
| **confirming** | Command strip + explanation | Full action bar (navigable) | — | `y` `n` `q` `Esc` `e` `f` `←` `→` `⏎` |
| **editing-command** | TextInput (prefilled with command) | `⏎ to run  │  Esc to discard changes` | — | Text editing keys, `⏎` `Esc` |
| **composing-followup** | Command strip + explanation + TextInput (placeholder `actually...`) | `⏎ to send  │  Esc to discard` | — | Text editing keys, `⏎` `Esc` |
| **processing-followup** | Command strip + explanation + follow-up text (read-only, no cursor) | `Esc to cancel` | `⢎ Reticulating splines...` (animated) | `Esc` |

### State transitions

**confirming (default state when a command is presented)**
- `y` or Enter on Yes → exit, run command
- `n`, `q`, or `Esc` → exit, cancel
- Enter on No → exit, cancel
- `←` `→` → navigate action bar
- `e` or Enter on Edit → editing-command
- `f` or Enter on Follow-up → composing-followup
- `d` `c` → no-op (deferred actions)

**editing-command**
- `⏎` → exit, run the edited command
- `Esc` → confirming (discards changes, restores original command)
- All text editing keys → modify draft

**composing-followup**
- `⏎` → processing-followup (sends follow-up text to LLM; empty submissions are no-op)
- `Esc` → confirming (discards follow-up text)
- All text editing keys → modify follow-up text

**processing-followup**
- LLM returns command → confirming (dialog updates with new command, risk, explanation; follow-up text is discarded)
- LLM returns answer or max rounds exhausted → exit (dialog closes, query.ts handles the fall-through)
- LLM throws → exit (dialog closes, exception bubbles to query.ts)
- `Esc` → composing-followup (cancels the in-flight LLM call via AbortSignal; the follow-up text is preserved and re-editable)

The follow-up text is preserved across the composing-followup ↔ processing-followup boundary so the user can edit-and-resubmit after cancelling. It is discarded when the user backs all the way out to confirming (composing-followup → confirming via Esc) OR when a new command arrives (processing-followup → confirming).

## TextInput component

`src/tui/text-input.tsx` is a generic input used by all four uses (read-only display in confirming, editable in editing-command, editable + placeholder in composing-followup, read-only in processing-followup). Visual parity across the four uses is the primary reason it's a single component with a `readOnly` mode rather than two components — any future styling change propagates everywhere.

The props are a discriminated union of editable vs readOnly. Editable callers pass `value`, `onChange`, `onSubmit`, optional `placeholder`. Read-only callers pass only `value`. The union makes it impossible to pass no-op handlers in the read-only case, and an inner `EditableTextInput` skips `useInput` registration entirely so read-only doesn't subscribe to keypresses.

`Esc` is NOT handled inside `TextInput`. Each parent state registers its own `useInput({ isActive: ... })` block to handle escape transitions, mirroring the existing pattern in `dialog.tsx`.

## Lifting Dialog props to local state

`command`, `riskLevel`, and `explanation` are held as local `useState` seeded from `initialCommand`/`initialRiskLevel`/`initialExplanation` props. When the follow-up LLM call resolves, the dialog calls `setCommand/setRiskLevel/setExplanation` to swap to the new command in place. React re-renders the dialog without remounting it, so the alt screen never flickers.

Re-rendering with new `initial*` props after mount does NOT overwrite the state — only the initial values are read. Pinned by `tests/dialog.test.tsx`.

## Spinner

Two consumers, two modules:

- `src/tui/spinner.ts` — frames + interval constants and the React `useSpinner(active)` hook used inside the dialog (drives `bottomBorderSegments` during processing-followup).
- `src/core/spinner.ts` — `startChromeSpinner(text)` for stderr animation outside Ink (used by `runRoundsUntilFinal` around LLM calls).

```ts
export const SPINNER_FRAMES = ["⢎ ", "⠎⠁", "⠊⠑", "⠈⠱", " ⡱", "⢀⡰", "⢄⡠", "⢆⡀"];
export const SPINNER_INTERVAL = 80; // ms
```

Frames are 2 cells wide. Pinning the visual width matters because `bottomBorderSegments` reserves a fixed slot — variable-width frames would shift the trailing dashes each tick.

The chrome spinner installs a one-time process exit / SIGINT / SIGTERM listener that restores the cursor if the process dies before `stop()` runs. It also short-circuits when `isOutputIntercepted()` is true — while the dialog owns the alt screen, raw `\r` writes from the chrome spinner would flicker into the Ink render. The dialog's own border spinner takes over in that window.

## Output sink (chrome + verbose routing)

`src/core/output-sink.ts` exposes `interceptOutput`/`release`/`writeLine`. `chrome()` and `verbose()` are thin formatters that route through `writeLine(line, chromeEvent?)`. With no interception active, `writeLine` writes straight to `process.stderr` — identical to the old behavior. While the dialog holds an interception via `interceptOutput(handler)`, every line is buffered for replay, and chrome lines additionally fan out to the handler so the dialog can render them live in the bottom border.

`chrome(text, icon?)` takes the icon as a separate argument so the structured `ChromeEvent` (`{ text, icon? }`) reaches the dialog with the icon kept apart from the text. Stderr output stays byte-identical to the legacy single-arg `chrome("🔍 text")` form.

### Why one sink for both kinds

Order preservation. Chrome and verbose lines are interleaved in real time; separate buffers would reorder them on flush. A single buffer keeps the original interleave. Only chrome lines reach the dialog handler (verbose is debug noise that would clutter the dialog) — the asymmetry is built into the API by making `chromeEvent` optional.

### Lifecycle ordering (load-bearing)

`interceptOutput()` is called AFTER `ENTER_ALT_SCREEN`; `release()` is called AFTER `EXIT_ALT_SCREEN`. The release ordering matters: the flushed lines must land in real scrollback, not in the alt buffer that's about to disappear.

### Safety properties

- Double-intercept and double-release both throw — both indicate a programmer error that would silently lose history.
- Handler exceptions are swallowed; the line is still buffered first so scrollback survives a buggy dialog handler.
- `isOutputIntercepted()` lets producers that bypass `writeLine` (the chrome spinner uses `chromeRaw` for partial-line `\r` writes) know to stay silent during the dialog's lifetime.

## LLM integration

Follow-up rounds are normal rounds in the round loop. Round numbers stay sequential (a probe triggered by a follow-up after rounds 1-2 is round 3, not round 1). Conversation history is preserved in full.

### Conversation shape after follow-up

```
input.messages:
  [system prompt]
  [context + original query]
  [assistant: probe response]         # round 1
  [user: probe output]                # round 1
  [assistant: command response]       # round 2
  [user: follow-up text]              # appended when user submits follow-up
  [assistant: probe response]         # round 3 (LLM may probe before responding)
  [user: probe output]                # round 3
  [assistant: new command response]   # round 4
```

The closing `[assistant: command response]` is normally NOT in `input.messages` (command responses exit the loop, so the existing loop never echoes them back). The follow-up closure (`createFollowupHandler` in `src/core/query.ts`) pushes it explicitly before appending the user's follow-up text, using `JSON.stringify(currentResponse)` — the same shape probe responses use.

### Round budget

The round counter and the budget check are decoupled. `LoopState = { budgetRemaining, roundNum }` is a mutable object shared between `runQuery` and the follow-up closure: `budgetRemaining` resets to `maxRounds` on every follow-up, but `roundNum` keeps incrementing for the lifetime of the entry.

Example with `maxRounds=5`:
- Rounds 1-2: initial probe + command (budget: 3 remaining)
- User follows up → budget resets to 5
- Rounds 3-6: follow-up probes + new command (budget: 1 remaining)
- User follows up again → budget resets to 5
- Rounds 7-11: ...

### Stale instruction stripping

When a call ends on its last round, `runRoundsUntilFinal` pushes `lastRoundInstruction` (and `probeRiskInstruction` for refused probes) onto `input.messages`. Without cleanup, the next follow-up call would start with stale "must return command or answer" instructions from the previous call. `stripStaleInstructions(messages)` removes both kinds before the closure re-enters the loop. The refused-probe instruction is pushed as an `[assistant probe JSON, user refusal]` pair; stripping removes the assistant echo too so the conversation never has an orphan turn.

### Risk level after a swap

A follow-up may swap in a command with a different risk level. The dialog updates its display via `setRiskLevel`, but `query.ts` also needs the new value to decide what to log and execute. The `current` reference (`CurrentCommand = { response, round }`) is shared between `runQuery` and `createFollowupHandler` and mutated on every successful command swap, so the eventual `executeShellCommand` and the round log entry see the latest risk level.

### Unlimited chaining

Each follow-up resets the round budget. Round numbers never reset.

## Round loop

`runRoundsUntilFinal(provider, input, state, entry, options)` is the standalone loop function. It returns a discriminated union:

```ts
type LoopResult =
  | { type: "command"; response: CommandResponse; round: Round }
  | { type: "answer"; content: string }
  | { type: "exhausted" }
  | { type: "aborted" };
```

- The function does NOT execute final commands. It returns when it has a final-form response. The caller (`runQuery`) handles execution.
- Probes are still executed inside the function — they're part of "until final".
- `entry` and `addRound` are owned by the loop function. Each round (probe, answer, command) is logged eagerly as it completes. Command rounds return the live `Round` reference so the caller can mutate `exec_ms`/`execution` after running.
- `AbortSignal` is threaded through `options` and checked at the top of each iteration. On abort the function returns `{ type: "aborted" }` so the dialog can fall back to composing-followup without treating it as exhausted.
- The chrome spinner is started/stopped around each LLM call. While the dialog owns the alt screen, the spinner short-circuits (see § Spinner).

## showDialog API

`showDialog()` in `src/tui/render.ts` carries follow-up results back to `query.ts`:

```ts
type FollowupHandler = (text: string, signal: AbortSignal) => Promise<FollowupResult>;
type FollowupResult =
  | { type: "command"; command: string; riskLevel: "low" | "medium" | "high"; explanation?: string }
  | { type: "answer"; content: string }
  | { type: "exhausted" }
  | { type: "aborted" }
  | { type: "error"; message: string };
```

`onFollowup` is required, not optional — there is no current use case for a non-follow-up dialog, and making it required removes a dead code path.

The dialog calls `onFollowup(text, signal)` from inside the processing-followup effect. The `AbortSignal` is wired to a controller that aborts when the user presses Esc during processing-followup. Inside `runRoundsUntilFinal`, the loop checks `signal.aborted` before each LLM call and bails out with `{ type: "aborted" }`.

Result handling in the dialog:
- `command` → call `setCommand/setRiskLevel/setExplanation`, transition to confirming
- `answer` → unmount Ink, return `{ result: "answer", content }` from `showDialog`
- `exhausted` → unmount Ink, return `{ result: "exhausted" }`
- `aborted` → transition back to composing-followup (text preserved)
- `error` → unmount Ink, return `{ result: "error", message }`

`query.ts` dispatches on each `DialogResult` variant: `answer` prints to stdout, `exhausted` prints "Could not resolve...", `error` re-throws.

## Logging

Logging is per-round. Each `Round` records the parsed response, execution details, and timing — but NOT the conversation `messages` array. Follow-up rounds are indistinguishable from any other round from the log's perspective.

To make follow-ups visible in logs (and to support the planned `w --followup` subcommand), `Round` carries an optional `followup_text?: string` (`src/logging/entry.ts`). It is set on the FIRST round of every follow-up call — even if that round is a probe and the resulting command lands several rounds later. Subsequent rounds in the same call leave it unset. The follow-up closure in `query.ts` passes the user's text through `RoundsOptions.followupText`; `runRoundsUntilFinal` consumes it once via a local `pendingFollowupText` and clears it on use.

The very first user turn of an entry is NOT a follow-up — it lives on `LogEntry.prompt`.

We don't switch to logging the conversation directly because: (a) it would duplicate the system prompt / memory / context across every entry, and (b) the structured per-round shape is what eval and feedback-signal extraction use today. Per-round + `followup_text` gives the same info without the bloat.

## Low-risk dialog

After a follow-up the new command may be low risk. The dialog stays open (the user asked for refinement — they want to see the result before running). The risk badge updates to show low risk with a green gradient.

`src/tui/border.ts` holds the gradient stops and badge metadata in a single `RISK` table keyed by `"low" | "medium" | "high"`, with `{ stops, badge }` per level. `topBorderSegments` reads `badge.icon` and `badge.label` from the table instead of templating ` ⚠ ${riskLevel} risk `. `interpolateGradient` and `topBorderSegments` accept all three levels; `DialogProps.riskLevel` widens accordingly.

The badge math depends on `⚠` and `✔` having identical `string-width`. `tests/border.test.ts` pins this assumption.

Low-risk dialogs only appear via follow-up — initial low-risk commands still auto-execute without ever opening a dialog.

## Bottom border status

`bottomBorderSegments(totalWidth, status?)` accepts an optional status string. When present, the bottom border embeds a near-white status segment (`STATUS_COLOR = "#d2d2e1"`) flanked by dim dashes:

```
╰─ ⢎ Reticulating splines... ──────────────────╯
```

The white status text is split out into its own segment so the dim border color doesn't drown the spinner + label. Spaces around the status sit on the dim segments, not the white one, so the bright bar doesn't extend past the visible label. If even a 1-char-plus-ellipsis doesn't fit at the requested width, the function falls back to a plain border (no status).

## Not in scope

- Describe action implementation
- Copy action implementation
- Chrome spinner for pre-dialog LLM wait (uses `startChromeSpinner`, separate feature)
- Syntax highlighting in command display

## Future: `w --followup` subcommand

A planned subcommand that reopens a dialog for the last log entry, so the user can continue refining a command after the initial invocation has ended.

**Workflow:**
```
$ w list all markdown files here
  → runs `find . -name '*.md'`
$ w --followup
  → opens dialog in composing-followup state with previous command and description shown
  → user types refinement, submits, gets new command
```

**Design considerations:**
- The log entry may not capture all runtime context (full probe outputs, raw conversation history). The `followup_text` field on each `Round` is the first step toward making logs replayable.
- The in-session follow-up (this spec) and `w --followup` should share the same dialog states (composing-followup / processing-followup) and LLM round shape, so the reconstructed conversation plugs into the same flow.
- Commands that auto-executed (low risk) still need the command + description in the log to show them in the dialog.
