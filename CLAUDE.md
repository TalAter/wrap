# Wrap

Wrap is a CLI tool that translates natural language into shell commands and runs them. Input: `w find all typescript files modified today` → runs `find . -name '*.ts' -mtime 0` and prints the result. See SPEC.md for full details.

## Stack

- **Runtime:** Bun (TypeScript). Use `bun add` / `bun add -D` for dependencies. Never npm or pnpm.
- **Lint/format:** Biome (`bun run check` = lint + test)
- **Test:** `bun test` (files in `tests/`)
- **Build:** `bun build src/index.ts --compile --outfile wrap`

## Hard Rule: stdout is for useful output only

Stdout carries **useful output** — the executed command's stdout (command mode) or the answer text (answer mode). Wrap's own chrome (UI, notifications, confirmations, errors) must **never** write to stdout. All Wrap chrome goes to stderr or `/dev/tty`.

## Error messages

All user-facing error messages must be clear, helpful, and non-technical. No stack traces, no internal variable names, no jargon. Errors in the same category share a prefix (e.g., all config errors start with `Config error:`), followed by a plain-language description of what went wrong.

## Testing — TDD

All implementation follows TDD. Always write a failing test before writing code. No exceptions. See `.claude/skills/tdd.md` for the full workflow.
Aim for maximum test coverage.
