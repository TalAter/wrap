# TUI Approach

## Decision: Ink (lazy-loaded) + existing chrome utilities

We use **Ink** (React for CLI) as our TUI framework for all interactive UI. Non-interactive output continues to use Wrap's existing `chrome()` / `chromeRaw()` utilities in `src/core/output.ts`, which write to stderr.

Ink is lazy-loaded via `await import("ink")` so it only adds cost when interactive UI is actually needed. Most Wrap invocations (low-risk commands) never load Ink.

## Three output tiers

All Wrap UI ("chrome") goes to **stderr** or **/dev/tty**. Never stdout. This is a hard rule throughout the codebase (see `SPEC.md`).

**Tier 1 — Static chrome.** `chrome()` and `chromeRaw()` from `src/core/output.ts`. Simple text to stderr. Error messages, status lines, post-execution summaries. Already exists, no changes needed.

**Tier 2 — Animated chrome.** Spinners, streaming text, progress indicators. Still lightweight, no Ink. Built on `chromeRaw()` with `setInterval` and cursor control (`\r`, hide/show cursor). A small spinner utility or `nanospinner` (tiny, supports custom streams). This tier covers "waiting for LLM response" indication.

**Tier 3 — Interactive UI (Ink).** Anything that captures user input or has dynamic layout: confirmation panels, config wizard forms, interactive mode text input, error-recovery prompts. Loaded via `await import("ink")` only when triggered.

## How Ink is configured

Wrap has two hard constraints that require specific Ink configuration:

### 1. Render to stderr, not stdout

Ink's `render()` accepts a `stdout` option. Pass `process.stderr`:

```ts
render(<Component />, { stdout: process.stderr, stdin: ttyStream });
```

This redirects **all** Ink rendering (layout, re-renders, cursor management) to stderr. Stdout remains untouched for command output.

### 2. Read input from /dev/tty when stdin is piped

Wrap supports `cat file | w explain this` — stdin is consumed by the pipe, so interactive prompts can't read from `process.stdin`. The standard Unix pattern (used by fzf, sudo, less) is to open `/dev/tty` directly:

```ts
import { createReadStream } from "fs";
const ttyInput = createReadStream("/dev/tty");
render(<Component />, { stdout: process.stderr, stdin: ttyInput });
```

When stdin is NOT piped, `process.stdin` can be used directly. The Ink entry point should detect this and choose accordingly.

Bun supports opening `/dev/tty` as a file/stream. Bun also supports `process.stdin.setRawMode(true)` for raw key capture, and `process.stdout.columns` / `process.stdout.rows` for terminal dimensions.

### 3. Input buffer flush

Before rendering any interactive prompt, flush/discard any buffered terminal input. This prevents a stray Enter keypress (pressed while the user was waiting for the LLM response) from accidentally confirming a dangerous command. This is critical for safety.

### 4. Clean teardown

Ink provides `unmount()` and `waitUntilExit()`. Before Wrap spawns a child process (the confirmed command), Ink must be fully unmounted: no alternate screen, no cursor artifacts, no lingering raw mode. The terminal must be back to normal before the child process runs.

## Compatibility notes from research

**Bun + Ink works in production.** Anthropic's Claude Code CLI ships as a Bun-compiled binary using Ink + React for its TUI. This is the strongest existence proof.

**Yoga layout (Ink's flexbox engine):** Historically used native bindings (`yoga-layout-prebuilt`). Newer versions ship as pure WASM (`yoga-wasm-web`, `yoga-layout` v3+), which should survive `bun build --compile`. Verify the installed version uses WASM, not native binaries. If `bun build --compile` fails with yoga-related errors, this is the likely culprit — switch to the WASM package.

**`useInput` quirks:** There are documented issues with Ink's `useInput` in some Bun versions (Ink issue #6862). If key capture doesn't work, the workaround is reading from the tty stream directly and dispatching events manually. Claude Code presumably solved this already, so their approach may be worth studying if issues arise.

**`process.stdin` buffering on macOS:** Bun issue #18239 documents different stdin buffering behavior on macOS. Opening `/dev/tty` explicitly (as described above) sidesteps this entirely.

## Where Ink gets used

**Confirmation panel** — when the LLM generates a medium or high-risk command. See `SPEC.md` for full keybinding spec and risk tiers. This is the most urgent need; medium/high-risk commands are currently refused (see `src/core/query.ts` lines 228-234).

**Config wizard** — first-run setup and `w config`. Provider selection (radio/select), API key entry (masked text input), model selection. Standard form UI. Ink has component libraries for these: `ink-select-input`, `ink-text-input`.

**Interactive mode** — `w` with no args. Multiline text editor with Enter to submit, Shift+Enter for newline. Most complex Ink usage. See `specs/interactive-mode.md`.

**Error recovery** — if a confirmed command fails, prompting "Retry? Edit? Explain?" This is a simpler variant of the confirmation panel.

## Where Ink is NOT used

**Answer rendering** (terminal markdown) — purely formatted text output to stdout (when TTY) or plain text (when piped). No interactivity.

**Streaming LLM responses** — Tier 2 animated chrome. Appending text to stderr as chunks arrive.

**Spinners / progress** — Tier 2.

**Simple status messages, errors, post-execution output** — Tier 1 `chrome()`.

## Bundle size and startup

Ink + React + Yoga adds roughly ~2.5MB to the compiled binary. This is acceptable given Wrap already bundles the AI SDK, provider libraries, and Zod. The lazy-load pattern means init costs are only paid when interactive UI is needed. Low-risk command execution (the common path) never imports Ink.

React initialization adds roughly 50-100ms. This happens after the LLM response arrives (which takes 500-2000ms), so the user never perceives it.

## Useful companion libraries

- **Syntax highlighting** for shell commands in the confirmation panel: `highlight.js` or `cli-highlight`
- **Terminal markdown rendering** for answer mode: `marked-terminal`
- **Tiny color library** if `src/core/ansi.ts` needs extending: `picocolors` (7KB, 14x smaller than chalk, no deps). Wrap's existing `ansi.ts` already covers bold, dim, 24-bit RGB, and gradients — may not need anything else.
- **Spinner** for Tier 2: `nanospinner` or hand-roll on `chromeRaw()` (~20 lines)
- **Box drawing**: Ink's `<Box borderStyle="round">` handles this natively for Tier 3. For Tier 1/2, Unicode box characters written via `chromeRaw()`.

These libraries are just suggestions. Do not limit yourself to these.