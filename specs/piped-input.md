# Piped Input

> Architecture for detecting, reading, truncating, and threading piped stdin through Wrap's query pipeline.

> **Status:** Not implemented

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

Check `process.stdin.isTTY`. When stdin is a TTY (interactive terminal), the value is `true`. When stdin is piped, redirected from a file, or from a heredoc, the value is `undefined`. The check is `!process.stdin.isTTY` — covers both `undefined` and `false`. No need to distinguish pipe from file redirect from heredoc; all mean "non-interactive data on stdin."

**Empty pipes:** If the buffered content is empty or whitespace-only after reading, treat it as if stdin was not piped. No `## Piped input` section, no `pipe_stdin` field. Avoids confusing the LLM with an empty section.

**No timeout.** `await Bun.stdin.text()` reads until EOF, same as `cat`. If the left side of the pipe never closes (`tail -f | w`), Wrap hangs — standard Unix behavior. Users learn to use `tail -100 app.log | w` instead. Every tool that reads stdin has this property.

---

## Reading & Buffering

Read the full piped content into a string in memory: `await Bun.stdin.text()`. No cap — trust the user. If they pipe 500MB and run out of memory, that's on them.

**Future optimization:** For very large inputs, write to a temp file and re-pipe from disk instead of holding the full content in memory. This is deferred — string-in-memory covers the vast majority of real use cases.

**Binary content:** No detection or rejection. Send whatever the user piped. The LLM will likely produce garbage for binary input, but the user isn't blocked. Test with various file types post-implementation and consider adding a guardrail if real problems emerge.

**Note on encoding:** `Bun.stdin.text()` decodes as UTF-8, replacing invalid byte sequences with U+FFFD. This means binary content re-piped via `pipe_stdin` may not match the original bytes. A future improvement could use `Bun.stdin.bytes()` to read as `Uint8Array`, preserving raw bytes for re-piping while converting to string only for the LLM preview. Deferred — text-mode covers the vast majority of real use cases (logs, code, diffs, command output).

---

## Truncation

When piped input exceeds `maxPipedTokens` (configurable, default 50,000 tokens estimated at ~4 chars/token = ~200KB), Wrap truncates what it sends to the LLM but keeps the full buffer in memory for re-piping. The check: `pipedInput.length > maxPipedTokens * 4`. When truncating, slice to the first `maxPipedTokens * 4` characters.

**What the LLM sees:**

```
## Piped input (truncated — showing first ~200KB of 12MB total)

[first ~200KB of content]
```

The truncation note tells the LLM the content is incomplete and how large the full input is. The system prompt explains that `pipe_stdin: true` feeds the full content to the command.

**Silent truncation.** No stderr message to the user. The LLM knows it's truncated; the user doesn't need to. The feature "just works."

**No hard ceiling.** Context windows grow, token costs drop, and users with local models may want to send very large inputs. The threshold controls what's sent to the LLM, not what's accepted.

### Config

```jsonc
{
  "maxPipedTokens": 50000  // ~200KB at 4 chars/token. Above this, piped input is truncated before sending to LLM.
}
```

Add to `src/config/config.schema.json` and the config type.

### Future: `--full` flag

A `--full` flag that sends the complete piped content to the LLM without truncation, accepting the token cost. Deferred — truncation + re-piping handles most cases. When demand emerges, add as a flag parsed and stripped before the prompt (e.g., `w --full explain this`).

---

## Prompt Assembly

### Message structure

Piped input is the **first section** in the final user message, before memory facts, CWD, and the user's request. Natural reading order: "here's the document, here's the question about it."

```
## Piped input
[content, possibly truncated]

## System facts
- Default shell is zsh
- OS: macOS 15.4

## Facts about /Users/tal/project
- Uses pnpm

- Working directory (cwd): /Users/tal/project

## User's request
what does this error mean
```

When piped input is present but there are no CLI args, the `## User's request` section is omitted. The piped content is always labeled `## Piped input` regardless of whether CLI args are present — consistent, simple.

**Data flow for "no args + pipe":** `QueryContext.prompt` is set to empty string, `QueryContext.pipedInput` holds the content. `assembleCommandPrompt` skips the `## User's request` section when `prompt` is empty. The LLM sees only the `## Piped input` section and infers intent from its content.

### System prompt

Add a permanent section to the system prompt explaining piped input behavior. Always present (not conditional on whether piped input exists in the current request) — the LLM always knows the feature exists:

