---
name: piped-input
description: Stdin materialization to a temp file, UTF-8 preview for the LLM, file-based consumption by generated commands
Source: src/core/attached-input.ts, src/main.ts, src/llm/
Last-synced: 0a22f2a
---

# Piped input

```bash
cat error.log | w what does this error mean
git diff | w summarize these changes
```

When wrap is piped into, the bytes are written to a file under `$WRAP_TEMP_DIR` (mode `0o600`) before the first LLM call. The LLM sees a UTF-8 preview and the path; generated commands reference the file directly — by argument or shell redirection. There is no stdin-streaming path from wrap into children.

In LLM- and code-facing names this is "attached" (the model reasons about a file on disk). Human-facing prose says "piped" (matches the user's mental model).

## Detection and read

`!process.stdin.isTTY`. Full buffer read, no cap, no timeout. Whitespace-only or empty content is treated as no input — prevents `echo "" | w help` from dropping into the query path. Subcommand flags dispatch before the read so `--help`/`--version` never block on a pipe.

## Materialization

Eager: `$WRAP_TEMP_DIR` is created and the file written before the LLM call (the prompt depends on the path existing). Mode pinned both upfront and after write so umask can't leave a window. Not cleaned on exit — same policy as the rest of the temp dir.

The byte buffer is dropped after the preview is built. Session state carries only the preview, path, size, and a truncation flag — a 1 GB pipe costs the preview budget in RAM, not the raw bytes.

## Preview

Strict UTF-8 decode. On any decode error: a single summary line declaring binary content and byte count. Long text is middle-truncated to a configurable budget; a "preview truncated" line appears in the prompt only when content was actually elided — no false claims.

## Prompt sections

The attached-input section is the **first** part of the user message, before memory, CWD, and the request. A separate system-prompt instruction (runtime-only, injected only when input was attached) tells the LLM to treat the content as a file and gives shapes: file argument, stdin redirection, pipeline. Interactive tools (vim, less) must take the file-argument form — piping into them breaks keyboard input.

## Decisions

- **File, not stream.** Generated commands reference the temp path via normal shell syntax. Wrap has no opinion about how bytes reach children. Keeps the schema small, handles interactive tools, and lets later rounds re-read without re-streaming.
- **Full read, no streaming.** Hanging on `tail -f` is standard Unix.
- **Binary-safe via raw bytes.** Non-UTF-8 content is preserved verbatim on disk; preview degrades to a summary line.
- **Two prompt sections.** The instruction is runtime-only; the voice guide is optimizer-shared. See [[answer-voice]].
- **Eager file write, lazy temp dir otherwise.** Piped input is the only pre-shell consumer; other writers wait for the first shell exec per [[multi-step]].

Unrelated: piped *output* (stdout not a TTY) overrides voice to bare values. See [[answer-voice]].
