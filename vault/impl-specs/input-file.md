# Input file

> Reframe piped input as a file on disk at `$WRAP_TEMP_DIR/input`, accessible via standard shell redirection. Drop the `pipe_stdin` schema field and the Blob-into-stdin runtime path. Fix the interactive-command TTY bug as a side effect by opening `/dev/tty` per child when the parent's stdin is a pipe. Switch stdin reads to `Bun.stdin.bytes()` for binary safety; rename the internal variable `pipedInput` → `attachedInput`.

**Status: ready for implementation.**

Replaces the current architecture documented in [[piped-input]]. Interacts with [[safety]] — piped input is an injection surface, and the on-disk copy extends that surface briefly to the filesystem.

---

## Motivation

Today piped input lives only as an in-memory string. To feed it to a command, the LLM sets `pipe_stdin: true` and Wrap attaches a `Blob` to the child's stdin. This has three problems:

**1. Interactive commands break when wrap is piped into.**

```
echo irrelevant | w run vim /tmp/scratch.txt
→ Vim: Warning: Input is not from a terminal
  (vim exits silently, file empty, exit_code 0)
```

Root cause: Wrap's own fd 0 is the pipe. `Bun.spawn` with `stdin: "inherit"` forwards that drained pipe to vim. Vim reads EOF, gives up, exits clean. Silent failure.

**2. LLM has to reinvent the "stage stdin to a file" pattern.**

Recent log showing the LLM reasoning through this from scratch (`tail -10 CLAUDE.md | w count the lines then let me edit it in vim`):

```
"But the content is piped — to edit it in vim I need to save it to a
temp file first, then open that. Let me count lines and write to temp
file, then open vim…"
```

Then emits `tee $WRAP_TEMP_DIR/input.md | wc -l && vim $WRAP_TEMP_DIR/input.md` (the LLM picked `.md` itself — historical quote). Clever, but:
- Fragile — another run without this scratchpad would just crash vim.
- Token-heavy — reasoning re-derived every time.
- Inconsistent — different invocations pick different filenames / patterns.

**3. In-memory string doesn't scale and corrupts binary.**

`Bun.stdin.text()` buffers everything in a JS string. Multi-GB pipes OOM. Non-UTF-8 bytes get mangled. Both fall out of this spec once bytes are streamed to disk and the in-memory buffer is released after the preview is built.

## The reframe

Materialize piped input to a known path at wrap startup. Tell the LLM the path. Let it use normal shell: file arguments (`vim $WRAP_TEMP_DIR/input`), input redirection (`jq . < $WRAP_TEMP_DIR/input`), explicit pipelines (`cat $WRAP_TEMP_DIR/input | sort | uniq`).

Wrap stops owning an opinion about how the content reaches the child. The shell does its job.

TTY bug resolves because the pipe-fd-on-parent problem becomes irrelevant for 95% of cases (LLM reads the file, not stdin), and the remaining ~5% is handled by a small `shell.ts` change that opens `/dev/tty` as the child's stdin when the parent's is a non-TTY.

---

## Behavior

### On invocation

`main.ts` reads piped content (as today, via `readAttachedInput()` — renamed from `readPipedInput`), then:

