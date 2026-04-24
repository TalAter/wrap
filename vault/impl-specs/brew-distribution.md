---
title: Brew distribution
status: implemented (v0.0.1 shipped 2026-04-24)
---

# Brew distribution

> **Status:** Implemented. `brew install talater/wrap/wrap` works on macOS as of v0.0.1.
> Source of truth is the code:
> - Release pipeline: [`.github/workflows/release.yml`](../../.github/workflows/release.yml)
> - Release helper: [`scripts/release.ts`](../../scripts/release.ts)
> - Build scripts: [`scripts/build.ts`](../../scripts/build.ts), [`scripts/build-release.ts`](../../scripts/build-release.ts), [`scripts/build-config.ts`](../../scripts/build-config.ts)
> - Bun pin: [`.bun-version`](../../.bun-version)
> - Formula: [`talater/homebrew-wrap:Formula/wrap.rb`](https://github.com/talater/homebrew-wrap/blob/main/Formula/wrap.rb)
>
> This doc captures design decisions and gotchas that the code alone doesn't reveal. Cutting a release day-to-day: see [Release checklist](#release-checklist) below.

---

## Scope

In scope (shipped):
- Prebuilt-binary formula in personal tap `talater/homebrew-wrap`.
- Release pipeline in `talater/wrap` that cross-compiles 4 arches, ad-hoc signs macOS, publishes GH Release, opens PR in tap.
- Parametrized completion subcommand so brew + wizard can own completions for different command names without collision (see [[subcommands]]).

Out of scope (see [§ Future channels](#future-channels)):
- homebrew-core submission.
- linuxbrew formula, `install.sh`, `.deb`/apt repo, npm publish, scoop bucket.
- Wizard alias step (e.g. `w=wrap`). Completion shape already accommodates it.
- Developer ID signing + notarization. Ad-hoc only until a curl-install channel exists and Gatekeeper quarantine bites.
- Build retry / per-arch partial-failure recovery. Policy: delete release + tag, re-push.

---

## Formula design notes

Source: [`talater/homebrew-wrap:Formula/wrap.rb`](https://github.com/talater/homebrew-wrap/blob/main/Formula/wrap.rb).

- Target triples use rust-style naming (`aarch64-apple-darwin` / `x86_64-apple-darwin`), matching homebrew-core precedent (zellij, starship).
- No `bottle do` block. Tarballs *are* the binary; bottles only matter for source-built core formulae.
- No `post_install` — would be rejected for `$HOME` writes. Wizard handles config on first user invocation.
- `generate_completions_from_executable` is called with no `shell_parameter_format` — the default passes the bare shell name, which matches `wrap --completion <shell>`. Do **not** use `:arg`; that produces `--shell=zsh` and our CLI rejects it.
- `deny_network_access! :test` (not `:for_test` or `deny_network_access_for`). `brew style` is component-order-sensitive: `deny_network_access!` sits before `def install`; `livecheck` sits before `on_macos`.
- Placeholder sha256s use the 64-zero string so `brew style` passes; install fails loudly until real shas land. `dawidd6/action-homebrew-bump-formula` fills them on auto-bump.
- `ENV["WRAP_HOME"] = testpath/".wrap"` in the test block is defense-in-depth — asserted commands short-circuit before `getWrapHome()` is read; keep so the test stays safe as it grows.

---

## Release pipeline — design notes

Workflow: [`release.yml`](../../.github/workflows/release.yml).

Four jobs in sequence: `create-release` → `build` (matrix) → `publish-release` → `bump-tap`.

Non-obvious decisions:

- **Draft-then-publish.** `create-release` makes a draft so a partial matrix failure never exposes a half-built release.
- **Single-creator + matrix-uploaders** avoids the race 4 parallel "create or append" jobs would hit. `--clobber` on upload makes per-arch retry idempotent within the same release.
- **`gh` CLI over third-party actions** for release lifecycle — fewer moving parts, idiomatic 2025+.
- **Strip before codesign.** `strip` invalidates a Mach-O signature → SIGKILL at runtime. Reversed order is the bug that ate half a day on the first release.
- **`BUN_NO_CODESIGN_MACHO_BINARY=1`** during build works around Bun's self-sign SIGKILL bug ([oven-sh/bun#29120](https://github.com/oven-sh/bun/issues/29120)). Verify env var name if updating Bun — historical name, may be renamed.
- **`WRAP_BUILD_TARGET`** (not `BUN_BUILD_TARGET`) — the var is ours (consumed by `scripts/build-release.ts`), not Bun-native.
- **Bun pin** lives in `.bun-version` and `scripts/release.ts` stamps it from `Bun.version` at release time, so CI always builds with whatever Bun the author tested on.
- **Runner choice for x86_64 macOS is `macos-15-intel`.** `macos-13` was retired; `macos-14` is Apple Silicon.
- **`bump-tap` runs on macOS.** The formula is `on_macos`-only, so on Linux `dawidd6` sees no `url` and fails with `formula requires at least a URL`.
- **Prerelease detection:** `contains(github.ref_name, '-')`. `v0.0.1` → stable; `v0.0.1-rc.1` → prerelease (publish but skip tap bump).
- **No `concurrency:`** currently — tag-push collisions are unlikely. Add `concurrency: { group: release-${{ github.ref }} }` if two near-simultaneous tags ever race.

### Build matrix

| Target | Bun `--target` | Runner |
|---|---|---|
| `aarch64-apple-darwin` | `bun-darwin-arm64` | `macos-14` |
| `x86_64-apple-darwin` | `bun-darwin-x64` | `macos-15-intel` |
| `aarch64-unknown-linux-gnu` | `bun-linux-arm64` | `ubuntu-24.04-arm` |
| `x86_64-unknown-linux-gnu` | `bun-linux-x64` | `ubuntu-24.04` |

Linux binaries ship even though no Linux formula exists yet — they're staging for future linuxbrew / `install.sh`.

### Partial-failure recovery

Per-arch build fails → `publish-release` gated by `needs: build`, so nothing publishes. Partial assets may land on the draft.

Recovery:
1. `gh release delete <tag> --cleanup-tag --yes`
2. `git tag -d <tag>`
3. Fix the issue.
4. `bun run release <version>` (or re-tag manually) → push.

`create-release` now guards with `gh release view || gh release create`, so re-running the workflow on the same tag is also safe.

---

## Release checklist

Day-to-day: cutting v0.0.N.

```bash
bun run check                       # green
bun run release 0.0.N               # bumps pkg, stamps .bun-version, commits, tags
git push origin main
git push origin v0.0.N              # triggers workflow
# Watch https://github.com/talater/wrap/actions
# On success: bump-tap opens a PR in talater/homebrew-wrap. Review + merge.
```

One-time setup (already done for v0.0.1): [PAT setup](#pat-setup).

---

## PAT setup

`HOMEBREW_TAP_TOKEN` is a fine-grained PAT that lets the workflow push to the tap repo.

1. https://github.com/settings/personal-access-tokens/new
2. Resource owner: `talater`. Repository access: only `talater/homebrew-wrap`.
3. Permissions: `Contents: Read and write` + `Pull requests: Read and write`.
4. `talater/wrap` → Settings → Secrets → Actions → `HOMEBREW_TAP_TOKEN`.

Expiry per personal preference. CI does not create this.

---

## Completion ownership

| Owner | When | Shell | Where written | Command registered |
|---|---|---|---|---|
| Brew | `brew install` runs `wrap --completion <shell>` | zsh | `/opt/homebrew/share/zsh/site-functions/_wrap` | `wrap` |
| Brew | same | bash | `/opt/homebrew/etc/bash_completion.d/wrap` | `wrap` |
| Brew | same | fish | `/opt/homebrew/share/fish/vendor_completions.d/wrap.fish` | `wrap` |
| Wizard alias step (future) | After user picks alias `<n>` → runs `wrap --completion <shell> <n>` | zsh | `~/.zsh/completions/_<n>` | `<n>` |
| Wizard alias step (future) | same | bash | `~/.local/share/bash-completion/completions/<n>` | `<n>` |
| Wizard alias step (future) | same | fish | `~/.config/fish/completions/<n>.fish` | `<n>` |

No overlap. Each file registers one distinct command name. Wizard-side paths match `completionCmd.help` (`src/subcommands/completion.ts`).

---

## Future channels

Kept release-pipeline shape generic so fan-out stays cheap:

1. **Linuxbrew** — add `on_linux do { on_arm / on_intel }` to the same formula. Linux binaries already build. `bump-tap` also needs to keep running on macOS (the linux block coexists with the macOS one inside `on_*` guards).
2. **`curl -fsSL install.sh | bash`** — script in `talater/wrap`. Detect OS/arch, download tarball from GH Release, extract to `~/.local/bin/` or `/usr/local/bin/`, prompt for alias. Shares build output w/ brew.
3. **GH Release tarball (manual download)** — already shipped as side effect. Add a `SHA256SUMS` file for verification. macOS Gatekeeper quarantine may fire when `curl` sets `com.apple.quarantine` — mitigation is Developer ID + notarization, deferred.
4. **`.deb` package + apt repo** — build step adds `dpkg-deb`; host apt repo via GH Pages or packagecloud.

Principle across all channels: wizard owns first-run experience (config + alias). Package managers only drop the binary + completion-for-binary-name. Never write `$HOME` from install hooks.
