---
name: release
description: How to cut a Wrap release — semver bump, tag, watch CI, merge tap bump. Brew distribution design notes.
Source: scripts/release.ts, .github/workflows/release.yml, scripts/bump-tap.ts
Last-synced: b6ebba4
---

# Release

Wrap ships as a Bun-compiled single binary. Today the only stable distribution channel is Homebrew via the personal tap [`talater/homebrew-wrap`](https://github.com/talater/homebrew-wrap); Linux binaries are built but not yet published through a package manager. This note covers **how to cut a release** and **why the brew pipeline is shaped the way it is**.

---

## Cutting a release

From a clean `main`:

```bash
bun run release 0.0.N        # or 0.0.N-rc.1 for a prerelease
git push origin main
git push origin v0.0.N       # triggers the release workflow
```

`bun run release` (see `scripts/release.ts`) does the preflight:

- working tree must be clean
- current branch must be `main`
- tag must not already exist
- `bun run check` (lint + tests) must pass
- stamps `.bun-version` with the currently-installed `Bun.version` so CI rebuilds on the same Bun you tested with
- bumps `package.json` to the target version
- commits and tags locally

It **does not push** — you push manually so an un-intended run is easy to undo.

Once the tag lands on GitHub, the `.github/workflows/release.yml` workflow takes over:

1. **`create-release`** — cuts a draft GH Release, verifies that the tag matches `package.json` version.
2. **`build`** — four parallel matrix jobs: `aarch64-apple-darwin`, `x86_64-apple-darwin`, `aarch64-unknown-linux-gnu`, `x86_64-unknown-linux-gnu`. Each cross-compiles, strips, then (macOS only) ad-hoc codesigns, tars, and uploads to the draft.
3. **`publish-release`** — flips the draft to published. Tags containing `-` (e.g. `v0.0.2-rc.1`) are marked prerelease.
4. **`bump-tap`** — runs `scripts/bump-tap.ts`, which opens a same-repo PR in `talater/homebrew-wrap` that bumps all three URLs + sha256s (source archive, arm64-darwin, x86_64-darwin). **Skipped on prereleases.**

When the bump PR lands in the tap, `brew install talater/wrap/wrap` picks up the new version.

**Manual merge policy:** review the tap bump PR and click merge. No auto-merge until the pipeline is battle-tested.

---

## What can go wrong

- **Any build-matrix arch fails.** `publish-release` is gated by `needs: build`, so nothing publishes. Partial assets may have landed on the draft. Recovery: delete the GH Release and tag, fix, retry. `create-release` is guarded with `gh release view || gh release create`, so re-running on the same tag is safe even if the draft already exists.
- **Release CI green but `brew install` SIGKILLs on macOS.** Canonical cause is signature invalidation: something modified the binary *after* `codesign` (a `strip` step in the wrong order, brew's bottle-build path rewriting, etc.). The workflow strips before signing — keep that order. Anything that mutates the Mach-O after signing needs a re-sign.

**Partial-failure recovery recipe:**

```bash
gh release delete v0.0.N --cleanup-tag --yes
git tag -d v0.0.N
# fix the issue
bun run release 0.0.N
git push origin main
git push origin v0.0.N
```

---

## Brew distribution — design decisions

Implementation details are in the code; the rationale is here.

### Why a personal tap, not homebrew-core

homebrew-core has a high bar (popularity, maturity, source-built), ongoing review burden, and couples our release cadence to their review queue. A personal tap ships the moment a tag builds, accepts prebuilt binaries, and keeps submission to core as a later option once usage justifies it.

### Why prebuilt binaries instead of source

`bun --compile` produces a single ~63MB binary that includes the Bun runtime. Asking brew to source-build that would mean installing Bun at build time and compiling from a git checkout — slower, more moving parts, and it fights brew's "no network at build time after download" expectations. The tarball-per-arch approach mirrors zellij, starship, and most Rust-style CLI tools.

### Why rust-style target triples

`aarch64-apple-darwin` / `x86_64-apple-darwin` / `aarch64-unknown-linux-gnu` / `x86_64-unknown-linux-gnu` match homebrew-core precedent for Rust binaries. Staying on this convention makes a future core submission a smaller diff and makes the tarball names obvious to anyone who's installed a Rust CLI via brew.

### Why ad-hoc codesign, not Developer ID + notarization

macOS refuses to run unsigned binaries from outside the App Store. Ad-hoc signing (`codesign --sign - --force`) satisfies first-run execution without paying the Apple Developer fee or running a notarization flow. The cost: no Gatekeeper quarantine bypass, so a future `curl install.sh | bash` channel will show the "downloaded from internet" dialog. Brew installs are fine because brew sets trusted extended attributes. Upgrade path when a `curl` channel ships: Developer ID + `xcrun notarytool`.

### Why no `post_install`

brew formulae cannot write to `$HOME` during install. The Wrap wizard handles config on first `wrap` invocation — the setup step is deliberately a runtime concern, not an install-time one. See [[wizard]].

### Why Bun is pinned via `.bun-version` + `release.ts`

Bun's `--compile` has version-specific bugs (notably the self-sign SIGKILL, mitigated with `BUN_NO_CODESIGN_MACHO_BINARY=1`). Floating on `latest` means a Bun release can silently break the binary. Pinning in a file means there's one place to bump; auto-stamping from `Bun.version` inside `release.ts` means CI is guaranteed to use whatever Bun the release author actually tested with — no drift.

### Why `WRAP_BUILD_TARGET`, not `BUN_BUILD_TARGET`

The env var is ours — consumed by `scripts/build.ts`, not by Bun. A `BUN_` prefix invites future readers to search Bun's docs and find nothing.

### Why the formula uses no `version` field and has a top-level `url` placeholder

Two things shape the formula file:

- **No explicit `version "…"` line.** brew derives the version from the URL path (`…/v0.0.N/…`). Having both is redundant and creates a footgun if they drift.
- **Top-level `url` + `sha256` pointing at the source archive, outside `on_macos`.** `brew readall --os=all --arch=all` (what `brew test-bot --only-tap-syntax` runs) loads the formula on every OS including Linux. With all URLs nested in `on_macos`, Linux sees no URL and rejects the formula. `depends_on :macos` blocks *install* but not *load*. A top-level source-archive url satisfies the loader; `on_macos` overrides it on the actual install path. When a Linux formula block lands, both the placeholder and `depends_on :macos` come out.

### Why `scripts/bump-tap.ts`, not `dawidd6/action-homebrew-bump-formula`

`brew bump-formula-pr` (the backend the dawidd6 action wraps) is built around single-URL formulae. Our formula has three URLs (source + arm64 + intel), and the action would only update the first — intel users silently stuck on the old version. The custom script downloads the three tarballs, computes sha256s in parallel, rewrites all three `url`/`sha256` pairs in one pass, commits, force-pushes to a `bump-wrap-<version>` branch, and opens a same-repo PR via `gh`. Runs on ubuntu (no macOS runner needed).

### Why the tap's `tests.yml` is syntax-only

`brew test-bot --only-formulae` / `--build-bottle` rewrites paths inside the ad-hoc-signed Mach-O, which invalidates the signature and then `generate_completions_from_executable` SIGKILLs on the now-dead binary. The bottle-build step is also meaningless for a binary-only tap — we already ship the binary. Keep `--only-tap-syntax` (value: `brew readall` + `brew style` + `brew audit`); the actual install path is exercised by every real `brew install`.

### Why completions are a subcommand flag, not a separate `completion` command

`wrap --completion <shell> [name]` stays within the single-binary shape and doesn't require brew to know anything special. The optional `[name]` argument means the wizard can later reuse the same binary to install `alias`-flavored completions (`w` instead of `wrap`) without colliding with the brew-owned set. See [[subcommands]].

---

## Completion ownership

| Owner | Shell | Path | Command name |
|---|---|---|---|
| Brew | zsh | `/opt/homebrew/share/zsh/site-functions/_wrap` | `wrap` |
| Brew | bash | `/opt/homebrew/etc/bash_completion.d/wrap` | `wrap` |
| Brew | fish | `/opt/homebrew/share/fish/vendor_completions.d/wrap.fish` | `wrap` |
| Wizard alias (future) | zsh | `~/.zsh/completions/_<alias>` | `<alias>` |
| Wizard alias (future) | bash | `~/.local/share/bash-completion/completions/<alias>` | `<alias>` |
| Wizard alias (future) | fish | `~/.config/fish/completions/<alias>.fish` | `<alias>` |

No overlap — each file registers one distinct command name.

---

## Future distribution channels

Not built yet; the release pipeline is shaped to make fan-out cheap.

1. **Linuxbrew.** Add `on_linux do { on_arm / on_intel }` to the same formula using the already-built Linux tarballs. Remove the top-level placeholder `url` + `depends_on :macos` once Linux URLs are visible.
2. **`curl -fsSL install.sh | bash`.** Script in `talater/wrap`. Detect OS/arch, download the matching release tarball, extract to `~/.local/bin/`, prompt for alias. Gatekeeper quarantine dialog fires on macOS unless Developer ID + notarization is added.
3. **GH Release tarball (manual download).** Already shipped as side effect. Add `SHA256SUMS` for verification.
4. **`.deb` package + apt repo.** Add `dpkg-deb` step to the build matrix; host via GH Pages or packagecloud.
5. **homebrew-core.** Once usage justifies the review cost. The current formula already matches core conventions (rust-style triples, no `post_install`, `livecheck`).

Principle across all channels: the wizard owns the first-run experience (config + alias). Package managers only drop the binary and completion files. Never write `$HOME` from install hooks.

---

## `HOMEBREW_TAP_TOKEN` — one-time setup

Fine-grained PAT that lets the workflow open PRs in the tap:

1. https://github.com/settings/personal-access-tokens/new
2. Resource owner: `talater`. Repository access: only `talater/homebrew-wrap`.
3. Permissions: `Contents: Read and write` + `Pull requests: Read and write`.
4. `talater/wrap` → Settings → Secrets → Actions → `HOMEBREW_TAP_TOKEN` = the token value.

Set expiry per personal preference. Rotating the PAT is a five-minute job.
