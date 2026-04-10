# Multi-step Commands

> **Status:** Implemented.

Collapses `probe`/`command`/`answer` into a unified `command`/`reply` schema with a `final` flag controlling loop continuation. Extends "low risk" to include writes into a per-invocation temp directory exposed as `$WRAP_TEMP_DIR`. Together these enable multi-step flows — "download, inspect, run the inspected file"; "extract, identify, edit"; "stash, test, restore" — without sacrificing the safety properties of the old probe/command split.

See `src/command-response.schema.ts` for the schema, `src/core/runner.ts` for the loop, `src/core/transcript.ts` for turn kinds + echo projection, `src/session/reducer.ts` for the dialog state machine, `src/session/session.ts` for the coordinator + `runConfirmedStep` hook, and `src/tui/dialog.tsx` for rendering.

---

## Motivation

The pre-refactor schema split LLM responses into three types: `probe` (read-only recon, output fed back to the LLM), `command` (final shell action, output to user), `answer` (final text). Probes were pinned to `risk_level: low` with an in-round refusal retry. The structural limitation: **it couldn't express workflows where an intermediate step had side effects.**

Canonical case: "`curl` an install script, inspect it, run the exact bytes you inspected." With only read-only probes available, the LLM would probe the URL and then return a final command that re-fetched and piped to `sh`. The bytes "approved" and the bytes that ran weren't proven identical, and the natural decomposition (download → inspect → execute the local file) was forbidden because writing to disk isn't read-only.

The shape generalises: any "do step 1 so I can decide step 2" flow collapsed badly. Extract → identify config → edit. `git stash` → test → decide whether to revert. Backup → migrate → verify. Options were: bundle into one shell command (user confirms blind), redo work across rounds (waste + races), or punt to answer mode.

The insight: the dimension separating `probe` from `command` wasn't kind-of-action, it was *terminality*. Probes were non-terminal commands whose output went to the LLM; commands were terminal commands whose output went to the user. Risk-limiting probes to `low` was a safety patch on top of that. Once non-terminal commands at any risk are allowed (with the same confirmation gating as final commands), `probe` has nothing left to distinguish it.

This reversed the older "single composed pipeline, never sequential confirmations" rule from SPEC.md v1 — back then, stepping through a multi-command sequence with confirmation between steps was forbidden because there was no architecture for it and the LLM would just bundle everything into one shell invocation. The `final` flag + dialog-open rule below is the architecture that was missing.

---

## Schema

```ts
// SCHEMA_START
export const CommandResponseSchema = z.object({
  type: z.enum([
    "command",  // shell command to execute
    "reply",    // direct text response
  ]),
  // false = intermediate step; output captured and fed back next round.
  // true (default) = terminal; command runs with inherit or reply prints.
  final: z.boolean().default(true),
  // Cross-round intent; prompt-required when final:false, parser-tolerant.
  plan: z.string().nullable().optional(),
  content: z.string(),
  // low = read-only OR write-only to $WRAP_TEMP_DIR per "store not execute".
  //       Installers/build tools/third-party code are NOT low even when
  //       outputs land in $WRAP_TEMP_DIR.
  // medium = modifies user state outside $WRAP_TEMP_DIR.
  // high = destructive or irreversible.
  risk_level: z.enum(["low", "medium", "high"]),
  explanation: z.string().nullable().optional(),
  // ... memory_updates, memory_updates_message, watchlist_additions, pipe_stdin unchanged
});
// SCHEMA_END
```

The LoopReturn and coordinator tags kept the `answer` variant name even though the schema field is `reply` — the discriminator is decoupled from the schema field so reducer transitions didn't churn. `TranscriptTurn.kind: "answer"` similarly.

### Field ordering

Structured output is generated linearly, so earlier fields steer later ones. `plan` sits before `content` so the model commits to multi-step intent before writing the command.

Two specs touch ordering and must coexist:

| Field | Audience | Lifetime | Stripped from echo? |
|---|---|---|---|
| `_scratchpad` | model, this round | one round | yes |
| `plan` | model next round + user (dialog) | until `final: true` ends the chain | no |
| `explanation` | user only | n/a | yes |

Natural order: `_scratchpad, type, final, plan, content, risk_level, explanation, memory_updates, memory_updates_message, watchlist_additions, pipe_stdin`.

---

## Loop Semantics

### The risk × final matrix

| `final` | `risk_level` | Output | Confirmation | Loop |
|---|---|---|---|---|
| `true` | `low` | inherit | none *(initial)* / dialog *(if open)* | exit |
| `true` | `medium`/`high` | inherit | dialog | exit |
| `false` | `low` | captured | none | continue (inline in `runLoop`) |
| `false` | `medium`/`high` | captured | dialog | continue (via `executing-step`) |

### Dialog-open rule (load-bearing)

