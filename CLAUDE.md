# Wrap

Wrap is a CLI tool that translates natural language into shell commands and runs them. Input: `w find all typescript files modified today` → runs `find . -name '*.ts' -mtime 0` and prints the result. See SPEC.md for full details.

## Stack

- **Runtime:** Bun (TypeScript). Use `bun add` / `bun add -D` for dependencies. Never npm or pnpm.
- **Lint/format:** Biome (`bun run check` = lint + test)
- **Test:** `bun test` (files in `tests/`)
- **Build:** `bun build src/index.ts --compile --outfile wrap`

## Testing — TDD

Write a failing test first, then make it pass. No exceptions. Tests cover the full pipeline via a subprocess helper (`tests/helpers.ts`) that spawns the real binary and captures stdout/stderr/exitCode. LLM and memory layers will be behind interfaces for mocking.
