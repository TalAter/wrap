# Continuation (`-c` / `--continue`)

> **Status:** Implemented.
>
> Resume the previous wrap conversation in a new invocation. `wrap how do I deploy this` → answer → `wrap -c ok do it` runs as if it were one continuous chat. Chains arbitrarily deep.

---

## Motivation

[[follow-up]] handles refinement *inside* a dialog. Continuation handles refinement *across* invocations — process exited, terminal scrolled, user thought of something else, wants to keep going without re-typing all the prior context.

Real flows from the design conversation:

- `w how do I run claude code with full perms yolo` → answer → `w -c run it`
- `w can you use crt.sh to find out ollama.com` → answer → `w -c narrow that down to just blog.ollama.com`
- `w create container and install rustup in it` → execution → `w -c sh into that container` → execution → `w -c kill that container`

---

## Flag

`-c` / `--continue` is a boolean modifier flag. Stripped from argv pre-dispatch alongside `--model`, `--verbose`. Per-invocation only — not persisted. Always means "the most recent continuable parent" per the lookup rule.

## Data model

`LogEntry.turns[]` is both the runtime transcript and the durable log — one shape, two consumers (the JSONL writer and the LLM projector). Continuation walks the `parent_id` chain to assemble ancestor `turns[]` and projects through the same `buildPromptInput` the rest of the loop uses.

Continuation reads:

- **`ppid`** — `process.ppid` at session start. Drives the lookup rule.
- **`parent_id`** — the continuation parent's `id`. Absent outside the continuation path.
- **`turns`** — `user | assistant | step | final | cwd_change`. `user` turns store bare prompt text; framing (context + `sectionUserRequest`) is applied at projection time via `AttemptDirectives.requestFraming`. `final` turns mark session end with `source: model | user_override | cancelled | blocked | exhausted | error`; pure-answer sessions skip the `final` turn (the assistant turn carries the answer). `cwd_change` turns appear only in assembled continuation chains, never in stored entries.

## Lookup rule

**First** match wins:

1. Newest entry whose `ppid` equals `process.ppid` AND `process.ppid !== 1`. ("Same shell session." `ppid === 1` means orphaned/launchd-reparented — falls through.)
2. Otherwise, the newest entry overall. ("Whatever you last did, anywhere.")

**PPID, not TTY.** PTY device paths recycle (close/reopen Terminal can land on the same `/dev/ttysNNN`). The shell process's PID is durable across detach/reattach (tmux, screen) and only changes on a new shell or `exec zsh` (rare in interactive use). The false-match cost of TTY recycling is large; the privacy cost of cross-session leakage via PPID match is small.

All `outcome` values are continuable: `success | error | blocked | cancelled | max_rounds`. Even an errored or cancelled run is meaningful context for `w -c try again with pnpm instead`.

JSON.parse failures on individual log lines are swallowed per [[logging]]'s "logging never crashes" principle.

**Race: `-c` while parent is still running.** The parent's log entry isn't appended until the parent's `main()` finalizes. A `-c` fired while the parent still runs picks the entry *before* the parent. Acceptable — interactively rare, and "the previous one" is the closest correct answer.

## Refusal

Refuse continuation if the **immediate parent**'s `LogEntry.attached_input` is set. The temp file is gone (per-invocation tmpdir, OS-cleaned), and the preview alone isn't a faithful replay of what was piped in. Forcing the user to re-pipe is honest. Ancestors deeper in the chain are not re-checked — the chain has already absorbed any prior pipe via earlier successful continuations.

NEW attached input on the child (parent had none) is fine — flows in as normal context for this invocation alongside the loaded chain.

Errors surface via the top-level `try/catch` in `main()`. Failure happens BEFORE stdin materialization, ensure-config, or composer entry so we don't pay for setup we're about to discard:

- Empty log / no match: `Continue error: no previous wrap run found.`
- Parent had attached input: `Continue error: previous run had piped input that's no longer available.`

## Replay model

Continuation does NOT re-send the parent's literal provider-message history. It walks the `parent_id` chain to assemble ancestor turns, then projects via the same function used in single-invocation flow.

