# TUI Approach

## Decision: Ink 5+ (lazy-loaded) + existing chrome utilities

We use **Ink** (React for CLI) as our TUI framework for all interactive UI. Non-interactive output continues to use Wrap's existing `chrome()` / `chromeRaw()` utilities in `src/core/output.ts`, which write to stderr.

Ink is lazy-loaded via `await import("ink")` so it only adds cost when interactive UI is actually needed. Most Wrap invocations (low-risk commands) never load Ink.

**Requires Ink 5+** — earlier versions have WASM/compilation issues with `bun build --compile`.

## Three output tiers

All Wrap UI ("chrome") goes to **stderr** or **/dev/tty**. Never stdout. This is a hard rule throughout the codebase (see `SPEC.md`).

**Tier 1 — Static chrome.** `chrome()` and `chromeRaw()` from `src/core/output.ts`. Simple text to stderr. Error messages, status lines, post-execution summaries. Already exists, no changes needed.

**Tier 2 — Animated chrome.** Spinners, streaming text, progress indicators. Still lightweight, no Ink. Built on `chromeRaw()` with `setInterval` and cursor control (`\r`, hide/show cursor). A small spinner utility or `nanospinner` (tiny, supports custom streams). This tier covers "waiting for LLM response" indication.

**Tier 3 — Interactive UI (Ink).** Anything that captures user input or has dynamic layout: dialogs, config wizard forms, interactive mode text input, error-recovery prompts. Loaded via `await import("ink")` only when triggered.

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

**Dialog** — when the LLM generates a medium or high-risk command. See `SPEC.md` for full keybinding spec and risk tiers. Basic dialog implemented: renders command, risk level, explanation, tiered keybindings (medium: Enter=run; high: y+Enter=run). Falls back gracefully when no TTY is available.

**Config wizard** — first-run setup and `w config`. Provider selection (radio/select), API key entry (masked text input), model selection. Standard form UI. Ink has component libraries for these: `ink-select-input`, `ink-text-input`.

**Interactive mode** — `w` with no args. Multiline text editor with Enter to submit, Shift+Enter for newline. Most complex Ink usage. See `specs/interactive-mode.md`.

**Error recovery** — if a confirmed command fails, prompting "Retry? Edit? Explain?" This is a simpler variant of the dialog.

### Ink + chromeRaw coordination

While Ink is mounted, it owns stderr rendering. `chrome()` and `chromeRaw()` must NOT write to stderr concurrently — Ink manages its own screen region and uncoordinated writes corrupt the display.

For async dialog states (describe, follow-up) that trigger LLM calls while Ink is mounted, both `chrome()` and `verbose()` route through a shared stderr sink that buffers messages and forwards them to a dialog listener. On dialog unmount the buffer is flushed to stderr (after `EXIT_ALT_SCREEN`). See `specs/follow-up.md` §"Stderr message routing".

## Where Ink is NOT used

**Answer rendering** (terminal markdown) — purely formatted text output to stdout (when TTY) or plain text (when piped). No interactivity.

**Streaming LLM responses** — Tier 2 animated chrome. Appending text to stderr as chunks arrive.

**Spinners / progress** — Tier 2.

**Simple status messages, errors, post-execution output** — Tier 1 `chrome()`.

## Bundle size and startup

Ink + React + Yoga adds ~1MB to the compiled binary (measured). The lazy-load pattern means init costs are only paid when interactive UI is needed. Low-risk command execution (the common path) never imports Ink.

React initialization adds roughly 50-100ms. For the dialog this happens after the LLM response arrives (500-2000ms), so the user never perceives it. For interactive mode (`w` with no args) Ink is the first thing rendered — 100ms is below perception threshold for cold-start.

## Dialog visual design

The dialog uses a **synthwave gradient** border that shifts hue based on risk level. See `specs/dialog-style.sh` for the exact ANSI reference rendering (run `bash specs/dialog-style.sh` to preview).

**Layout:**
- Rounded corners (`╭╮╰╯`), thin lines (`─│`). No heavy border (Unicode has no heavy rounded corners).
- Left-aligned, content-fitted width. Long commands wrap within the box.
- Gradient flows from bright accent (top-left corner) → dim neutral (bottom-right). Both the top edge and left edge carry the gradient; right edge and bottom are dim neutral.
- Command displayed on a **tinted background** strip (subtle code-block feel, ~`rgb(35,35,50)`).
- Explanation text below command, slightly dimmer than body text.
- **No separator line** between command area and action bar — just breathing room (blank lines).
- **Risk badge** pill embedded in the top-right border: `─── ⚠ medium ──╮`. Pill has a tinted background matching the risk color.

**Risk-level color palettes:**
- **Medium:** pink→purple synthwave. Border starts `rgb(255,100,200)`, fades through purple to `rgb(60,60,100)`. Badge: amber text `rgb(255,200,80)` on dark warm bg `rgb(80,60,30)`.
- **High:** red→purple synthwave. Border starts `rgb(255,60,80)`, fades through magenta/purple to `rgb(60,60,100)`. Badge: red text `rgb(255,100,100)` on dark red bg `rgb(80,25,25)`.

**Syntax highlighting** for the command: command names in warm orange, flags in cyan/blue, strings/values in pink. Use a shell highlighting library (`cli-highlight` or similar) or hand-color based on simple token rules.

**Action bar:**
- Format: `Run command?  Yes  No  │  Describe  Edit  Follow-up  Copy`
- Y/N are the primary actions, separated from secondary actions (D/E/F/C) by a dim vertical bar `│`.
- Shortcut keys are the **first letter** of each word, styled: **bold + underlined + accent color**. Y/N keys use a warmer accent `rgb(245,200,100)`, secondary keys use a cooler `rgb(170,170,195)`. The rest of each word is dim `rgb(115,115,140)`.
- Same Y/N keybinding for both medium and high risk (simplified from the original tiered Enter/y+Enter scheme).

**Keybindings (both risk levels):**
- `y` = run the command
- `n`, `q`, or `Esc` = cancel
- `d` = describe (LLM explanation)
- `e` = edit (editable command field)
- `f` = follow-up (text input for refinement)
- `c` = copy to clipboard

## Useful companion libraries

- **Syntax highlighting** for shell commands in the dialog: `highlight.js` or `cli-highlight`
- **Terminal markdown rendering** for answer mode: `marked-terminal`
- **Tiny color library** if `src/core/ansi.ts` needs extending: `picocolors` (7KB, 14x smaller than chalk, no deps). Wrap's existing `ansi.ts` already covers bold, dim, 24-bit RGB, and gradients — may not need anything else.
- **Spinner** for Tier 2: `nanospinner` or hand-roll on `chromeRaw()` (~20 lines)
- **Box drawing**: Ink's `<Box borderStyle="round">` handles this natively for Tier 3. For Tier 1/2, Unicode box characters written via `chromeRaw()`.

These libraries are just suggestions. Do not limit yourself to these.