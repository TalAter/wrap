# Skills

## Goal

Collapse common multi-round Wrap invocations into a single LLM round. Today `w commit` takes ~8s because the LLM probes `git status`, then `git diff`, then proposes a commit. With this feature, both probes run before the first LLM call and their output is already in the transcript when the model first sees the prompt, so the model can produce a final commit proposal in one round (~2s). This is done by introducing the concept of skills that Wrap can decide to run on its own before even consulting the LLM so that the results of those skills get sent to the LLM on the first call. We already have some discovery steps which do something similar (e.g., listing files in cwd, running `which <tool>`, etc). These will be refactored into skills.

## What a skill is

A **skill** is a bundle of read-only shell commands paired with a trigger. When the trigger matches, each command runs before the first LLM call and produces one **turn pair** appended to the transcript: an `assistant` turn carrying the proposed command and a `step` turn carrying the output — the same shape Wrap already produces during multi-step rounds (see [[multi-step]]).

A skill is NOT a tool the LLM chooses. Activation is deterministic. The skill runs imperatively; the resulting turns are structurally identical to turns the LLM might have produced via non-final probing.

## V1 scope

Two bundled skills. No user-defined skills, no config surface.

- **`discovery`** — trigger is "always". Emits the equivalent of `pwd`, an `ls` of cwd, and a `which` lookup for the tool watchlist. Reuses the existing helpers in `src/discovery/` so mtime-sorting + the 50-entry cap on cwd files and the tool-name validation guard on the watchlist are preserved; the existing output formats become the body of the corresponding step turns. Replaces the cwd/files/tools portions of the eager-discovery context block produced by `formatContext()` in `src/llm/format-context.ts`.
- **`commit`** — trigger matches `/\bcommit\b/i` against the user prompt. Emits `git status --short` and `git diff --cached`.

## Trigger types

- `{ kind: "always" }`
- `{ kind: "match"; pattern: RegExp }` — tested against the user prompt. **User prompt** here means the natural-language argv that follows `w`, after any modifier flags are stripped; piped stdin is NOT included in the match. The commit skill uses `/\bcommit\b/i`. Accept false positives — wasted IO is cheap relative to a saved LLM round-trip.

## Turn placement — before the user prompt

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

Every transcript turn carries a source field identifying who emitted it. The existing `step` and `final` turns already carry a `source` field (`"model" | "user_override"` and friends — see `src/logging/entry.ts`). This work extends that field to identify the emitting skill — exact union shape is the implementer's call, but conceptually:

```
source: "llm" | { skill: string }
```

Durable through the JSONL log so continuation can rebuild the conversation faithfully (see [[continuation]]). The marker is what distinguishes a skill-emitted turn from a real LLM turn — there's no other architectural difference between them.

## Continuation

Each invocation re-fires its skills against the new prompt and the current state. Fresh skill-emitted turns are appended before the new user prompt. Prior skill-emitted turns from earlier invocations stay in the transcript as history with their original source markers — they are real turns, just emitted by a skill rather than the LLM.

## What the discovery skill displaces

The discovery skill takes over what `formatContext()` does today for cwd path, cwd files listing, and tool watchlist results. These observations move out of the context block and into transcript turns.

What stays in the context block (knowledge, not observations):

- Memory facts
- Piped-input instruction and the attached-input preview block (these are about untrusted user-supplied input, not about probed environment state)

The existing `cwd_change` turn kind is deprecated. A cwd change is now expressed by the next invocation's discovery skill emitting a fresh `pwd` step turn. Remove the existing wrap-note that today renders cwd changes between continuations (`src/main.ts` and the `cwd_change` branch in `src/core/transcript.ts`).

## Failure handling

- A skill command's output is included in the transcript only on exit 0. Non-zero exits are misfires (e.g. `git status` outside a repo); drop the turn pair silently.
- 1s hard timeout per command. On timeout, drop the turn pair silently.
- Misfires never surface to the user and never reach the LLM.

## UX

Silent. No spinner, no chrome, no "🔍 Checking…" line. The user sees nothing between accepting the prompt and the LLM's response.

## Code organization

`src/skills/<name>.ts` per skill, registry in `src/skills/index.ts`. The existing `src/discovery/` is absorbed into `src/skills/discovery.ts`.
