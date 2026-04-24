# Copy command to clipboard

> **Status:** Implemented.

Press `C` in the confirming dialog to copy the command to the system clipboard. Label flashes `Copied` in the success color for 2.5s, reverts to `Copy`. Re-press re-copies and resets the timer.

Source:
- `src/core/clipboard.ts` — tool consts, argv, resolver, `copyToClipboard`, test hooks.
- `src/tui/response-dialog.tsx` — intercept, flash state, bar item.
- `src/tui/action-bar.tsx` — `flashColor` override on approve-style items.
- `src/discovery/init-probes.ts` — spreads `CLIPBOARD_TOOLS` / `CLIPBOARD_PASTE_TOOLS` into `PROBED_TOOLS`.

## Design choices

**Dialog-local, not a reducer event.** Copy is intercepted in `dispatchAction` before reaching `dispatch`. Reducer stays pure; the `"copy"` case in `ActionId` is kept as a no-op stub (dropping it would force every exhaustiveness-asserting reducer test to update — not worth the one-line cost).

**Per-tool argv keyed by bare tool name.** Mirrors `EDITORS` shape. TypeScript exhaustiveness on `Record<ClipboardTool, ...>` flags missing entries when adding a binary.

**Module-cached resolver, not riding the startup probe.** `resolveClipboardTool()` does its own `Bun.which` sweep (module-cached, first call wins) rather than reading from `ToolProbeResult`. Adding a plumbing channel to share probe results would be more code than calling `Bun.which` for up to 5 binaries on first dialog render.

**`CLIPBOARD_TOOLS` + `CLIPBOARD_PASTE_TOOLS` are the single source of truth.** Spread into `PROBED_TOOLS` so LLM context and the Copy action never drift. Paste tools are probed-only (no resolver yet); colocating them is cohesive even though the module's code doesn't consume them.

**Silent failure.** `copyToClipboard` is synchronous and swallows all errors — `try/catch` for sync throws (ENOENT race) plus `.catch(() => {})` on `FileSink.write`/`end` (async SIGPIPE / already-exited child). The dialog flashes `Copied` regardless. Designing an error UI for a near-zero-incidence failure mode would cost more than it's worth.

**`proc.unref()` immediately after spawn.** Process exit must not block on the child, and a hung `xclip` (X11 selection wait) or `clip.exe` (WSL interop stall) must not wedge the dialog. No `await proc.exited`.

**Strip a single trailing `\n`.** Paste-to-shell auto-execute footgun: LLM responses that end with a newline would be executed immediately on paste.

**`flashNonce: number`, not `flashUntil`.** The value is never compared against a clock — it's a monotonic re-render trigger. Using `Date.now()` risked same-millisecond collisions on a re-press (React bails on setState equality → effect doesn't re-run → timer doesn't reset). A monotonic counter avoids the collision.

**`flashColor` on `ActionItem`.** Overrides both the approve-style head letter and the tail, so `Copied` reads as one uniform success token. `theme.select.selected` (a single-color token) is the right slot: `badge.riskLow` is a `{fg, bg}` pair and `interactive.highlight` is the primary-action accent — both would mislead.

**Padded base label `"Copy "` (trailing space).** Label width stays stable across the flip to `"Copied"` — one cell wider, absorbed by `naturalContentWidth`. Avoids width thrash on the action bar.

**Test-only `_setClipboardTestHooks` on the module.** Bun's `mock.module` leaks across test files in a single `bun test` process. The hooks let the dialog's tests substitute `resolveClipboardTool`/`copyToClipboard` without module-mocking; `afterEach` restores them so the window is one test wide.

## Out of scope

- OSC 52 escape fallback. Silent failure on terminals without support would be worse than no Copy.
- Copy in `editing` or other non-confirming dialog modes.
- Adding the resolved clipboard tool to the persistent watchlist — already probed at every startup.
- Leading-space payload prefix for shell-history suppression.
- Copy over SSH — user needs a clipboard tool on the SSH origin (lemonade, etc.).
- WSL `clip.exe` line-ending normalization — payload written as-is; clip.exe handles LF.
