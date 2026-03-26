---
description: "Audit specs — clean up implementation details for built features, keep architecture + reasoning. Args: empty for full audit, a spec filename, or a commit hash."
---

You are auditing the spec files in `specs/`. Your goal: keep specs useful as **living reference docs**, not as build plans for already-built features.

## What to do

**Argument parsing:** The user may provide `$ARGUMENTS`:
- **Empty / "all"**: Audit every file in `specs/`.
- **A filename** (e.g., `memory.md`): Audit only that spec file.
- **A commit hash or range** (e.g., `abc123`, `HEAD~3..HEAD`): Run `git diff <ref>` to see what code changed, then audit every spec file whose topic is affected by those changes.

## How to audit a spec file

For each spec file, you must **carefully verify what is built vs. not built** before making any changes. Never assume from the tone of the spec — check the code.

### Step 1: Investigate

Launch sub-agents in parallel to investigate each section/feature described in the spec. Each sub-agent should:

- Search the codebase (`src/`, `tests/`) for the actual implementation
- Check whether the described behavior exists in code: look for functions, types, tests, config keys
- Report back: for each feature/section, is it **built**, **partially built**, or **not started**?

Be thorough. A spec might say "add X to file Y" — check whether X actually exists in Y. A spec might describe a multi-step flow — check whether each step is implemented.

**Watch for spec drift:** A feature may have been implemented and then changed since — the spec wasn't updated, so it describes stale behavior rather than something unbuilt. Compare the spec against the actual code, not just against "does it exist." If the code diverges from the spec, check `git log` for the relevant files to understand whether the spec is outdated or the code is wrong. If you can't tell, **ask the user** rather than guessing.

### Step 2: Rewrite

For **built features**, remove:
- Implementation plans, step-by-step build instructions
- "What code to write" / "what files to change" / "what the code should look like"
- Before/after comparisons of code states
- Completed TODO items
- Pseudo-code or real code that duplicates what's in the actual source files

For **built features**, keep and strengthen:
- Architecture: how the pieces connect, what the modules are, data flow
- Reasoning: **why** design choices were made, tradeoffs considered, alternatives rejected
- Constraints and invariants the code must maintain
- Behavior descriptions (what it does, not how to build it)
- Edge cases and important gotchas

For **unbuilt or partially built features**:
- Keep implementation details — they're still needed
- Add a clear `## TODO` section at the end listing exactly what still needs to be implemented
- Each TODO item should be specific enough to act on

### Step 3: Cross-reference

- SPEC.md and ARCHITECTURE.md are the main entry points. They should reference sub-specs (e.g., "See `specs/memory.md` for details") rather than duplicating content.
- If a sub-spec covers a topic well, the main specs should summarize briefly and point there.
- Remove redundancy between files — each fact should live in one place.

## Style guidelines

- Keep specs high-level. An LLM working on the code can read the actual source files — the spec should tell it **what matters and why**, not **what the code looks like**.
- Write for a future reader (human or LLM) who needs to understand the system before modifying it.
- Preserve the voice and character of the original specs where possible.
- Be concise. Don't pad.

## Output

After rewriting, give a brief summary of what changed in each file and why as well as any open questions you may have.
