# Piped Input

> How Wrap detects, reads, threads, and re-pipes stdin content through a query.

> **Status:** Implemented. Deferred items at bottom.

---

## Motivation

Wrap's value is staying in the terminal. Piped input extends that to data already there — logs, diffs, file contents, command output:

```bash
cat error.log | w what does this error mean
git diff | w summarize these changes
```

It also unlocks a power feature: Wrap can handle arbitrarily large inputs by showing the LLM a truncated view while keeping the full buffer available to re-pipe into whatever command the LLM generates. The LLM uses Unix tools to surgically extract what it needs.

---

## Detection & reading

- **Detect:** `!process.stdin.isTTY` (covers both `undefined` and `false`).
- **Read:** `await Bun.stdin.text()` — full content into memory, no cap, no timeout. If the producer never closes (`tail -f | w`), Wrap hangs. Standard Unix.
- **Empty / whitespace-only:** treated as no piped input. No `## Piped input` section added; `pipe_stdin` becomes meaningless.
- **Binary:** not detected or rejected. `text()` decodes UTF-8 and replaces invalid bytes with U+FFFD, so re-piped binary may not match original bytes. See Deferred.

---

## Flow & ordering

```
parseArgs → flag? → dispatch (exit, no stdin read)
          → readPipedInput()
          → no args + no pipe → --help (exit)
          → no args + pipe    → empty user prompt
          → config/provider/memory/cwd
          → runSession({ prompt, pipedInput, … })
```

**Flags dispatch before reading stdin** so `--help` / `--version` never block on a pipe. `parseArgs` only looks at `process.argv`; piped bytes are never parsed as flags.

---

## Prompt assembly

Piped input is the **first section** of the final user message, before memory facts, CWD, and the user's request. When no CLI args are present, the `## User's request` section is omitted entirely.

The `pipedInputInstruction` system-prompt block (from `prompt.constants.json`) is injected **only when piped input is present** — no wasted tokens otherwise. It teaches the LLM what `pipe_stdin` means.

---

## Truncation

When piped input exceeds `maxPipedInputChars` (default 200,000, same unit as `maxCapturedOutputChars`), the LLM sees a truncated view while Wrap keeps the full buffer for re-piping:

```
## Piped input (truncated — showing first 200000 of 12000000 chars)
[first ~200KB]
```

**Silent.** No stderr notice — the LLM knows, and the user doesn't need to.

Current implementation uses a naive `slice()`. A shared line-aware utility is deferred (see below).

---

## Re-piping: `pipe_stdin`

Top-level optional boolean on `CommandResponse`. When `true` and piped input exists, Wrap spawns the command with `stdin: new Blob([pipedInput])`. Otherwise: `stdin: "inherit"` for commands, `undefined` for probes.

- Present on all response types; only meaningful for `command` and `probe`.
- No special safety treatment — `risk_level` already covers danger.
- **Naming invariant:** `pipe_stdin` (snake_case) in the LLM schema and logs; `pipedInput` (camelCase) in TS internals.
- **Consumed stdin:** after Wrap reads to EOF, child processes that inherit stdin get an empty pipe, not a TTY. Standard Unix behavior.

---

## Invariants & edge cases

- **Chrome rule holds:** piped input never writes to stdout. Only the executed command's stdout (or answer text) does.
- **Answer formatting is stdout-driven**, not stdin-driven: markdown vs plain depends on `process.stdout.isTTY`.
- **Modes:** all modes work. Force-answer (`w?`) ignores `pipe_stdin`. Force-command (`w!`) can set it. Yolo auto-executes as usual.
- **Dialog:** piped input claims stdin, so any dialog must read from `/dev/tty`. Currently medium/high-risk commands are refused when stdin is piped <!-- FLAG: verify this refusal still matches current dialog behavior now that the router owns the dialog -->.
- **Probes + pipe_stdin:** supported. The buffer persists across rounds so the LLM can probe repeatedly against the same content.
- **Threads:** not yet implemented. Open question: store piped content in the thread or not?
- **Logging:** the `piped_input` log field is truncated to 1,000 chars with a `\n[…truncated, N chars total]` note, omitted when absent.

---

## Config

```jsonc
{
  "maxPipedInputChars": 200000  // ~200KB, same unit as maxCapturedOutputChars
}
```

---

## Deferred

- `--full` flag to bypass LLM-side truncation.
- Temp-file buffering for multi-GB inputs (avoid holding huge strings in memory).
- `Bun.stdin.bytes()` for binary-safe re-piping.
- Shared `truncateToLine(text, maxChars)` utility (`src/core/truncate.ts`) cutting at the last newline before the limit, used by both piped-input and probe-output truncation. Falls back to a hard cut for single-line content.
