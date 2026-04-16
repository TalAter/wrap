---
description: Testing conventions — TDD workflow and test-authoring rules
---

# Testing

## TDD workflow

Follow this cycle for every implementation change.

1. **Write a failing test or tests** in `tests/`. No implementation yet.
2. **Run `bun test`** — confirm the new tests fail. If they pass, those tests aren't testing new behavior or aren't narrow enough; fix it.
3. **Write minimal implementation** — just enough to make the tests pass.
4. **Run `bun test`** — all tests must pass. Fix code, not tests.
5. **Run `bun run check`** — lint + typecheck + tests clean.

## Rules

- Never write implementation before a failing test exists
- Never weaken a test to make it pass — fix the code instead
- For large features, break into multiple small test→implement cycles
- Refactor only after green (tests passing), not before
- Tests use the subprocess helper (`tests/helpers.ts`) that spawns the real binary and captures stdout/stderr/exitCode (NOTE: This rule may need changing later as we separate integration and unit tests. Let the user know if you think it is time)
- LLM and memory layers will be behind interfaces for mocking
- **Test command strings must be harmless if executed.** The inline-step path calls the real shell, so a regression could actually run them. Use `echo rm-rf-fake`, `true`, `false` — never literal `rm`, `git stash`, `sudo`, `dd`, or `curl | sh`.
