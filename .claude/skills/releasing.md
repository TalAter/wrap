---
description: How to cut a wrap release (version bump, tag, CI, homebrew tap) and what to check when it breaks
---

# Releasing

Design rationale lives in [[release]] (`vault/release.md`) — read that for **why**. This is the **how**, plus gotchas hit in practice.

## Cutting a release

```
bun run release <version>   # e.g. bun run release 0.0.7, or 0.0.7-rc.1 for a prerelease
```

This script (`scripts/release.ts`) does preflight (clean tree, on `main`, synced with `origin/main`, `bun run check` passes), bumps `package.json`, stamps `.bun-version` to the locally-installed Bun, commits `release vX.Y.Z`, and tags. It deliberately does **not** push.

Then:

```
git push origin main
git push origin vX.Y.Z
```

The tag push triggers `.github/workflows/release.yml`: 6-arch build matrix → checksums → install verification (ubuntu/alpine/macOS) → publish → (non-prerelease tags only) opens a PR on `homebrew-wrap` to bump the tap formula.

Watch it: `gh run list --limit 3` to find the run, then `gh run watch <id>`.

**The homebrew PR does not auto-merge.** Review the diff (`gh pr view <n> --repo TalAter/homebrew-wrap`) and merge once its `test-bot` check is green. If `test-bot` fails on `brew style`, it's Homebrew's formula linter, not your version bump — fix the formula on the PR's branch and push a follow-up commit (don't reopen a new PR).

## Preflight fails with mass TUI test failures (input never registers)

If dozens of Ink tests fail with keystrokes never arriving (`onSubmit`/`onChange` timeouts, paste-listener MaxListeners warnings), suspect a corrupted `node_modules` before suspecting code: running `bun install` standalone inside `wrap/` builds a local tree but can leave stale workspace symlinks (e.g. `react`, `ink-testing-library`) pointing into monowrapo's store. Two React/ink instances split the stdin context. Check with `find node_modules -maxdepth 1 -type l`. Fix: `rm -rf wrap/node_modules`, then `bun install` from `monowrapo` — never standalone.

## wrap-core resolution — don't "fix" this if CI breaks on it

Read [[dependency-model]] (`vault/dependency-model.md`) before touching anything here. Short version: `wrap-core` is deliberately unpublished and version-matched via a local Bun workspace; CI resolves it separately via an ad hoc two-package workspace in `release.yml`'s `build` job. The two mechanisms are independent and can silently drift apart — that's exactly what broke the v0.0.6 release.

If a release fails with `wrap-core@... 404` or "Could not resolve wrap-core/...": the ad hoc workspace step in `release.yml` is what's broken, not the dependency spec. **Never** change `package.json`'s `wrap-core` version to a `github:` ref or commit SHA to "fix" CI — that defeats the local-dev workspace design and was tried and reverted once already.

## Recovering from a failed release run

The GitHub release is created as a **draft** first and only published after the full matrix + verify steps pass, so a failed run never ships anything broken. To retry after a code fix:

```
gh release delete vX.Y.Z --yes --cleanup-tag   # removes the failed draft + tag
git tag vX.Y.Z                                  # re-tag on the fixed commit
git push origin vX.Y.Z
```
