---
name: piped-input
description: Stdin detection, file materialization at $WRAP_TEMP_DIR/input, UTF-8 preview for the LLM, file-based consumption by generated commands
Source: src/core/attached-input.ts, src/main.ts, src/llm/format-context.ts, src/llm/context.ts
Last-synced: c1a4169
---

# Piped input

```bash
cat error.log | w what does this error mean
git diff | w summarize these changes
cat data.csv | w sort by the third column and save to sorted.csv
```

When wrap is piped into, the bytes are written to `$WRAP_TEMP_DIR/input` (mode `0o600`) before the first LLM call. The LLM sees a UTF-8 preview of the content and the path; generated commands reference the file directly — by argument for tools that take one, by redirection for tools that read stdin. There is no stdin-streaming path from wrap into children.

The prompt section, the config key (`maxAttachedInputChars`), the internal variable names (`attachedInputPreview` etc.) all use "attached" rather than "piped" — the LLM sees a file on disk, not a pipe, and the naming matches that framing.

## Detection and reading

`!process.stdin.isTTY`. `Bun.stdin.bytes()` reads the full buffer — no cap, no timeout. Zero-length or ASCII-whitespace-only content is treated as no input (prevents `echo "" | w help` from dropping into the query path).

Flags dispatch before the stdin read, so `--help` / `--version` never block on a pipe.

## Materialization

`main.ts` eagerly creates `$WRAP_TEMP_DIR` (the normal lazy path in [[multi-step]] waits until the first shell exec; we can't wait because the LLM call's prompt depends on the file existing), writes `input`, and explicitly `chmod`s `0o600`. Mode is set both upfront (via the write option, so there's no window where umask could leave the file permissive) and after (to guarantee `0o600` regardless of umask). The file is not cleaned up on exit — same policy as the rest of `$WRAP_TEMP_DIR`.

The full byte buffer is dropped after the preview is built. Session state carries only the preview string, path, size, and a truncation flag — for a 1 GB pipe the RAM footprint is the preview budget, not the raw bytes.

## Preview

`buildAttachedInputPreview(bytes, maxChars)` returns `{ preview: string, truncated: boolean }`. Strict UTF-8 decode; on any decode error, return a single summary line (`Binary content — N bytes, not previewable.`) with `truncated: false`. Text longer than `maxChars` (default 200,000 via `maxAttachedInputChars`) runs through `truncateMiddle` and returns with `truncated: true`.

## Prompt section

`## Attached input` is the **first section** of the final user message, before memory, CWD, and the user's request. Layout:

```
## Attached input
Path: $WRAP_TEMP_DIR/input (12K)
Preview truncated — the file on disk carries the full original bytes.

<preview body>
```

The `Preview truncated` line only appears when the preview actually elided content. When the preview is the full content, the line is omitted — no false claims.

`attachedInputInstruction` is a separate system-prompt section, injected conditionally (only when stdin was piped). It tells the LLM to treat the content as a file and gives three shapes: file argument (`vim $WRAP_TEMP_DIR/input`), stdin redirection (`cmd < $WRAP_TEMP_DIR/input`), and pipelines (`cat $WRAP_TEMP_DIR/input | sort | uniq`). Interactive tools must take the file-argument form — piping into vim or less breaks their keyboard input.

## Piped output

When stdout is not a TTY, voice is overridden: bare values, no commentary. See [[answer-voice]]. Unrelated to piped input handling; named similarly only because both involve pipes.

## Decisions

- **File, not stream.** Generated commands reference `$WRAP_TEMP_DIR/input` via normal shell syntax. Wrap has no opinion about how bytes reach children. Keeps the schema small (no `pipe_stdin` flag), handles interactive tools correctly (no drained-pipe-as-stdin trap), and lets later rounds re-read the content without re-streaming.
- **"Attached" in LLM- and code-facing names, "piped" in human-facing prose.** The model reasons about a file, not a stream; the user's mental model is a pipe.
- **Full read, no streaming.** Hanging on `tail -f` is standard Unix.
- **Binary-safe via bytes.** `Bun.stdin.bytes()` preserves non-UTF-8 content verbatim on disk. Preview degrades to a summary line.
- **Two prompt sections, not one branching prompt.** `attachedInputInstruction` is runtime-only; voice guide is optimizer-shared. See [[answer-voice]].
- **Eager file write, lazy temp dir otherwise.** Piped-input materialization is the only pre-shell consumer of `$WRAP_TEMP_DIR`; everything else waits for the first shell exec per [[multi-step]].
