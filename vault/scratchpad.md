---
name: scratchpad
description: Forced pre-commit planning slot in the LLM response schema — first position, visible in logs/verbose
Source: src/command-response.schema.ts, src/core/round.ts
Last-synced: 0a22f2a
---

# Scratchpad

Optional planning field at position 0 of the response schema. Forced before `type`, `content`, and `risk_level` so non-reasoning models think before committing.

Visible in `--log` and `--verbose`. Never shown to the user.

## Why

Without it, two failure modes recurred:

1. Model writes an overengineered command, then critiques itself in `explanation` — but explanation is user-facing and generated after the command. Too late.
2. Logs show what the model picked, not why. Debugging wrong responses needs guessing.

Non-reasoning models don't get extended-thinking blocks. A first-position scratchpad gives them a chain-of-thought slot through the schema.

## First position is the point

Structured output generates token-by-token in JSON-key order. A scratchpad after `content` is dead weight — the model already committed. A build-time test pins it as key 0.

## Forward-phrased rule

The natural "required when risk is medium/high" can't work — the scratchpad generates before risk exists. The rule is phrased as intent: "required for any request that modifies, deletes, or destroys state." Post-parse retry is the safety net.

## Cross-round

Stripped from prior-round echoes (see [[multi-step]]) — replaying stale plans encourages anchoring. Preserved across in-round retries so the model sees what it just wrote.

## High-risk retry

If a high-risk command parses with no scratchpad, one in-round retry asks for the same response with the scratchpad filled. Doesn't consume a round budget slot.

- **High only, not medium.** Medium covers mundane changes. High is destructive — where visible reasoning matters.
- **Accept still-null on retry.** Retry-storming worse than a rare log gap. Confirm dialog is the final safety layer.
- **Narrow instruction.** Re-emit, don't rewrite the command.

## Always on

No per-provider toggle. Reasoning models produce a brief restatement — wasted but harmless. Not worth config complexity.

## Decisions

- **Underscore name.** Marks it internal. `_thinking`/`_reasoning` collide with extended-thinking terminology. `_plan` too narrow.
- **Optional, nullable.** Trivial requests skip it; nullable is needed for OpenAI strict mode.
- **Soft length cap only.** Hint in the field comment; a hard cap would trigger validation retries.
- **No eval assertions.** Locking the optimizer into reasoning shapes prematurely constrains it.
