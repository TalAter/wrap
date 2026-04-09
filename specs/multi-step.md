# Multi-step Commands

> Collapse `probe`/`command`/`answer` into a unified `command`/`reply` schema with a `final` flag controlling loop continuation. Extend "low risk" to include writes into a per-invocation temp directory exposed as `$WRAP_TEMP_DIR`. Together these enable multi-step flows the current architecture can't express — "download, inspect, run the inspected file"; "extract, identify, edit"; "stash, test, restore" — without sacrificing the safety properties of today's probe/command split.

> **Status:** Planned. Not yet implemented.

> **Prerequisites:**
> - `specs/follow-up.md` — supplies the UX vocabulary (the four-state dialog machine, follow-up flow, low-risk dialog gradient, bottom-border status slot).
> - `specs/coordinator-refactor.md` — landed before this spec; replaced the old `query.ts` closure architecture with a five-layer pipeline: `runLoop` async generator → reducer → coordinator (`runSession`) → dialog. This spec is written against the post-refactor architecture and assumes the reader is familiar with: `Transcript` + `buildPromptInput` (`src/core/transcript.ts`), `runRound` (`src/core/round.ts`), `runLoop` (`src/core/runner.ts`), the typed notification bus (`src/core/notify.ts`), the `AppState` reducer (`src/session/reducer.ts`), and `runSession` with its dispatch closure + post-transition hooks (`src/session/session.ts`).
> - `specs/scratchpad.md` — orthogonal field addition; ordering and coexistence is documented in § Field ordering and scratchpad coexistence below. May land before or after this spec.

---

## Motivation

Today's schema splits LLM responses into three types: `probe` (read-only reconnaissance, output fed back to the LLM), `command` (final shell action, output to the user), `answer` (final text response). Probes are pinned to `risk_level: low` with an in-round refusal retry that rejects anything else. The split has a structural limitation: **it cannot express workflows where an intermediate step has side effects.**

The canonical case: "`curl` an install script, inspect it, run the exact bytes you inspected." Today the LLM probes the URL (streams contents into context), then returns a final command that re-fetches the URL and pipes to `sh`. The bytes the LLM "approved" and the bytes that run aren't proven identical, and the natural decomposition (download to disk → inspect → execute the local file) is forbidden because writing to disk isn't read-only.

The shape generalises: any flow of the form "do step 1 so I can decide what step 2 should be" collapses badly today. Extract archive → identify the right config file → edit it. `git stash` → run tests → decide whether to revert. Backup → migrate → verify. The LLM has three unsatisfying options: bundle into one shell command (user confirms blind), redo work across rounds (waste plus race conditions), or punt to answer mode (breaks the task).

The fix turns out to be small. The dimension separating `probe` from `command` isn't kind-of-action — it's *terminality*. Probes are non-terminal commands whose output goes to the LLM; commands are terminal commands whose output goes to the user. Risk-limiting probes to `low` was a safety patch on top of that, not a property of what probing fundamentally is. Once you allow non-terminal commands at any risk (with confirmation gating identical to today), `probe` has nothing left to distinguish it.

The schema cost is one new boolean and one new string. The runtime changes are mostly mechanical because the coordinator refactor already extracted `runLoop` into the right shape — generator-driven, transcript-backed, with a coordinator that owns dispatch and dialog lifecycle.

---

## Schema Change

### New shape

```ts
// SCHEMA_START
export const CommandResponseSchema = z.object({
  // `_scratchpad` from specs/scratchpad.md goes here as field 1 when it lands.
  // If not yet implemented, leave only this comment — do not add a placeholder
  // field. See § Field ordering and scratchpad coexistence.

  type: z.enum([
    // command = shell command to execute
    "command",
    // reply = direct text response (general-knowledge answers, clarifications, etc.)
    "reply",
  ]),

  // When false, this is an intermediate step: output is captured and fed
  // back to you in the next round to inform your next action. When true
  // (default), the loop ends — the command runs with output going to the
  // user's terminal, or the reply is shown to the user.
  final: z.boolean().default(true),

  // Multi-step intent. Set this when `final` is false; leave unset when
  // `final` is true. Describes the full plan across steps so the user sees
  // where a confirmed intermediate step is heading and your own next round
  // retains continuity. Shown in the dialog beneath the explanation, and
  // echoed to you in the next round's message history.
  plan: z.string().nullable().optional(),

  // Command text (for type=command) or reply text (for type=reply)
  content: z.string(),

  // low = read-only, OR write-only to $WRAP_TEMP_DIR for storage (download,
  //       copy, extract data). Installers, build tools, and anything that
  //       executes third-party code are NOT low, even when their outputs
  //       land in $WRAP_TEMP_DIR. See the temp-dir principle in the system
  //       prompt.
  // medium = modifies user state (files outside $WRAP_TEMP_DIR, repo, env)
  // high = destructive or irreversible
  risk_level: z.enum(["low", "medium", "high"]),

  // Brief description shown to the user in the dialog or as a chrome line
  // above auto-executed intermediate steps. Never used for your own
  // thinking — use _scratchpad for that (when present).
  explanation: z.string().nullable().optional(),

  // ... memory_updates, memory_updates_message, watchlist_additions, pipe_stdin: unchanged ...
});
// SCHEMA_END
```

### What changes

