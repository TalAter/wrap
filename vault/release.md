---
name: release
description: Distribution architecture and design decisions (brew tap + curl-sh installer)
Source: scripts/release.ts, scripts/install.sh, .github/workflows/release.yml, scripts/bump-tap.ts
Last-synced: ec24c98
---

# Release

Wrap ships as a Bun-compiled single binary on macOS and Linux via two channels: the personal Homebrew tap [`talater/homebrew-wrap`](https://github.com/talater/homebrew-wrap) and a curl-sh installer at `wrap.talater.com/install.sh`.

How-to-cut-a-release lives in `scripts/release.ts` and the `release.yml` workflow. This note covers **why** the pipeline is shaped the way it is.

## Pipeline shape

Local `bun run release` does preflight (clean tree, on main, tests pass), stamps `.bun-version` with the currently-installed Bun, bumps `package.json`, commits and tags. It deliberately does **not** push — push is manual so an unintended run is easy to undo.

Tag push triggers GH Actions: build matrix (6 arch tarballs — mac arm/intel, linux glibc arm/intel, linux musl arm/intel; macOS stripped + ad-hoc-signed; Linux untouched), generate `checksums.txt`, upload `install.sh` as a release asset, run `verify-install` smoke (real install + re-run on ubuntu/alpine/macos), publish the draft release, then open a PR in the tap. The tap consumes only the four non-musl triples; musl is install-script-only. Prereleases (`-rc.N`) skip the tap bump.

## Install script

`scripts/install.sh` is the source of truth — uploaded byte-identical as a release asset. `wrap.talater.com/install.sh` is a Cloudflare Pages redirect to `releases/latest/download/install.sh`.

The script is short and well-commented; the **why** for each non-obvious decision (atomic same-dir rename, POSIX `pipefail` workaround on the checksum verify, Alpine `ldd 2>&1 | grep` musl probe, `.zshenv` not `.zshrc`, `grep -qxF` whole-line idempotency) lives next to the code. Don't duplicate it here.

Tested by three independent rigs: `shellcheck` (POSIX-portability gate before any tarball ships), `scripts/test-install.sh` (local Docker rig the maintainer runs while iterating — ubuntu+alpine arm64 containers against locally-built tarballs), and the CI `verify-install` matrix job (linux glibc, linux musl, macOS — runs the same assertion checklist at `scripts/install-assert.sh` against the just-uploaded draft assets, gates `publish-release` on success). No in-process unit tests — install.sh is orchestration code; every interesting failure mode involves the real filesystem.

## Design decisions

- **Personal tap, not homebrew-core.** Core has a high bar, ongoing review burden, and couples release cadence to their queue. Tap ships the moment a tag builds. Core remains a later option.
- **Prebuilt binaries, not source-built.** `bun --compile` produces a ~100MB binary including the runtime. Source-building would mean Bun-at-build-time and fights brew's "no network after download" expectations. Mirrors zellij/starship convention.
- **Rust-style target triples.** Matches homebrew-core precedent for binary CLIs; smaller diff for a future core submission.
- **Sigstore build attestations.** Each arch tarball is attested via `actions/attest-build-provenance`, binding sha256 to commit + workflow. Defends against tampered binaries (compromised release token, swapped asset, CDN attack). [OpenSSF proposal](https://repos.openssf.org/proposals/build-provenance-and-code-signing-for-homebrew.html) to make provenance mandatory in brew is advancing.
- **Ad-hoc codesign, not Developer ID + notarization.** Satisfies macOS first-run execution without the Apple fee. Trade-off: no Gatekeeper bypass, so the **manual browser download** path shows the "downloaded from internet" dialog. Curl-sh and brew don't trigger it — `curl` doesn't set `com.apple.quarantine` (only quarantine-aware apps like Safari/Chrome/Mail do). The Gatekeeper workaround (`xattr -d com.apple.quarantine wrap` or right-click → Open) is documented on the manual-download row of the website only.
- **No `post_install`.** Brew formulae cannot write to `$HOME` during install. Wizard owns first-run config — runtime concern, not install-time. See [[wizard]].
- **Bun pinned via `.bun-version` + auto-stamped at release time.** `bun --compile` has had version-specific regressions ([oven-sh/bun#29120](https://github.com/oven-sh/bun/issues/29120)). Floating on `latest` means a Bun release can silently break the binary. Auto-stamping from `Bun.version` guarantees CI uses whatever Bun the release author tested with.
- **Formula has no `version` field.** Brew derives version from URL path; a separate `version` is a drift footgun.
- **Linux binaries aren't stripped.** GNU strip discards Bun's standalone-compile trailer (appended past the ELF image), leaving a binary that boots as bare `bun` and never runs the embedded entrypoint. macOS `strip -x` only touches the Mach-O symbol table, so it's safe. Cost of skipping Linux strip: negligible.
- **Custom `bump-tap.ts`, not `dawidd6/action-homebrew-bump-formula`.** Backend `brew bump-formula-pr` only updates the first URL; our formula has four binary URLs (mac arm/intel + linux arm/intel). Other arches would silently stick on the old version.
- **Tap CI is `--only-tap-syntax`.** `--only-formulae` / `--build-bottle` rewrites paths inside the ad-hoc-signed Mach-O, invalidating the signature. Bottle-build is meaningless for a binary-only tap anyway. The actual install path is exercised by every real `brew install`.
- **Completions as a `--completion <shell>` flag, not a separate command.** Stays within the single-binary shape. The optional `[name]` argument lets the wizard later install alias-flavored completions (`w` instead of `wrap`) without colliding with brew-owned files.

## Completion ownership

Brew owns `wrap` completions (zsh/bash/fish in standard system paths). The wizard will own alias completions in user paths. No overlap — each file registers one distinct command name.

## Future channels

Pipeline is shaped to make fan-out cheap: `.deb` + apt repo, eventually homebrew-core once usage justifies the review cost.

Principle across all channels: the wizard owns first-run UX (config + alias). Package managers only drop the binary and completion files. Never write `$HOME` from install hooks.
