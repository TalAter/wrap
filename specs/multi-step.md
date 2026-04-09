# Multi-step Commands

> Collapse `probe`/`command`/`answer` into a unified `command`/`reply` schema with a `final` flag controlling loop continuation. Extend "low risk" to include writes into a per-invocation temp directory exposed as `$WRAP_TEMP_DIR`. Together these enable multi-step flows the current architecture can't express — "download, inspect, run the inspected file"; "extract, identify, edit"; "stash, test, restore" — without sacrificing the safety properties of today's probe/command split.

> **Status:** Planned. Not yet implemented.

> **Prerequisites:**
> - `specs/follow-up.md` — UX vocabulary: four-state dialog machine, low-risk gradient, bottom-border status slot.
> - `specs/session.md` — landed. This spec is written against the post-refactor surface: `runLoop` generator (`src/core/runner.ts`), `runRound` (`src/core/round.ts`), `Transcript` + `buildPromptInput` (`src/core/transcript.ts`), typed notification bus (`src/core/notify.ts`), `AppState` reducer (`src/session/reducer.ts`), and `runSession` + `pumpLoop` with dispatch closure + post-transition hooks (`src/session/session.ts`).
> - `specs/scratchpad.md` — orthogonal; ordering rules below. May land before or after this spec.

---

## Motivation

Today's schema splits LLM responses into three types: `probe` (read-only recon, output fed back to the LLM), `command` (final shell action, output to user), `answer` (final text). Probes are pinned to `risk_level: low` with an in-round refusal retry. The structural limitation: **it cannot express workflows where an intermediate step has side effects.**

Canonical case: "`curl` an install script, inspect it, run the exact bytes you inspected." Today the LLM probes the URL, then returns a final command that re-fetches and pipes to `sh`. The bytes "approved" and the bytes that run aren't proven identical, and the natural decomposition (download → inspect → execute the local file) is forbidden because writing to disk isn't read-only.

The shape generalises: any "do step 1 so I can decide step 2" flow collapses badly. Extract → identify config → edit. `git stash` → test → decide whether to revert. Backup → migrate → verify. Options today: bundle into one shell command (user confirms blind), redo work across rounds (waste + races), or punt to answer mode.

The fix: the dimension separating `probe` from `command` isn't kind-of-action, it's *terminality*. Probes are non-terminal commands whose output goes to the LLM; commands are terminal commands whose output goes to the user. Risk-limiting probes to `low` was a safety patch on top of that. Once non-terminal commands at any risk are allowed (with the same confirmation gating), `probe` has nothing left to distinguish it.

---

## Schema Change

```ts
// SCHEMA_START
export const CommandResponseSchema = z.object({
  // `_scratchpad` (from specs/scratchpad.md) goes here as field 1 if it lands.

  type: z.enum([
    "command",  // shell command to execute
    "reply",    // direct text response (knowledge answers, clarifications)
  ]),

  // false = intermediate step; output captured and fed back next round.
  // true (default) = terminal; command runs with inherit or reply prints.
  final: z.boolean().default(true),

  // Cross-round intent, prompt-required when final:false, parser-tolerant.
  // Shown in the dialog under explanation and echoed to the model next round.
  plan: z.string().nullable().optional(),

  content: z.string(),

  // low = read-only, OR write-only to $WRAP_TEMP_DIR per "store not execute".
  //       Installers/build tools/third-party code are NOT low even when
  //       outputs land in $WRAP_TEMP_DIR.
  // medium = modifies user state outside $WRAP_TEMP_DIR.
  // high = destructive or irreversible.
  risk_level: z.enum(["low", "medium", "high"]),

  explanation: z.string().nullable().optional(), // strictly user-facing
  // ... memory_updates, memory_updates_message, watchlist_additions, pipe_stdin unchanged
});
// SCHEMA_END
```

**Mapping.** `probe` → `command` with `final: false`. `answer` → `reply` (one-word rename; anticipates future non-final replies — clarifying questions — with `type: reply, final: false`, schema-ready but not implemented here). `risk_level` is no longer type-constrained; "low" now includes `$WRAP_TEMP_DIR` writes.

### Field ordering and scratchpad coexistence

Structured output is generated linearly, so earlier fields steer later ones. `plan` must sit before `content` so the model commits to multi-step intent before writing the command — same logic as scratchpad.

Two specs touch ordering and must coexist. They solve different problems; don't collapse them.

| Field | Audience | Lifetime | Stripped from echo? |
|---|---|---|---|
| `_scratchpad` | model, this round | one round | yes |
| `plan` | model next round + user (dialog) | until `final: true` ends the chain | no |
| `explanation` | user only | n/a | yes |

Natural order: `_scratchpad, type, final, plan, content, risk_level, explanation, memory_updates, memory_updates_message, watchlist_additions, pipe_stdin`. Whichever of scratchpad/multi-step lands second preserves the other's position.