The session:
1. Seeds `entry.turns` with the assembled ancestor chain (root first, parent last).
2. If the parent's cwd differs from the current cwd, pushes a `cwd_change` turn at the tail of the seed.
3. Pushes the new bare `user` turn onto the seeded transcript.
4. Builds a fresh `PromptScaffold` + `requestFraming` from current memory, cwd discovery, provider, and optimized prompt. The directive wraps the first user turn (the chain root's original prompt) with the child's current `contextString`.
5. Runs the loop normally. Round budget resets to `maxRounds`.

**Storage is O(D), not O(D²).** Just before persistence, the session slices off the seeded ancestor prefix so the child's stored `turns[]` contains only its own new turns. The assembled chain lives only in memory; the JSONL accumulates one invocation's turns per entry.

Memory is loaded fresh for the *current* cwd (via `ensureMemory`), not the parent's memory snapshot. Memory mutations the parent made are already on disk. Provider is current. Prompt scaffold is current. The CHAIN is what's loaded, not snapshot.

Switching `--model` between invocations is supported and intentional: `wrap --model anthropic:sonnet deploy this` → error → `wrap -c --model anthropic:opus didn't work, try again` is a valid flow. The fresh scaffold pulls the *current* provider's optimized prompt, so few-shot demos may differ from the parent's. Acceptable; the assistant-turn projection already strips schema-version-sensitive fields.

A `parent_id` that references a missing entry truncates the chain — replay proceeds on whatever survived.

## LLM-visible projection of turns

Provider messages are user/assistant only — Anthropic has no mid-conversation system role, and using OpenAI's mid-conversation system messages would be provider-specific. Each Turn projects to one or more `ConversationMessage`s:

| Turn kind | Projected to | Notes |
|---|---|---|
| `user` (first) | `{ role: "user", content: requestFraming.contextString + sep + requestFraming.sectionUserRequest + "\n" + turn.text }` | Framing applied only to the first user turn encountered |
| `user` (subsequent) | `{ role: "user", content: turn.text }` | Bare |
| `assistant` | `{ role: "assistant", content: project(turn.response) }` | Same response-projection that strips memory_updates / explanation / etc. |
| `step` | `{ role: "user", content: <captured-output section> }` | The model's command is on the prior assistant turn |
| `final` | `{ role: "user", content: <wrap-note>...</wrap-note> }` | Session-metadata |
| `cwd_change` | `{ role: "user", content: <wrap-note>...</wrap-note> }` | Session-metadata |

Metadata turns (`final`, `cwd_change`) use `<wrap-note>` XML-style fences. The fences make multi-line bodies (e.g. heredocs in `user_override` commands) unambiguous. A short system-prompt sentence tells the LLM the convention.

`final`-turn body text per `source`:

- `model` — `previous command exited <exit_code>`
- `user_override` — `user ran the following instead of the proposal; exited <exit_code>:\n<command>`
- `cancelled` — `user cancelled the previous command: <command>`
- `blocked` — `previous command was blocked`
- `exhausted` (with last proposal) — `previous run hit the round budget without completing or executing the proposed command; last proposal was: <command>`
- `exhausted` (no proposal) — `previous run hit the round budget without completing`
- `error` — `previous run ended in an error before completing`

## UX

### Continuation badge

A single-line `↳ Continuing: <parent prompt>` badge renders above the composer input and at the top of the dialog body throughout a `-c` invocation. Pre-render normalization:

1. Collapse runs of whitespace (including embedded newlines from TUI-mode parents) to a single space.
2. Trim to `max(20, columns - "↳ Continuing: ".length - 1)` chars with a single-char Unicode ellipsis if needed. The `-1` is a right-edge gutter against terminals that hide the last column.
3. Suppress when the terminal is narrower than 20 cols, or the prompt is blank.

Empty `-c` on a TTY opens the interactive composer with the badge. Empty `-c` with no TTY and no pipe → same `--help` short-circuit as today, but lookup-failure errors take precedence (the lookup runs before the `--help` short-circuit).

## Decisions

- **Chain walk on replay, not snapshot.** Each entry stores only its own invocation's turns. O(D) storage instead of O(D²). Truncation by a missing parent reduces the chain but doesn't break replay.
- **Fresh memory + cwd discovery + provider.** Continuation inherits *conversation*, not environment. Memory mutations from parent already on disk.
- **Round budget resets per `-c`.** Matches [[follow-up]] semantics — each user push gets a fresh budget.
- **Allow new attached input on child.** Parent had no pipe → child piping is a normal invocation that happens to inherit chain.
- **One metadata turn → one user-role message.** Mid-conversation system-role messages aren't portable across providers (Anthropic has top-level system only).

## Acceptance scenarios (regression checklist)

End-to-end behaviors verified by the test suite:

1. **Basic chain (3-deep):** Storage stays O(D); each entry persists only its own turns; `parent_id` walks the chain.
2. **Per-PPID scope:** Two terminals open. Term-A run, Term-B run. Back to Term-A: `w -c …` continues Term-A's run, not Term-B's. (Unit-tested at the lookup layer; cross-process PPID isolation can't be simulated from inside one test process.)
3. **Global fallback:** From a fresh shell (no matching PPID), `w -c …` continues the globally newest entry.
4. **CWD change:** `cd /a; w how to deploy; cd /b; w -c do it` — third invocation's assembled chain starts with a `cwd_change` turn before the new `user` turn.
5. **User-override final turn:** Edited command runs → next `-c` sees a `final` turn with `source: "user_override"` and the user's edited bytes in the assembled chain.
6. **Refusal: parent had pipe:** `cat foo | w explain this` → `w -c more` → exits 1 with `Continue error: previous run had piped input that's no longer available.`
7. **Refusal: empty log:** Fresh install, `w -c hi` → exits 1 with `Continue error: no previous wrap run found.`
8. **Empty `-c` on TTY:** `w -c` opens the composer with the `↳ Continuing: <parent prompt>` badge.
9. **`--model` swap mid-chain:** Second invocation runs against the new model with the first's chain assembled.
10. **Cancelled parent:** Next `-c` sees a `final` turn with `source: "cancelled"`.
11. **Truncated chain (missing parent):** Chain entry references a `parent_id` that's been hand-deleted. Replay proceeds with the partial chain; no crash.
