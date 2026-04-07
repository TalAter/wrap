# Follow-up

Refine a command from inside the dialog by typing follow-up text. The LLM receives the full conversation + follow-up as a new round and returns an updated command. The dialog stays mounted (no alt-screen flicker) and updates in place.

Depends on: `confirm-panel-impl.md`, `tui-approach.md`

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

The dialog has four states. Each state defines what renders in the content area, the action bar slot, and which keys are active. Each state transition flushes any pending stdin to prevent stray keypresses from leaking across states (safety feature, see `tui-approach.md` §"Input buffer flush").

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

**confirming (the default state shown when a command is presented)**
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

Extract `CommandInput` into a generic `TextInput` in `src/tui/text-input.tsx`. Same cursor, keybindings, and rendering logic. Used by both editing-command and composing-followup modes.

```tsx
type TextInputProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  width: number;
  placeholder?: string;     // shown when value is empty, dim color
  readOnly?: boolean;       // no cursor, no input handling — used in processing-followup state
};
```

- Full-width dark background (`#232332`) — set on the containing `<Box>` inside the component itself. Background is part of the component, not the parent.
- Placeholder rendered in dim color (`#73738c`) when value is empty (cursor is implicitly at position 0 in this case).
- All existing keybindings from `CommandInput` carry over (Ctrl-A/E/U/K/W/Y, word movement, etc.)
- `Cursor` class unchanged.
- When `readOnly`, the component renders the value as plain text inside the same dark strip, no cursor block, no `useInput` registration. Used in the processing-followup state to display the in-flight follow-up text without allowing edits.
- `Esc` is NOT handled inside `TextInput`. The parent registers a separate `useInput({ isActive: <state matches> })` block to handle it (mirrors the existing `confirm.tsx:84-91` pattern).

### Usage in confirm.tsx

```tsx
// editing-command state:
<TextInput value={draft} onChange={setDraft} onSubmit={handleEditSubmit} width={innerWidth} />

// composing-followup state:
<TextInput value={followupText} onChange={setFollowupText} onSubmit={handleFollowupSubmit}
  width={innerWidth} placeholder="actually..." />

// processing-followup state:
<TextInput value={followupText} onChange={() => {}} onSubmit={() => {}}
  width={innerWidth} readOnly />
```

In composing-followup / processing-followup states, the layout is: command strip → explanation → TextInput → hint. The TextInput appears just above the action bar slot.

## Lifting props to local state

Currently `confirm.tsx` receives `command`, `riskLevel`, `explanation` as props. Because `confirmCommand` calls `render()` once with frozen props, the dialog can't update in place when the LLM returns a new command via follow-up.

Convert the three props into `useState`:

```tsx
function ConfirmPanel({ initialCommand, initialRiskLevel, initialExplanation, ... }) {
  const [command, setCommand] = useState(initialCommand);
  const [riskLevel, setRiskLevel] = useState(initialRiskLevel);
  const [explanation, setExplanation] = useState(initialExplanation);
  // ...
}
```

When the follow-up LLM call resolves, the processing-followup effect calls `setCommand`, `setRiskLevel`, `setExplanation` to swap to the new command. React re-renders the dialog in place. No alt-screen flicker.

## Spinner

Shared spinner module at `src/tui/spinner.ts`. Two consumers: Ink (React hook) and chrome (stderr animation).

```ts
export const SPINNER_FRAMES = ["⢎ ", "⠎⠁", "⠊⠑", "⠈⠱", " ⡱", "⢀⡰", "⢄⡠", "⢆⡀"];
export const SPINNER_INTERVAL = 80; // ms
```

Frames are 2 cells wide. The hook callers and `bottomBorderSegments` should compute width via `string-width` and pin the assumption with a unit test (frames must report consistent width across runs).

### React hook (for the dialog border)

```ts
export function useSpinner(active: boolean): string {
  // setInterval cycles through SPINNER_FRAMES at SPINNER_INTERVAL while active.
  // Cleared when active=false. Returns the current frame string (or "" when inactive).
}
```

The `active` flag prevents the interval from running when the dialog isn't in processing-followup (avoids unnecessary re-renders).

Used in `bottomBorderSegments()` during processing-followup — the spinner frame + status text is embedded in the bottom-left of the border, matching how the risk badge is embedded in the top-right.

```
╰─ ⢎ Reticulating splines... ──────────────────╯
```

Status text and spinner share the bottom border's dim color. No special highlight — they're informational, not warnings.

### Chrome spinner (for stderr, future use)