```
## Piped input

Piped input serves as:
1. Context for answers — analyze, explain, or summarize it
2. Data for commands — set pipe_stdin to true to feed it to the command's stdin
3. The user's request itself — when no CLI args are provided

When pipe_stdin is true in your response, the full original piped content
(not just the truncated preview) will be fed to the command's stdin.

Content may be truncated for large inputs. If so, a note indicates total
size. Use probe + pipe_stdin to extract specific parts of the full content.
```

---

## Response Schema: `pipe_stdin`

Add a top-level optional boolean to `CommandResponse`:

```typescript
const commandResponseSchema = z.object({
  type: z.enum(["command", "probe", "answer"]),
  content: z.string(),
  risk_level: z.enum(["low", "medium", "high"]),
  explanation: z.string().nullish(),
  pipe_stdin: z.boolean().optional(),  // NEW
  memory_updates: z.array(/* ... */).nullish(),
  memory_updates_message: z.string().nullish(),
});
```

**Semantics:** When `pipe_stdin` is `true`, Wrap feeds the full piped input buffer to the spawned command's stdin. When `false` or absent, the command gets empty stdin.

Present on all response types (top-level optional boolean). Only meaningful for `command` and `probe` — answers ignore it. Simpler schema than a discriminated union.

**No special safety treatment.** `pipe_stdin` doesn't affect risk level. The LLM's `risk_level` assessment already covers the command's danger. Re-piping is just plumbing.

**Naming convention:** `pipe_stdin` (snake_case) in the LLM response schema and log entries matches existing conventions (`risk_level`, `memory_updates`). `pipedInput` (camelCase) in TypeScript internals (`QueryContext`, function parameters) matches TypeScript conventions.

---

## Command Execution

When `pipe_stdin` is `true` and piped input is present:

```typescript
const proc = Bun.spawn([shell, "-c", response.content], {
  stdout: "inherit",
  stderr: "inherit",
  stdin: new Blob([pipedInput]),  // Re-pipe the full buffer
});
```

When `pipe_stdin` is `false`/absent or no piped input:

```typescript
const proc = Bun.spawn([shell, "-c", response.content], {
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",  // Current behavior
});
```