---

## Loop Semantics

### The risk × final matrix

| `final` | `risk_level` | Output | Confirmation | Loop |
|---|---|---|---|---|
| `true` | `low` | inherit | none *(initial)* / dialog *(if open)* | exit |
| `true` | `medium`/`high` | inherit | dialog | exit |
| `false` | `low` | captured | none | continue (inline in `runLoop`) |
| `false` | `medium`/`high` | captured | dialog | continue (via `executing-step`) |

Row 3 is today's probe, generalised. Row 4 is new.

### Dialog-open rule (load-bearing)

The dialog is either open or closed for the rest of the loop — no flicker. It **opens** the first time anything needs confirmation (any medium/high). Before that, non-final lows run silently and surface via chrome lines in scrollback. Once open, it **stays open** until the loop exits: subsequent non-final lows run inside its lifecycle (captured output reaches the output slot via the notification bus), and subsequent final lows render in `confirming` with the low-risk gradient rather than auto-executing — matching the follow-up branch's post-follow-up low-risk behaviour.

This produces a deliberate asymmetry: an initial final-low skips the dialog entirely, but a final-low *after* a step that opened the dialog does not. Flickering the dialog on/off mid-flow is worse than the asymmetry.

### Control flow split

- **`runLoop` handles non-final low inline.** Capture via `executeShellCommand`, post-process, push a `step` turn to the transcript, yield `step-output` (which the session listener routes to any open dialog's `state.outputSlot`), continue. Never returns to the consumer for this case.
- **`runLoop` returns for everything else** — final any-risk, non-final medium/high, reply, exhausted, aborted. The `LoopReturn` variants stay as today. The `answer` variant carries `type: reply` responses (variant name stays `answer` to avoid touching every reducer transition — the discriminator is decoupled from the schema field).
- **The coordinator handles non-final medium/high via a new `submit-step-confirm` post-transition hook**, parallel to today's `submit-followup` hook. On entry: run the confirmed command in capture mode, emit `step-output` through the bus, push a `confirmed_step` turn, reset `loopState.budgetRemaining`, call `pumpLoop()`. The two hooks share `pumpLoop` — they only differ in which turn they push beforehand. Keep them separate; do not merge.
- **New reducer tag `executing-step`**, entered from `confirming` on `key-action run` when `state.response.final === false && state.response.risk_level !== "low"`. This is a dialog tag (`isDialogTag` includes it) so the dialog stays mounted while the captured step runs.

Initial dispatch on first `loop-final`: final-low → `exiting{run, source: "model"}`; final-med/high → `confirming`; non-final med/high → `confirming`; reply → `exiting{answer}`; exhausted → `exiting{exhausted}`.

### `source: "user_override"` for confirmed steps

If the user opens the editor and changes the bytes of a non-final med/high step, the `confirmed_step` turn carries the user-authored command (so the LLM sees what actually ran). The round's audit log records both the original model bytes and the executed bytes — same shape as today's user_override audit on final commands.

### Transcript turn kinds

Today's `TranscriptTurn` union has `user` / `probe` / `candidate_command` / `answer`. Multi-step replaces `probe` with two kinds:

- **`step`** — inline-executed non-final low. Carries `response`, `output`, `exitCode`. Renders in `buildPromptInput` as assistant-projected-response + user-captured-output.
- **`confirmed_step`** — a non-final med/high the user confirmed. Same fields, renders identically to `step`. The LLM doesn't need to know the user confirmed it.

`candidate_command` and `answer` (LoopReturn variant only — schema field is `reply`) keep their meaning.

### Echo projection

When `buildPromptInput` renders `step` / `confirmed_step` / `candidate_command` turns for the next round, project the stored `CommandResponse` to a minimal shape rather than stringifying it whole.

**Include:** `type`, `content`, `risk_level`, `final`, `plan` (when present), `pipe_stdin` (when present).
**Strip:** `_scratchpad` (one-round scope), `explanation` (user-facing, wastes tokens, invites misuse as scratchpad), `memory_updates_message`, `watchlist_additions` (already actioned).

The builder is the one place that decides which fields the LLM sees. Use a module-private helper; no exported `JSON.stringify(response)` call sites outside the builder.

### Round budget

Unchanged from the follow-up branch. `budgetRemaining` resets on each follow-up; `roundNum` is monotonic. Multi-step flows consume budget the same way probes did. "Last round" means last of the current countdown, not last ever — a follow-up resets it.

`lastRoundInstruction` is rewritten to forbid `final: false` on the last available round.

---

## Temp Directory (`$WRAP_TEMP_DIR`)

### Creation and lifetime

One temp dir per `w` invocation, created at startup via `mkdtempSync` and exported into `process.env`. `Bun.spawn` inherits env, so every spawned shell sees it — no per-spawn wiring. Lifetime is the whole invocation (all follow-up rounds, all dialog interactions).

**Cleanup is deferred.** No exit handler, no signal trap. Rationales: (a) enables a future resume flow; (b) keeps implementation trivial. `$TMPDIR` is temporary by convention and OS cleanup is the backstop. Startup sweep is out of scope.

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

The temp dir section is included in the assembled prompt context every round, even when empty. Listing refreshes per round (unlike `cwd`, which is read once) because the dir mutates mid-invocation. The LLM is told only the variable name, never the literal path — keeps generated commands portable and matches the dialog display.

### Visibility and clipboard substitution

| Surface | Form |
|---|---|
| Dialog, logs, chrome | `$WRAP_TEMP_DIR` form (readable) |
| `[C]opy` action, shell-history injection | **Substitute** with literal path |

Rule: when the command crosses the invocation boundary (clipboard, shell history — anywhere it might be replayed in a different process), expand `$WRAP_TEMP_DIR` to the actual path. Inside the invocation, the env var form is preferred. Without substitution, a replayed `$WRAP_TEMP_DIR/install.sh` would silently expand to `/install.sh` in a fresh shell — worse than a clear failure.

---

## Dialog Changes

Adds one state: **`executing-step`**, entered from `confirming` on `key-action run` when the current command is non-final med/high. The dialog stays mounted while `submit-step-confirm` runs the capture and re-enters `pumpLoop`.

Two conditional slots:
- **Step output slot** between the top border and the command strip. 4 rows when populated (label + tail-3-rows); 1 row when empty (`Output: (no output)`); 0 rows before any step runs in this dialog. Replacement, not accumulation — each step replaces the slot; older outputs live in real scrollback via the notification buffer flushed on dialog unmount.
- **Plan slot** between explanation and action bar. 0 rows when `response.plan` is absent. Styled distinctly from `explanation` so "what this step does" is visually separable from "the bigger picture".

Output slot source: the post-truncation string pushed to the LLM (single source of truth). Tail-3-rows is computed after Ink's soft-wrapping to dialog width.

### `executing-step` transitions

While in `executing-step`: spinner on, previous output (if any) stays visible, `step-output` notifications update `state.outputSlot` via the reducer.

When `pumpLoop` returns its `LoopReturn`, the reducer transitions:

| Result | Next state | Notes |
|---|---|---|
| `command`, `final: true`, any risk | `confirming` | Low-risk gradient for low; dialog does NOT skip (asymmetric with initial final-low). User confirms → `exiting{run}` → inherit-exec. |
| `command`, `final: false`, med/high | `confirming` | New step. Confirm → re-enters `executing-step`. |
| `answer` (= reply) | `exiting{answer}` | Dialog unmounts; reply prints to stdout. Previous step output already in scrollback. |
| `exhausted` | `exiting{exhausted}` | Same as today. |
| `aborted` | `executing-step` (no-op) | Belt-and-braces — Esc would have transitioned out already. |

`command, final: false, low` is never a `LoopReturn` the reducer sees in `executing-step` — those are handled inline inside `runLoop` and never escape the generator.

### Step-output wiring

`src/core/notify.ts` already carries a `step-output` notification kind (added during the coordinator refactor). Multi-step extends the coordinator's notification listener so `step-output` notifications reach the reducer in both `processing` and `executing-step`. The reducer's notification branch sets `state.outputSlot = n.text`.

Step output is NOT chrome, NOT verbose, and MUST NOT reach stdout — stdout remains reserved for final-command `inherit` output and final-reply text per `CLAUDE.md`. The bus's default-handler fallback intentionally drops `step-output` when no session listener is subscribed (only during init/teardown).

### Icon heuristic (kept)

`fetchesUrl(content)` stays — non-final commands display a chrome line with `🌐` for URL fetches and `🔍` otherwise, applied to `response.explanation`.

---

## Removals

Deleted with `probe`:
- `REFUSED_PROBE_INSTRUCTION` and probe risk-level retry in `runRound`
- `AttemptDirectives.probeRiskRetry` in transcript
- `verboseResponse`'s probe case (folded into command)
- `probe` variant of `TranscriptTurn` and enum value in schema
- `probeRiskInstruction` / `probeRiskRefusedPrefix` prompt constants
- `maxRounds` description's "(probes + error-fix attempts)" parenthetical
- `seed.jsonl` probe assertions → `type: command, final: false`; `eval/bridge.ts` and `eval/dspy/metric.py` follow

Kept: `fetchesUrl` (icon heuristic), `maxCapturedOutput*` / `sectionCapturedOutput` / `capturedNoOutput` (already in place from the coordinator refactor).

`formatProbeBody` in transcript.ts is renamed `formatStepBody` — it's still probe-named but works on the new `step` turn shape.

---

## Backwards Compatibility

None. Wrap is pre-release; the single user accepts pre-refactor log entries won't parse. Action: `rm ~/.wrap/logs/wrap.jsonl` (or leave it — nothing reads old entries). No shim, no aliases, no transitional enum.

---

## Out of scope

- **Cleanup sweep for old `wrap-scratch-*` dirs.** Sketch: startup sweep of `$TMPDIR/wrap-scratch-*` older than N days. OS cleanup is sufficient backstop pre-release.
- **Non-final replies** (clarifying questions). Schema shape-ready; loop/dialog/prompt don't implement.
- **Fine-grained rule engine for temp-dir confinement.** Risk classification is the LLM's job.
- **`--print` flag interaction with multi-step.** Ambiguous. Decide when `--print` lands.
- **LLM-emitted icon for chrome lines.** `fetchesUrl()` heuristic kept.
- **Per-step output retention in dialog state.** Only the most recent step's tail held; older outputs in scrollback.

---

## TODO

Implementation order. Each step leaves the tree green. Step 4 is a coherent merge — splitting it would leave the loop inconsistent.

1. **Rename `answer` → `reply`** in the schema enum. Sweep `type === "answer"` switch cases. `LoopReturn`'s variant name stays `answer`. Update prompt few-shots and eval seed. `probe` stays; loop shape unchanged.
2. **Add `final` and `plan` to the schema with defaults.** `probe` still in the enum. No loop changes yet — `final` defaults `true`, LLM doesn't know about the fields.
3. **Add `$WRAP_TEMP_DIR` infrastructure.** `mkdtempSync` on init, export to env, add temp-dir listing to the per-round context assembly (hoist out of the scaffold if the scaffold is only computed once today), add `tempDirPrinciple` prompt constant. Probes can now write into the temp dir but `probe` is still the mechanism.
4. **Drop `probe` and wire `final: false`** (coherent merge). Remove enum value; add `step` / `confirmed_step` transcript turn kinds and their echo-projection rendering; replace probe branch in `runLoop` with `if (!response.final && response.risk_level === "low")`; delete probe-risk retry and refusal plumbing; rewrite `lastRoundInstruction`; update few-shots + eval seed. Add `finalFlagInstruction` describing **only** the non-final-low case. After this step, non-final low works end-to-end; non-final non-low is unreachable because the prompt doesn't advertise it.
5. **Add `executing-step` and unlock non-final non-low.** Reducer tag + dialog state + `submit-step-confirm` post-transition hook + prompt expansion are coupled — one merge. Extend notification listener to route `step-output` in `executing-step`. Add dialog's output slot + plan slot + extended spinner condition. Add the multi-step few-shot.
6. **Eval calibration.** Run DSPy against the updated seed, add adversarial "install foo into a temp area" lifecycle sample (must NOT be a low non-final — pins "store not execute" against adversarial framing).
7. **Editing-prompts mirror sync** last, per `.claude/skills/editing-prompts.md`.

### Test coverage required

- Schema round-trips for `command` with `final: false` + `plan`, `command` with `final: true` default, `reply` with `final: true`.
- `plan` is prompt-enforced, not schema-enforced — parser accepts `final: false` with `plan` absent/null, loop proceeds (keeps JSON Schema flat for OpenAI strict mode + Anthropic tool-use).
- `buildPromptInput` projection strips user-facing fields on `step` / `confirmed_step` / `candidate_command` turns.
- `runLoop` handles `final: false, low` inline; does not retry or refuse `final: false, medium`.
- `runRound` no longer has a probe-risk retry path.
- `$WRAP_TEMP_DIR` set in `process.env`, inherited by `Bun.spawn`, listing empty/non-empty cases, refreshes per round.
- `executing-step` renders output slot (tail 3 rows), new step replaces previous output, swap to `confirming` preserves previous output until user acts, empty output renders as single row, plan slot conditional on `response.plan`.
- Final low *after* a step opens `confirming` (does NOT auto-execute); initial final low still auto-executes with no dialog (pins the asymmetry).
- Non-final low inside an open dialog updates the output slot via the bus → reducer path.
- `submit-step-confirm` hook contract: calls capture, emits `step-output`, pushes exactly one `confirmed_step` turn, resets budget, calls `pumpLoop`. Does NOT touch `state.outputSlot` directly — goes through notification listener → dispatch → reducer.
- Multi-step integration: happy path (non-final low download → final med run), mid-step confirmation (`git stash` → test → `git stash pop`), last-round forces `final: true`, round budget resets on follow-up, non-final `plan: null` proceeds without rejection, captured output exit-code append.
- Adversarial: "install foo into a temp area" returns med/high, not low non-final.