```ts
export function startChromeSpinner(text: string): () => void {
  // setInterval writing \r + frame + text to stderr.
  // Returns a stop function that clears the line and shows the cursor.
}
```

Not used by follow-up directly — the dialog uses the React hook. Provided for future use (e.g., LLM wait indicator before the dialog opens, used by `runRoundsUntilCommand` outside of dialog mode).

## Stderr message routing (chrome + verbose)

During follow-up, the dialog is in alt-screen. Both `chrome()` (probe announcements, memory updates, errors) and `verbose()` (debug-level diagnostic lines) write to stderr — and stderr writes during alt-screen go to the alt buffer, where they're invisible AND lost on alt-screen exit. We need messages to:
1. Appear inside the dialog's border status (live, during processing-followup) — chrome only, not verbose
2. Appear in stderr scrollback after the dialog closes (history) — both chrome and verbose, in original order

### Shared stderr writer

Both `chrome()` and `verbose()` already write to stderr but do their own formatting. Refactor them to route through a single internal helper, `stderrWrite(formattedLine, kind)`, which owns the buffer and listener:

```ts
// src/core/stderr-sink.ts (new file)

type Kind = "chrome" | "verbose";
type Listener = (kind: Kind, msg: string) => void;

let listener: Listener | null = null;
let buffer: Array<{ kind: Kind; line: string }> | null = null;

export function subscribeStderr(fn: Listener): () => void {
  listener = fn;
  buffer = [];
  return () => {
    listener = null;
    const pending = buffer ?? [];
    buffer = null;
    // Caller must EXIT_ALT_SCREEN BEFORE invoking unsubscribe
    // so these writes land in the main buffer.
    for (const { line } of pending) process.stderr.write(line);
  };
}

export function stderrWrite(line: string, kind: Kind): void {
  if (buffer !== null) {
    buffer.push({ kind, line });
    listener?.(kind, line);
    return;
  }
  process.stderr.write(line);
}
```

`chrome()` and `verbose()` become thin wrappers:

```ts
// src/core/output.ts
export function chrome(text: string, icon?: string): void {
  const line = `${icon ? `${icon} ` : ""}${text}\n`;
  stderrWrite(line, "chrome");
}

// src/core/verbose.ts
export function verbose(msg: string): void {
  if (!enabled) return;
  stderrWrite(`${prefix()}${dim(msg)}\n`, "verbose");
}
```

### Why one buffer for both

Order preservation. If verbose and chrome had separate buffers, flushing them on exit would reorder messages relative to how they were emitted. A single buffer keeps the original interleaving.

### How the dialog consumes it

