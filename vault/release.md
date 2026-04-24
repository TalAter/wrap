---
name: release
description: How to cut a Wrap release — semver bump, tag, watch CI, merge tap bump. Brew distribution design notes.
Source: scripts/release.ts, .github/workflows/release.yml
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
2. **`build`** — four parallel matrix jobs: `aarch64-apple-darwin`, `x86_64-apple-darwin`, `aarch64-unknown-linux-gnu`, `x86_64-unknown-linux-gnu`. Each cross-compiles the binary, strips symbols, then (macOS only) ad-hoc codesigns it, tars it, and uploads to the draft.
3. **`publish-release`** — flips the draft to published. Tags containing `-` (e.g. `v0.0.2-rc.1`) are marked prerelease.
4. **`bump-tap`** — runs on macOS, uses `dawidd6/action-homebrew-bump-formula` to open a PR in `talater/homebrew-wrap` that bumps the formula URL to the new tag and updates sha256s. **Skipped on prereleases.**

When the bump PR lands in `talater/homebrew-wrap`, `brew install talater/wrap/wrap` picks up the new version.

**Manual merge policy:** review the tap bump PR and click merge. No auto-merge until the pipeline is battle-tested.

---

## What can go wrong

- **Any build-matrix arch fails.** `publish-release` is gated by `needs: build`, so nothing publishes. Partial assets may have landed on the draft. Recovery: delete the GH Release and tag, fix, retry. `create-release` is guarded with `gh release view || gh release create`, so re-running the workflow on the same tag is safe even if the draft already exists.
- **Tap bump fails after publish.** Publish already happened, so `brew install` against the pinned tarball URL still works for whoever can find the release — but the tap won't move forward automatically. Recover by merging the PR by hand (or fixing whatever tripped the action and re-triggering).
- **Release CI green but `brew install` SIGKILLs on macOS.** The canonical cause is signature invalidation: `strip` was run *after* `codesign`, which kills the Mach-O signature and macOS refuses to execute. The workflow currently strips before signing — keep it that way.

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

homebrew-core has a high bar (popularity, maturity, source-built), ongoing review burden, and couples our release cadence to their review queue. A personal tap:

- Ships the moment a tag builds.
- Accepts prebuilt binaries, so there's no need to teach brew how to build a Bun-compiled TS CLI from source.
- Keeps submission to core as a later option once usage justifies it.

### Why prebuilt binaries instead of source

`bun --compile` produces a single ~63MB binary that includes the Bun runtime. Asking brew to source-build that would mean installing Bun at build time and compiling from a git checkout — slower, more moving parts, and it fights brew's "no network at build time after download" expectations. The tarball-per-arch approach mirrors what zellij, starship, and most other Rust-style CLI tools use.

### Why rust-style target triples

`aarch64-apple-darwin` / `x86_64-apple-darwin` / `aarch64-unknown-linux-gnu` / `x86_64-unknown-linux-gnu` match homebrew-core precedent for Rust binaries (zellij, starship, etc.). Staying on this convention makes a future core submission a smaller diff and makes the tarball names obvious to anyone who's installed a Rust CLI via brew.

### Why ad-hoc codesign, not Developer ID + notarization

macOS refuses to run unsigned binaries from outside the App Store. Ad-hoc signing (`codesign --sign - --force`) satisfies the *first-run execution* requirement without paying the Apple Developer fee or running a notarization flow. The cost: no Gatekeeper quarantine bypass, so a future `curl install.sh | bash` channel will show the "downloaded from internet" dialog. Brew installs are fine because brew sets trusted extended attributes. Upgrade path when a `curl` channel ships: Developer ID + `xcrun notarytool`.

### Why no `post_install`

brew formulae cannot write to `$HOME` during install. The Wrap wizard handles config on first `wrap` invocation — the setup step is deliberately a runtime concern, not an install-time one. See [[wizard]].

### Why Bun is pinned via `.bun-version` + `release.ts`

Bun's `--compile` has version-specific bugs (notably the self-sign SIGKILL, mitigated with `BUN_NO_CODESIGN_MACHO_BINARY=1`). Floating on `latest` means a Bun release can silently break the binary. Pinning in a file means there's one place to bump. Auto-stamping that file from `Bun.version` inside `release.ts` means CI is guaranteed to use whatever Bun the release author actually tested with — no drift between "the Bun I ran `bun run check` on" and "the Bun CI compiles with."

### Why the formula uses literal version URLs, not interpolation

`url "…/v0.0.1/wrap-<triple>.tar.gz"`, not `url "…/v#{version}/…"`. `brew bump-formula-pr` (which the auto-bump action wraps) does an `inreplace` on the formula file looking for the literal previous URL; with `#{version}` interpolation, the regex never matches the source and the bump fails with `inreplace failed`. Explicit URLs make the file one more place to keep in sync, but the auto-bump takes care of that.

### Why `bump-tap` runs on macOS

The formula is `on_macos do`-only (no Linux block yet). When `dawidd6/action-homebrew-bump-formula` loads the formula on a Linux runner, the `on_macos` block is skipped, no `url` is visible, and the action errors with `formula requires at least a URL`. Running the job on macOS makes the `on_arm`/`on_intel` URLs load, and the action can compute both sha256s. If we ever add a Linux formula block, the macOS runner still handles everything — the macOS side also evaluates the `on_linux` block just fine, it's just formula Ruby.

### Why completions are a subcommand flag, not a separate `completion` command

`wrap --completion <shell> [name]` stays within the single-binary shape and doesn't require brew to know anything special. The optional `[name]` argument means the wizard can later reuse the same binary to install `alias`-flavored completions (`w` instead of `wrap`) without colliding with the brew-owned set. See [[subcommands]] for the completion subcommand shape.

### Why `WRAP_BUILD_TARGET`, not `BUN_BUILD_TARGET`

The env var is ours — it's consumed by `scripts/build.ts`, not by Bun. Naming it with a `BUN_` prefix invites future readers to search Bun's docs and find nothing. `WRAP_*` makes the ownership obvious.

---

## Completion ownership

Who writes which completion file, for which command name:

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

1. **Linuxbrew.** Add `on_linux do { on_arm / on_intel }` to the same formula using the already-built Linux tarballs. `bump-tap` continues to run on macOS.
2. **`curl -fsSL install.sh | bash`.** Script in `talater/wrap`. Detect OS/arch, download the matching release tarball, extract to `~/.local/bin/`, prompt for alias. Gatekeeper quarantine dialog fires unless Developer ID + notarization is added — see above.
3. **GH Release tarball (manual download).** Already shipped as side effect. Add `SHA256SUMS` for verification.
4. **`.deb` package + apt repo.** Add `dpkg-deb` step to the build matrix, host via GH Pages or packagecloud.
5. **homebrew-core.** Once usage justifies the review cost. The current formula already matches core conventions (rust-style triples, no `post_install`, `livecheck`).

Principle across all channels: the wizard owns the first-run experience (config + alias). Package managers only drop the binary and completion files. Never write `$HOME` from install hooks.

---

## One-time setup (already done for v0.0.1)

### `HOMEBREW_TAP_TOKEN` secret

Fine-grained PAT that lets the workflow open PRs in the tap:

1. https://github.com/settings/personal-access-tokens/new
2. Resource owner: `talater`. Repository access: only `talater/homebrew-wrap`.
3. Permissions: `Contents: Read and write` + `Pull requests: Read and write`.
4. `talater/wrap` → Settings → Secrets → Actions → `HOMEBREW_TAP_TOKEN` = the token value.

Set expiry per personal preference. Rotating the PAT is a five-minute job.
