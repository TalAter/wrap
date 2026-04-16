---
name: piped-input
description: Stdin detection, reading, prompt assembly, truncation, re-piping via pipe_stdin
Source: src/core/piped-input.ts, src/llm/format-context.ts, src/llm/build-prompt.ts
Last-synced: c54a1a5
---

# Piped input

```bash
cat error.log | w what does this error mean
git diff | w summarize these changes
```

Wrap handles arbitrarily large inputs by showing the LLM a truncated view while keeping the full buffer available to re-pipe into generated commands.

## Detection and reading

`!process.stdin.isTTY`. `Bun.stdin.text()` reads full content — no cap, no timeout. Empty/whitespace-only treated as no piped input.

Flags dispatch before reading stdin — `--help`/`--version` never block on a pipe.

## Prompt assembly

Piped input is the **first section** of the final user message, before memory, CWD, and user request. When no CLI args, `## User's request` section is omitted.

`pipedInputInstruction` in the system prompt injected only when piped input is present.

## Truncation

When content exceeds `maxPipedInputChars` (default 200,000), the LLM sees a truncated view. Full buffer kept for re-piping. Silent — no stderr notice.

## Re-piping: `pipe_stdin`

Top-level boolean on `CommandResponse`. When `true` and piped input exists, child spawned with `stdin: new Blob([pipedInput])`. Otherwise `stdin: "inherit"`.

Present on all response types; meaningful for commands and non-final steps. No special safety treatment — `risk_level` handles danger. Buffer persists across rounds.

## Piped output

When stdout is not a TTY, voice is overridden: bare values, no commentary. See [[answer-voice]].

## Decisions

- **Full read, no streaming.** Re-piping needs the complete buffer. Hanging on `tail -f` is standard Unix.
- **LLM sees truncated, command gets full.** The LLM uses Unix tools to surgically extract what it needs from the full buffer.
- **Two instructions, not one branching prompt.** Piped input instruction is runtime-only; voice guide is optimizer-shared. See [[answer-voice]].
