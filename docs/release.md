# Releasing

Wrap ships prebuilt binaries for macOS and Linux through two channels: the
personal Homebrew tap [`talater/homebrew-wrap`](https://github.com/talater/homebrew-wrap)
and the curl-sh installer at `wrap.talater.com/install.sh` (a redirect to the
latest release's `install.sh` asset). A personal tap ships the moment a tag
builds; homebrew-core is a later option. The tap consumes the four non-musl
tarballs; musl is install-script-only. Binaries are ad-hoc signed, not
notarized: curl and brew never set the quarantine attribute, so only a manual
browser download sees the Gatekeeper dialog. The installer writes the binary
and shell PATH setup; the wizard owns first-run provider config. Completions ship as
`--completion <shell> [name]` so the single binary stays the only artifact.

## Cutting a release

```
scripts/release.sh <version>   # e.g. scripts/release.sh 0.0.8, or 0.0.8-rc.1 for a prerelease
```

The script does preflight (clean tree, on `main`, synced with `origin/main`, `make check terminal` passes), bumps `version` in `Cargo.toml`, refreshes the `wrap` entry in `Cargo.lock`, commits `release vX.Y.Z`, and tags. It deliberately does **not** push. `DRY_RUN=1` runs the preflight and shows the bump as a diff without committing or tagging.

Then:

```
git push origin main
git push origin vX.Y.Z
```

Watch it: `gh run list --limit 3` to find the run, then `gh run watch <id>`.

## What the workflow does

`.github/workflows/release.yml` runs on every `v*` tag push:

1. `create-release` checks the tag matches `Cargo.toml` and creates a **draft** release (idempotent).
2. `shellcheck` lints the installer and release scripts; `test` runs `make check terminal` so formatting, Clippy, behavioral, CLI and terminal failures block builds.
3. `build` is a six-leg matrix, each on a runner of its own architecture: macOS arm (`macos-14`) and intel (`macos-15-intel`), Linux arm (`ubuntu-24.04-arm`) and intel (`ubuntu-24.04`), each Linux runner doing both glibc and musl. Every leg runs `cargo build --release --locked --target <triple>`, strips the binary (`strip -x` + ad-hoc `codesign` on macOS), tars it as a single `wrap`, uploads `wrap-<triple>.tar.gz` to the draft, and attests provenance. The musl legs install `musl-tools` and point the target's C compiler at `musl-gcc` so the C in `aws-lc-sys` (pulled by rustls) links against musl.
4. `checksums` downloads the six tarballs and uploads `checksums.txt` (`sha256sum` format). `install-asset` uploads `scripts/install.sh` byte-identical.
5. `verify-install-linux` (ubuntu glibc, alpine musl) and `verify-install-macos` run `scripts/install-assert.sh` against the draft assets served over local HTTP.
6. `publish-release` flips the draft to published (prerelease when the tag contains `-`).
7. `bump-tap` (non-prerelease tags only) runs `scripts/bump-tap.sh`: computes sha256 of the four non-musl tarballs and opens a PR on `talater/homebrew-wrap`. Needs the `HOMEBREW_TAP_TOKEN` secret.

**The homebrew PR does not auto-merge.** Review the diff (`gh pr view <n> --repo TalAter/homebrew-wrap`) and merge once its `test-bot` check is green. If `test-bot` fails on `brew style`, it's Homebrew's formula linter, not your version bump — fix the formula on the PR's branch and push a follow-up commit (don't open a new PR).

## Testing the installer locally

`scripts/test-install.sh` builds glibc + musl tarballs inside a `rust:slim-bookworm` container for the host architecture and runs the assertion checklist in ubuntu and alpine containers. Requires Docker or Podman. Override the architecture with `WRAP_TEST_PLATFORM=linux/amd64` or `linux/arm64`.

## Recovering from a failed release run

The release is a **draft** until the full matrix + verify steps pass, so a failed run never ships anything broken. To retry after a code fix:

```
gh release delete vX.Y.Z --yes --cleanup-tag   # removes the failed draft + tag
git tag vX.Y.Z                                  # re-tag on the fixed commit
git push origin vX.Y.Z
```

If `bump-tap` fails after publishing, re-run just that job from the Actions UI, or run `TAG=vX.Y.Z GH_TOKEN=<tap PAT> scripts/bump-tap.sh` locally.
