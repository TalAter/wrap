# Wrap

Wrap is a CLI tool that translates natural language into shell commands and runs them. Input: `w find all typescript files modified today` → runs `find . -name '*.ts' -mtime 0` and prints the result. Product spec and architecture docs live in `specs/`.

## Stack

- **Runtime:** Bun (TypeScript). Use `bun add` / `bun add -D` for dependencies. Never npm or pnpm.
- **Lint/format:** Biome + tsc (`bun run lint` = biome --write + typecheck)
- **Test:** `bun test` (files in `tests/`). Run specific tests with `bun test tests/foo.test.ts`
- **Full check:** `bun run check` = lint + test

## Hard Rule: stdout is for useful output only

Stdout carries **useful output** — the executed command's stdout (command mode) or the answer text (answer mode). Wrap's own chrome (UI, notifications, confirmations, errors) must **never** write to stdout. All Wrap chrome goes to stderr or `/dev/tty`.

## Error messages

All user-facing error messages must be clear, helpful, and non-technical. No stack traces, no internal variable names, no jargon. Errors in the same category share a prefix (e.g., all config errors start with `Config error:`), followed by a plain-language description of what went wrong.

## Testing — TDD

All implementation follows TDD. Always write a failing test before writing code. No exceptions. See `.claude/skills/tdd.md` for the full workflow.
Aim for maximum test coverage.

## Editing prompts

Wrap's LLM prompt is split across multiple files with a Python source of truth and a TS runtime mirror. Editing the wrong one silently breaks the optimizer or runtime. **Before changing any prompt text, read `.claude/skills/editing-prompts.md`.**

## Stop hook

A stop hook runs `bun run lint` (biome --write + tsc) automatically when you finish. Don't run lint/format/tsc as a final check before stopping — they'll just run twice. Tests are **not** in the stop hook — run them yourself when needed, preferring targeted runs (`bun test tests/foo.test.ts`) over the full suite.
