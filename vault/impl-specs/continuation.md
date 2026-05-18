# Continuation (`-c` / `--continue`)

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

- `-c` / `--continue`. Modifier flag (strips from argv pre-dispatch like `--model`, `--verbose`).
- Boolean. No id-targeting, no N-back. Always means "the most recent continuable parent" per the lookup rule below.
- Registered in `SETTINGS` (`src/config/settings.ts`) as `{ type: "boolean", flag: ["-c", "--continue"], default: false, description: "..." }`. The existing modifier-registry derivation in `src/subcommands/registry.ts` picks it up automatically. Read at runtime via `getConfig().continue`. Per-invocation only — not persisted to `config.jsonc`. See [[subcommands]] and [[config]].

## Data model (what continuation reads and writes)

`LogEntry.turns[]` is the runtime transcript and the durable log — one shape, two consumers (the JSONL writer and the LLM projector). Continuation walks the `parent_id` chain to assemble ancestor `turns[]` and projects through the same `buildPromptInput` the rest of the loop uses.

The relevant fields:

- **`ppid`** — `process.ppid` at session start. Used by the lookup rule below.
- **`parent_id`** — the continuation parent's `id`. Absent outside the continuation path.
- **`turns`** — `user | assistant | step | final | cwd_change`. `user` turns store bare prompt text; framing (context + `sectionUserRequest`) is applied at projection time via `AttemptDirectives.requestFraming`. `final` turns mark session end with `source: model | user_override | cancelled | blocked | exhausted | error`; pure-answer sessions skip the `final` turn (the assistant turn carries the answer). `cwd_change` turns appear only in continuation chains.

## Lookup: which parent to continue

Implemented as `findContinuationParent(wrapHome: string, ppid: number): LogEntry | null` in a new `src/logging/lookup.ts`. Reads the JSONL backward. No sidecar load — the parent's turns live directly on the entry. If the JSONL file does not exist (fresh install), returns `null` (test this).

JSON.parse failures on log lines are swallowed line-by-line per [[logging]]'s "logging never crashes" principle.

Use a subagent to see where else we are doing reads and searches (eg `--log`). Consider if it makes sense to refactor this into a log read/search/etc function.

No backwards compatibility with old logs. **First** match wins:

1. Entry whose `ppid` equals current `process.ppid` AND `process.ppid !== 1`. ("Same shell session." `ppid === 1` means orphaned/launchd-reparented — falls through to rule 2.)
2. Otherwise, the newest entry overall. ("Whatever you last did, anywhere.")

PPID, not TTY. PTY device paths recycle (close/reopen Terminal can land on the same `/dev/ttysNNN`). The shell process's PID is durable across detach/reattach (tmux, screen) and only changes on a new shell or `exec zsh` (rare in interactive use). The vulnerability cost is small; the false-match cost of TTY recycling is large.

All `outcome` values are continuable: `success | error | blocked | cancelled | max_rounds`. Even an errored or cancelled run is meaningful context for `w -c try again with pnpm instead`.

**Lookup runs early in `main.ts`** — after argv parsing and before stdin materialization, ensure-config, or composer entry. Failure exits 1 immediately:

- Empty log / no match: `Continue error: no previous wrap run found.`
- Parent had attached input (see Refusal): `Continue error: previous run had piped input that's no longer available.`

Errors are thrown as `new Error("Continue error: ...")` from `main.ts` and surface via the existing top-level `try/catch` in `main()`.

**Race: `-c` while parent is still running.** The parent's log entry isn't appended until the parent's `main()` finalizes. A `-c` fired while the parent still runs will pick the entry *before* the parent. Acceptable — interactively rare, and "the previous one" is the closest correct answer.

## Refusal

Refuse continuation if the **immediate parent**'s `LogEntry.attached_input` is set. (Ancestors deeper in the chain are not re-checked — the chain has already absorbed any prior pipe via earlier successful continuations.) The temp file is gone (per-invocation tmpdir, OS-cleaned), and the preview alone isn't a faithful replay of what was piped in. Forcing the user to re-pipe is honest.

NEW attached input on the child (parent had none) is fine — flows in as normal context for this invocation alongside the loaded chain.

## Replay model

Continuation does NOT re-send the parent's literal provider-message history. It walks the `parent_id` chain to assemble ancestor turns, then projects via the same function used in single-invocation flow.

Concretely, on a `-c` invocation in `main.ts`:

1. Lookup parent via `findContinuationParent(wrapHome, process.ppid)`. If null → throw `Continue error: no previous wrap run found.`
2. Refuse if parent's `attached_input` is set → throw `Continue error: previous run had piped input that's no longer available.`
3. **Walk the chain.** Starting from parent, follow `parent_id` recursively to the chain root, collecting entries. Concat all entries' `turns[]` arrays in chronological order (root first, parent last). O(D) JSONL lookups for chain depth D — each lookup is a backward scan for a specific `id`. If a `parent_id` references a missing entry, treat as chain root (the chain is truncated; replay still works on whatever survived).
4. If parent's `cwd !== process.cwd()`, push a `cwd_change` turn onto the assembled array.
5. Pass the assembled `Turn[]` through to `runSession` via `SessionOptions.continuationParent?: { parentId: string; assembledTurns: Turn[]; parentPrompt: string }`.
6. `runSession` detects `continuationParent`: skips its normal first-user-turn push, seeds `entry.turns = [...continuationParent.assembledTurns]`, then pushes the new bare `{ kind: "user", text: prompt }` (the user's `-c` text). Round budget resets to `maxRounds`.
7. The session builds a fresh `PromptScaffold` + `requestFraming` directive from current memory, current cwd discovery, current provider, current optimized prompt. The directive wraps the first user turn (the chain root's original prompt) with the child's current `contextString`.
8. Run the loop normally. Runner appends `assistant`, `step`, `final` turns directly onto `entry.turns`. At exit, the session writes the entry to JSONL with `parent_id = continuationParent.parentId`, `ppid = process.ppid`. **The new entry's `turns[]` contains only this invocation's new turns** — no ancestor copy. Storage is O(D) total across the chain, not O(D²).

Memory is loaded fresh for the *current* cwd (via `ensureMemory`), not the parent's memory snapshot. Memory mutations the parent made are already on disk. Provider is current. Prompt scaffold is current. The CHAIN is what's loaded, not snapshot.

Switching `--model` between invocations is supported and intentional: `wrap --model anthropic:sonnet deploy this` → error → `wrap -c --model anthropic:opus didn't work, try again` is a valid flow. The fresh scaffold pulls the *current* provider's optimized prompt, so few-shot demos may differ from the parent's. Acceptable; the assistant-turn projection already strips schema-version-sensitive fields.

## LLM-visible projection of turns

Provider messages are user/assistant only — Anthropic has no mid-conversation system role, and using OpenAI's mid-conversation system messages would be provider-specific. The projection function maps each Turn kind to one or more `ConversationMessage`s:

| Turn kind | Projected to | Notes |
|---|---|---|
| `user` (first) | `{ role: "user", content: requestFraming.contextString + sep + requestFraming.sectionUserRequest + "\n" + turn.text }` | Framing applied only to the first user turn encountered |
| `user` (subsequent) | `{ role: "user", content: turn.text }` | Bare |
| `assistant` | `{ role: "assistant", content: project(turn.response) }` | Same response-projection that strips memory_updates / explanation / etc. |
| `step` | `{ role: "user", content: <captured-output section> }` | Same as today's `step` rendering — the model's command is on the prior assistant turn |
| `final` | `{ role: "user", content: <wrap-note>...</wrap-note> }` | Session-metadata; see below |
| `cwd_change` | `{ role: "user", content: <wrap-note>...</wrap-note> }` | Session-metadata; see below |

Metadata turns (`final`, `cwd_change`) use `<wrap-note>` XML-style fences. The fences make multi-line bodies (e.g. heredocs in `user_override` commands) unambiguous, and the system prompt instruction tells the LLM the convention.

One metadata turn → one user-role message; adjacent metadata turns produce adjacent user-role messages. All providers we ship accept consecutive same-role messages.

The system prompt gains one short instruction: "User messages wrapped in `<wrap-note>` tags are session metadata injected by wrap, not user input."

Per [`.claude/skills/editing-prompts.md`](../../.claude/skills/editing-prompts.md): the new instruction must be added to the Python source-of-truth AND the TS runtime mirror, otherwise the next `bun run optimize` drops it.

Examples (`final` turn):

```
<wrap-note>
previous command exited 0
</wrap-note>
```

```
<wrap-note>
user ran the following instead of the proposal; exited 0:
cat <<EOF > foo.txt
hello
EOF
</wrap-note>
```

