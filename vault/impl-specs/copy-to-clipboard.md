# Copy command to clipboard

Implement the `[C]opy` action in the confirming dialog. Stub lives at `src/session/reducer.ts:137-139` (`case "copy": return state;`).

## Summary

- Resolve a clipboard binary at first dialog render via `Bun.which`, module-cached for the process lifetime.
- Show `[C]opy` only if a binary was resolved.
- On press: spawn the resolved binary, pipe the command to stdin, flip the label to `Copied` in the success color, revert after 2.5s. Re-press re-copies and resets the timer.
- Strip trailing `\n` from the copied payload (paste-to-shell auto-execute footgun).
- Failures are silent — flip happens regardless of spawn outcome.

## Supported binaries

A single ordered const drives both probing and selection — first match in declared order wins:

```ts
// new: src/core/clipboard.ts
export const CLIPBOARD_TOOLS = [
  "wl-copy",   // Linux Wayland
  "xclip",     // Linux X11
  "xsel",      // Linux X11
  "pbcopy",    // macOS
  "clip.exe",  // Windows / WSL
] as const;

export const CLIPBOARD_PASTE_TOOLS = ["pbpaste", "wl-paste"] as const;
```

Spread both into `PROBED_TOOLS` (`src/discovery/init-probes.ts`) and remove the literal clipboard entries currently inline (`pbcopy`, `pbpaste`, `xclip`, `xsel`, `wl-copy`, `wl-paste`). `clip.exe` is new — currently not probed.

Per-tool argv keyed by bare name (mirrors `EDITORS` shape in `src/core/editor.ts:36`):

```ts
const CLIPBOARD_ARGS: Record<(typeof CLIPBOARD_TOOLS)[number], readonly string[]> = {
  "wl-copy": [],
  "xclip": ["-selection", "clipboard"],
  "xsel": ["-ib"],
  "pbcopy": [],
  "clip.exe": [],
};
```

TypeScript's exhaustiveness on the keyed type catches missing entries when adding a binary.

## Resolution

Mirror `resolveEditor` (`src/core/editor.ts:91`) literally: module-level cache, `Bun.which` per candidate in declared order, no dependency on `ToolProbeResult`. The probe runs at startup but doesn't expose its result outside `session.ts`/LLM context — riding it would mean adding a new plumbing channel; calling `Bun.which` for 5 binaries on first dialog render (cached thereafter) is strictly cheaper.

```ts
// src/core/clipboard.ts
export function resolveClipboardTool(): (typeof CLIPBOARD_TOOLS)[number] | null;
```

Returns the **bare tool name** (e.g. `"pbcopy"`), not the full path — argv lookup in `CLIPBOARD_ARGS` is keyed by bare name and `Bun.spawn` accepts bare names. Module-cached: first call wins for the process lifetime. Include a `_resetClipboardCacheForTests()` escape hatch matching `src/core/editor.ts:124`.

## Spawn helper

The actual write lives in `src/core/clipboard.ts`, not inline in the dialog:

```ts
// src/core/clipboard.ts
export function copyToClipboard(text: string): void;
```

- Resolves the tool via `resolveClipboardTool()` (cached). Returns silently if null.
- Strips trailing `\n` from `text`.
- `Bun.spawn([tool, ...CLIPBOARD_ARGS[tool]], { stdin: "pipe", stdout: "ignore", stderr: "ignore" })`. `stderr: "ignore"` so xclip's chatter doesn't surface in the dialog.
- `proc.stdin.write(strippedText); proc.stdin.end();` — Bun's `FileSink.end()` takes no arguments (mirrors `src/subcommands/log.ts:88-89`). Do **not** use `proc.stdin.end(payload)` (Node `Writable` API, not Bun's).
- `proc.unref()` immediately after. Do **not** `await proc.exited`. Process exit must not block on the child, and a hung `xclip` (X11 selection wait) or `clip.exe` (WSL interop stall) must not wedge the dialog.
- Wrap the entire body in `try/catch` and swallow. `Bun.spawn` throws synchronously on ENOENT race or stdin write to an already-exited child; an unhandled rejection from an async caller would surface in stderr and break the silent contract.

