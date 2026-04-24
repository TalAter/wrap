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

## Test value — what earns a test

TDD is mandatory, but tests must earn their place. "Delete it and nothing changes" = bloat, don't write it.

**Each test pins a behavioral contract you can name in one sentence** ("returns `[]` for empty input", "emits `config-error` notification when file missing"). If you can't name the contract, skip it. Think broadly — contracts include outputs, side effects, error shapes, invariants, state transitions, and more.

**Red must fail for the right reason.** A real assertion on real behavior — not `ReferenceError`, missing export, or type error. Compiler already catches those.

**A few examples of things NOT to test** (not exhaustive):
- "Function is exported" / "module imports without throwing"
- Constants equal to their literal
- Type-only assertions the compiler enforces
- Trivial getters/setters, barrel re-exports

**No one-test-per-function quota.** One test covering a real branch beats three covering plumbing.

**Floor:** every branch and every user-visible error path has a behavioral test. Value rules don't excuse missing coverage.
