---
name: continuation
description: `-c` / `--continue` flag — resume the previous wrap conversation in a new invocation
Source: src/main.ts, src/logging/lookup.ts, src/session/session.ts, src/tui/continuation-badge.ts
Last-synced: 04c5a3f
---

# Continuation

[[follow-up]] refines a command from inside one dialog. Continuation resumes the conversation *across* invocations — process exited, terminal scrolled, user thought of something else. Chains arbitrarily deep.

Lookup is PPID-scoped with a global newest fallback. All outcomes are continuable — even an errored or cancelled run is useful context for `w -c try again`.

## Refusal

Refuses if the **immediate parent**'s `attached_input` is set — the temp file is OS-cleaned and the preview alone isn't a faithful replay. Ancestors deeper in the chain aren't re-checked; the chain already absorbed any prior pipe via earlier successful continuations. Failure happens BEFORE stdin materialization or composer entry so we don't pay for setup we're about to discard. One prefix: `Continue error:`.

## Replay model

Walks the `parent_id` chain to assemble ancestor turns, then projects through the same `buildPromptInput` the rest of the loop uses — no separate "replay path." Storage is O(D), not O(D²): the seeded ancestor prefix is sliced off before persistence, so each entry stores only its own new turns. The chain lives only in memory.

Memory, cwd discovery, provider, and the prompt scaffold are loaded fresh. The chain is the conversation; everything else is the environment.

Metadata turns (`final`, `cwd_change`) project to user-role messages wrapped in `<wrap-note>` fences. A short system-prompt sentence tells the LLM the convention. User-role because mid-conversation system messages aren't portable across providers.

## Decisions

- **Chain walk on replay, not snapshot.** O(D) storage. Truncation by a missing parent reduces the chain but doesn't break replay.
- **PPID, not TTY.** PTY paths recycle; shell PIDs are durable across detach/reattach.
- **Fresh memory + provider + scaffold.** Continuation inherits *conversation*, not environment. `--model` swaps mid-chain are intentional.
- **Round budget resets per `-c`.** Same as [[follow-up]] — each user push gets a fresh budget.
- **New attached input on child is allowed.** Parent had no pipe → child piping is a normal invocation that happens to inherit the chain.
- **Continuation badge stays mounted throughout the invocation.** Visible reminder that the answer being built isn't from a blank slate.
