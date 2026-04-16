---
name: scratchpad
description: Forced pre-commit planning slot in the LLM response schema — first position, visible in logs/verbose
Source: src/command-response.schema.ts, src/core/round.ts, src/core/transcript.ts
Last-synced: c54a1a5
---

# Scratchpad

Optional `_scratchpad` field at position 0 of `CommandResponseSchema`. A forced planning slot generated **before** `type`, `content`, and `risk_level` so non-reasoning models think before committing.

Visible in `--log` and `--verbose`. Never shown to the user.

## Why

Without it, two failure modes recurred:
1. Model writes an overengineered command in `content`, then critiques itself in `explanation` — but `explanation` is user-facing and generated after the command. Too late.
2. Logs show what the model picked, not why. Debugging wrong responses requires guessing.

Non-reasoning models (Haiku 4.5) don't get extended-thinking blocks. First-position scratchpad gives them a chain-of-thought slot through the schema.

## First position is the point

Structured output generates token-by-token in JSON-key order. A scratchpad after `content` is dead weight — the model already committed. A build-time test pins `_scratchpad` as key 0 of the JSON schema.

## Forward-phrased rule

The natural "required when `risk_level` is medium or high" can't work — `_scratchpad` generates before `risk_level` exists. Rule is instead phrased as intent: "required for any request that modifies, deletes, or destroys state." Post-parse retry is the safety net.

## Cross-round handling

Stripped from prior-round echoes via `projectResponseForEcho` (see [[multi-step]]) — each round plans fresh, replaying stale plans encourages anchoring. Preserved in in-round retries (probe-risk, scratchpad-required) so the model sees what it just wrote.

## High-risk retry

After parse: `type === "command" && risk_level === "high" && _scratchpad == null` → one in-round retry with `scratchpadRequiredInstruction`. Does not consume a `maxRounds` slot.

- **High only, not medium.** Medium covers mundane changes (`mkdir`, `git add`). High is destructive/irreversible — where visible reasoning matters.
- **Accept still-null.** Retry-storming worse than a rare log gap. Confirm dialog is the final safety layer.
- **Narrow instruction.** Re-emit same response with scratchpad filled. Don't encourage rewriting the command.

## Always on

No per-provider toggle. Reasoning models produce a brief restatement in `_scratchpad` — wasted but harmless. Not worth config complexity to save ~$0.015/call.

## Decisions

- **`_scratchpad` name.** Underscore = internal. `_thinking`/`_reasoning` collide with extended-thinking terminology. `_plan` too narrow.
- **`.nullable().optional()`.** Trivial requests skip it. `.nullable()` needed for OpenAI strict mode.
- **Soft length cap only.** "1–3 sentences" in the field comment. Hard `.max(N)` would trigger validation retries.
- **No eval assertions.** Locking the optimizer into reasoning shapes prematurely constrains it.
