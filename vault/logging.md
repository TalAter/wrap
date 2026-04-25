---
name: logging
description: Always-on JSONL invocation logging
Source: src/logging/
Last-synced: 0a22f2a
---

# Logging

Always-on, no opt-in. When the LLM returns malformed output, the raw response would otherwise be gone. Same data seeds future eval and thread history.

Single append-only JSONL at `${WRAP_HOME}/logs/wrap.jsonl`. One line per invocation, `tail`/`grep`/`jq` friendly. Schema lives in code.

## Detailed logging (`logTraces`)

Off by default. Toggle via flag, env, or config. When on, every LLM attempt records the full prompt and provider wire bodies. The wire request body is stripped of `system`/`messages` because they duplicate the wrap-built prompt; what remains is the SDK-added delta. Headers and subprocess env are never logged. A defensive apiKey scrub runs on every wire body.

## What gets logged

Successful commands, non-zero exits, answers, malformed JSON, provider crashes, blocked/cancelled commands, non-final steps, round budget exhaustion. Memory-init LLM calls and trivial subcommands (`--help`, `--version`, config errors) are not.

## `--log` subcommand

Output goes to stdout (it's useful output, not chrome). Auto-detect: TTY + `jq` → colorized; TTY no `jq` → pretty JSON; non-TTY → raw JSONL. See [[subcommands]].

## Decisions

- **One record per invocation, rounds nested.** Multi-step interactions captured without multiple appends.
- **Full memory snapshot per entry.** `cwd` lets reader reconstruct scope matching without duplicating filtering logic.
- **System prompt as hash only.** Reproducibility without per-entry bloat — match to prompt version in git.
- **Sensitive data logged verbatim.** Same threat model as `~/.bash_history` — local file. API keys redacted to last 4 chars.
- **Wire capture plumbed over the notification bus.** PromptInput stays pure data; providers don't import logging types. Matches the house convention for cross-cutting observability.
- **Categorical attempt errors (`parse`/`provider`/`empty`).** Beats free-text matching for consumers.
- **Per-attempt timings + round-level sum.** Per-attempt enables retry-cost analysis; sum kept for back-compat jq patterns.
- **No size cap on detailed logs.** Opt-in; the user owns the bloat.
- **Logging failures are swallowed.** A broken log never crashes an invocation.