| Field | Today | After |
|---|---|---|
| `type` | `command \| probe \| answer` | `command \| reply` |
| `final` | — | new; default `true` |
| `plan` | — | new; prompt-required when `final: false`, parser-tolerant (never rejected) |
| `explanation` | optional, occasionally used as scratchpad | optional, strictly user-facing |
| `risk_level` | low/medium/high; pinned `low` for probes | low/medium/high; no type-based restriction; "low" now includes writes into `$WRAP_TEMP_DIR` subject to the "store not execute" principle (see § Temp Directory) |

`probe` is replaced by any `command` with `final: false`. `answer` is renamed to `reply` — a one-word rename that anticipates a future capability without a second schema migration: a non-final reply (LLM clarifying question) is just `type: reply, final: false`. Schema-ready, not implemented in this spec.

### Field ordering and scratchpad coexistence

Structured output is generated linearly in key order, so earlier fields steer later ones. `plan` must sit before `content` so the model commits to multi-step intent before writing the specific command — same logic as scratchpad.

Two specs touch the ordering and must coexist: `specs/scratchpad.md` pins `_scratchpad` as field 1 (per-round thinking, stripped from echo), and this spec adds `plan` (cross-round intent, kept in echo). They solve different problems — don't collapse them.

| Field | Audience | Lifetime | Stripped from echo? |
|---|---|---|---|
| `_scratchpad` | The model, this round | One round | Yes |
| `plan` | The model next round + the user (dialog) | Until `final: true` ends the chain | No |
| `explanation` | The user only | N/A | Yes |

Natural order:

```
_scratchpad, type, final, plan, content, risk_level, explanation,
memory_updates, memory_updates_message, watchlist_additions, pipe_stdin
```

> **NOTE TO IMPLEMENTING LLM.** `_scratchpad` may land before or after this spec. Before touching `src/command-response.schema.ts`, check whether it already exists. If yes, preserve it as field 1 and slot this spec's fields in after it. If no, proceed with the order above and leave this NOTE for whoever lands `_scratchpad` next.

---

## Loop Semantics

### The risk × final matrix

| `final` | `risk_level` | Output | Confirmation | Loop |
|---|---|---|---|---|
| `true` | `low` | `inherit` | none *(initial)* / dialog *(if open)* | exit |
| `true` | `medium` / `high` | `inherit` | dialog | exit |
| `false` | `low` | captured | none | continue (inline) |
| `false` | `medium` / `high` | captured | dialog | continue (via `executing-step`) |

Row 3 is today's probe, generalised. Rows 1–2 are today's `command`. Row 4 is new: a non-low intermediate step with confirmation.

**Dialog-open rule (load-bearing).** The dialog is either open or closed for the rest of the loop — no flicker. It **opens** the first time anything needs confirmation (any medium/high). Before that, non-final low commands run silently and surface via chrome lines in scrollback. Once open, it **stays open** until the loop exits: subsequent non-final lows run inside its lifecycle (their captured output reaches the output slot via the sink fan-out described below); subsequent final lows render in `confirming` with the low-risk gradient rather than auto-executing, matching the follow-up branch's post-follow-up low-risk behaviour.

### `runLoop` updates

The loop is the `runLoop` async generator in `src/core/runner.ts`. It already has the right shape (`LoopState`, `LoopOptions`, `LoopEvent`, `LoopReturn`, abort via signal, per-round events the coordinator logs). Changes:

- Replace the probe branch with `if (!response.final && response.risk_level === "low") { ... }`. The body is the same as today's probe branch: capture via `executeShellCommand`, post-process the output, push a `step` turn (the new transcript turn kind, see below) to the `Transcript`, yield `step-output`, continue. The existing `step-running` / `step-output` events fire for any non-final-low — the coordinator's notification listener already routes `step-output` through the bus to the reducer's `state.outputSlot`.
- Remove the probe-risk retry block from `runRound` in `src/core/round.ts` (the `response.type === "probe" && response.risk_level !== "low"` branch and its `AttemptDirectives.probeRiskRetry` plumbing in `src/core/transcript.ts`). Non-final non-low commands now fall through to the existing return path — `runLoop` returns `{ type: "command", response, round }` — and the coordinator dispatches them through the dialog.
- Capture uses the existing `executeShellCommand(content, { mode: "capture", stdinBlob })`.
- Output post-processing is unchanged from today's probe path: combine stdout+stderr, append `\nExit code: N` on non-zero, truncate to `maxCapturedOutput` chars. Empty output → `capturedNoOutput` placeholder (rendered in `formatProbeBody` inside `src/core/transcript.ts` — generalised, despite the function name still saying "probe"; rename it to `formatStepBody` as part of this spec). The dialog's tail-3-rows display reads the same post-truncation string emitted via `step-output`.
- `verboseResponse` (in `src/core/round.ts`) collapses the `command`/`probe` cases; the log line carries a `final`/`step` label derived from `response.final` (presentation only, not a schema enum value):
  ```
  LLM responded (command, final, medium): rm -rf node_modules
  LLM responded (command, step, low): curl -fsSL ... -o $WRAP_TEMP_DIR/install.sh
  LLM responded (reply, 248 chars)
  ```

### New transcript turn kinds

Today's `TranscriptTurn` union has `user` / `probe` / `candidate_command` / `answer`. Multi-step adds two:

- **`step`** — the inline-executed non-final low (replaces today's `probe` turn for the new architecture). Carries `response: CommandResponse`, `output: string`, `exitCode: number`. Renders in `buildPromptInput` as `{role: "assistant", content: JSON.stringify(projectForEcho(response))}` followed by `{role: "user", content: sectionCapturedOutput + "\n" + body}`. Replaces the `probe` rendering path entirely; `probe` can be removed from the union.
- **`confirmed_step`** — a non-final medium/high step the user confirmed via the dialog. Carries the same fields as `step`. The coordinator's `submit-step-confirm` post-transition hook pushes this turn after capturing the output. Renders identically to `step` for now (the LLM doesn't need to know the user confirmed it; the surrounding context already conveys that).

`candidate_command` and `answer` keep their meaning. The `probe` turn kind is deleted along with the schema enum value.

The projection-on-render rule (see § Echo projection) lives inside `buildPromptInput`'s `step` / `confirmed_step` / `candidate_command` rendering branches via a small module-private `projectForEcho` helper — no exported helper, no separate call sites.

### Control flow: non-final medium/high

This is the subtlest part of the spec. Control flow is expressed as dispatch hooks on the `runSession` coordinator (`src/session/session.ts`), not as closures. The split:

- **`runLoop` handles non-final low inline** (as described above) — does NOT return to the consumer. It pushes a `step` turn to the transcript and continues. Captured output reaches any open dialog via `step-output` events emitted through `notifications.emit`, which the coordinator's listener routes to the reducer (`state.outputSlot`).
- **`runLoop` returns to the consumer for everything else** — final any-risk, non-final medium/high, reply, exhausted, aborted. All four `LoopReturn` variants (`command`, `answer`, `exhausted`, `aborted`) stay as-is. The `answer` variant carries `type: reply` responses (the discriminator is the LoopReturn variant name, not the schema field — the schema renames `answer` → `reply` but `LoopReturn`'s variant stays `answer` to avoid touching every reducer transition).
- **The coordinator handles non-final medium/high via a new post-transition hook on `submit-step-confirm`.** This is the multi-step parallel of today's `submit-followup` post-transition hook (the `if (state.tag === "processing")` branch in the dispatch closure). On `submit-step-confirm`, the hook:
  1. Runs the confirmed command in capture mode via `executeShellCommand(... mode: "capture")`.
  2. Emits the post-truncated output through `notifications.emit({ kind: "step-output", text })` so the open dialog's output slot updates.
  3. Pushes a new `confirmed_step` turn to the `Transcript` (containing the response, captured output, and exit code).
  4. Resets `loopState.budgetRemaining` (same as the follow-up hook does).
  5. Calls the coordinator's existing `pumpLoop()` primitive with no arguments. The resulting events flow through the same `handleLoopEvent` the follow-up restart uses.
  
  The two hooks share `pumpLoop` — they only differ in which transcript turn they push beforehand. Keep them separate functions; do not merge.
- **The reducer adds an `executing-step` tag** entered from `confirming` on `key-action run` when the current command is non-final medium/high (instead of `exiting{run, source: "model"}`). The reducer's run-action branch in `reduceConfirming` reads `state.response.final` to decide the transition target — final → `exiting{run}`, non-final → `executing-step`. The coordinator notices `state.tag === "executing-step"` in the post-transition hook and runs the `submit-step-confirm` flow above.
- **`executing-step` is a dialog tag** for the purposes of `isDialogTag` — the dialog stays mounted while the captured step runs, so `state.outputSlot` updates land in the visible UI.
- **Initial dispatch** on the first `loop-final`: final-low → `exiting{run, source: "model"}` (skip dialog, inherit-exec); final-medium/high → `confirming` (dialog opens); non-final-medium/high → `confirming` for the intermediate step (dialog opens for the first time on a step); reply → `exiting{answer}`; exhausted → `exiting{exhausted}`.
- **`source: "user_override"` for confirmed steps.** When a non-final medium/high step is run after the user opened the editor and changed the bytes, the captured output's provenance matches the model's command, but the executed bytes are user-authored. The `confirmed_step` turn should carry the user-authored command in its `response.content` so the LLM sees what actually ran. The audit log on the round records both the original model bytes and the executed bytes — same shape as the existing `source: "user_override"` audit on the run outcome.

### Echo projection

When `buildPromptInput` renders a `step` / `confirmed_step` / `candidate_command` turn into the next round's messages, project the stored `CommandResponse` to a minimal shape rather than `JSON.stringify(response)` directly:

**Include:** `type`, `content`, `risk_level`, `final`, `plan` (when present), `pipe_stdin` (when present)
**Strip:** `_scratchpad`, `explanation`, `memory_updates_message`, `watchlist_additions`

`explanation` is user-facing, not model-facing — replaying it wastes tokens and invites the model to use it as scratchpad. `plan` stays because cross-round continuity is its purpose. `_scratchpad` strips per `specs/scratchpad.md`. The rest are user-facing chrome already actioned by Wrap.

The projection lives inside `buildPromptInput` in `src/core/transcript.ts`. The transcript stores full `CommandResponse` objects on `step` / `confirmed_step` / `candidate_command` turns; the builder is the one place that decides which fields the LLM sees. Add a private `projectForEcho` helper at the top of the module and call it from each rendering branch. There is no separate exported helper, and there is no `JSON.stringify(response)` call site outside the builder.

### `lastRoundInstruction` rewrite

```json
"lastRoundInstruction": "This is your last available round. You must respond with `final: true` — either a final command, or a reply. Do not set `final: false`."
```

### Round budget

No change from the follow-up branch. `budgetRemaining` resets on each follow-up; `roundNum` is monotonic. Multi-step flows consume budget the same way probes did. "Last round" means the last of the current countdown, not the last ever — a follow-up resets it. If multi-step flows routinely exhaust the default budget, raise the default.

---

## Temp Directory (`$WRAP_TEMP_DIR`)

### Creation and lifetime

Created once per `w` invocation at startup:

```ts
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "wrap-scratch-"));
process.env.WRAP_TEMP_DIR = tempDir;
```

`Bun.spawn` inherits `process.env` by default, so every spawned shell sees `$WRAP_TEMP_DIR` automatically. No per-spawn wiring.

Lifetime: the entire `w` invocation, including all follow-up rounds and dialog interactions. One invocation = one temp dir, regardless of how many commands run inside it.

**Cleanup is deferred.** No exit handler, no signal trap. The directory persists past invocation — (a) supports a future resume-style flow and (b) keeps the implementation trivial. We rely on `$TMPDIR` being temporary by convention; OS-level cleanup (periodic sweeps, tmpfs reboot clearing) is the backstop. Future startup-time sweep sketched in § Out of scope.

### The principle

> **The temp dir is for *storing* artifacts, not for *executing* arbitrary code.**

Load-bearing rule. The examples below illustrate it but are not exhaustive — the LLM should reason from the principle, not pattern-match. The boundary is "what kind of operation," not "where does the output land" — a `pip install` whose files happen to land inside the temp dir still executes arbitrary third-party code.

Low-risk (auto-executes as non-final):

- ✓ `curl -fsSL ... -o $WRAP_TEMP_DIR/installer.sh`
- ✓ `cp ~/Downloads/foo.tar.gz $WRAP_TEMP_DIR/`
- ✓ `tar -xf $WRAP_TEMP_DIR/foo.tar.gz -C $WRAP_TEMP_DIR/extracted/`
- ✓ `git clone https://github.com/x/y $WRAP_TEMP_DIR/y`
- ✓ `aws s3 cp s3://bucket/file $WRAP_TEMP_DIR/`, `gh api ...`, `gcloud storage cp ...` — authenticated reads count; the user already authorised the credentials.

Not low-risk (must be a confirmed command):

- ✗ `pip install --target $WRAP_TEMP_DIR/lib foo` — runs `setup.py`
- ✗ `npm install --prefix $WRAP_TEMP_DIR foo` — runs install scripts
- ✗ `make -C $WRAP_TEMP_DIR/project` — runs Makefile recipes
- ✗ `cargo build` — runs `build.rs`
- ✗ `bash $WRAP_TEMP_DIR/installer.sh` — *this is the action the user is approving*

### Context format

Always include the temp dir section in the assembled prompt context, even when the dir is empty. Listing is refreshed at the start of each round (unlike `cwd`, which is read once — temp dir mutates within an invocation).

Empty:

```
## Temp directory: $WRAP_TEMP_DIR
(empty)
```

Non-empty: list paths relative to `$WRAP_TEMP_DIR`:

```
## Temp directory: $WRAP_TEMP_DIR
- install.sh
- extracted/foo.conf
- extracted/bar.conf
```

The LLM is told only the variable name, never the literal path. This keeps generated commands portable across runtime detail changes and matches what's shown in the dialog.

### Visibility surfaces

| Surface | Form |
|---|---|
| Dialog command display | `$WRAP_TEMP_DIR` form (readable) |
| Logs (`~/.wrap/logs/wrap.jsonl`) | `$WRAP_TEMP_DIR` form |
| Chrome lines | `$WRAP_TEMP_DIR` form when visible (LLM-controlled text) |
| `[C]opy` action (clipboard) | **Substitute** with literal path |
| Shell history injection | **Substitute** with literal path |

The substitution rule for `[C]opy` and shell-history injection: when the command crosses the boundary out of the invocation (clipboard, shell history, anywhere it might be replayed in a different process), expand `$WRAP_TEMP_DIR` to the actual path. Inside the invocation, the env var form is preferred for readability. The replayed-elsewhere form points at the same files (which may still exist, depending on cleanup behaviour) — if the temp dir is gone, the command fails clearly rather than silently expanding `$WRAP_TEMP_DIR/install.sh` to `/install.sh`.

Implementation lives next to the existing `[C]opy`/shell-history-injection code (both currently TODO in `specs/todo.md`).

---

## Dialog Changes

### New state and layout

This spec adds one state to the dialog machine: **`executing-step`**, entered from `confirming` when the user confirms a non-final medium/high command. It renders the UI while the coordinator's `submit-step-confirm` post-transition hook (see § Control flow) runs the command in capture mode, pushes a `confirmed_step` turn, and re-enters the loop via `pumpLoop()`.

The dialog gains two conditional slots: a **step output slot** between the top border and the command strip, and a **plan slot** between the explanation and the action bar. Absent slots collapse their rows entirely, so a plain final command with no prior step renders like today.

```
╭─────── ⚠ risk-badge ──╮
│                        │
│  Output:               │ ← step output slot
│    line N-2            │    — 4 rows when populated (label + tail-3-rows)
│    line N-1            │    — 1 row when empty: `Output: (no output)`
│    line N              │    — 0 rows before any step runs in this dialog
│                        │
│  command               │
│                        │
│  explanation           │
│                        │
│  Plan: ...             │ ← plan slot, 0 rows when response.plan is absent
│                        │
│  Run command? ... bar  │
╰────────────────────────╯
```

Action bar is simplified; the real one has the buttons from `specs/follow-up.md`. Style `plan` distinctly from `explanation` (suggested: `Plan:` prefix + dim/italic) so the user can tell "what this step does" from "the bigger picture" at a glance.

### `executing-step` behaviour

Entered by `reduceConfirming` on `key-action run` when `state.response.final === false && state.response.risk_level !== "low"`. The reducer transitions `confirming → executing-step`; the coordinator's post-transition hook on the new state runs the `submit-step-confirm` flow described in § Control flow.

Activity inside the dialog while `executing-step`:

1. Bottom-border spinner is on (`useSpinner(state.tag === "executing-step" || state.tag === "processing")` — extend the existing condition). Previous step output (if any) stays visible in the output slot.
2. The coordinator's `submit-step-confirm` hook spawns the command in capture mode, post-processes the output, emits `notifications.emit({ kind: "step-output", text })`. The notification listener pushes a chrome notification through `dispatch({ type: "notification", notification })` while in `executing-step` (extend the existing `state.tag === "processing"` guard to also fire for `executing-step`). The reducer's `notification` branch sets `state.outputSlot` and the dialog rerenders.
3. The hook pushes a `confirmed_step` turn to the transcript and calls `pumpLoop()`. `pumpLoop` may iterate internally (handling non-final lows inline; each one emits its own `step-output` and lands in the slot via the same path).
4. When `pumpLoop` returns its `LoopReturn`, it dispatches `loop-final`. The reducer's `executing-step` branch transitions:

| Result | Next state | Notes |
|---|---|---|
| `command, final: true, any risk` | `confirming` | Low-risk gradient for low; the coordinator does NOT skip the dialog (asymmetric with `thinking → final low → exiting{run}`). User confirms → `exiting{run}` → run with `inherit`. |
| `command, final: false, medium/high` | `confirming` | New step. On `key-action run`, re-enters `executing-step`. |
| `answer` | `exiting{answer}` | Dialog unmounts; reply prints to stdout. Step output already in scrollback (flushed from the buffer on unmount). |
| `exhausted` | `exiting{exhausted}` | Same as today. |
| `aborted` | `executing-step` (no-op) | Belt-and-braces — the user's Esc would have already transitioned out. |

`command, final: false, low` is never a `LoopReturn` the reducer sees in `executing-step` — those are handled inline inside `runLoop` and never escape the generator.

Output slot source: the post-truncation string pushed to the LLM (single source of truth). Tail-3-rows is computed after Ink's soft-wrapping to dialog width. Replacement, not accumulation — each new step replaces the slot; older outputs live in real scrollback via the notification buffer flushed on unmount.

### Step output — wiring through the existing notification bus

`src/core/notify.ts` already carries a `step-output` notification kind (added during the coordinator refactor for the `runLoop` generator's inline-step events). Multi-step adds nothing new to the bus itself; it just extends the coordinator's notification listener so `step-output` notifications dispatched from `pumpLoop`'s `handleLoopEvent` reach the reducer:

```ts
// In session.ts notification listener — extend the existing chrome branch:
if (state.tag === "processing" || state.tag === "executing-step") {
  if (n.kind === "chrome" || n.kind === "step-output") {
    dispatch({ type: "notification", notification: n });
  }
}
```

The reducer's `notification` branch in `reduceProcessing` and the new `reduceExecutingStep` reads `n.kind === "step-output"` and sets `state.outputSlot = n.text` (in addition to the existing chrome → `state.status` mapping).

Step output is NOT chrome, NOT verbose, and MUST NOT reach stdout — stdout remains reserved for final-command `inherit` output and final-reply text per `CLAUDE.md`. The bus's default-handler fallback (`writeNotificationToStderr`) writes `step-output` notifications to stderr when no session listener is subscribed (which is only the case during init/teardown — never during the actual step run).

### Icon heuristic (kept)

`fetchesUrl(content)` stays — non-final commands display a chrome line with `🌐` for URL fetches and `🔍` otherwise, applied to `response.explanation`. Same as today.

---

## Prompt and Context Changes

Constants in `src/prompt.constants.json`:

| Key | Action |
|---|---|
| `lastRoundInstruction` | Rewritten — see § Loop Semantics |
| `probeRiskInstruction` | Removed |
| `probeRiskRefusedPrefix` | Removed |
| `tempDirPrinciple` | New — the "store, not execute" principle plus the yes/no examples from § Temp Directory, embedded where `cwd`/memory context lives. Phrase type-agnostically ("low-risk operations include …") so it survives the step-4 `probe` removal without rewriting. |
| `finalFlagInstruction` | New — `final` semantics: when to use `false` (multi-step intent) vs `true` (terminal), and the last-round rule |

(`sectionCapturedOutput` and `capturedNoOutput` are already in place from the coordinator refactor.)

Few-shot examples in `src/prompt.optimized.json`: every `type: probe` becomes `type: command, final: false`. Add one few-shot demonstrating a multi-step flow (download to `$WRAP_TEMP_DIR`, then run the staged file).

Read `.claude/skills/editing-prompts.md` before touching the prompt files — the schema source of truth lives between `SCHEMA_START`/`SCHEMA_END` in `src/command-response.schema.ts` and is mirrored to `prompt.optimized.json`; any schema change must sync the mirror.

---

## Removals

Code paths deleted as part of this spec:

- `REFUSED_PROBE_INSTRUCTION` constant in `src/core/round.ts`
- `AttemptDirectives.probeRiskRetry` in `src/core/transcript.ts` (no probe concept means no probe-risk retry directive)
- `runRound`'s probe risk-level retry block (in `src/core/round.ts`) — the `if (response.type === "probe" && response.risk_level !== "low")` branch
- `verboseResponse`'s `case "probe"` (in `src/core/round.ts`) — folded into `case "command"`
- The `probe` variant of `TranscriptTurn` (in `src/core/transcript.ts`) — replaced by the new `step` turn kind
- The `probe` enum value in `CommandResponseSchema` (in `src/command-response.schema.ts`)
- `probeRiskInstruction` and `probeRiskRefusedPrefix` constants in `src/prompt.constants.json`
- `fetchesUrl` — KEPT (icon heuristic for chrome lines on URL-fetching steps)
- `maxRounds` description in `src/config/config.schema.json` — drop the "(probes + error-fix attempts)" parenthetical
- `seed.jsonl` probe assertions → `type: command, final: false`; `eval/bridge.ts` and `eval/dspy/metric.py` follow wherever they match on `type: "probe"`

The `maxCapturedOutput*` / `sectionCapturedOutput` / `capturedNoOutput` names are already in place from the coordinator refactor — no rename work in this spec.

---

## Backwards Compatibility

None. Wrap is pre-release; the single user accepts that pre-refactor entries in `~/.wrap/logs/wrap.jsonl` won't parse against the new schema. Action: `rm ~/.wrap/logs/wrap.jsonl` (or leave it — nothing reads old entries). No shim, no aliases, no transitional enum.

---

## Test Plan

### Unit tests

1. **Schema round-trips `command` with `final: false` + `plan`.** All fields preserved.
2. **Schema round-trips `command` with `final: true` default, no `plan`.**
3. **Schema round-trips `reply` with `final: true`, no `plan`.**
4. **`plan` is prompt-enforced, not schema-enforced.** Parser accepts `final: false` with `plan` absent/null; loop proceeds normally (captured output replayed, dialog renders without plan slot, next round runs). Avoiding zod refinement keeps the JSON Schema flat for OpenAI strict mode and Anthropic tool-use.
5. **`buildPromptInput` strips user-facing fields when rendering `step` / `confirmed_step` / `candidate_command` turns.** Add to `tests/transcript.test.ts`. Populated response → rendered assistant content (parsed back from JSON) contains `type`, `content`, `risk_level`, `final`, `plan`, `pipe_stdin`; omits `_scratchpad`, `explanation`, `memory_updates_message`, `watchlist_additions`.
6. **`buildPromptInput` handles a minimal final command** with no `plan`.
7. **`runLoop` handles `final: false, low` inline** like today's probe (in `tests/runner.test.ts`) — capture spawn, output post-process, push a `step` turn to the transcript, yield `step-output`, continue to round 2.
8. **`runLoop` does not retry or refuse `final: false, medium`.** No extra LLM call, no refusal push, loop returns `{ type: "command", response, round }`.
9. **`runLoop` returns `{ type: "command", response, round }` for a final response of any risk.**
10. **`runRound` no longer has a probe-risk retry path** (in `tests/round.test.ts`) — the `probeRiskRetry` `AttemptDirectives` field is gone, the in-round retry block is gone. A non-low probe response from the test provider falls through to whatever the runner does next (which after the rewrite is just "return the round normally"; the "probe" enum value no longer exists).
11. **`lastRoundInstruction` text update is loaded** into the assembled prompt on the last round.
12. **`$WRAP_TEMP_DIR` is set in `process.env` after init** and inherited by `Bun.spawn` (verify via `printenv WRAP_TEMP_DIR` spawn).
13. **Temp dir context section — empty case.** Listing reads `(empty)` after fresh init.
14. **Temp dir context section — non-empty case.** File written into temp dir appears in the listing, path relative to `$WRAP_TEMP_DIR`.
15. **Temp dir listing refreshes per round** (distinct from `cwd` which is read once).

### Dialog tests

16. **`executing-step` renders the output slot** with the tail 3 rows of mocked stdout.
17. **New step replaces previous output in the slot** — no concatenation across steps.
18. **Swap to `confirming` preserves previous output** until the user acts on the new command.
19. **Final reply after a step unmounts the dialog** and prints to stdout; previous output is in scrollback.
20. **Empty output renders `Output: (no output)`** as a single row rather than hiding.
21. **First-step fresh entry** — output slot absent until command completes; bottom-border spinner active during spawn.
22. **Plan slot conditional on `response.plan`** — rendered when set, collapsed when null/absent.
23. **Final low after a step opens `confirming`** with low-risk gradient, does NOT auto-execute. User confirms before inherit-exec.
24. **Initial final low still auto-executes** with no dialog ever mounted — pins the asymmetry.
25. **Non-final low inside an open dialog updates the output slot.** In `tests/session.test.ts`. Provider returns [non-final medium, non-final low, final medium]. After round-1 confirm, the `submit-step-confirm` post-transition hook runs the captured exec, pushes a `confirmed_step` turn, and calls `pumpLoop`. `runLoop` handles round 2 inline (the runner emits `step-output` which the listener routes to `state.outputSlot`) and returns on round 3 with `loop-final command medium`. Assert: dialog stayed mounted; `state.outputSlot` updated twice; final state is `confirming` for round 3.
26. **`submit-step-confirm` post-transition hook contract.** Unit-test-style coverage of the hook (in `tests/session.test.ts` or a focused helper test). With `executeShellCommand` mocked: dispatching `submit-step-confirm` from `executing-step` causes the hook to (a) call `executeShellCommand` in capture mode, (b) emit `step-output` via `notifications.emit`, (c) push exactly one `confirmed_step` turn to the transcript with the post-truncated body and the exit code, (d) reset `loopState.budgetRemaining`, (e) call `pumpLoop`. The hook does NOT touch `state.outputSlot` directly — that path goes through the notification listener → `dispatch` → reducer.

### Integration / round-loop tests

27. **Multi-step happy path, no dialog until the final.** Provider returns [non-final low download, final medium run]. Round 1 runs silently with chrome line to scrollback; dialog opens for round 2; user confirms; run with `inherit`.
28. **Multi-step with mid-step confirmation.** Provider returns [non-final medium `git stash`, non-final low test, final low `git stash pop`]. Dialog opens for round 1, user confirms, enters `executing-step`. Round 2 runs inline (inside the dialog). Round 3 is final-low — because the dialog is open, it transitions to `confirming` with low-risk gradient rather than auto-executing. User confirms; dialog unmounts; round 3 runs with `inherit`.
29. **Last-round forces `final: true`.** With `maxRounds=2` and LLM returning `final: false` on round 2, assert `lastRoundInstruction` was pushed before the call.
30. **Round budget resets on follow-up** — already covered by follow-up branch tests; pin the new `final` semantics don't break it.
31. **Non-final `plan: null` proceeds without rejection** — no retry, no refusal, one LLM call per round.
32. **Captured output exit-code append** — non-zero exit produces `Exit code: N` at the end of the pushed message.

### Eval

33. **Update `seed.jsonl` probe assertions** to `type: command, final: false`; confirm `eval/dspy/metric.py` handles the new shape.
34. **Add a multi-step seed sample** asserting `final: false` on intermediates and `final: true` on the terminal round.
35. **Adversarial: "install foo into a temp area"** — assert the LLM returns `command` with `risk_level: medium` or higher, NOT a low non-final. Pins "store, not execute" against adversarial framing.

---

## Out of scope

- **Cleanup sweep for old `wrap-scratch-*` dirs.** Sketch: startup sweep of `$TMPDIR/wrap-scratch-*` older than N (proposed 7 days). OS cleanup is a sufficient backstop pre-release.
- **Migration of pre-refactor log entries.** Accepted loss. See § Backwards Compatibility.
- **Non-final replies (LLM clarifying questions).** Schema shape-ready (`type: reply, final: false`); loop/dialog/prompt don't implement it in this spec. Future work, no migration cost.
- **Fine-grained rule engine for temp-dir confinement.** `specs/safety.md`'s rule engine stays pattern-based — it does NOT validate temp-dir writes. Risk classification is the LLM's job.
- **`--print` flag interaction with multi-step.** Ambiguous (first step? final? script?). Decide when `--print` lands.
- **LLM-emitted icon for chrome lines.** `fetchesUrl()` heuristic kept. The LLM can prepend an emoji to `explanation` if it wants a different one.
- **Per-step output retention in dialog state.** Only the most recent step's tail is held. Older outputs live in real scrollback via the sink.

---

## Implementation order

**Prerequisite.** The coordinator refactor (`specs/coordinator-refactor.md`) is already merged. This spec is written against the post-refactor surface: `runLoop` async generator (`src/core/runner.ts`), `runRound` (`src/core/round.ts`), `Transcript` + `buildPromptInput` (`src/core/transcript.ts`), the typed notification bus (`src/core/notify.ts`), the `AppState` reducer (`src/session/reducer.ts`), and `runSession` with its dispatch closure + post-transition hooks (`src/session/session.ts`).

Each step leaves the tree green. Step 4 is a coherent merge — splitting it would leave the loop inconsistent.

1. **Rename `answer` → `reply`.** Schema enum value. Sweep `type === "answer"` switch cases in `src/core/runner.ts` / `src/core/round.ts` / `src/core/transcript.ts` / `src/session/reducer.ts` / `src/session/session.ts` / `src/tui/dialog.tsx` / `eval/bridge.ts`. `LoopReturn`'s variant name stays `answer` (the discriminator is decoupled from the schema field). Update prompt few-shots and eval seed. `probe` stays; loop shape unchanged.
2. **Add `final` and `plan` to the schema with defaults.** `final: z.boolean().default(true)`, `plan: z.string().nullable().optional()`, positioned between `type` and `content` (or between `_scratchpad` and `type` if scratchpad already landed — see § Field ordering). `probe` stays in the enum. No loop changes — `final` defaults `true`, LLM doesn't know about the fields yet. Tests pin that the parser accepts responses with and without the new fields.
3. **Add `$WRAP_TEMP_DIR` infrastructure.** `mkdtempSync` on init in `src/main.ts` or a new `src/core/temp-dir.ts`, set `process.env.WRAP_TEMP_DIR`, add the temp-dir listing to `src/llm/format-context.ts` (refreshed per round — note this requires `assemblePromptScaffold` to be called on every round, which is a change from today; or, equivalently, hoist the temp-dir-listing format step out of the scaffold and recompute it in `runSession`'s pumpLoop preamble each iteration). Add `tempDirPrinciple` to `src/prompt.constants.json` and wire it into the system prompt. Probes can now write into the temp dir, but `probe` is still the mechanism.
4. **Drop `probe` and wire `final: false`. (coherent merge)**
   - Remove `"probe"` from the schema enum in `src/command-response.schema.ts`.
   - Add the new `step` and `confirmed_step` turn kinds to `TranscriptTurn` in `src/core/transcript.ts`. Delete the `probe` turn kind. Add the rendering branches (with the projection-on-render rule from § Echo projection).
   - Add a private `projectForEcho` helper at the top of `src/core/transcript.ts` and call it from the `step` / `confirmed_step` / `candidate_command` rendering branches in `buildPromptInput`. (The `candidate_command` branch is currently `JSON.stringify(turn.response)` directly — change it to project first.)
   - In `src/core/runner.ts`'s `runLoop`: replace the probe branch with `if (!response.final && response.risk_level === "low")`. The body (a) calls `executeShellCommand` in capture mode, (b) post-processes via the existing stdout+stderr+exit-code merge, (c) yields `step-running` then `step-output`, (d) pushes a new `step` turn to the transcript, (e) continues. Non-final non-low falls through to the existing `return { type: "command", response, round }` path.
   - In `src/core/round.ts`: delete the `if (response.type === "probe" && response.risk_level !== "low")` retry block. Delete `REFUSED_PROBE_INSTRUCTION`. Collapse `verboseResponse`'s probe case into the command case. Rename `formatProbeBody` → `formatStepBody` (it's still in `src/core/transcript.ts`, but the name was probe-specific).
   - In `src/core/transcript.ts`: delete `AttemptDirectives.probeRiskRetry` and its rendering branch in `buildPromptInput`.
   - In `src/prompt.constants.json`: delete `probeRiskInstruction` and `probeRiskRefusedPrefix`. Rewrite `lastRoundInstruction` per § Loop semantics.
   - Update few-shots in `src/prompt.optimized.json` (`type: probe` → `type: command, final: false`) and eval seed (`eval/examples/seed.jsonl`), `eval/bridge.ts`, `eval/dspy/metric.py`.
   - Add `finalFlagInstruction` describing **only** the non-final-low case ("use `final: false` with a low-risk command to gather context"). Do NOT describe non-final non-low yet — step 5 adds that.
   
   After this step, non-final low works end-to-end (equivalent to today's probe). Non-final non-low is unreachable because the prompt doesn't advertise it; if the LLM somehow produces one, `runLoop` returns it and the coordinator's `loop-final` reducer transition routes it to `confirming` — which then falls into the existing `key-action run` → `exiting{run}` path because the reducer doesn't yet branch on `state.response.final`. That's fine: it'll inherit-exec a non-final command, which is a no-op behavior change at this stage.
5. **Add `executing-step` + unlock non-final non-low.** Dialog state + reducer + coordinator hook + prompt update are coupled — one merge.
   - Add the `executing-step` tag to `AppState` in `src/session/state.ts` (carries `response`, `round`, optional `outputSlot`, optional `status`). Update `isDialogTag` to include it.
   - Add `outputSlot?: string` to all dialog states (`confirming`, `editing`, `composing`, `processing`, `executing-step`) per the additive-state-fields constraint from `specs/coordinator-refactor.md`.
   - Update `reduceConfirming` to branch on `state.response.final` for `key-action run`: `final: true` → existing `exiting{run}`, `final: false` → new `executing-step`.
   - Add `reduceExecutingStep` to `src/session/reducer.ts`. Transitions per the table in § `executing-step` behaviour.
   - Extend the existing `reduceProcessing` notification handler (and add the same logic to `reduceExecutingStep`): when `n.kind === "step-output"`, set `state.outputSlot = n.text`. Existing `chrome` → `state.status` mapping is unchanged.
   - Add the `submit-step-confirm` post-transition hook to `runSession`'s dispatch closure in `src/session/session.ts`, parallel to the existing `if (state.tag === "processing")` follow-up hook. The new `if (state.tag === "executing-step")` branch runs the capture, emits `step-output`, pushes a `confirmed_step` turn, and calls `pumpLoop()`.
   - Extend the coordinator's notification listener: while `state.tag === "processing"` OR `state.tag === "executing-step"`, dispatch `chrome` AND `step-output` notifications to the reducer.
   - Add the step output slot and plan slot to `src/tui/dialog.tsx`. Render `state.outputSlot` (when set) above the command strip; render `state.response.plan` (when set) below the explanation. Width/height calculation extends naturally.
   - Extend `useSpinner`'s active condition in `dialog.tsx` to include `state.tag === "executing-step"`.
   - Expand `finalFlagInstruction` to describe the multi-step case with examples (`git stash` before testing, `cp` backup before editing).
   - Add the multi-step few-shot to `src/prompt.optimized.json`.
6. **Eval calibration.** Run DSPy against the updated seed, confirm no regression, add the adversarial lifecycle sample.
7. **Editing-prompts mirror sync.** Always last per `.claude/skills/editing-prompts.md`.
