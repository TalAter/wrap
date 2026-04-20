---
name: forget
description: `w --forget` — interactive multi-select (or `--yolo` one-shot) to delete wrap's persisted user data
Source: src/subcommands/forget.ts, src/subcommands/forget-footprint.ts, src/subcommands/forget-delete.ts, src/tui/forget-dialog.tsx
Last-synced: 7274114
---

# `w --forget`

Subcommand that deletes Wrap's persisted user data. Interactive multi-select dialog by default; `--yolo` skips the dialog and deletes everything on the default list.

## Why

Privacy + reset. Users need a discoverable way to wipe what Wrap has learned about them and the prompts/responses logged on disk. No surgical edits — file-level deletion only.

## Items

Four buckets. All checked by default.

| Item | Path(s) | What it is |
|---|---|---|
| **Memory** | `~/.wrap/memory.json`, `~/.wrap/tool-watchlist.json` | Learned facts (per scope) + probed-tools list. Bundled together — the watchlist is conceptually part of memory. |
| **Logs** | `~/.wrap/logs/wrap.jsonl` | Append-only history: prompts, LLM responses, executed commands, exit codes. |
| **Cache** | `~/.wrap/cache/` (whole dir) | Appearance + models.dev. Auto-regenerates on next run. |
| **Temp files** | `$TMPDIR/wrap-scratch-*` | Per-session scratch dirs — normally self-clean on session end, but survive crashes. Glob matched by prefix. |

**Excluded:**
- `~/.wrap/config.jsonc` — user-intentional (providers, API keys). Never deleted by `--forget`. Use `rm` if needed.
- `~/.wrap/config.schema.json` — derived; ignored.

**Granularity:** file-level. No per-scope or per-entry surgery on `memory.json` or `wrap.jsonl`. "Memory" deletes both files outright.

## CLI surface

`--forget` is a **Command** (not a modifier option) in the subcommand registry. Same dispatch as `--log`, `--help`, `--version`.

```
w --yolo --forget          # skip dialog, delete everything (canonical form)
w --forget --yolo          # same; `--yolo` detected in args (see Arg ordering)
w --forget                 # interactive dialog
w --forget <prompt...>     # ERROR: forget is standalone
```

`--yolo` reuses the existing `--yolo` flag. Its semantics broaden here: previously "skip command-risk gates, auto-execute"; now also "skip destructive-confirm dialogs". `WRAP_YOLO=1` works the same.

**Arg ordering.** `extractModifiers` (src/core/input.ts) stops at the first non-modifier flag. `w --yolo --forget` routes `--yolo` through `setConfig()` before dispatch (so `getConfig().yolo === true`). `w --forget --yolo` leaves `--yolo` in `forgetCmd.run(args)`. Both work — `forgetCmd` treats yolo as `getConfig().yolo || args.includes("--yolo")`.

**Prompt check.** After stripping the literal `--yolo` from `args`, any remaining arg → exit 1, stderr: `--forget cannot be combined with a prompt.`

## Dialog UX

Built with the existing `Checklist` component (`src/tui/checklist.tsx`) wrapped in `ForgetDialog` (`src/tui/forget-dialog.tsx`).

Layout — name + footprint, right-aligned:

```
 ❯ [✓]  Memory        (23 facts, 4K)
   [✓]  Logs          (1,203 entries, 4M)
   [✓]  Cache         (2 files, 18K)
   [✓]  Temp files    (3 dirs, 112M)

   ↑↓ move · space toggle · enter forget · esc cancel
```

**Empty/unreadable rows** still render (label shows `(empty)` or `(unreadable)`) to keep row count and cursor behavior stable across runs. Deleting an empty bucket is a silent no-op — no row is hidden based on disk state.

**No trash glyph inside the dialog.** The trash icon is reserved for the post-delete chrome line. The dialog itself stays glyph-free so alignment doesn't drift across fonts.

### Keys

| Key | Action |
|---|---|
| ↑/↓ | move cursor |
| space | toggle current row |
| enter | forget (executes deletions on selected items) |
| esc | cancel — exit 0, nothing deleted |

Empty submit (zero items checked + Enter) is equivalent to Esc: exit 0, nothing deleted, no output. `Checklist` supports this via its `allowEmptySubmit` prop (default false so the provider wizard keeps its "must pick one" guard).

### Non-TTY

Dialog needs a raw-mode TTY. If stdin is not a TTY and `--yolo` is not set → exit 1, stderr: `Forget error: --forget requires a TTY or --yolo.`

## `--yolo` path

No dialog. No confirmation. Delete all four buckets. Exit 0.

Mental model: `--forget` = "show me what I'd delete"; `--forget --yolo` = "just do it." Matches the existing `--yolo` "I know what I'm doing" semantics.

## Output

Single line on **stderr** (per the stdout-is-useful-output invariant):

```
🗑 Forgotten.
```

- Trash icon: `\uf1f8` when `config.nerdFonts`, otherwise `🗑️`.
- No per-item breakdown. No size freed.
- Emitted only when at least one file was actually removed — a no-op (fresh install, empty submit, Esc) is silent.

## Errors & edge cases

- **Missing files** (e.g., no `memory.json` yet): silent success. Idempotent — `w --forget --yolo` always exits 0 on a fresh install.
- **Corrupt `memory.json`**: footprint shows `(unreadable)`; deletion still unlinks the file.
- **Permission errors**: print `Forget error: could not remove <path>.` to stderr, continue with remaining items, exit 1 if any item failed.
- **Concurrent Wrap process with a live `wrap-scratch-*`**: nuked. No PID/mtime check. Documented edge case; rare and user-initiated.
- **Concurrent Wrap process mid-write to `wrap.jsonl`**: `unlink` succeeds; the other process keeps writing to the now-unlinked inode until close, then a new file is created on next append. User's view: logs cleared. Acceptable; no lock.
- **Symlinks under `cache/`**: `fs.rm({recursive, force})` removes the symlink itself, not its target. Tested explicitly.
- **`WRAP_HOME` env var**: respected (uses `getWrapHome()`).
- **Other modifier flags** (`--verbose`, `--no-animation`): respected for output rendering. `--model` / `--provider` ignored (no LLM call).

## Short-circuit position

`forgetCmd` runs via `dispatch()` after `setConfig()` but before `ensureConfig()` / provider init / memory load (same as other commands, per `vault/subcommands.md` invariants). `getConfig()` is available; full config validation is not required.
