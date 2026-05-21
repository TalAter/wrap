# Skills

> **Implementation status (2026-05-21):**
> - ✅ Per-turn `source` field + `cwd_change` turn removal — landed.
> - ✅ Watchlist + memory-init probes carveout from `src/discovery/` — landed.
> - ✅ Skills infrastructure: types, registry shell (empty), runner with 1s timeout + silent misfire drop — landed at `src/skills/`.
> - ✅ Discovery skill + wire-in (replaces `formatContext` tools/cwdFiles, dissolves remaining `src/discovery/`).
> - ⏳ Commit skill.
> - ⏳ Prompt-constants + eval-bridge cleanup (post-discovery housekeeping).

## Goal

Collapse common multi-round Wrap invocations into a single LLM round. Today `w commit` takes ~8s because the LLM probes `git status`, then `git diff`, then proposes a commit. With skills, both probes run before the first LLM call and their output is already in the transcript when the model first sees the prompt, so the model can produce a final commit proposal in one round (~2s). Skills also subsume what `formatContext()` previously did for eager discovery (cwd, files, tools) — those observations now flow through the transcript as turns rather than the context block.

## What a skill is

A **skill** is a bundle of read-only shell commands paired with a trigger. When the trigger matches, each command runs before the first LLM call and produces one **turn pair** appended to the transcript: an `assistant` turn carrying the proposed command and a `step` turn carrying the output — the same shape Wrap already produces during multi-step rounds (see [[multi-step]]).

A skill is NOT a tool the LLM chooses. Activation is deterministic. The skill runs imperatively; the resulting turns are structurally identical to turns the LLM might have produced via non-final probing.

## V1 scope

Two bundled skills. No user-defined skills, no config surface.

- ✅ **`discovery`** — always-on. Emits pwd / ls (mtime-sorted, capped at 50) / `which` over `PROBED_TOOLS ∪ watchlist`. Source: `src/skills/discovery.ts`.
- ⏳ **`commit`** — trigger matches `/\bcommit\b/i` against the user prompt. Emits `git status --short` and `git diff --cached`.

## Trigger types

> **Status:** Implemented (`src/skills/types.ts`).

- `{ kind: "always" }`
- `{ kind: "match"; pattern: RegExp }` — tested against the user prompt. **User prompt** here means the natural-language argv that follows `w`, after any modifier flags are stripped; piped stdin is NOT included in the match. Accept false positives — wasted IO is cheap relative to a saved LLM round-trip.

## Turn placement — before the user prompt

> **Status:** Implemented. `seedFirstUserTurn` in `src/session/session.ts` is the single source of truth for this invariant; it runs skills, splices their turns, then pushes the user turn. Called from both the argv entry path and the `processing-interactive` submit hook so neither path can drift.

All skill-emitted turns are inserted BEFORE the user prompt in the transcript. The user's prompt is always the last turn before the next LLM call.

```
system:    <instructions, memory facts, piped-input notice>
[discovery skill turns]
[commit skill turns — if matched]
user:      "commit"          ← last
→ next LLM call
```

This matches the trust-fence pattern already used for piped input (see [[piped-input]], [[safety]]) and is the recency-bias guard for false-positive matches. For example, for `w summarize the previous commit`, the substring match fires and the commit skill emits its turns, but the LLM responds to the user's actual request (likely re-probing `git log` / `git show HEAD`) because the prompt is the freshest message. If skill turns came AFTER the user prompt, the LLM would treat them as the trajectory to continue and conflate uncommitted changes with "the previous commit".

## Per-turn source marker

> **Status:** Implemented.

Assistant and step turns carry a `source` field identifying who emitted them:

- assistant: `"model" | { kind: "skill"; name: string }`
- step: `"model" | "user_override" | { kind: "skill"; name: string }`

`"model"` means an LLM-emitted turn. The `{ kind: "skill"; name }` discriminated-union shape mirrors the `Trigger` shape and leaves room for additive fields (e.g. task index) without a breaking change. Durable through the JSONL log so continuation can rebuild the conversation faithfully (see [[continuation]]). The marker is the only architectural difference between a skill-emitted turn and a real LLM turn.

## Continuation

