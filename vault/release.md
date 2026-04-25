---
name: release
description: Brew distribution architecture and design decisions
Source: scripts/release.ts, .github/workflows/release.yml, scripts/bump-tap.ts
Last-synced: 0a22f2a
---

# Release

Wrap ships as a Bun-compiled single binary. Today the only stable channel is Homebrew via the personal tap [`talater/homebrew-wrap`](https://github.com/talater/homebrew-wrap). Linux binaries are built but not yet published through a package manager.

How-to-cut-a-release lives in `scripts/release.ts` and the `release.yml` workflow. This note covers **why** the pipeline is shaped the way it is.

## Pipeline shape

Local `bun run release` does preflight (clean tree, on main, tests pass), stamps `.bun-version` with the currently-installed Bun, bumps `package.json`, commits and tags. It deliberately does **not** push — push is manual so an unintended run is easy to undo.

Tag push triggers GH Actions: build matrix (4 arch tarballs, macOS ad-hoc-signed after strip), publish the draft release, then open a PR in the tap that bumps source + per-arch URLs/sha256s. Prereleases (`-rc.N`) skip the tap bump.

## Design decisions

- **Personal tap, not homebrew-core.** Core has a high bar, ongoing review burden, and couples release cadence to their queue. Tap ships the moment a tag builds. Core remains a later option.
- **Prebuilt binaries, not source-built.** `bun --compile` produces a ~63MB binary including the runtime. Source-building would mean Bun-at-build-time and fights brew's "no network after download" expectations. Mirrors zellij/starship convention.
- **Rust-style target triples.** Matches homebrew-core precedent for binary CLIs; smaller diff for a future core submission.
- **Sigstore build attestations.** Each arch tarball is attested via `actions/attest-build-provenance`, binding sha256 to commit + workflow. Defends against tampered binaries (compromised release token, swapped asset, CDN attack). [OpenSSF proposal](https://repos.openssf.org/proposals/build-provenance-and-code-signing-for-homebrew.html) to make provenance mandatory in brew is advancing.
- **Ad-hoc codesign, not Developer ID + notarization.** Satisfies macOS first-run execution without the Apple fee. Trade-off: no Gatekeeper bypass, so a future `curl install.sh | bash` channel will show the "downloaded from internet" dialog. Brew is fine because brew sets trusted xattrs.
- **No `post_install`.** Brew formulae cannot write to `$HOME` during install. Wizard owns first-run config — runtime concern, not install-time. See [[wizard]].
- **Bun pinned via `.bun-version` + auto-stamped at release time.** `bun --compile` has had version-specific regressions ([oven-sh/bun#29120](https://github.com/oven-sh/bun/issues/29120)). Floating on `latest` means a Bun release can silently break the binary. Auto-stamping from `Bun.version` guarantees CI uses whatever Bun the release author tested with.
- **Formula has no `version` field, has top-level placeholder `url`.** Brew derives version from URL path; a separate `version` is a drift footgun. Top-level URL outside `on_macos` is needed because `brew readall --os=all` (run by tap-syntax checks) loads the formula on Linux too — `depends_on :macos` blocks install but not load. Both come out when a Linux block lands.
- **Custom `bump-tap.ts`, not `dawidd6/action-homebrew-bump-formula`.** Backend `brew bump-formula-pr` only updates the first URL; our formula has three (source + arm64 + intel). Intel users would silently stick on the old version.
- **Tap CI is `--only-tap-syntax`.** `--only-formulae` / `--build-bottle` rewrites paths inside the ad-hoc-signed Mach-O, invalidating the signature. Bottle-build is meaningless for a binary-only tap anyway. The actual install path is exercised by every real `brew install`.
- **Completions as a `--completion <shell>` flag, not a separate command.** Stays within the single-binary shape. The optional `[name]` argument lets the wizard later install alias-flavored completions (`w` instead of `wrap`) without colliding with brew-owned files.

## Completion ownership

Brew owns `wrap` completions (zsh/bash/fish in standard system paths). The wizard will own alias completions in user paths. No overlap — each file registers one distinct command name.

## Future channels

Pipeline is shaped to make fan-out cheap: Linuxbrew (add `on_linux` to existing formula), `curl install.sh | bash` (Gatekeeper dialog unless notarization is added), `.deb` + apt repo, eventually homebrew-core once usage justifies the review cost.

Principle across all channels: the wizard owns first-run UX (config + alias). Package managers only drop the binary and completion files. Never write `$HOME` from install hooks.
