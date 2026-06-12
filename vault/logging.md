---
name: logging
description: Always-on JSONL invocation logging
Source: src/logging/, src/core/round.ts
Last-synced: eb05626
---

# Logging

Always-on, no opt-in. When the LLM returns malformed output, the raw response would otherwise be gone. Same data seeds future eval and thread history.

Single append-only JSONL at `${WRAP_HOME}/logs/wrap.jsonl`. One line per invocation, `tail`/`grep`/`jq` friendly. Schema lives in code.

## Detailed logging (`logTraces`)

Off by default. Toggle via flag, env, or config. When on, every LLM attempt records the full assembled request and provider wire bodies, copied from core's conversation record at record-build time (see [[llm]]). The wire request body is stripped of `system`/`messages` because they duplicate the assembled request; what remains is the SDK-added delta. Headers and subprocess env are never captured. API keys are scrubbed by core before wires land in the record.

Trace fields are **not** inlined into the main log. They are written to a sidecar at `${WRAP_HOME}/logs/traces/<entry-id>.json`.

## What gets logged

Successful commands, non-zero exits, answers, malformed JSON, provider crashes, blocked/cancelled commands, non-final steps, round budget exhaustion. Memory-init LLM calls and trivial subcommands (`--help`, `--version`, config errors) are not.

## `--log` subcommand

Output goes to stdout (it's useful output, not chrome). Auto-detect: TTY + `jq` → colorized; TTY no `jq` → pretty JSON; non-TTY → raw JSONL. See [[subcommands]].

## Decisions

- **One record per invocation, rounds nested.** Multi-step interactions captured without multiple appends.
- **Full memory snapshot per entry.** `cwd` lets reader reconstruct scope matching without duplicating filtering logic.
- **System prompt as hash only.** Reproducibility without per-entry bloat — match to prompt version in git.
- **Sensitive data logged verbatim.** Same threat model as `~/.bash_history` — local file. API keys redacted to last 4 chars.
- **Attempts derive from the conversation record.** Core's entries carry per-call forensics; round.ts maps them to `AttemptMeta` after the await. No notification bus; providers don't import logging types.
- **Categorical attempt errors (`parse`/`provider`/`empty`).** Beats free-text matching for consumers.
- **Per-attempt timings + round-level sum.** Per-attempt enables retry-cost analysis; sum kept for back-compat jq patterns.
- **No size cap on detailed logs.** Opt-in; the user owns the bloat.
- **Logging failures are swallowed.** A broken log never crashes an invocation.
