# Piped Input

> Architecture for detecting, reading, truncating, and threading piped stdin through Wrap's query pipeline.

> **Status:** Implemented. See deferred items at bottom.

---

## Motivation

Wrap's core value prop is staying in the terminal. Piped input extends this to data already in the terminal — logs, diffs, file contents, command output. Instead of copying output, switching to a browser, and pasting into an LLM, the user pipes directly:

```bash
cat error.log | w what does this error mean
git diff | w summarize these changes
ls -la | w which is the largest file
```

Piped input also enables a power feature: Wrap can process arbitrarily large files by truncating what the LLM sees while re-piping the full content to generated commands. The LLM uses Unix tools to surgically extract what it needs.

---

## Detection

Check `!process.stdin.isTTY` — covers `undefined` (piped) and `false`. No distinction between pipe, file redirect, or heredoc.

**Empty pipes:** Empty or whitespace-only content → treated as no piped input. No `## Piped input` section, no `pipe_stdin`.

**No timeout.** `Bun.stdin.text()` reads until EOF. If the left side never closes (`tail -f | w`), Wrap hangs — standard Unix behavior.

---

## Reading & Buffering

`await Bun.stdin.text()` reads full content into a string. No cap — trust the user.

**Binary content:** No detection or rejection. `Bun.stdin.text()` decodes UTF-8, replacing invalid bytes with U+FFFD. Binary content re-piped via `pipe_stdin` may not match original bytes.

---

## Truncation

When piped input exceeds `maxPipedInputChars` (configurable, default 200,000 chars), Wrap truncates what the LLM sees but keeps the full buffer for re-piping. The LLM sees:

```
## Piped input (truncated — showing first 200000 of 12000000 chars)

[first ~200KB of content]
```

**Silent truncation.** No stderr message. The LLM knows; the user doesn't need to.

### Line-aware truncation

Both piped input and probe output truncation will use a shared `truncateToLine(text, maxChars)` utility that cuts at the last newline before the limit. Falls back to hard cut for single-line content. Lives in `src/core/truncate.ts`. **Not yet implemented** — current code uses naive `slice()`.

### Config

```jsonc
{
  "maxPipedInputChars": 200000  // ~200KB. Same unit as maxProbeOutputChars.
}
```

---

## Prompt Assembly

Piped input is the **first section** in the final user message (before memory facts, CWD, user's request). When no CLI args are present, `## User's request` is omitted.

The piped input system prompt instruction (`pipedInputInstruction` in `prompt.constants.json`) is only included when piped input is present — no wasted tokens otherwise. It explains `pipe_stdin` semantics to the LLM.

---

## Response Schema: `pipe_stdin`

Top-level optional boolean on `CommandResponse`. When `true`, Wrap feeds the full piped buffer to the spawned command's stdin via `new Blob([pipedInput])`. Present on all response types; only meaningful for `command` and `probe`.

No special safety treatment — `risk_level` already covers command danger.

**Naming:** `pipe_stdin` (snake_case) in LLM schema/logs. `pipedInput` (camelCase) in TypeScript internals.

---

## Command Execution

When `pipe_stdin: true` and piped input present: `stdin: new Blob([pipedInput])`. Otherwise: `stdin: "inherit"` (commands) or `undefined` (probes).

**Consumed stdin:** After Wrap reads piped input, stdin is at EOF. Child processes inheriting stdin get an empty pipe, not a TTY. Standard Unix behavior.

---

## Execution Flow

```
parseArgs(argv)
       |
       +-- flag? --> dispatch subcommand (exit). Skip stdin read entirely.
       |
       +-- readPipedInput()  --> reads stdin if piped, returns string | undefined
       |
       +-- no args + no pipe? --> dispatch --help (exit)
       |
       +-- no args + pipe? --> pipedInput becomes the prompt (empty string)
       |
       +-- loadConfig() → initProvider() → ensureMemory() → resolvePath()
       |
       +-- runQuery({ prompt, provider, memory, cwd, pipedInput })
```

Flag dispatch runs **before** `readPipedInput()` so `--help`/`--version` don't waste time reading stdin. `parseInput` only looks at `process.argv` — piped content is never parsed as flags.

---

## Logging

`piped_input` field truncated to 1,000 chars with `\n[…truncated, N chars total]` note. Omitted when no piped input.

---

## Interaction with Unimplemented Features

### Probes

Probe + `pipe_stdin` works now — the buffer persists across rounds. The LLM can use probes to surgically extract from large piped content.

### Threads

Deferred. When threads land, decide whether to store piped content in the thread.

### Dialog

Piped input claims stdin, so the dialog must read from `/dev/tty`. For now, medium/high-risk commands are refused regardless.

### Answer formatting

Piped input doesn't affect formatting. Markdown vs plain depends on **stdout** TTY status, not stdin.

### Mode interaction

Works with all modes. Force-answer (`w?`): `pipe_stdin` ignored. Force-command (`w!`): LLM can use `pipe_stdin: true`. Yolo: auto-executes as usual.

---

## Deferred

- `--full` flag — send complete piped content to LLM without truncation
- Temp-file buffering for very large inputs (avoid multi-GB strings in memory)
- `Bun.stdin.bytes()` for binary-safe re-piping (current `text()` corrupts non-UTF-8)
- `truncateToLine()` shared utility — replace naive `slice()` in all truncation sites
