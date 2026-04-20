---
name: forget
description: `w --forget` — interactive multi-select to delete wrap's persisted user data (memory, logs, cache, temp files). `--yolo` skips the dialog.
status: spec
---

# `w --forget`

Subcommand that deletes wrap's persisted user data. Interactive multi-select dialog by default; `--yolo` skips dialog and deletes everything that's on the default deletion list.

## Why

Privacy + reset. Users need a discoverable way to wipe what wrap has learned about them and the prompts/responses logged on disk. No surgical edits — file-level deletion only.

## Items

Four buckets. All checked by default in the dialog.

| Item | Path(s) | What it is |
|---|---|---|
| **Memory** | `~/.wrap/memory.json`, `~/.wrap/tool-watchlist.json` | Learned facts (per scope) + probed-tools list. Bundled together — watchlist is conceptually part of memory. |
| **Logs** | `~/.wrap/logs/wrap.jsonl` | Append-only history: prompts, LLM responses, executed commands, exit codes. |
| **Cache** | `~/.wrap/cache/` (whole dir) | Appearance + models.dev. Auto-regenerate on next run. |
| **Temp files** | `os.tmpdir()/wrap-scratch-*` | Per-session scratch dirs that normally self-clean on session end but survive crashes. Glob match by `wrap-scratch-` prefix. |

**Excluded:**
- `~/.wrap/config.jsonc` — user-intentional (providers, API keys). Never deleted by `--forget`. Use `rm` if needed.
- `~/.wrap/config.schema.json` — derived; ignored.

**Granularity:** file-level. No per-scope or per-entry surgery on `memory.json` or `wrap.jsonl`. "Memory" deletes both files outright.

## CLI surface

`--forget` is a **Command** (not an Option) in the subcommand registry. Same dispatch as `--log`, `--help`, `--version`.

```
w --yolo --forget          # skip dialog, delete all default items (canonical form)
w --forget --yolo          # same; `--yolo` detected in args (see Arg ordering)
w --forget                 # interactive dialog
w --forget <prompt...>     # ERROR: forget is standalone
```

`--yolo` reuses the existing `--yolo` flag. Semantics broaden: previously "skip command-risk gates, auto-execute"; now also "skip destructive-confirm dialogs". `WRAP_YOLO=1` env var works the same.

**Arg ordering.** `extractModifiers` (src/core/input.ts) stops at the first non-modifier flag. `w --yolo --forget` routes `--yolo` through `setConfig()` before dispatch (so `getConfig().yolo === true`). `w --forget --yolo` leaves `--yolo` in `forgetCmd.run(args)`. Both must work — `forgetCmd` treats yolo as `getConfig().yolo || args.includes("--yolo")`.

**Prompt check.** After stripping the literal `--yolo` from `args`, any remaining arg → exit 1, stderr: `--forget cannot be combined with a prompt.`

Listed in `--help` output. Help detail: `w --help --forget` describes items and `--yolo` interaction.

## Dialog UX

Built with existing `Checklist` component (`src/tui/checklist.tsx`) wrapped in a new `ForgetDialog` (`src/tui/forget-dialog.tsx`).

Layout — name + footprint, dot-leader aligned:

```
 ❯ [✓]  Memory               (23 facts, 4K)
   [✓]  Logs      (1,203 entries, 4M)
   [✓]  Cache               (2 files, 18K)
   [✓]  Temp files     (3 dirs, 112M)

   ↑↓ move · space toggle · enter forget · esc cancel
```

Size formatter: reuse `formatSize` from `src/fs/temp.ts` (`B` / `K` / `M` units, rounded). No new formatter.

Footprint computation:
- **Memory**: open `memory.json`, count facts across all scopes. If parse fails or file missing → treat as unreadable/empty. Sum byte sizes of `memory.json` + `tool-watchlist.json`. Parsing memory.json for fact count is required and overrides the "don't open files" guideline for this one field — wrapped in try/catch.
- **Logs**: line count of `wrap.jsonl` (streamed read; no full parse); byte size of file.
- **Cache**: recursive file count + total bytes under `cache/`. Reuse `walk` helper pattern from `src/fs/temp.ts`.
- **Temp files**: dir count under `os.tmpdir()` matching `wrap-scratch-*`; recursive total bytes via same walk pattern.

Items with size 0 / missing / unreadable are still shown (greyed) with `(empty)` instead of size — keeps row count stable; never re-orders the list. Selecting an empty item is a silent no-op.

**No trash glyph inside the dialog.** The `🗑`/`\uf1f8` icon is reserved for the post-delete chrome line (see §Output). Dialog stays glyph-free to keep row alignment stable across fonts.

### Keys

| Key | Action |
|---|---|
| ↑/↓ | move cursor |
| space | toggle current row |
| enter | submit (executes deletions on selected items) |
| esc | cancel — exit 0, nothing deleted |

Empty submit (zero items checked + Enter) → exit 0, no output. Same outcome as Esc. To support this, extend `Checklist` with an `allowEmptySubmit` prop (default false to keep existing wizard behavior; `ForgetDialog` opts in). Esc is wired via `useInput` in `ForgetDialog` (Ink allows multiple `useInput` listeners in the same tree).

### Non-TTY

Dialog requires a raw-mode TTY (Ink `useInput`). If stdin is not a TTY and `--yolo` is not set → exit 1, stderr: `Forget error: --forget requires a TTY or --yolo.` Prevents hangs in pipes / CI.

## `--yolo` path

No dialog. No confirmation. Delete all four default items immediately. Exits 0.

Mental model: `--forget` = "show me what I'd delete"; `--forget --yolo` = "just do it." Matches the existing `--yolo` "I know what I'm doing" semantics.