> **Status:** Implemented via `seedFirstUserTurn` re-firing on every invocation entry.

Each invocation re-fires its skills against the new prompt and the current state. Fresh skill-emitted turns are appended before the new user prompt. Prior skill-emitted turns from earlier invocations stay in the transcript as history with their original source markers — they are real turns, just emitted by a skill rather than the LLM. Multi-generation discovery (e.g. successive `pwd` outputs across a `cd`) is intentional: the LLM sees the progression.

## What the discovery skill displaces

> **Status:** Implemented. The split below is the design rule for future skills.

The discovery skill took over what `formatContext()` did for cwd path, cwd files listing, and tool watchlist results. These are **observations** — they belong in transcript turns, not the context block.

What stays in the context block (**knowledge**, not observations):

- Memory facts
- Piped-input instruction and the attached-input preview block (these are about untrusted user-supplied input, not about probed environment state)

The `cwd_change` turn kind was removed; a `cd` is now expressed by the next invocation's discovery skill emitting a fresh `pwd` step turn.

## Failure handling

> **Status:** Implemented in the runner.

- A skill command's output is included in the transcript only on exit 0. Non-zero exits are misfires (e.g. `git status` outside a repo); drop the turn pair silently.
- 1s hard timeout per task, applied uniformly to shell tasks and TS `run` tasks. On timeout, drop the turn pair silently.
- Misfires never surface to the user and never reach the LLM.

## UX

> **Status:** Implemented.

Silent. No spinner, no chrome, no "🔍 Checking…" line. The user sees nothing between accepting the prompt and the LLM's response.

## Task shape

> **Status:** Implemented (`SkillTask` in `src/skills/types.ts`). `Skill.tasks` is a thunk (`() => SkillTask[]`) so dynamic skills (e.g. discovery re-reading the watchlist) can defer list-build to run time without lying about the field's type.

A skill is a list of tasks. Each task has a `command` string (shown in the skill-emitted assistant turn) and an optional `run` function. When `run` is absent, the runner executes `command` in a shell. `run` is the escape hatch for tasks whose output is computed in TS (e.g. discovery's `ls` task synthesises `command: "ls"` while internally calling `listCwdFiles`). Returning `null` or throwing from `run` is a misfire and drops the turn pair, matching how non-zero exit drops a shell task. Tasks within a skill run in parallel; turn order is preserved by zipping results with the task list.

The skill-emitted assistant turn must carry a `response` so `buildPromptInput` projects it as a real LLM message — the runner stamps `{ type: "command", final: false, content: task.command, risk_level: "low" }`. Without `response`, the projector silently skips the turn.

## Code organization

`src/skills/<name>.ts` per skill, registry in `src/skills/index.ts`. The old `src/discovery/` has been dissolved:

- Watchlist storage (persistence) → `src/watchlist.ts`. Lives **outside** `src/skills/` on purpose: the tracker (persisted state) and its consumer (the discovery skill's `which` task) are separated, so adding/reading the watchlist isn't tangled with skill execution.
- Memory-init probes → `src/memory/memory-init-probes.ts` (these run once on memory init, not per-invocation).
- Per-call discovery (cwd-files + tool probe) → `src/skills/discovery.ts`.

## Prompt-constants + eval-bridge cleanup (follow-up)

> **Status:** Not started. Read [[editing-prompts]] before touching prompt text — the TS mirror is generated from a Python source-of-truth.

After the discovery skill landed, several pieces still reference the displaced sections:

- `src/prompt.constants.json`: `sectionDetectedTools`, `sectionUnavailableTools`, `sectionCwdFiles`, `cwdPrefix` are unused by the runtime but still emitted.
- `eval/dspy/optimize.py`: still references those section keys when assembling examples.
- `eval/bridge.ts`: still accepts `tools` / `cwdFiles` fields at the JSON boundary (silently ignored).
- `toolsScopeInstruction` text in the prompt references "detected tools" — the LLM no longer sees that section header in the context block (it sees the discovery skill's `which` step output instead).

This is one coordinated edit: Python source-of-truth, TS mirror, optimizer, and the eval bridge. Sequence it after the commit skill so prompt edits aren't competing with skill-content changes.