The dialog is either open or closed for the rest of the loop — no flicker. It **opens** the first time anything needs confirmation (any medium/high). Before that, non-final lows run silently and surface via chrome lines in scrollback. Once open, it **stays open** until the loop exits: subsequent non-final lows run inside its lifecycle (captured output reaches the output slot via the notification bus), and subsequent final lows render in `confirming` with the low-risk gradient rather than auto-executing — matching the follow-up branch's post-follow-up low-risk behaviour.

This produces a deliberate asymmetry: an initial final-low skips the dialog entirely, but a final-low *after* a step that opened the dialog does not. Flickering the dialog on/off mid-flow is worse than the asymmetry.

### Control flow split

- **`runLoop` handles non-final low inline.** Capture via `executeShellCommand`, post-process, push a `step` turn to the transcript, yield `step-output` (which the session listener routes to any open dialog's `state.outputSlot`), continue. Never returns to the consumer for this case.
- **`runLoop` returns for everything else** — final any-risk, non-final medium/high, reply, exhausted, aborted. The `answer` variant of `LoopReturn` carries `type: reply` responses.
- **The coordinator handles non-final medium/high via the `runConfirmedStep` post-transition hook**, parallel to the `submit-followup` branch. On entry: run the confirmed command in capture mode, emit `step-output` through the bus, push a `confirmed_step` turn, reset `loopState.budgetRemaining`, call `startPumpLoop`.
- **Reducer tag `executing-step`**, entered from `confirming` on `key-action run` when `state.response.final === false && state.response.risk_level !== "low"`. Also entered from `editing` via `submit-edit` when the underlying response is non-final med/high (user_override for steps). `isDialogTag` includes it.

### `source: "user_override"` for confirmed steps

If the user opens the editor and changes the bytes of a non-final med/high step, the `confirmed_step` transcript turn carries the user-authored command (so the LLM sees what actually ran). The round's audit log keeps the original model bytes in `round.parsed.content` and the executed bytes in `round.execution.command`, so audits can still tell them apart — no separate `source` field needed on the turn itself.

### Echo projection

When `buildPromptInput` renders `step` / `confirmed_step` / `candidate_command` / `answer` turns for the next round, it projects the stored `CommandResponse` to a minimal shape via the module-private `projectResponseForEcho` helper rather than stringifying it whole.

**Include:** `type`, `content`, `risk_level`, `final`, `plan` (when set), `pipe_stdin` (when set).
**Strip:** `explanation` (user-facing, wastes tokens, invites misuse as scratchpad), `memory_updates` / `memory_updates_message` / `watchlist_additions` (already actioned by the runner).

The builder is the one place that decides which fields the LLM sees — there is no exported `JSON.stringify(response)` call site outside it.

### Round budget

`budgetRemaining` resets on each follow-up *and* on each confirmed step; `roundNum` is monotonic. Multi-step flows consume budget the same way probes did. "Last round" means last of the current countdown, not last ever — a follow-up resets it.

`lastRoundInstruction` forbids `final: false` on the last available round. If the LLM ignores it and returns a non-final-low on the last round, `runLoop` bails with `{type: "exhausted"}` rather than running the step.

---

## Temp Directory (`$WRAP_TEMP_DIR`)

### Creation and lifetime

One temp dir per `w` invocation, created at startup in `main.ts` via `createTempDir()` (which wraps `mkdtempSync` and exports into `process.env`). Lifetime is the whole invocation (all follow-up rounds, all dialog interactions).

`Bun.spawn` does NOT auto-inherit `process.env` — `executeShellCommand` must pass `env: process.env` explicitly. This was a real bug caught during implementation: without the explicit pass-through, spawned commands never saw `WRAP_TEMP_DIR` and the whole feature would have silently broken.

**Cleanup is deferred.** No exit handler, no signal trap. Rationales: (a) enables a future resume flow; (b) keeps implementation trivial. `$TMPDIR` is temporary by convention and OS cleanup is the backstop.

### The principle

> **The temp dir is for *storing* artifacts, not for *executing* arbitrary code.**

Load-bearing rule. The LLM should reason from the principle, not pattern-match. The boundary is "what kind of operation," not "where does the output land" — a `pip install` whose files happen to land inside the temp dir still executes arbitrary third-party code.

Low-risk (auto-executes as non-final):
- `curl -fsSL ... -o $WRAP_TEMP_DIR/installer.sh`
- `cp ~/Downloads/foo.tar.gz $WRAP_TEMP_DIR/`
- `tar -xf $WRAP_TEMP_DIR/foo.tar.gz -C $WRAP_TEMP_DIR/extracted/`
- `git clone https://github.com/x/y $WRAP_TEMP_DIR/y`
- `aws s3 cp`, `gh api`, `gcloud storage cp` — authenticated reads; user already authorised the credentials.

Not low-risk (confirmed command):
- `pip install --target $WRAP_TEMP_DIR/lib foo` — runs `setup.py`
- `npm install --prefix $WRAP_TEMP_DIR foo` — runs install scripts
- `make -C $WRAP_TEMP_DIR/project`, `cargo build` — runs build recipes
- `bash $WRAP_TEMP_DIR/installer.sh` — *the action the user is approving*

### Context format

The temp dir section is included in the assembled prompt context **every round**, even when empty. Listing refreshes per round (unlike `cwd`, which is read once) because the dir mutates mid-invocation. The LLM is told only the variable name, never the literal path — keeps generated commands portable and matches the dialog display. Plumbed via the `liveContext` attempt directive in `buildPromptInput`.

### Visibility and clipboard substitution

| Surface | Form |
|---|---|
| Dialog, logs, chrome | `$WRAP_TEMP_DIR` form (readable) |
| `[C]opy` action, shell-history injection | **Substitute** with literal path |

Rule: when the command crosses the invocation boundary (clipboard, shell history — anywhere it might be replayed in a different process), expand `$WRAP_TEMP_DIR` to the actual path. Inside the invocation, the env-var form is preferred. Without substitution, a replayed `$WRAP_TEMP_DIR/install.sh` would silently expand to `/install.sh` in a fresh shell — worse than a clear failure. *(Clipboard/history substitution is deferred to the `[C]opy` action work in `todo.md`.)*

---

## Dialog

### `executing-step` state

Entered from `confirming` on `key-action run` when the current command is non-final med/high. The dialog stays mounted while `runConfirmedStep` runs the capture and re-enters `pumpLoop`. Esc exits back to `confirming` (the coordinator aborts the in-flight capture via the shared `currentLoopAbort` controller).

### Conditional slots

- **Step output slot** above the command strip. Shows the post-truncation string pushed to the LLM (single source of truth) tailed to the last 3 rows via `formatOutputSlot()`. Empty output renders the `(no output)` sentinel; undefined (before any step in this dialog) renders nothing. Replacement, not accumulation — each step replaces the slot; older outputs live in real scrollback via the notification buffer flushed on dialog unmount.
- **Plan slot** between explanation and action bar. Conditional on `response.plan`; absent when null/omitted. Styled distinctly from `explanation` so "what this step does" is visually separable from "the bigger picture".

### `executing-step` transitions

While in `executing-step`: spinner on, previous output (if any) stays visible, `step-output` notifications update `state.outputSlot` via the reducer.

When `pumpLoop` returns its `LoopReturn`, the reducer transitions:

| Result | Next state | Notes |
|---|---|---|
| `command`, `final: true`, any risk | `confirming` | Low-risk gradient for low; dialog does NOT skip (asymmetric with initial final-low). User confirms → `exiting{run}` → inherit-exec. |
| `command`, `final: false`, med/high | `confirming` | New step. Confirm → re-enters `executing-step`. |
| `answer` (= reply) | `exiting{answer}` | Dialog unmounts; reply prints to stdout. Previous step output already in scrollback. |
| `exhausted` | `exiting{exhausted}` | Same as base. |
| `aborted` | `executing-step` (no-op) | Belt-and-braces — Esc would have transitioned out already. |

`command, final: false, low` is never a `LoopReturn` the reducer sees in `executing-step` — those are handled inline inside `runLoop` and never escape the generator.

### Step-output wiring

`src/core/notify.ts` carries a `step-output` notification kind. The notification router is state-agnostic: it forwards every notification to the coordinator while the dialog is mounted AND `isDialogLive()` returns true (`processing` or `executing-step`). The reducer's notification branch sets `state.outputSlot = n.text` on `step-output` and `state.status = n.text` on `chrome`.

Step output is NOT chrome, NOT verbose, and MUST NOT reach stdout — stdout remains reserved for final-command `inherit` output and final-reply text per `CLAUDE.md`. The bus's default-handler fallback intentionally drops `step-output` when no session listener is subscribed (only during init/teardown).

### Icon heuristic (kept)

`fetchesUrl(content)` stays — non-final commands display a chrome line with `🌐` for URL fetches and `🔍` otherwise, applied to `response.explanation`.

---

## Out of scope (deferred to later work)

- **Cleanup sweep for old `wrap-scratch-*` dirs.** OS cleanup is sufficient backstop pre-release.
- **Non-final replies** (clarifying questions). Schema shape-ready; loop/dialog/prompt don't implement.
- **Fine-grained rule engine for temp-dir confinement.** Risk classification is the LLM's job.
- **`--print` flag interaction with multi-step.** Decide when `--print` lands.
- **LLM-emitted icon for chrome lines.** `fetchesUrl()` heuristic kept.
- **Per-step output retention in dialog state.** Only the most recent step's tail is held; older outputs live in scrollback.
- **End-to-end session test for `runConfirmedStep` via Ink stdin.** No TTY harness for dialog key events today; reducer + notification-router + dialog render tests cover the pieces independently.
- **Clipboard/shell-history substitution of `$WRAP_TEMP_DIR` → literal path.** Lives with the `[C]opy` action in `todo.md`.
