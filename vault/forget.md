---
name: forget
description: `w --forget` — delete Wrap's persisted user data
Source: src/subcommands/forget.ts, src/subcommands/forget-footprint.ts, src/subcommands/forget-delete.ts, src/tui/forget-dialog.tsx
Last-synced: 0a22f2a
---

# `w --forget`

Deletes Wrap's persisted user data. Interactive multi-select dialog by default; `--yolo` skips it and deletes everything.

## Why

Privacy + reset. Users need a discoverable way to wipe what Wrap learned about them and what got logged on disk.

## Buckets

Four file-level buckets, all checked by default: **memory** (learned facts + tool watchlist — bundled because the watchlist is conceptually memory), **logs**, **cache** (auto-regenerates), **temp files** (per-session scratch dirs that survived crashes; matched by prefix glob).

Excluded: the user's own config and the bundled schema. Config is user-intentional (providers, API keys); use `rm` if you really want it gone.

**Granularity is file-level.** No per-scope or per-entry surgery — keeps the surface tiny and unambiguous.

## UX

Dialog uses the shared checklist component. Rows always render even when a bucket is empty or unreadable, so cursor behaviour stays stable across runs. Empty submit equals cancel: exit 0, nothing deleted, no output.

Output is a single stderr line with a trash glyph (per the stdout-is-useful invariant). Emitted only when something was actually removed — fresh installs and cancellations are silent.

Mental model: `--forget` shows what would be deleted; `--forget --yolo` just does it. Matches the existing yolo "I know what I'm doing" semantics — yolo's meaning broadens here from "skip risk gates" to also "skip destructive confirms."

## Behaviour

- Idempotent. Missing files are silent successes.
- Non-TTY without yolo → exit 1 with a plain-language error. Dialog needs raw-mode TTY.
- Combined with a prompt → exit 1, plain error.
- Permission errors print one stderr line per failure, continue, exit 1 if any failed.
- Concurrent Wrap process: temp scratch dirs are nuked without PID/mtime checks (rare, user-initiated). Log file is unlinked while the other process keeps writing to the now-orphan inode until close — acceptable; no lock.
- Cache symlinks: the link is removed, not its target.
- `WRAP_HOME` respected.

Short-circuits like other commands: runs after settings resolve but before provider/memory init. See [[subcommands]].