1. If content is non-empty: write bytes to `$WRAP_TEMP_DIR/input`, mode `0600`.
2. Pass the full content string to `runSession` alongside the path (for the prompt's truncated preview section).
3. If content is empty/whitespace-only: no file written, no prompt section — same as today's empty-pipe behavior.

### LLM prompt

The piped-input section becomes file-framed, not stream-framed:

- Section header renames: `## Piped input` → `## User's input file`.
- Section body carries the path first, then the truncated preview:
  ```
  ## User's input file

  Path: $WRAP_TEMP_DIR/input (12.4K)

  <truncated preview>
  ```
- `attachedInputInstruction` (renamed from `pipedInputInstruction`) rewrites to file-first framing (see §Prompt changes).

### Command execution

`executeShellCommand` keeps its two modes (`capture`, `inherit`). The `stdinBlob` parameter goes away. Per-spawn stdin rules:

| Parent's stdin | Child's stdin |
|---|---|
| Is a TTY | `"inherit"` (real tty flows through) |
| Is a pipe + `/dev/tty` openable | opened `/dev/tty` fd |
| Is a pipe + no controlling terminal | `"ignore"` (honest EOF, not silent pipe-EOF) |

This single rule is the entire TTY fix. No detection list, no shell parsing, no schema flag.

---

## Schema changes

Drop `pipe_stdin` from `CommandResponseSchema` in `src/command-response.schema.ts`. No replacement. The LLM uses shell redirection for any streaming need:

```
# Before (what LLM emitted with pipe_stdin: true)
{content: "jq .", pipe_stdin: true}

# After
{content: "jq . < $WRAP_TEMP_DIR/input"}
```

`CommandResponse` type narrows. All `stdinBlob` call-sites in `runner.ts:222-223`, `session.ts:157`, `session.ts:372` collapse to a single stdin-resolution helper in `shell.ts`.

`ShellExecOptions` loses the `stdinBlob` field entirely:

```ts
export type ShellExecOptions = {
  mode: "capture" | "inherit";
};
```

The stdin choice is internal to `executeShellCommand`. No backdoor for tests — tests that need a specific stdin inject via `process.stdin` stubbing (consistent with how `readAttachedInput` is tested today).

`LoopOptions` / `SessionOptions` replace `pipedInput: string` with `attachedInputPreview: string | undefined` and `attachedInputTruncated: boolean`. The full buffer is not held on session state — see §Runtime changes / main.ts.

**Before editing the schema comment:** read `.claude/skills/editing-prompts.md`.

---

## Prompt changes

Coordinated edits across three files. Follow the two-source rule for instructions.

### `src/prompt.constants.json`

- Rename key `sectionPipedInput` → `sectionAttachedInput`. Value: `## Attached input`.
- Rewrite `pipedInputInstruction` → `attachedInputInstruction`. Draft:
  > The user's input has been saved to a file at `$WRAP_TEMP_DIR/input`. Treat it as a file: pass it as a file argument when the command accepts one (`vim $WRAP_TEMP_DIR/input`, `grep foo $WRAP_TEMP_DIR/input`, `jq . $WRAP_TEMP_DIR/input`), or feed it via shell redirection when the command reads stdin (`cmd < $WRAP_TEMP_DIR/input`). Prefer file-argument form for interactive tools (editors, pagers). The preview below is the full content unless a "Preview truncated" line precedes it; the file always contains the full original bytes.

### `eval/dspy/optimize.py` (source of truth)

Rewrite the `WrapSignature` docstring with the new file-first framing. This is the canonical source DSPy/MIPRO seeds optimization from — if you skip this, the next optimize run silently reverts the change. Edit this first.

### `src/prompt.optimized.json` (runtime mirror)

Mirror the identical wording into the `instruction` field so runtime picks it up before the next optimize run. Leave `promptHash` stale — `bun run optimize` recomputes.

`schemaText` auto-regenerates from `command-response.schema.ts` on the next optimize run. For immediate-use editing, mirror the updated schema text by hand.

### `eval/examples/seed.jsonl`

Existing seeds currently assert `pipe_stdin_expected: true` on the LLM output (lines ~100, 101, 103). These assertions must be rewritten to expect shell-redirection form instead — e.g., `content: "wc -l < $WRAP_TEMP_DIR/input"` with no `pipe_stdin` assertion. Don't just delete them; preserve the coverage.

Add new seeds for cases the reframe must handle:

- Interactive final: `echo body | w edit this in vim` → `vim $WRAP_TEMP_DIR/input` (not `cat $WRAP_TEMP_DIR/input | vim`, which is the regression case).
- Redirection: `cat log | w extract error lines` → `grep ERROR $WRAP_TEMP_DIR/input`.
- Pipeline where `cat |` is idiomatic: `ps aux | w show the longest-running process` → `cat $WRAP_TEMP_DIR/input | awk …`.
- Reply case (no file use): `echo 'red' | w what color is this` → `reply`, not a command.
- Regression catcher: a seed that would fail if the LLM emits `cat $WRAP_TEMP_DIR/input | vim` (interactive tool fed a pipe instead of a file argument).

---

## Runtime changes

### `src/core/piped-input.ts`

Rename file → `src/core/attached-input.ts`. Rename function `readPipedInput` → `readAttachedInput`. Switch `Bun.stdin.text()` → `Bun.stdin.bytes()` → return `Uint8Array | undefined`. The "empty/whitespace-only = undefined" guard now checks byte length + a quick UTF-8 whitespace check (or simply non-zero length; whitespace-only edge cases are rare and this is a caller boundary, not a correctness invariant).

Rename every internal `pipedInput` identifier to `attachedInput` across `main.ts`, `session.ts`, `runner.ts`, `format-context.ts`, `LoopOptions`, `SessionOptions`, and test fixtures. One pass, search-replace.

### `src/main.ts`

After `readAttachedInput()` and `createTempDir()`, write the input file and build the prompt preview. Use async `writeFile` and `chmod` after write — `writeFile`'s `mode` option is subject to `umask`, so a shared-system umask of `0o002` would leave the file world-readable. Explicit `chmod` guarantees `0o600`.

```ts
let attachedInputPreview: string | undefined;
if (attachedInput) {
  const path = join(process.env.WRAP_TEMP_DIR!, "input");
  await writeFile(path, attachedInput);
  await chmod(path, 0o600);
  verbose(`Input file: ${path} (${formatSize(attachedInput.byteLength)})`);
  attachedInputPreview = buildAttachedInputPreview(attachedInput, getConfig().maxAttachedInputChars);
}
```

`buildAttachedInputPreview` (new pure helper in `src/core/attached-input.ts`) UTF-8 decodes the bytes, truncates to the preview budget, and returns a plain string. For non-UTF-8 bytes it returns a short summary line (`Binary content — 12.4M, not previewable`) so the LLM knows the file exists without polluting the prompt with mojibake.

Only the preview string is threaded through `SessionOptions` → `LoopOptions`. The `Uint8Array` itself is dropped after the write + preview step — the file on disk is the single source of truth for any future use.

Order matters: `createTempDir` must run before the write. Size display uses the existing `formatSize` helper from `src/fs/temp.ts`.

### `src/core/shell.ts`

Replace `stdinBlob` with an internal stdin resolver. `Bun.spawn` accepts a numeric fd for the stdin option, so an `openSync` fd can be passed directly.

```ts
function chooseChildStdin(): "inherit" | "ignore" | number {
  if (process.stdin.isTTY) return "inherit";
  try {
    return openSync("/dev/tty", "r");
  } catch {
    return "ignore";
  }
}
```

Wrap the spawn in `try/finally` so an opened fd closes even if `proc.exited` rejects:

```ts
const stdin = chooseChildStdin();
try {
  const proc = Bun.spawn([shell, "+m", "-ic", command], { ...stdio, stdin });
  return await proc.exited;
} finally {
  if (typeof stdin === "number") closeSync(stdin);
}
```

Both the `capture` and `inherit` branches use the resolver. **Behavior change for capture-mode probes:** today they get a closed stdin (`stdinBlob` undefined → `undefined` → closed). After this change, a probe running in a piped invocation gets `/dev/tty` as its stdin. A probe that accidentally reads stdin would now block on keyboard input instead of hitting EOF immediately. Probes don't read stdin by design, but the behavior shift is worth knowing during debugging.

Open once per spawn, not once globally — `dup2` in the parent isn't available at the JS level. Per-spawn cost is small (one syscall × 5–8 spawns per invocation); caching across spawns is possible but trades robustness (tty-state mutations between spawns could corrupt the cached fd) for marginal perf. Defer caching unless profiling shows it matters.

### `src/session/session.ts` and `src/core/runner.ts`

Remove the `stdinBlob` plumbing (`session.ts:157`, `session.ts:372`, `runner.ts:222-223`). Replace `pipedInput: string` with `attachedInputPreview: string | undefined` and `attachedInputTruncated: boolean` on `LoopOptions` / `SessionOptions`. No other consumer of the full bytes remains.

### `src/llm/format-context.ts`

Rename `sectionPipedInput` → `sectionAttachedInput`. Consume `attachedInputPreview` + `attachedInputTruncated` instead of the full buffer. Section body:

- Always lead with `Path: $WRAP_TEMP_DIR/input (size)`.
- If `attachedInputTruncated === true`, add a line like `Preview truncated — full content is in the file.` then the preview.
- If `attachedInputTruncated === false`, show the preview directly with no "truncated" wording — it's the full content.

Current code passes `maxPipedInputChars` into `formatContext` and does the truncation inline; move that responsibility to `buildAttachedInputPreview` in main so `formatContext` just renders what it was given.

---

## Cleanup

Temp-dir lifecycle is unchanged. Per `src/fs/temp.ts:10-14`, Wrap deliberately does not clean up on exit — the OS's `$TMPDIR` policy is the backstop, and a future resume flow may reuse artifacts. The input file inherits this policy.

Mode `0600` ensures only the user can read it while it exists.

---

## Edge cases

- **Empty / whitespace-only pipe** — no file written, no prompt section. Matches today's behavior.
- **No controlling TTY** (CI, some docker, cron) — `/dev/tty` open throws ENXIO/ENOENT. Fall back to `"ignore"`. Interactive commands will fail with an honest "no terminal" error rather than silent EOF.
- **Background pipelines** (`w vim &`) — wrap exits after child completes either way. Detached-after-fork scenarios already unsupported.
- **Wrap piped to AND piped from** (`cat foo | w transform | less`) — parent's fd 0 is pipe (covered), fd 1 is pipe (already handled via `pipedOutputInstruction`). No new interaction.
- **Multi-round consistency** — round 2 reads the same file written in round 0. No state to re-stream.
- **Very large input** — disk I/O scales where RAM doesn't. Today's in-memory limit becomes irrelevant; `maxPipedInputChars` still governs the prompt preview only, not the on-disk file.
- **Binary input** — mode `0600` and a bytes-level write keep bytes intact. Independent follow-up to switch `Bun.stdin.text()` → `Bun.stdin.bytes()`.

---

## Limitations (accepted)

- **LLM residual bias toward stdin patterns.** Even with the reframe, some responses will do `cat $WRAP_TEMP_DIR/input | vim` instead of `vim $WRAP_TEMP_DIR/input`. The first is broken (vim reads the pipe, not the file). Mitigation: explicit prompt sentence prioritising file-argument form for interactive tools, plus a seed example making the pattern concrete. Add at least one eval sample that catches regressions.
- **Brief on-disk copy of potentially sensitive content.** Logs, credentials, API responses land on disk for the invocation lifetime + OS cleanup lag. Kernel swap already flushes RAM-only content to disk in practice, so the security delta vs. today is small. Mode `0600` contains it.
- **One hardcoded filename.** `input` (no extension). Content may be anything — markdown, JSON, binary, logs. A neutral name avoids misleading editors, the LLM's reasoning, or `file`-command output. Editors that key off content rather than extension still pick sensible highlighting.

---

## Test plan

- **File materialization**
  - Piped stdin → `$WRAP_TEMP_DIR/input` exists with correct bytes.
  - File mode is `0o600` regardless of the user's umask.
  - Empty/whitespace-only pipe → no file written, no prompt section.
- **TTY fix**
  - `echo x | wrap vim /tmp/t` — vim opens with a working keyboard (not "Input is not from a terminal").
  - `echo x | wrap sudo tee /tmp/t` — sudo password prompt appears on the user's terminal; pipe data reaches `tee` via the LLM emitting `< $WRAP_TEMP_DIR/input`.
  - `wrap vim /tmp/t` (no pipe) — still works; parent's tty is inherited as before.
  - No `/dev/tty` available (headless context) — interactive command exits with a clear error, not silent EOF.
- **Schema + runtime**
  - `pipe_stdin` removed from schema parses cleanly; old responses that included `pipe_stdin: true` don't crash (zod ignores extra keys by default; verify).
  - No remaining references to `options.stdinBlob` in `runner.ts` / `session.ts`.
- **Prompt**
  - New section header shows the path + size line above the truncated preview.
  - `bun test tests/prompt.test.ts` passes.
  - Eyeball-diff: `optimize.py` docstring and `prompt.optimized.json` `instruction` say the same things.

## Implementation order (TDD)

Steps 1–4 are tightly coupled — ship together, not as separate PRs. Step 1 in isolation delivers a narrow TTY fix, but the motivation (file-first reframing) requires steps 2–4 to land together. If landing incrementally, pair step 1 with step 2 at minimum.

1. **Shell.ts TTY fix.** Add `chooseChildStdin`; unit-test each branch (tty parent, pipe parent + /dev/tty openable, pipe parent + no tty). Integration: `echo x | wrap vim /tmp/foo` opens vim with a working keyboard.
2. **File materialization.** Write `$WRAP_TEMP_DIR/input` in `main.ts`. Test: after invocation with piped stdin, the file exists with the right bytes and mode `0o600` regardless of umask.
3. **Prompt reframe.** Rename section + `pipedInputInstruction` → `attachedInputInstruction`, rewrite the instruction, update `optimize.py` docstring (source of truth) then `prompt.optimized.json` (mirror). Add / rewrite seeds. Run `bun test tests/prompt.test.ts`.
4. **Drop `pipe_stdin`.** Remove from schema (SCHEMA_START/END block) and every runtime call-site. Tests: every existing test that set `pipe_stdin: true` should switch to using shell redirection in its expected command output.
5. **Eval pass.** Run eval on the updated prompt. Fix any regressions surfaced by seed examples.
6. **Manual smoke.** Real terminal, each of:
   - `w vim /tmp/scratch.txt`
   - `echo hi | w vim this content`
   - `cat README.md | w show me the first 20 lines`
   - `cat log | w find errors and open them in less`
   - `echo x | w use sudo to tee to /tmp/y` (pipe-data-plus-sudo-password)
   - `echo x | w run top for 5 seconds`

---

## Open questions

- **Prompt section presentation.** Plain `Path: $WRAP_TEMP_DIR/input (size)` line vs. stronger visual framing (fenced block, anchor phrase). Relying on the LLM reading the path line reliably for now; revisit if eval shows regressions where the model guesses a stale filename.
