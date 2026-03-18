# Wrap

Wrap is a CLI tool that translates natural language into shell commands and runs them. Input: `w find all typescript files modified today` → runs `find . -name '*.ts' -mtime 0` and prints the result. See SPEC.md for full details.

## Stack

- **Runtime:** Bun (TypeScript). Use `bun add` / `bun add -D` for dependencies. Never npm or pnpm.
- **Lint/format:** Biome (`bun run check` = lint + test)
- **Test:** `bun test` (files in `tests/`)
- **Build:** `bun build src/index.ts --compile --outfile wrap`

## Hard Rule: stdout is sacred

Wrap's own UI/messages must **never** write to stdout. Stdout is reserved exclusively for the executed command's output (so piping works: `w list files | grep foo`). All Wrap output goes to stderr or `/dev/tty`.

## Testing — TDD

All implementation follows TDD. Always write a failing test before writing code. No exceptions. See `.claude/skills/tdd.md` for the full workflow.
Aim for maximum test coverage.
