# TUI Approach

## Decision: Ink 5+ (lazy-loaded) + existing chrome utilities

We use **Ink** (React for CLI) as our TUI framework for all interactive UI. Non-interactive output continues to use Wrap's existing `chrome()` / `chromeRaw()` utilities in `src/core/output.ts`, which write to stderr.

Ink is lazy-loaded via `await import("ink")` so it only adds cost when interactive UI is actually needed. Most Wrap invocations (low-risk commands) never load Ink.

**Requires Ink 5+** — earlier versions have WASM/compilation issues with `bun build --compile`.

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

### 4. Cursor restore

Bun has a known bug where the cursor disappears after an Ink app exits on macOS (bun#26642). Wrap must explicitly restore cursor visibility (`\x1B[?25h`) on Ink unmount and in signal handlers (SIGINT, SIGTERM). This is cheap insurance even after the bug is fixed.

### 5. Clean teardown

Ink provides `unmount()` and `waitUntilExit()`. Before Wrap spawns a child process (the confirmed command), Ink must be fully unmounted: no alternate screen, no cursor artifacts, no lingering raw mode. The terminal must be back to normal before the child process runs.

## Bun compatibility

**Bun + Ink works in production.** Anthropic's Claude Code CLI ships as a Bun-compiled binary using Ink + React for its TUI (they use a custom fork with heavier modifications, but vanilla Ink 5+ works for Wrap's needs).

**Yoga layout (Ink's flexbox engine):** Ink 5+ depends on `yoga-layout` 3.2.x, which ships as base64-encoded WASM embedded in a JS module. No native bindings. Confirmed working with `bun build --compile` (bun#6567, fixed June 2025).

**`useInput` + Bun (bun#6862, still open):** Ink's `useInput` hook doesn't work reliably with Bun because Bun doesn't handle `process.stdin` the way Ink expects. **Workaround:** use Ink's `useStdin` hook with `setRawMode: true` for input capture instead of relying on `useInput` directly. This is the standard pattern until the Bun issue is fixed.

## Where Ink gets used

**Confirmation panel** — when the LLM generates a medium or high-risk command. See `SPEC.md` for full keybinding spec and risk tiers. This is the most urgent need; medium/high-risk commands are currently refused (see `src/core/query.ts` lines 228-234).

**Config wizard** — first-run setup and `w config`. Provider selection (radio/select), API key entry (masked text input), model selection. Standard form UI. Ink has component libraries for these: `ink-select-input`, `ink-text-input`.

**Interactive mode** — `w` with no args. Multiline text editor with Enter to submit, Shift+Enter for newline. Most complex Ink usage. See `specs/interactive-mode.md`.

**Error recovery** — if a confirmed command fails, prompting "Retry? Edit? Explain?" This is a simpler variant of the confirmation panel.

### Ink + chromeRaw coordination

While Ink is mounted, it owns stderr rendering. `chrome()` and `chromeRaw()` must NOT write to stderr concurrently — Ink manages its own screen region and uncoordinated writes corrupt the display. Any output that needs to appear while Ink is active (memory update notifications, verbose lines, probe indicators during a follow-up LLM call) must go through Ink components, not `chromeRaw()`.

In practice this is unlikely in the initial implementation — Ink mounts after the LLM responds, shows the confirmation panel, and unmounts before anything else runs. It becomes relevant when describe/follow-up trigger LLM calls while the panel is active (see phasing below).

### Phasing: describe and follow-up

The full confirmation panel has async states: pressing `[D]escribe` or submitting a `[F]ollow-up` triggers an LLM call while the TUI is active. Phase this:

**Phase 1:** Unmount Ink before the LLM call. Let existing chrome (spinners, probe indicators) handle the wait. Re-mount Ink with the updated panel when the LLM responds.

**Phase 2:** Keep Ink mounted during LLM calls. Loading/spinner state as an Ink component. All chrome routed through Ink while mounted.

## Where Ink is NOT used

**Answer rendering** (terminal markdown) — purely formatted text output to stdout (when TTY) or plain text (when piped). No interactivity.

**Streaming LLM responses** — Tier 2 animated chrome. Appending text to stderr as chunks arrive.

**Spinners / progress** — Tier 2.

**Simple status messages, errors, post-execution output** — Tier 1 `chrome()`.

## Bundle size and startup

Ink + React + Yoga adds ~1MB to the compiled binary (measured). The lazy-load pattern means init costs are only paid when interactive UI is needed. Low-risk command execution (the common path) never imports Ink.

React initialization adds roughly 50-100ms. For the confirmation panel this happens after the LLM response arrives (500-2000ms), so the user never perceives it. For interactive mode (`w` with no args) Ink is the first thing rendered — 100ms is below perception threshold for cold-start.

## Useful companion libraries

- **Syntax highlighting** for shell commands in the confirmation panel: `highlight.js` or `cli-highlight`
- **Terminal markdown rendering** for answer mode: `marked-terminal`
- **Tiny color library** if `src/core/ansi.ts` needs extending: `picocolors` (7KB, 14x smaller than chalk, no deps). Wrap's existing `ansi.ts` already covers bold, dim, 24-bit RGB, and gradients — may not need anything else.
- **Spinner** for Tier 2: `nanospinner` or hand-roll on `chromeRaw()` (~20 lines)
- **Box drawing**: Ink's `<Box borderStyle="round">` handles this natively for Tier 3. For Tier 1/2, Unicode box characters written via `chromeRaw()`.

These libraries are just suggestions. Do not limit yourself to these.