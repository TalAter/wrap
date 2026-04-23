---
title: Brew distribution
status: in-flight
---

# Brew distribution

Goal: `brew install talater/wrap/wrap` works on macOS for v0.0.1. Personal tap only. Design ports cleanly to homebrew-core later. Linux binaries also built now (for future linuxbrew/install.sh); no Linux formula ships yet.

---

## Scope

In scope:
- Prebuilt-binary formula in personal tap `talater/homebrew-wrap`.
- Release pipeline in `talater/wrap` that cross-compiles 4 arches, ad-hoc signs macOS binaries, publishes GH Release, opens PR in tap.
- Parametrized completion subcommand so brew + wizard can own completions for different command names without collision.
- MIT LICENSE in `talater/wrap`.

Out of scope (future, see § Future channels):
- homebrew-core submission
- linuxbrew formula, install.sh, .deb/apt repo, npm publish, scoop bucket.
- Wizard section to setup alias (e.g. `w`). Completion shape designed so it drops in cleanly.
- Developer ID signing + notarization. Ad-hoc only until a curl-install channel exists.
- GH Release build retry / partial-failure recovery. Policy: delete release + tag, re-push.

---

## Prerequisites — code changes in app repo

1. **Parametrize completion generator.** `src/subcommands/completion.ts` currently hardcodes the command name `w` throughout — this is a **behavior change**, not a pure refactor. Touch points (find by function name, not line number, since these will drift):
   - `generateZshCompletion` — `#compdef w`, `_w_providers()`, `_w()`, `_w "$@"` (the function names are referenced from the file install location, so they must be parametrized too).
   - `generateBashCompletion` — `_w()`, `complete -F _w w`.
   - `generateFishCompletion` — `complete -c w` (also passed via `fishCompleteLine`'s third arg).
   - Module-level `HINT` constant (currently `Run \`w --help completion\` …`).
   - `completionCmd.usage` (currently `w --completion <shell>`) and `completionCmd.help` (paths and example commands all use `w`).

   Add optional positional `<name>` arg after the shell name, default = `wrap`. Thread through `runCompletion` → `generateCompletion` → each generator, into both the registered command name (`#compdef <name>`, `complete -c <name>`) and the function/identifier names (`_<name>`, `_<name>_providers`). Update `runCompletion`'s arg-count check (currently rejects more than one arg) to accept up to two.
   - `wrap --completion zsh` → emits `#compdef wrap`, `_wrap()`, `_wrap_providers()`.
   - `wrap --completion zsh w` → emits `#compdef w`, `_w()`, `_w_providers()`.

   Positional (not `--name <cmd>` flag) — keeps the brew formula's `generate_completions_from_executable(... shell_parameter_format: :arg)` working unchanged (it passes only the shell name).

   Help text (`completionCmd.help`) is for the human running `wrap --completion --help`, not for the generator output. Keep examples in help oriented to the binary as installed (`wrap --completion zsh > …/_wrap`); leave the user-installed-as-`w` flow to the wizard's future alias section.

   Short-circuit in `src/main.ts:45-47` already prevents config load on flag dispatch — keep as-is.

2. **Create a newrelease build script.** Add `scripts/build-release.ts` (or similar) for CI cross-compile. Do **not** extend `build.ts` — it's for local dev (`bun run build`); release build is a CI concern with different inputs (target arch). Keep them separate.

   The `react-devtools-core` stub plugin in `build.ts` is required for Ink to compile and must be reused by the release script. Extract it into a shared module (e.g. `scripts/build-config.ts`) imported by both `build.ts` and `build-release.ts`. Release script reads target from arg or `BUN_BUILD_TARGET` env, passes into `Bun.build({ compile: { target, outfile: "wrap" } })`. Output filename stays `wrap` regardless of target.

3. **CI tag/package.json version match step.** Shell check in release workflow before build: `[ "$(jq -r .version package.json)" = "${GITHUB_REF#refs/tags/v}" ]`. `jq` is preinstalled on GH-hosted macOS and Ubuntu runners.

---

## Tap repo: `talater/homebrew-wrap`

If you're creating a new folder, ask user to create it and let you know where.

Bootstrap via `brew tap-new talater/wrap`. Keep generated scaffold:
- `Formula/wrap.rb`
- `README.md` — install snippet + 1-line description + link to main repo.
- `.github/workflows/tests.yml` — `brew test-bot --only-formulae` on PR. Free regression net.

### Formula shape

```ruby
class Wrap < Formula
  desc "Translate natural language into shell commands"
  homepage "https://github.com/talater/wrap"
  version "0.0.1"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/talater/wrap/releases/download/v#{version}/wrap-aarch64-apple-darwin.tar.gz"
      sha256 "REPLACE"
    end
    on_intel do
      url "https://github.com/talater/wrap/releases/download/v#{version}/wrap-x86_64-apple-darwin.tar.gz"
      sha256 "REPLACE"
    end
  end

  livecheck do
    url :stable
    strategy :github_latest
  end

  def install
    bin.install "wrap"
    generate_completions_from_executable(
      bin/"wrap", "--completion",
      shells: [:bash, :zsh, :fish],
      shell_parameter_format: :arg,
    )
  end

  def caveats
    <<~EOS
      Run `wrap` to configure your LLM provider.

      Tip: add `alias w=wrap` to your shell rc for a shorter command.
    EOS
  end

  deny_network_access_for :test

  test do
    ENV["WRAP_HOME"] = testpath/".wrap"
    assert_match version.to_s, shell_output("#{bin}/wrap --version")
    assert_match "#compdef wrap", shell_output("#{bin}/wrap --completion zsh")
    assert_match "_wrap", shell_output("#{bin}/wrap --completion bash")
    assert_match "complete -c wrap", shell_output("#{bin}/wrap --completion fish")
  end
end
```

Notes:
- Do not follow the above ruby source code blindly. Use judgement and if you think something is wrong, outdated, or needs changing, let the user know.
- Target triples use rust-style naming (`aarch64-apple-darwin` / `x86_64-apple-darwin`), matching homebrew-core precedent (zellij, starship).
- No `bottle do` block. Tarballs already are the binary. Bottles only relevant once formula is source-built in core.
- No `post_install` — would be rejected for `$HOME` writes (and `deny_network_access_for :postinstall` is therefore moot; only the `:test` directive is included). Wizard handles config on first user invocation.
- `ENV["WRAP_HOME"] = testpath/".wrap"` is defense-in-depth: the asserted commands (`--version`, `--completion`) short-circuit before `getWrapHome()` is read, so the env var is currently unused. Keep it so the line stays correct if test grows to exercise config-touching paths.

---

## Release pipeline — `talater/wrap/.github/workflows/release.yml`

Trigger: tag push `v*`. No `workflow_dispatch` (keep surface small; retry policy = delete + retag).

### Workflow shape

Three jobs, sequenced:

1. **`create-release`** — single job, runs first. Creates the GH Release as a draft (so partial failures don't expose a half-built release): `gh release create "$GITHUB_REF_NAME" --draft --title "$GITHUB_REF_NAME" --notes "Release $GITHUB_REF_NAME"`.
2. **`build`** — matrix job, 4 arches. Needs `create-release`. Builds, signs, strips, tars, uploads tarball via `gh release upload`.
3. **`publish-release`** — needs `build` (all 4 arches must succeed). Promotes draft to published, marks prerelease if tag contains `-`: `gh release edit "$GITHUB_REF_NAME" --draft=false --prerelease=$([[ "$GITHUB_REF_NAME" == *-* ]] && echo true || echo false)`.
4. **`bump-tap`** — needs `publish-release`. Skips on prerelease tags.

Single-creator + matrix-uploaders avoids the race that 4 parallel "create or append" jobs would hit. All steps use `gh` CLI rather than third-party actions for the GH Release lifecycle — fewer moving parts, idiomatic in 2025+.

### Build matrix (4 arches)

| Target | Bun `--target` | Runner |
|---|---|---|
| `aarch64-apple-darwin` | `bun-darwin-arm64` | `macos-14` |
| `x86_64-apple-darwin` | `bun-darwin-x64` | `macos-13` |
| `aarch64-unknown-linux-gnu` | `bun-linux-arm64` | `ubuntu-24.04-arm` (GH-hosted ARM runner; available on public repos since 2024) |
| `x86_64-unknown-linux-gnu` | `bun-linux-x64` | `ubuntu-24.04` |

### Steps per build matrix job

1. Checkout.
2. Verify tag matches `package.json` version (fail fast on mismatch).
3. Install Bun (`oven-sh/setup-bun@v2`, pin to a specific Bun version via `bun-version:` input — do not float on `latest`, since the `--compile` self-sign bug is version-specific).
4. `bun install --frozen-lockfile`.
5. Build: `BUN_NO_CODESIGN_MACHO_BINARY=1 BUN_BUILD_TARGET=bun-<arch> bun run scripts/build-release.ts` (workaround Bun self-sign SIGKILL bug, oven-sh/bun#29120). Verify env var name against the pinned Bun version's docs before merging — historical name is `BUN_NO_CODESIGN_MACHO_BINARY`, may have been renamed.
6. **macOS only:** `codesign --sign - --force ./wrap` (ad-hoc sign).
7. Strip (per-OS):
   - macOS: `strip -x wrap` (`-x` removes local symbols).
   - Linux: `strip --strip-unneeded wrap` (GNU `strip`).
8. `tar -czf wrap-<triple>.tar.gz wrap`.
9. Upload tarball to the draft release: `gh release upload "$GITHUB_REF_NAME" wrap-<triple>.tar.gz --clobber` (`gh` is preinstalled on all GH-hosted runners; `--clobber` makes the step idempotent on retry within the same release).

### Tap bump job

Runs `needs: publish-release`. Skips on prerelease tags (any tag containing `-`, e.g. `-rc.1`, `-beta.0`).

```yaml
- uses: dawidd6/action-homebrew-bump-formula@v4
  if: ${{ !contains(github.ref, '-') }}
  with:
    token: ${{ secrets.HOMEBREW_TAP_TOKEN }}
    tap: talater/homebrew-wrap
    formula: wrap
    tag: ${{ github.ref }}
```

`action-homebrew-bump-formula` downloads each `url` in formula and recomputes sha256 automatically. Multi-arch URLs via `#{version}` interpolation are recomputed in one pass.

### PAT: `HOMEBREW_TAP_TOKEN`

Manual one-time setup (GitHub UI):

1. **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.**
2. Resource owner: `talater`. Repository access: only `talater/homebrew-wrap`.
3. Permissions: `Contents: Read and write` + `Pull requests: Read and write`.
4. Copy the token.
5. In `talater/wrap` → Settings → Secrets and variables → Actions → New repository secret. Name: `HOMEBREW_TAP_TOKEN`. Value: the token.

CI does not create this. Token expiry to set per personal preference (90 days / 1 year / no expiry).

### Merge policy

Manual. Review PR in tap repo, click merge. No auto-merge until release process proven.

### Partial-failure policy

Any build-matrix job fails → tap bump job is gated by `needs: build`, so it doesn't run. Partial assets may have landed on the GH Release. To recover:

1. Delete the GH Release.
2. Delete the git tag (local + remote).
3. Fix the issue.
4. Re-push the tag.

---

## Version source of truth

- `package.json` `version` field is canonical. Imported at compile time by `src/subcommands/version.ts`.
- Tag `v<version>` must match `package.json`. CI enforces.
- Manual bump: edit `package.json`, commit, tag, push tag.

Pre-release tags (`v0.0.1-rc.1`) build binaries + upload to GH Release (marked prerelease), but skip the tap bump.

---

## Completion ownership (recap)

| Owner | When | Shell | Where written | Command registered |
|---|---|---|---|---|
| Brew | `brew install` runs `wrap --completion <shell>` | zsh | `/opt/homebrew/share/zsh/site-functions/_wrap` | `wrap` |
| Brew | same | bash | `/opt/homebrew/etc/bash_completion.d/wrap` | `wrap` |
| Brew | same | fish | `/opt/homebrew/share/fish/vendor_completions.d/wrap.fish` | `wrap` |
| Wizard alias step (future) | After user picks alias `<n>` → runs `wrap --completion <shell> <n>` | zsh | `~/.zsh/completions/_<n>` (or per existing help text) | `<n>` |
| Wizard alias step (future) | same | bash | `~/.local/share/bash-completion/completions/<n>` | `<n>` |
| Wizard alias step (future) | same | fish | `~/.config/fish/completions/<n>.fish` | `<n>` |

No overlap. Each file registers one distinct command name. Wizard-side paths match those already documented in `completionCmd.help` (`src/subcommands/completion.ts`).

---

## Future channels (principles)

Not building now, but keep release pipeline shape generic so fan-out stays cheap:

1. **Linuxbrew** — add `on_linux do { on_arm / on_intel }` to same formula. Linux binaries already built by release pipeline, just need formula block + sha refs.
2. **`curl -fsSL install.sh | bash`** — script lives in `talater/wrap`. Detects OS/arch, downloads matching tarball from GH Release, extracts to `~/.local/bin/` or `/usr/local/bin/`, prompts for alias. Shares build output w/ brew.
3. **GH Release tarball (manual download)** — already shipped as side effect. Add SHA256SUMS file for verification. Gatekeeper quarantine dialog may fire on macOS (curl sets `com.apple.quarantine`); mitigation is Developer ID + notarization, deferred.
4. **`.deb` package + apt repo** — later. Build step adds `dpkg-deb` packaging, host apt repo via GH Pages or packagecloud. Cross-installer consistency: alias setup still owned by wizard.

Principle across all channels: wizard owns first-run experience (config + alias). Package managers only drop the binary + completion-for-binary-name. Never write `$HOME` from install hooks.

---

## Implementation checklist

Ordering matters: app repo work + first manual release happens **before** the tap is functional, since `dawidd6/action-homebrew-bump-formula` needs an existing formula in the tap to bump. Bootstrap = hand-written v0.0.1 formula → first manual `brew install` works → subsequent releases auto-bump.

App repo (`talater/wrap`):
- [ ] Parametrize `src/subcommands/completion.ts` — add positional `<name>` arg (after shell), default `wrap`. Update zsh/bash/fish generators to template both the registered command name and the function identifiers (`_<name>`, `_<name>_providers`). Update `HINT`, `completionCmd.usage`, and `completionCmd.help` so they no longer leak `w`.
- [ ] Test coverage for the new arg in `tests/` — assert `wrap --completion zsh` emits `#compdef wrap`, `wrap --completion zsh foo` emits `#compdef foo`, function names match.
- [ ] Extract shared build config (`react-devtools-core` plugin etc.) from `build.ts` into `scripts/build-config.ts`. Add `scripts/build-release.ts` that reads target from `BUN_BUILD_TARGET` env (or arg), reuses shared config, calls `Bun.build({ compile: { target, outfile: "wrap" } })`.
- [ ] `.github/workflows/release.yml` — tag-driven, version-match check, 4-arch matrix, draft release, ad-hoc sign (mac), per-OS strip, tar, upload, publish, tap bump.
- [ ] `HOMEBREW_TAP_TOKEN` secret added (fine-grained PAT, see § PAT setup).
- [ ] Repo is public on GitHub (already is).

Tap repo (`talater/homebrew-wrap`):
- [ ] `brew tap-new talater/wrap` bootstrap (locally, then `gh repo create`).
- [ ] Hand-write `Formula/wrap.rb` for v0.0.1 (with placeholder SHA256s — fill in after first release uploads).
- [ ] README with install snippet + 1-line description + link to main repo.
- [ ] Local verification: `brew install talater/wrap/wrap` + `brew test wrap` + `brew audit --strict wrap`.

First release (after both repos bootstrapped):
- [ ] Bump `package.json` to `0.0.1` (already there) → commit → tag `v0.0.1` → push tag.
- [ ] Watch CI: 4 arches build → release published → tap bump PR opens.
- [ ] Manually merge bump PR in tap repo.

Verification (post-merge):
- [ ] Clean-machine install: `brew install talater/wrap/wrap` → `wrap --version` works → `wrap` launches wizard → config written to `~/.wrap/` → subsequent `wrap "list ts files"` runs.
- [ ] Shell completion: `_wrap` file exists in `/opt/homebrew/share/zsh/site-functions/`, tab-completion fires on `wrap <TAB>`.
- [ ] Uninstall: `brew uninstall wrap` removes binary + completion, leaves `~/.wrap/` intact (documented in caveats).

---

## Notes

* Before deleting this spec, make sure that future concerns are logged elsewhere.