Synchronous, non-blocking, no return value. The dialog calls `copyToClipboard(state.response.content)` and immediately starts the flash animation.

## Action lifecycle

Keep `"copy"` in the `ActionId` union (`src/session/state.ts:179`) and keep the reducer's stub at `reducer.ts:137` returning state unchanged. The dialog routes the action away from dispatch via a small interception in the existing `dispatchAction` helper (`src/tui/response-dialog.tsx:420`):

```ts
const dispatchAction = (id: ActionId) => {
  if (id === "copy") {
    copyToClipboard(state.response.content);
    setFlashUntil(Date.now() + 2500);
    return;
  }
  dispatch({ type: "key-action", action: id });
};
```

Single source of truth: the conditional `CONFIRMING_ACTIONS` list (below) feeds both bar items and hotkey wiring. Copy's keypress lands in `dispatchAction` like every other action, but is intercepted before dispatch.

## Bar items + hotkeys

`CONFIRMING_ACTIONS` is currently a module-level `as const` (`response-dialog.tsx:25-35`) and `CONFIRMING_BAR_ITEMS` is its derived map (`response-dialog.tsx:39-43`). Both must move **inside** the component (or be wrapped in a `useMemo`) so they can read `clipboardTool`.

Mirror `appendEditorAction` (`response-dialog.tsx:65-74`):

```ts
function appendCopyAction(
  base: ReadonlyArray<{ id: ActionId; label: string; primary: boolean }>,
  clipboardTool: string | null,
) {
  if (!clipboardTool) return base;
  return [...base, { id: "copy" as const, label: "Copy ", primary: false }];
}
```

Plain append (not insert-before-Esc) — the confirming bar has no Esc terminal item, unlike the editor case.

Inside the component, derive the conditional `actions` once per render from `CONFIRMING_ACTIONS_BASE` (without copy) + `appendCopyAction`, then derive `barItems` and `hotkeyBindings` from the same `actions`. When `clipboardTool` is null, no `c` binding is registered and the bar item is absent.

`CONFIRMING_BAR_WIDTH = 61` (`response-dialog.tsx:36`) is consumed only as the `MIN_INNER_WIDTH` floor (line 37) for `naturalContentWidth`, not the bar's own width. No constant bump needed; `naturalContentWidth` already widens at render time.

## Flash + revert

Single piece of dialog-local state:

```ts
const [flashUntil, setFlashUntil] = useState<number | null>(null);
```

- `flashUntil` is `Date.now() + 2500` while flashed, `null` otherwise. Each press updates it (different timestamp ⇒ new value), which both triggers the timer effect's cleanup → reset and re-fires the side effect by being a fresh value.
- **Spawn site:** synchronous, inside `dispatchAction` (see §Action lifecycle). Not in a `useEffect`. The dialog calls `copyToClipboard(state.response.content)` and `setFlashUntil(...)` in the same handler. One site for the spawn, no effect-vs-handler ambiguity.
- **Timer effect** with dep `[flashUntil]`: when non-null, `setTimeout(() => setFlashUntil(null), 2500)`. **Cleanup must `clearTimeout`** so re-press doesn't stack timers (old timer would clear flash mid-second-press) and unmount doesn't `setState` on a dead component.
- Visible label derives from `flashUntil != null`. No `Date.now()` math at render time.

## Label flip

Padded base label `"Copy "` (trailing space, width 5). On flip, label becomes `"Copied"` (width 6). Ink wraps approve-style render in `" " + label + " "`, so the bar transitions `" Copy  │ "` → `" Copied │ "` — one cell wider, absorbed naturally by `naturalContentWidth`.

Color when flashed: `theme.select.selected` (existing single-color token, dark `[120, 230, 160]` / light `[15, 125, 55]` per `src/core/theme.ts`). `badge.riskLow` is a `{fg, bg}` pair — not a drop-in. `interactive.highlight` is the primary-action accent and would conflate "primary action" with "just succeeded".