## Output

Single line on **stderr** (per wrap's stdout-is-useful-output rule):

```
🗑 Forgotten.
```

- Trash icon: `\uf1f8` if `config.nerdFonts`, else `🗑️`, else nothing (bare `Forgotten.`).
- No per-item breakdown. No size freed.
- Same line for both dialog and `--yolo` paths **whenever at least one file was actually removed**.
- **Nothing-to-delete** (all targets already absent, or empty submit, or Esc): no output. Exit 0.

## Errors & edge cases

- **Missing files** (e.g., no `memory.json` yet): silent success. Idempotent — `w --forget --yolo` always exits 0 on a fresh install.
- **Corrupt `memory.json`**: footprint shows `(unreadable)`; deletion still unlinks the file.
- **Permission errors**: print `Forget error: could not remove <path>.` to stderr, continue with remaining items, exit 1 if any item failed.
- **Concurrent wrap process** — live `wrap-scratch-*`: nuke it. No PID/mtime check. Documented edge case; rare and user-initiated.
- **Concurrent wrap process** — mid-write to `wrap.jsonl`: `unlink` succeeds; other process keeps writing to the now-unlinked inode until close, then a new file is created on next append. User's view: logs cleared. Acceptable; no lock.
- **Symlinks under `cache/`**: `fs.rm({recursive,force})` removes the symlink itself, not its target. Test asserts this.
- **`WRAP_HOME` env var**: respected (use `getWrapHome()`).
- **Other modifier flags** (e.g. `--verbose`, `--no-animation`): respected for output rendering. `--model` / `--provider` ignored (no LLM call).

## Implementation outline

New files:
- `src/subcommands/forget.ts` — `forgetCmd: Command`. Entry point.
- `src/tui/forget-dialog.tsx` — Ink component wrapping `Checklist` + Esc handler + footprint computation.

Modified files:
- `src/subcommands/registry.ts` — append `forgetCmd` to `commands`.
- `src/tui/checklist.tsx` — add `allowEmptySubmit?: boolean` prop; when true, relax the `checked.size > 0` guard on Enter (current line ~44) so `onSubmit([])` fires on empty submit.
- `vault/subcommands.md` — add `--forget` row to Commands table.
- `vault/memory.md` — one-line mention: "Wipe with `w --forget` (see [[forget]])."

### Control flow (`forgetCmd.run(args)`)

1. Compute `yolo = getConfig().yolo || args.includes("--yolo")`.
2. Filter `--yolo` out of `args`; if any arg remains → print prompt-conflict error, exit 1.
3. Compute footprint for all four buckets.
4. If `yolo`: select all four; skip to step 7.
5. If stdin is non-TTY → print TTY error, exit 1.
6. Render `ForgetDialog`. Await submit/cancel. Esc or empty submit → exit 0, no output.
7. For each selected item, delete the corresponding paths. Track per-item success + whether anything was actually removed (distinguishes ENOENT from real delete).
8. Any failure → print error lines, exit 1. At least one real delete → print `🗑 Forgotten.` on stderr, exit 0. Zero real deletes (all absent) → no output, exit 0.

Short-circuit position: `forgetCmd` runs via `dispatch()` after `setConfig()` but before `ensureConfig()` / provider init / memory load (same as other commands per `vault/subcommands.md` invariants). `getConfig()` is available; full config validation is not required.

### Deletion primitives

- Files: `fs.promises.unlink`. ENOENT → silent success (no "real delete" counted).
- Directories: `fs.promises.rm(path, { recursive: true, force: true })`.
- Glob for scratch: `fs.promises.readdir(os.tmpdir())`, filter by `startsWith("wrap-scratch-")`, then `rm` each.

## Testing

TDD per project rule. Pattern: `tests/helpers.ts` `wrap()` / `tmpHome()`; Ink TUI via `tests/helpers/mock-stdin.ts` + `mock-stream.ts` (see `tests/dialog.test.tsx`, `tests/config-wizard-dialog.test.tsx`).

CLI-level:
- `forgetCmd` rejects non-`--yolo` args → exit 1, stderr message.
- `w --yolo --forget` and `w --forget --yolo` both delete all four buckets without TUI render. Both exit 0.
- Missing files (fresh install) → exit 0, no output.
- Permission error on one item → exit 1, others still deleted.
- Concurrent session appending to `wrap.jsonl` during delete: unlink succeeds (documented behavior).
- Non-TTY stdin + no `--yolo` → exit 1, TTY error message.
- Output goes to stderr; stdout silent.
- `WRAP_HOME` override respected.

Dialog:
- Empty submit (all deselected + Enter) → exit 0, nothing deleted, nothing printed.
- Esc cancel → exit 0, nothing deleted, nothing printed.
- Default-checked state: all four items selected on open.

Footprint:
- Memory: empty file shows `(empty)`; populated shows fact count + size; corrupt JSON shows `(unreadable)`.
- Logs: line count matches entries; empty file shows `(empty)`.
- Cache: file count + total bytes; missing `cache/` dir shows `(empty)`.
- Scratch: dir count + recursive bytes; no matching dirs shows `(empty)`.
- Scratch glob matches `wrap-scratch-*` only (not other `wrap-*` or unrelated dirs).

Safety:
- Symlinks under `cache/` — only the symlink is removed, not the target.
- `Checklist` without `allowEmptySubmit` still rejects empty Enter (regression guard for existing wizard).

## Open questions

- **Nothing-to-delete silent vs `Forgotten.`** — current spec: silent. Alternative: always print `🗑 Forgotten.` for reassurance even on no-op. Low stakes either way.