`render.ts` subscribes when the dialog mounts and unsubscribes when it unmounts. The listener is forwarded to `ConfirmPanel` via React state (e.g., `useState` updated from a `useEffect` that registers the subscriber). The dialog only displays `kind: "chrome"` messages in the border status — `verbose` is buffered for replay but not surfaced in the dialog (it's debug-level and would clutter the UI).

The unsubscribe MUST be called AFTER `EXIT_ALT_SCREEN`. Order in `render.ts`:

```ts
try {
  chromeRaw(ENTER_ALT_SCREEN);
  const unsubscribe = subscribeStderr(handlePanelMessage);
  // ... mount Ink, await waitUntilExit ...
  // After Ink unmounts:
} finally {
  chromeRaw(`${EXIT_ALT_SCREEN}${SHOW_CURSOR}`);
  unsubscribe(); // flushes buffer to main stderr
}
```

### Chrome icons

Probe announcements currently look like `chrome("🔍 " + text)` (`query.ts:233`). The new two-arg form separates icon from text:

```ts
chrome(response.explanation || response.content, "🔍");
```

Stderr writes get `🔍 text\n`. The dialog listener receives just `text` (icon stripped at the formatting boundary).

To make this work cleanly, the listener should be called with the raw text and kind, not the pre-formatted line. Update the `Listener` signature to `(kind: Kind, text: string, icon?: string) => void`. The dialog ignores `icon`; stderr fallback uses it for formatting.

Refactor existing callsites:
- `query.ts:233` (probe): `chrome(text, "🔍")`
- `query.ts:79` (memory): `chrome(message, "🧠")` (and remove the per-call prefix building)

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

The `[assistant: command response]` for round 2 is currently NOT pushed to `input.messages` by the existing loop (because command responses normally exit the loop). The follow-up closure must push this assistant message before appending the user follow-up. The format is `JSON.stringify(currentResponse)` — same shape as how probe responses are pushed at `query.ts:268-273`.

### Round budget

After a follow-up, the remaining-rounds budget resets to `maxRounds`. Round numbers keep incrementing. This requires decoupling the round counter from the budget check (currently they're the same `for` variable in `query.ts:143`).

Example with `maxRounds=5`:
- Rounds 1-2: initial probe + command (budget: 3 remaining)
- User follows up → budget resets to 5
- Rounds 3-6: follow-up probes + new command (budget: 1 remaining)
- User follows up again → budget resets to 5
- Rounds 7-11: ...

### Unlimited chaining

The user can follow up any number of times. Each follow-up resets the round budget. Round numbers never reset.

## Round loop refactor

The current round loop in `runQuery` (`src/core/query.ts:143-312`) is a `for` loop inline in the function body, tightly coupled to:
- The `entry` and `addRound` log lifecycle
- Console output (`console.log` for answers)
- The function's `return exitCode` (early-exits the whole `runQuery` on answer/command)

To make the follow-up callback work, we need to extract the loop into a function that can be called both from `runQuery` and from inside the follow-up closure. Sketch:

```ts
type LoopResult =
  | { type: "command"; response: CommandResponse }
  | { type: "answer"; content: string }
  | { type: "exhausted" };

type LoopState = {
  budgetRemaining: number;  // reset by follow-up
  roundNum: number;         // monotonic, never reset
};

async function runRoundsUntilFinal(
  provider: Provider,
  input: PromptInput,
  state: LoopState,
  entry: LogEntry,
  options: { maxProbeOutput: number; pipedInput?: string; ... },
): Promise<LoopResult> {
  while (state.budgetRemaining > 0) {
    state.roundNum += 1;
    state.budgetRemaining -= 1;
    const round: Round = {};
    // ... LLM call, parse, log ...
    // probe → execute, append messages, continue
    // command → return { type: "command", response }
    // answer → return { type: "answer", content }
  }
  return { type: "exhausted" };
}
```

`runQuery` becomes:

```ts
const state: LoopState = { budgetRemaining: maxRounds, roundNum: 0 };
const result = await runRoundsUntilFinal(provider, input, state, entry, options);

if (result.type === "answer") { console.log(result.content); return 0; }
if (result.type === "exhausted") { chrome("Could not resolve..."); return 1; }

// result.type === "command"
let currentResponse = result.response;
const onFollowup: FollowupHandler = async (text, signal) => {
  // Push the current command response and the follow-up user message
  input.messages.push(
    { role: "assistant", content: JSON.stringify(currentResponse) },
    { role: "user", content: text },
  );
  state.budgetRemaining = maxRounds; // reset budget, NOT roundNum
  const followupResult = await runRoundsUntilFinal(provider, input, state, entry, options);
  if (followupResult.type === "command") {
    currentResponse = followupResult.response; // remember for next follow-up's history
    return { type: "command", command: followupResult.response.content,
      riskLevel: followupResult.response.risk_level,
      explanation: followupResult.response.explanation };
  }
  return followupResult; // answer | exhausted
};

if (currentResponse.risk_level !== "low") {
  const decision = await confirmCommand(currentResponse, onFollowup);
  // ... handle decision ...
}
```

Notes:
- The loop function does NOT execute commands. It returns when it has a final-form response. The caller (`runQuery`) handles execution.
- `state` is mutated by both callers and is the source of truth for budget and round numbering.
- `entry` and `addRound` are still owned by the loop function — each round is logged as it completes.
- Probes are still executed inside the loop (they're part of "until final"). Their chrome output now flows through `subscribeStderr` to the dialog if it's mounted.
- `AbortSignal` for cancellation: pass it through `runRoundsUntilFinal` and check it before each LLM call. On abort, return a sentinel like `{ type: "aborted" }` (add this variant) so the dialog knows to go back to composing-followup without treating it as exhausted.

## confirmCommand API

The `confirmCommand()` signature in `src/tui/render.ts` expands to carry follow-up results back to `query.ts`:

```ts
export type FollowupHandler = (
  text: string,
  signal: AbortSignal,
) => Promise<FollowupResult>;

export type FollowupResult =
  | { type: "command"; command: string; riskLevel: "low" | "medium" | "high"; explanation?: string }
  | { type: "answer"; content: string }
  | { type: "exhausted" }
  | { type: "aborted" }     // user pressed Esc during processing-followup
  | { type: "error"; error: unknown }; // onFollowup threw

export type ConfirmResult =
  | { result: "run"; command: string }
  | { result: "cancel" }
  | { result: "blocked"; command: string }   // no TTY
  | { result: "answer"; content: string }    // follow-up returned an answer
  | { result: "exhausted" }                   // follow-up exhausted rounds
  | { result: "error"; error: unknown };     // follow-up threw

export async function confirmCommand(
  command: string,
  riskLevel: "medium" | "high" | "low",
  explanation: string | undefined,
  onFollowup: FollowupHandler,   // required
): Promise<ConfirmResult>;
```

`onFollowup` is required, not optional. Every `confirmCommand` call site (currently only `query.ts`) provides one — there is no current use case for a non-follow-up dialog, and making it required removes a dead code path in the dialog.

The dialog calls `onFollowup(text, signal)` from inside the processing-followup effect. The `AbortSignal` is wired to a controller that aborts when the user presses Esc during processing-followup. Inside `runRoundsUntilFinal`, the loop checks `signal.aborted` before each LLM call and bails out with `{ type: "aborted" }`.

Result handling in the dialog:
- `command` → call `setCommand/setRiskLevel/setExplanation`, transition to confirming
- `answer` → unmount Ink, return `{ result: "answer", content }` from `confirmCommand`
- `exhausted` → unmount Ink, return `{ result: "exhausted" }`
- `aborted` → transition back to composing-followup (text preserved), no return from `confirmCommand`
- `error` → unmount Ink, return `{ result: "error", error }`

`query.ts` handles each `ConfirmResult` variant: `answer` prints to stdout (existing answer-path code), `exhausted` prints "Could not resolve..." (existing max-rounds code), `error` re-throws.

## Logging

Logging is per-round and per-`LogEntry`, not per-conversation. `query.ts:118-125` creates one `LogEntry` per `runQuery` call and pushes a `Round` to it for each LLM call (`addRound(entry, round)` at `src/logging/entry.ts:76`). Each `Round` records the parsed response, execution details, and timing — but NOT the conversation `messages` array.

Follow-up rounds piggyback on this: each follow-up LLM call goes through `runRoundsUntilFinal` and produces a `Round` which gets `addRound`-ed to the same `LogEntry`. From the log's perspective, a follow-up round is indistinguishable from any other round. The fact that the user typed a refinement is captured implicitly by the new user message in the conversation history, which is NOT in the log.

To make follow-ups visible in logs (and to support `w --followup` later), add an optional `followup_text` field to the `Round` type. The follow-up closure sets it on the FIRST round it triggers after appending the follow-up text:

```ts
// src/logging/entry.ts
type Round = {
  // ... existing fields ...
  followup_text?: string; // set on the first round of a follow-up sequence
};
```

This is a single field, no schema upheaval, and lets the log faithfully reconstruct the follow-up sequence.

We don't switch to logging the conversation directly because: (a) it would duplicate system prompt / memory / context across every entry, and (b) the structured per-round shape is what eval and feedback-signal extraction use today. Per-round + `followup_text` gives us the same info without the bloat.

## Low-risk dialog

After a follow-up, the new command might be low risk. The dialog stays open (the user asked for refinement — they want to see the result before running). The risk badge updates to show low risk with a green gradient.

### Green gradient

```ts
// src/tui/border.ts
const LOW_STOPS: Color[] = [
  [100, 220, 140],
  [80, 200, 170],
  [60, 180, 200],
  [50, 140, 200],
  [50, 100, 170],
  [60, 60, 100],
];

const BADGE = {
  low: { fg: [120, 230, 160] as Color, bg: [25, 70, 40] as Color, icon: "✔", label: "low risk" },
  medium: { fg: [255, 200, 80] as Color, bg: [80, 60, 30] as Color, icon: "⚠", label: "medium risk" },
  high: { fg: [255, 100, 100] as Color, bg: [80, 25, 25] as Color, icon: "⚠", label: "high risk" },
};
```

`topBorderSegments()` builds `badgeText` from `BADGE[riskLevel]` instead of the hardcoded ` ⚠ ${riskLevel} risk ` template. `interpolateGradient()` and `topBorderSegments()` accept `"low" | "medium" | "high"`. `confirm.tsx`'s `ConfirmPanelProps.riskLevel` widens accordingly.

Verify both `⚠` and `✔` have `string-width === 1` (or both === 2, so long as they match) before shipping — `badgeStart` math depends on consistent visual width.

Low-risk dialogs only appear via follow-up (low-risk commands auto-execute on the initial round). The low-risk gradient only needs to render correctly, not be the common case.

## Glossary additions (SPEC.md)

The existing **Follow-up** entry at `SPEC.md:79` becomes stale (it implies the user must decline before refining; that's no longer true). Move it into a new TUI section and rewrite. Add the other dialog terms alongside it.

Replace the existing `### Response & behavior` row with:

| Term | Definition |
|------|-----------|
| ~~**Follow-up**~~ | (moved to TUI section) |

Add a new section after `### Output`:

### TUI

| Term | Definition |
|------|-----------|
| **Dialog** | Interactive Ink TUI rendered in alt-screen on stderr. Used for command confirmation, follow-up refinement, and future flows (describe, error recovery). 3-column layout: gradient border, content area, dim border. |
| **Action bar** | Navigable row of actions at the bottom of the dialog: Yes, No, Describe, Edit, Follow-up, Copy. Letter shortcut keys (`y/n/d/e/f/c`) plus arrow navigation. |
| **Risk badge** | Risk level pill embedded in the top-right of the dialog's top border (e.g., `⚠ medium risk`, `✔ low risk`). |
| **Text input** | Inline editable text field with cursor management (`src/tui/text-input.tsx`). Used for command editing and follow-up composition. Supports placeholder and read-only modes. |
| **Dialog state** | One of: confirming, editing-command, composing-followup, processing-followup. Determines available keys, what renders in the action bar slot, and the border status. Each state transition flushes pending stdin. |
| **Border status** | Animated indicator embedded in the bottom-left of the dialog's border. Shows spinner + status text during async operations (LLM calls, probes). |
| **Follow-up** | Dialog action: user types a refinement (e.g., "actually, skip node_modules"), the LLM returns an updated command, the dialog updates in place. Triggered by `f` or the Follow-up action bar item. Resets the round budget but keeps round numbering sequential. |
| **Composing** | Dialog state where the user is typing follow-up text into a TextInput. |
| **Loading** | Dialog state while a follow-up LLM call is in flight. The follow-up text is displayed read-only and the spinner runs in the bottom border. |

## File changes

| File | Change |
|------|--------|
| `src/tui/text-input.tsx` | **New.** Generic TextInput extracted from CommandInput. Supports `placeholder` and `readOnly` props. |
| `src/tui/spinner.ts` | **New.** Frames + interval constants, `useSpinner(active)` hook, `startChromeSpinner()`. |
| `src/core/stderr-sink.ts` | **New.** Single buffer + listener for both `chrome()` and `verbose()`. |
| `src/tui/confirm.tsx` | Lift command/risk/explanation to local state. Add 4-state machine (confirming/editing-command/composing-followup/processing-followup). Use TextInput. Subscribe to stderr-sink for border status. Wire follow-up callback. |
| `src/tui/border.ts` | Low-risk gradient + BADGE table with icon/label. `topBorderSegments` reads from BADGE. `bottomBorderSegments(totalWidth, status?)` accepts optional status text + spinner frame, both rendered in the existing dim border color. Risk type widens to `"low" \| "medium" \| "high"`. |
| `src/tui/render.ts` | `confirmCommand()` widens API: `onFollowup` required, `ConfirmResult` widened with `answer/exhausted/error` variants. Subscribes/unsubscribes the stderr sink around the Ink lifecycle. Unsubscribe runs AFTER `EXIT_ALT_SCREEN`. |
| `src/core/output.ts` | `chrome(text, icon?)` two-arg form. Routes through `stderr-sink`. |
| `src/core/verbose.ts` | `verbose()` routes through `stderr-sink`. |
| `src/core/query.ts` | Extract `runRoundsUntilFinal` from the inline loop. Provide `onFollowup` closure to `confirmCommand`. Handle new `ConfirmResult` variants. Update probe/memory chrome calls to two-arg form. |
| `src/logging/entry.ts` | Add optional `followup_text` to `Round`. |
| `specs/SPEC.md` | Glossary: move Follow-up entry into new TUI section, add dialog/action bar/risk badge/text input/dialog state/border status/state-name entries. |
| `specs/tui-approach.md` | Remove or update the `### Phasing: describe and follow-up` section (this spec implements Phase 2 — keep Ink mounted, route stderr through the sink). |
| `specs/confirm-panel-impl.md` | Strike the "deferred to phase 2" items that this spec implements (input buffer flush, keeping Ink mounted). |

## Not in scope

- Describe action implementation
- Copy action implementation
- Chrome spinner for pre-panel LLM wait (uses `startChromeSpinner`, separate feature)
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

**Design considerations for this spec:**
- The log entry may not capture all runtime context (full probe outputs, raw conversation history). The optional `followup_text` field on each `Round` is the first step toward making logs replayable.
- The in-session follow-up (this spec) and `w --followup` should share the same dialog states (composing-followup / processing-followup) and LLM round shape, so the reconstructed conversation plugs into the same flow.
- Commands that auto-executed (low risk) still need the command + description in the log to show them in the dialog.
