---
name: skills
description: Deterministic pre-LLM bundles that emit transcript turns to collapse multi-round flows
Source: src/skills/, src/session/session.ts (seedFirstUserTurn)
Last-synced: 8e2e5c7
---

# Skills

A **skill** is a bundle of read-only tasks that fire deterministically before the first LLM call. Each task emits a single `probe` turn into the transcript — one record carrying both the command and the captured output. The projector expands each probe into two LLM messages (assistant + user) identical to what the LLM would produce via a non-final step. Collapses common multi-round flows (`w commit` was 3 rounds, now 1) by front-loading what the LLM would have probed anyway.

A skill is NOT an LLM-chosen tool. Activation is deterministic; probe turns project identically to LLM-emitted assistant + step pairs.

## Activation

Triggers:
- `{ kind: "always" }` — every invocation
- `{ kind: "match"; pattern: RegExp }` — when the user prompt matches

False-positive matches are cheap: wasted IO beats a saved LLM round.

## Bundled skills

- **discovery** — always-on. `pwd`, `ls`, `which <PROBED_TOOLS ∪ watchlist>`. Replaces what `formatContext` used to emit as `## Detected tools` / `## Files in CWD` sections — observations flow through the transcript now. See [[discovery]].
- **commit** — fires on `/\bcommit\b/i`. `git status --short`, `git diff --cached`, `git diff`, plus an untracked-files probe showing each untracked file's content as an addition (since `git diff` omits untracked files, the LLM would otherwise leave new files behind). Each task drops its probe on empty output, so clean repos stay silent.

## Turn placement — the trust fence

Skill turns are spliced BEFORE the user prompt; the user's prompt is always the last turn. On a false-positive match (e.g. `w summarize the previous commit` firing the commit skill), the LLM still responds to the user's actual request because the prompt is freshest. If skill turns came AFTER the user prompt, the LLM would treat them as the trajectory to continue and conflate uncommitted state with "previous commit". See [[safety]].

## Failure

Misfires (non-zero exit, 1s timeout, empty output) drop the probe silently. Never reach the LLM, never surface to the user. Multi-step LLM probes still work after a skill misfire — the LLM just does what it would have done without the skill.

## Continuation

Each invocation re-fires its skills against the new prompt and current state. Prior probe turns stay in the transcript as history; new probe turns are appended before the new user prompt. Multi-generation discovery (successive `pwd` outputs across a `cd`) is intentional — the LLM sees the progression. See [[continuation]].

## Decisions

- **Deterministic triggers, not LLM-chosen tools.** Simpler than tool-use; zero LLM cost; structurally identical output. False positives are acceptable per the spec's cheap-IO calculus.
- **Trust fence: skill turns before user prompt.** Recency-bias guard; the prompt is always the LLM's freshest input.
- **No user-defined skills in V1.** Two bundled; surface stays closed until the shape settles.
- **Watchlist sits at `src/watchlist.ts`, outside `src/skills/`.** Tracker (persisted state) and consumer (discovery skill's `which` task) stay decoupled — adding tools to the watchlist isn't tangled with skill execution.
- **Task within a skill = thunk.** `Skill.tasks: () => SkillTask[]` so dynamic skills (e.g. discovery re-reading the watchlist) defer their list-build to run time without lying about the field's type.
- **Tasks parallel within a skill.** No inter-task deps; turn order in the transcript is preserved by zipping results with the declaration order.