`ActionItem` (`src/tui/action-bar.tsx:4-16`) gains an optional `color?: string`. When set, it overrides BOTH `accent` and `tail` resolution in the approve-style branch (so `Copied` reads as a single uniform success token, with the `C` still underlined). Only the dialog uses this field — no other call sites need to change.

## LLM noise

Adding `clip.exe` to `PROBED_TOOLS` adds one bare name to the "Unavailable tools" comma list for non-WSL users. The other clipboard tools are already probed today — Mac users already see `xclip, xsel, wl-copy, wl-paste` as unavailable. Net noise: one word.

## Failure mode

Silent. Flip happens regardless of spawn exit code or throw. `proc.unref()` + `try/catch` keep failure invisible. Not designing error UI for a near-zero-incidence dead-letter case.

## Tests (TDD — read `.claude/skills/testing.md` first)

- **`tests/clipboard.test.ts`**
  - `resolveClipboardTool` returns first match in declared order; null when no candidate is on `Bun.which`. Uses the test-only cache reset.
  - `copyToClipboard` strips trailing `\n` from payload before write (mock `Bun.spawn`).
  - `copyToClipboard` invokes spawn with `stdio: ["pipe", "ignore", "ignore"]` and calls `proc.unref()`.
  - `copyToClipboard` swallows synchronous throws from `Bun.spawn`.
  - `copyToClipboard` no-ops when resolver returns null.
- **`tests/init-probes.test.ts`** (or wherever PROBED_TOOLS is asserted)
  - Spreading `CLIPBOARD_TOOLS` and `CLIPBOARD_PASTE_TOOLS` into `PROBED_TOOLS` exposes every tool to probing (set-inclusion).
- **`tests/response-dialog.test.tsx`** (using ink-testing-library + fake timers)
  - With `resolveClipboardTool` mocked to return `"pbcopy"`: `Copy` item rendered; pressing `c` calls `copyToClipboard` once with `state.response.content`; label flips to `Copied` and reverts after 2500ms.
  - With `resolveClipboardTool` mocked to return null: no `Copy` bar item, bare `c` triggers no copy.
  - Re-press while flashed: `copyToClipboard` called again, timer resets (advance 2400ms → press again → advance 2400ms → still flashed; advance 100 more → reverted).
  - `Copied` renders with the `select.selected` theme color.

## Out of scope

- OSC 52 escape fallback. Skipped — silent failure on terminals without OSC 52 support would be worse than no Copy at all.
- Copy in `editing` or other non-confirming dialog modes.
- Adding the resolved clipboard tool to the persistent watchlist — already probed at every startup.
- Leading-space payload prefix for shell history suppression.
- Copy over SSH — user needs a clipboard tool on the SSH origin (lemonade, etc.); not Wrap's problem today.
- WSL `clip.exe` line-ending normalization — payload written as-is; clip.exe handles LF.
- Removing `"copy"` from `ActionId` / deleting the reducer stub. Keeping the stub is a one-line cost; dropping it would narrow the union and force every test asserting reducer exhaustiveness to update. Not worth it.

## Files touched

- `src/core/clipboard.ts` — new: `CLIPBOARD_TOOLS`, `CLIPBOARD_PASTE_TOOLS`, `CLIPBOARD_ARGS`, `resolveClipboardTool`, `copyToClipboard`, `_resetClipboardCacheForTests`.
- `src/discovery/init-probes.ts` — spread both clipboard consts into `PROBED_TOOLS`; remove the now-duplicated literals.
- `src/tui/response-dialog.tsx` — move `CONFIRMING_ACTIONS` and `CONFIRMING_BAR_ITEMS` inside the component (or memoize); add `appendCopyAction`; intercept `"copy"` in `dispatchAction`; add `flashUntil` state and timer effect; pass `color` on the Copy `ActionItem` when flashed.
- `src/tui/action-bar.tsx` — add optional `color?: string` to `ActionItem`; use it to override both `accent` and `tail` in the approve-style branch when set.
- Tests: `tests/clipboard.test.ts` (new), additions to `tests/response-dialog.test.tsx` and the existing init-probes test file.