**Note on consumed stdin:** When Wrap reads piped input, stdin is consumed (at EOF). With `stdin: "inherit"`, the child process inherits that empty pipe — not a TTY. Non-interactive commands work fine (they don't read stdin). Interactive commands that need a TTY (`vim`, `top`) will fail — same as piping into any interactive command (`cat file | vim`). This is standard Unix behavior.

**Error retry:** When a command with `pipe_stdin: true` fails and the error-retry flow generates a corrected command that also has `pipe_stdin: true`, re-pipe the buffer again. The buffer is still in memory. Design only — implement when the auto-fix loop lands.

---

## Logging

The `piped_input` field in `LogEntry` is populated when piped input is present. **Aggressively truncate in logs** — store only the first 1,000 characters. If the full content is larger, append `\n[…truncated, 12MB total]`. Logs are for debugging and reproducibility, not for replaying full piped content. The `piped_input` field is omitted entirely when there is no piped input (current behavior).

---

## Execution Flow

Piped input reading happens in `main()`, **before** subcommand dispatch:

```
parseInput(argv)
       |
       +-- readPipedInput()  --> reads stdin if piped, returns string | null
       |
       +-- flag? --> dispatch subcommand (exit). Piped input silently ignored.
       |
       +-- no args + no pipe? --> dispatch --help (exit)
       |
       +-- no args + pipe? --> pipedInput becomes the prompt
       |
       +-- loadConfig()
       |
       +-- initProvider()
       |
       +-- ensureMemory()
       |
       +-- resolvePath(cwd)
       |
       +-- runQuery({ prompt, provider, memory, cwd, pipedInput })
```

**Key flow change:** `readPipedInput()` runs immediately after `parseInput`, before any dispatch. This is necessary because:
1. When `parseInput` returns `type: "none"`, piped input determines whether to dispatch `--help` or use the piped content as the prompt.
2. When `parseInput` returns `type: "flag"` (e.g., `echo 'hello' | w --help`), the flag wins and piped input is silently ignored. Subcommands don't need piped input.

**Note:** `parseInput` itself does not change — it only looks at `process.argv`. Piped input detection is a separate step in `main()`. Piped content is never parsed as flags (`echo '--version' | w` does not trigger `--version`).

**Existing plumbing:** `QueryContext` in `src/llm/context.ts` already has `pipedInput?: string` and `LogEntry` in `src/logging/entry.ts` already has `piped_input?: string`. These fields are defined but not wired — this feature connects them.

---

## Interaction with Unimplemented Features

### Probes (blocker for full power)

The killer feature — LLM uses probe + `pipe_stdin` to surgically extract from huge files:

```
$ cat huge.log | w explain the error on line 12570000
# LLM sees first 200KB, knows it's truncated
# Returns: { type: "probe", command: "sed -n '12570000p'", pipe_stdin: true }
# Wrap pipes full content through sed → gets one line
# Sends that line back to LLM
# LLM returns: { type: "answer", content: "That error means..." }
```

**Not implemented in this feature.** Probes require the multi-round loop (SPEC.md sections 6-7) which doesn't exist yet. The piped input design accounts for this — `pipe_stdin` works on probes in the schema, and the buffer persists across rounds. When the multi-round loop lands, probe + pipe_stdin works without changes to the piped input implementation.

**Note:** Very large files (multi-GB) require the deferred temp-file optimization (see Reading & Buffering) since the current string-in-memory approach has practical limits (a 10GB file would require ~20GB of heap due to JS UTF-16 string encoding).

### Threads

Thread continuation with piped input (e.g., `cat file | w explain this` then `wyada but in more detail`) is deferred. Threads aren't implemented. When they are, decide whether to store piped content (or its truncated preview) in the thread.

### Confirmation TUI

When the confirmation TUI is built, piped input creates a TTY challenge: stdin is claimed by the pipe, so confirmations must read from `/dev/tty`. This is the standard Unix pattern (used by fzf, sgpt, less, sudo). For now, medium/high-risk commands with piped input are refused (same as without piped input — confirmation isn't implemented).

### Answer formatting

Piped input does not affect answer formatting. Whether answers are markdown or plain text depends only on whether **stdout** is a TTY, not stdin. `cat file | w explain this` gets markdown if stdout is a terminal.

### Mode interaction

Piped input works with all modes. In force-answer mode (`w?`), the LLM receives piped content as context but can only return an answer — `pipe_stdin` is ignored since there's no command to pipe into. In force-command mode (`w!`), the LLM must return a command and can use `pipe_stdin: true` to process the piped data. Yolo mode auto-executes as usual.

---

## Testing Strategy

### E2E tests

Extend `wrap()` and `wrapMock()` helpers to accept a `stdin` parameter. Bun.spawn supports passing stdin content to subprocesses. **Important:** The helpers' default must remain `stdin: "inherit"` (not `"pipe"`) so existing tests still see `process.stdin.isTTY === true` and don't accidentally trigger piped input detection.

Test cases:
- Piped input + CLI args → piped content as context, args as prompt
- Piped input, no CLI args → piped content becomes the prompt
- Empty pipe → treated as no piped input
- Large piped input → truncation in LLM context
- `pipe_stdin: true` in response → command receives piped content on stdin
- `pipe_stdin: false` in response → command gets empty stdin
- Piped input logged (with truncation for large inputs)
- No piped input → `piped_input` field omitted from log
- Piped content not parsed as flags (`echo '--version' | w`)

### Unit tests

- `readPipedInput()`: detection, reading, empty handling
- `assembleCommandPrompt()` with piped input: section ordering, truncation note
- Token estimation heuristic
- Truncation logic: correct cutoff, note format
- Log entry creation with piped input truncation

---

## Example Flows

### Basic piped input (answer)

```
$ cat error.log | w what does this error mean
The crash is caused by a null pointer dereference on line 42...
```

### Piped input as prompt (no args)

```
$ echo "find all typescript files modified today" | w
./src/index.ts
./src/utils/parser.ts
```

### Piped input with command (pipe_stdin)

```
$ cat urls.txt | w check which urls are alive
# LLM generates: xargs -P4 curl -sI (with pipe_stdin: true)
# Full urls.txt content piped to xargs
```

### Large piped input with truncation

```
$ cat huge.csv | w count the rows
# LLM sees first 200KB + truncation note
# Generates: wc -l (with pipe_stdin: true)
# Full CSV piped to wc -l
42857
```

### Future: Probe + pipe_stdin (requires multi-round loop + temp-file optimization for very large files)

```
$ cat huge.log | w explain the error on line 12570000
# Round 1: LLM probes with sed -n '12570000p' + pipe_stdin
# Round 2: LLM explains the extracted line
```