```
<wrap-note>
user cancelled the previous command: git push heroku main
</wrap-note>
```

```
<wrap-note>
previous command was blocked
</wrap-note>
```

```
<wrap-note>
previous run hit the round budget without completing or executing the proposed command; last proposal was: git push heroku main
</wrap-note>
```

```
<wrap-note>
previous run ended in an error before completing
</wrap-note>
```

`cwd_change`:

```
<wrap-note>
cwd changed from /Users/tal/proj-a to /Users/tal/proj-b
</wrap-note>
```

## UX

### Empty `-c` on a TTY

Open the interactive composer (existing flow per [[interactive-mode]]) with a single-line continuation badge above the input field showing the parent's prompt:

```
↳ Continuing: how do I deploy this project
> _
```

The parent prompt comes from the parent entry's first user turn text (`parent.turns.find(t => t.kind === "user")?.text`). Pre-render normalization:

1. Collapse internal newlines to a single space (TUI-mode parents may have multi-line prompts).
2. Trim to `max(20, (process.stdout.columns ?? 80) - len("↳ Continuing: ") - 1)` chars; append `…` (single-char Unicode ellipsis) if truncated.
3. If terminal width < 20 cols total, omit the badge entirely.

Empty `-c` with no TTY and no pipe → same `--help` short-circuit as today, but lookup-failure errors take precedence (see Lookup section).

### Processing dialog header

While the LLM call runs, show a single-line header above the spinner:

```
↳ Continuing: how do I deploy this project
  thinking…
```

Same normalization rules as the composer badge. Not shown when not a continuation.

### Refusal messages

All under the `Continue error:` prefix per [[architecture]]'s plain-language rule.

## Logging

No custom rendering. New `ppid` / `parent_id` fields appear in JSON output automatically.

## Decisions

- **Chain walk on replay, not snapshot.** Each entry stores only its own invocation's turns. O(D) storage instead of O(D²). Truncation by a missing parent reduces the chain but doesn't break replay.
- **Fresh memory + cwd discovery + provider.** Continuation inherits *conversation*, not environment. Memory mutations from parent already on disk.
- **Round budget resets per `-c`.** Matches [[follow-up]] semantics — each user push gets a fresh budget.
- **Allow new attached input on child.** Parent had no pipe → child piping is a normal invocation that happens to inherit chain.
- **One metadata turn → one user-role message.** Mid-conversation system-role messages aren't portable across providers (Anthropic has top-level system only).

## Acceptance scenarios

End-to-end behaviors that must work after implementation:

1. **Basic chain (3-deep, answer mode):** `w how do I deploy this` (answer) → `w -c ok do it` (command) → `w -c what about staging` (command). Third invocation's chain walk assembles all turns from all three entries; third entry's stored `turns[]` carries only its own.
2. **Per-PPID scope:** Two terminals open. Term-A run, Term-B run. Back to Term-A: `w -c ...` continues Term-A's run, not Term-B's.
3. **Global fallback:** `w -c ...` from a fresh shell (no matching PPID) continues the globally newest entry.
4. **CWD change:** `cd /a; w how to deploy; cd /b; w -c do it` — third invocation's assembled chain starts with a `cwd_change` turn before the new `user` turn.
5. **User-override final turn:** `w how to push` → user edits the proposed command in the dialog and runs it → `w -c what next` — second invocation sees a `final` turn with `source: "user_override"` and the user's edited bytes in the assembled chain.
6. **Refusal: parent had pipe:** `cat foo | w explain this` → `w -c more` → exits 1 with `Continue error: previous run had piped input that's no longer available.`
7. **Refusal: empty log:** Fresh install, `w -c hi` → exits 1 with `Continue error: no previous wrap run found.`
8. **Empty `-c` on TTY:** `w -c` (no text) opens the composer with the `↳ Continuing: <parent prompt>` badge.
9. **`--model` swap mid-chain:** `w --model anthropic:sonnet how to push` → `w -c --model anthropic:opus do it` — second invocation runs against the second model with the first's chain assembled.
10. **Cancelled parent:** `w deploy this` → user cancels in dialog → `w -c what went wrong` — second invocation sees a `final` turn with `source: "cancelled"`.
11. **Truncated chain (missing parent):** Chain entry references a `parent_id` that's been hand-deleted. Replay proceeds with the partial chain; no crash.
