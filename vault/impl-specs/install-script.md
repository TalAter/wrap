# Install script (`curl | sh`)

> Add a third install path alongside Homebrew and manual download: `curl -fsSL https://wrap.talater.com/install.sh | sh`. Targets any Unix shell, no package manager required.

**Status: Ready for implementation.**

The shape is opinionated: stay short and auditable, prefer `~/.local/bin` no-sudo install, refuse on brew-managed installs, name what changed in the success message.

---

## Goals & non-goals

**Goals**
1. One-line install on macOS + Linux, x86_64 + aarch64, glibc + musl (so it works in Alpine containers and on small VPSes).
2. No sudo. No surprise side effects. No telemetry.
3. Re-run = upgrade (idempotent).
4. Don't fight brew: refuse if Wrap is brew-managed.
5. Auditable: short enough that a senior dev `curl ... | less` can read it before piping.

**Non-goals**
- Windows. Punt to a future `install.ps1`.
- Pre-Haswell Intel CPUs (`-baseline` Bun targets). Audience isn't on 13yo metal.
- 32-bit, ARMv7, BSDs, RISC-V. Bun-build limit; "use brew or build from source."
- Pin-to-version URLs. Add when someone asks.
- Self-update mechanism. Re-run install.sh.
- Cosign / sigstore CLI verification. GitHub artifact attestations remain enabled; power users verify out-of-band with `gh attestation verify <tarball> --repo TalAter/wrap` (documented on the website's "paranoid path"). The script doesn't reach for `gh`.

---

## Distribution shape

### URL

One URL: **`wrap.talater.com/install.sh`**. Redirects to `https://github.com/TalAter/wrap/releases/latest/download/install.sh`. Cloudflare Pages `_redirects` (or equivalent). Cache the redirect 5min; let GitHub set the asset's cache.

The script always fetches from `releases/latest/download/...` — no version baked in, no templating, no `__WRAP_VERSION__` substitution. Repo file = release asset, byte-identical.

### Source of truth

`scripts/install.sh` in this repo is the canonical script. The release workflow uploads it as an asset alongside the binaries. The website serves the same file via redirect.

---

## Build matrix expansion

Current: 4 binaries (mac arm/intel, linux gnu arm/intel). Add musl:

| Triple | Bun target | Runner | Why |
|---|---|---|---|
| `x86_64-unknown-linux-musl` | `bun-linux-x64-musl` | ubuntu-24.04 | Alpine + distroless containers |
| `aarch64-unknown-linux-musl` | `bun-linux-arm64-musl` | ubuntu-24.04-arm | Alpine ARM containers |

The brew tap is unaffected — tap continues to consume only the four non-musl triples it always has.

**Source of truth for triple names**: the matrix in `release.yml`. `install.sh`'s detection must produce matching names; `checksums.txt` catches a typo on either side at install time (no checksum entry → abort).

---

## Verification

A single `checksums.txt` (GoReleaser-style) is uploaded alongside the binaries:

```
sha256-of-tarball  wrap-aarch64-apple-darwin.tar.gz
sha256-of-tarball  wrap-x86_64-apple-darwin.tar.gz
... (one line per tarball)
```

The release workflow gathers per-job sha256s into a single file in a final job. install.sh downloads the tarball and `checksums.txt`, greps for the right line, pipes to `shasum -a 256 -c -` (or `sha256sum -c -` fallback).

If neither `shasum` nor `sha256sum` is present, install.sh prints `warning: no sha256 tool found, skipping checksum verification` and continues. TLS already protects the download path; the checksum is defense-in-depth. No flag to opt out.

`checksums.txt` missing is treated as a broken release: abort with `error: checksums.txt missing from release; report at https://github.com/TalAter/wrap/issues`. The pipeline waits on `checksums` before publishing (see §Release pipeline changes), so this only fires if the release is genuinely broken.

GitHub artifact attestations remain enabled per the existing `attest-build-provenance` step. Documented on the website's paranoid path; not invoked from the script.

---

## Script behavior (flow)

**Flags** (all optional):
- `--install-dir <path>` — override install location (default: `$HOME/.local/bin`). Tilde **not** expanded; pass an explicit path.
- `--no-modify-path` — skip env-script writing and rc-file edits.
- `--uninstall` — run uninstall flow (see §Uninstall).
- `-h`, `--help` — print usage and exit.

No env vars.

**Internal-only flag** (undocumented, hidden from `--help`, used by the local docker rig and the CI `verify-install` job):
- `--base-url <url>` — override the release download base. Defaults to `https://github.com/TalAter/wrap/releases/latest/download`. Tests point this at a local HTTP server serving locally-built tarballs (local rig) or `gh release download`-staged draft assets (CI). See §Testing. CLI flag, not env var, so it cannot leak into child shells or parent processes from a poisoned environment — the user must type it explicitly to override.

**Output convention**: install.sh follows Wrap's runtime stdout invariant by analogy — all chrome (notes, warnings, errors, success message) goes to **stderr**. Stdout is unused. Reserving stdout means a caller can pipe install.sh into a logger and only see real output (none) without filtering chrome.

**Flow**:

```
1. License + identity header (5 lines, plain English).
2. set -eu. main() { ... } main "$@"  — partial-download guard.
3. Parse flags.
4. Require curl.
5. `$HOME` guard: if unset or empty, abort with `error: HOME is not set`.
6. Refuse sudo escalation: if `[ "$(id -u)" = 0 ]` AND `$SUDO_USER` is non-empty, abort with a message pointing at re-running as a normal user. Bare root (no `$SUDO_USER`) is allowed — that's the default in containers (Alpine, distroless), which is a primary use case. Files land under `/root/` in that case.
7. If `--uninstall` was passed: jump to §Uninstall flow.
8. Brew refusal: if `command -v brew` and `brew list talater/wrap/wrap` succeeds, abort with `error: wrap is managed by Homebrew; run 'brew upgrade talater/wrap/wrap'`.
9. Detect OS+arch via `uname -sm` case → base triple (4 cases + error).
10. **musl swap (linux-gnu triples only)**: see §Detection logic.
11. Build URL: `${BASE_URL:-https://github.com/TalAter/wrap/releases/latest/download}/wrap-${TRIPLE}.tar.gz` where `BASE_URL` is set from the internal-only `--base-url` flag if present.
12. `mktemp -d`; `trap 'rm -rf "$tmp"' EXIT INT TERM`. Download tarball + checksums.txt with `curl -fsSL`. The default URL is hardcoded `https://...` and there's no user input that affects the URL on the default path, so additional curl flags like `--proto '=https'` would be theater here.
13. Verify. POSIX `sh` has no `pipefail`, so a naive `grep ... | sha256-tool -c -` would silently pass when the triple is absent from `checksums.txt` (empty grep output → empty stdin → exit 0 from the hasher). Capture grep output first:
    ```sh
    expected="$(grep " wrap-${TRIPLE}.tar.gz$" checksums.txt || true)"
    [ -n "$expected" ] || err "no checksum entry for wrap-${TRIPLE}.tar.gz"
    printf '%s\n' "$expected" | sha256-tool -c -
    ```
    If neither `shasum` nor `sha256sum` is available, print the warning described in §Verification and skip. If `checksums.txt` itself failed to download, abort.
14. Extract tarball; install via atomic same-dir rename:
    - `mkdir -p "$INSTALL_DIR"`, then `mv` extracted binary to `$INSTALL_DIR/wrap.new`.
    - `chmod +x` **before** the final rename so the swap publishes an already-executable file.
    - `mv -f "$INSTALL_DIR/wrap.new" "$INSTALL_DIR/wrap"` — same-dir rename is atomic and safe even if the running `wrap` is being replaced.
15. PATH-shadow check: if another `wrap` is already on PATH at a different path, print a `warning:` naming both.
16. PATH setup (env-script pattern; see §Env-script).
17. Install completions (best-effort; see §Completions).
18. Print success: version, install dir, list of rc files modified (if any), list of completion files written (if any). Always print the "open a new shell" line when rc files were modified or zsh completions were installed.
```

### Detection logic

```sh
case "$(uname -sm)" in
  "Darwin arm64")               TRIPLE=aarch64-apple-darwin ;;
  "Darwin x86_64")              TRIPLE=x86_64-apple-darwin ;;
  "Linux aarch64"|"Linux arm64") TRIPLE=aarch64-unknown-linux-gnu ;;
  "Linux x86_64")               TRIPLE=x86_64-unknown-linux-gnu ;;
  *) err "Unsupported platform: $(uname -sm)" ;;
esac

# musl swap (Linux only). ldd --version prints to stderr on Alpine
# and exits 1, so 2>&1 + grep is the reliable single-line probe.
case "$TRIPLE" in
  *linux-gnu)
    if ldd --version 2>&1 | grep -qi musl; then
      TRIPLE="${TRIPLE%-gnu}-musl"
    fi
    ;;
esac
```

### Env-script (PATH)

Unless `--no-modify-path`, install.sh writes two env scripts inline via heredoc — `~/.wrap/env` (POSIX sh for bash + zsh) and `~/.wrap/env.fish`. Each shell's rc gets one source line. Self-deduplicating so re-runs are idempotent. Pattern from rustup's `~/.cargo/env`.

The heredoc substitutes the install dir but keeps `$PATH`/`$HOME` literal so each shell expands them at startup. `$HOME`-relative install dirs are normalized back to `$HOME/...` form before substitution for portability across machines.

`~/.wrap/env` (default install dir; `$HOME/.local/bin` is **literal** in the file, expanded at shell startup):

```sh
case ":${PATH}:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac
```

`~/.wrap/env.fish`:

```fish
fish_add_path -g $HOME/.local/bin
```

(`fish_add_path` is idempotent and handles dedup itself — no `contains` check needed.)

Each shell sources the env script:

| Shell | Target file | How |
|---|---|---|
| bash | `~/.bashrc` | append `. "$HOME/.wrap/env"` line if absent |
| zsh | `${ZDOTDIR:-$HOME}/.zshenv` | append `. "$HOME/.wrap/env"` line if absent |
| fish | `${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/wrap.fish` | write file with `source ~/.wrap/env.fish`; overwrite is fine (contents are fixed) |

Idempotent append for bash/zsh — whole-line match avoids false positives when `. "$HOME/.wrap/env"` appears as a substring inside a comment or string:

```sh
line='. "$HOME/.wrap/env"'
grep -qxF "$line" "$rc" || printf '\n%s\n' "$line" >> "$rc"
```

For fish, just `printf 'source ~/.wrap/env.fish\n' > "$conf_d/wrap.fish"`.

`--no-modify-path` skips env-script writing AND rc edits. Required for managed envs where the user owns rc files.

### Completions

After binary install, run `wrap --completion <shell>` (writes completion script to stdout) and redirect to user-owned paths:

| Shell | Path | Discovery |
|---|---|---|
| bash | `${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion/completions/wrap` | bash-completion package auto-loads from this dir |
| zsh | `${XDG_DATA_HOME:-$HOME/.local/share}/zsh/site-functions/_wrap` | user must have this dir on `fpath` (see note below) |
| fish | `${XDG_CONFIG_HOME:-$HOME/.config}/fish/completions/wrap.fish` | fish auto-loads from this dir |

Best-effort: each shell's completion install is wrapped so a failure (path not writable, parent dir missing and uncreatable) prints one stderr `warning:` line and continues. The binary works without completions.

**Zsh fpath note**: install.sh does not modify `fpath`. Users running any zsh completions (oh-my-zsh, prezto, manual) already have XDG dirs on `fpath`. If completions don't load, the success message tells them to add `~/.local/share/zsh/site-functions` to their `fpath`.

The success message reminds the user to open a new shell for completions to take effect.

Update `src/subcommands/completion.ts` help-text zsh line to match install.sh's path (`~/.local/share/zsh/site-functions/_wrap` instead of the current `~/.zsh/completions/_wrap`) so hand-installers and the script point at the same location.

### Uninstall

`install.sh --uninstall`. `--install-dir` is honored if the user installed to a non-default location; otherwise default applies.

1. Remove `$INSTALL_DIR/wrap`.
2. Remove `~/.wrap/env`, `~/.wrap/env.fish`.
3. Remove the `. "$HOME/.wrap/env"` line from each rc file that contains it. Skip rc files that don't contain the line — avoids any rewrite. Use a temp-file rewrite when present (POSIX-portable; some `sed -i` implementations differ between GNU/BSD). Place the temp file beside `$rc` so the final `mv` is a same-filesystem rename:
   ```sh
   line='. "$HOME/.wrap/env"'
   grep -qxF "$line" "$rc" || continue
   tmp_rc="$(mktemp "${rc}.XXXXXX")"
   grep -vxF "$line" "$rc" > "$tmp_rc"
   mv "$tmp_rc" "$rc"
   ```
4. Remove `${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/wrap.fish`.
5. Remove completion files at the paths listed in §Completions.
6. Print success message including: "Config and memory left at `~/.wrap/` — `rm -rf ~/.wrap` to fully remove, or run `wrap --forget` before next uninstall to wipe data while keeping the dir structure."

---

## Release pipeline changes

`.github/workflows/release.yml` currently has `create-release → build → publish-release → bump-tap`. Updates:

1. **New job `shellcheck`**, runs `shellcheck scripts/install.sh` and `scripts/test-install.sh`. `build` depends on it so the workflow fails before any tarball ships.
2. **Expand build matrix** to 6 targets (4 current + 2 musl; see "Build matrix expansion" above).
3. **New job `checksums`**, depends on `build`: downloads every tarball, computes sha256, writes `checksums.txt`, uploads as release asset, attests.
4. **Upload `scripts/install.sh` as a release asset** in a tiny job that runs alongside `checksums`. Byte-identical to the repo file — no templating.
5. **New job `verify-install`**, depends on `checksums` and the install-asset upload. Gates publish on a real install→re-run→uninstall cycle in OS+libc combinations not naturally exercised on the maintainer's Mac dev box. Full mechanics in §Testing rig 3; in summary: three matrix legs (`ubuntu:24.04` container, `alpine:3.20` container, `macos-14` runner) that each `gh release download` the draft assets, serve them over a local HTTP server, run install.sh via the `--base-url` test escape hatch, then run the assertion checklist. Failure leaves the release in draft.
6. **`publish-release` now depends on `verify-install`.** Reason: never publish a release where the install path is broken. `releases/latest` only resolves to non-prereleases, so the gate's purpose is correctness (don't ship a broken installer), not race protection on `latest`.
7. **`bump-tap` unchanged.** Tap continues consuming the four canonical triples; new musl triples are install-script-only.

Final shape: `create-release → build (×6) → {checksums, install-asset-upload} → verify-install → publish-release → bump-tap`.

---

## Website changes

Three install rows on the website's install section:

1. **Homebrew (macOS, Linux)** — `brew install talater/wrap/wrap`. Recommended for managed environments.
2. **Install script** — `curl -fsSL https://wrap.talater.com/install.sh | sh`. Recommended for any Unix, CI, Docker.
3. **Manual download** — link to release assets. Document the macOS Gatekeeper workaround (`xattr -d com.apple.quarantine wrap` or right-click → Open) on this row only; curl-sh and brew don't trigger it.

---

## Vault updates

`vault/release.md` § "Future channels" already anticipates this. Update when shipped:
- Confirm channel is live, link to install.sh.
- Correct the existing Gatekeeper note: curl-sh does **not** trigger the "downloaded from internet" dialog. `curl` doesn't set `com.apple.quarantine` (only quarantine-aware apps like Safari/Chrome/Mail/AirDrop/Messages do). Brew works for the same reason — it uses curl under the hood. The Gatekeeper dialog applies only to the **manual browser download** path; document the workaround in the manual-download row of the website, not in install.sh chrome.

`vault/README.md` Module map: add `scripts/install.sh` reference.

---

## Testing

install.sh is orchestration code that runs against real OS state — file paths, package contents, installed binaries, shell rc files, dynamic-loader behavior. There is **no useful unit-test surface**: every interesting failure mode involves the actual filesystem and OS. Specifically, **do not add Bun tests, Vitest, Jest, or any in-process test harness** for install.sh. The codebase's `tests/` directory is for the TypeScript runtime, not the installer.

Three test rigs cover install.sh, each independently runnable:

### 1. shellcheck (static)

Catches POSIX-portability bugs, quoting mistakes, and dead-code branches before any tarball ships. Runs as a dedicated `shellcheck` job in `release.yml` (see §Release pipeline changes); `build` depends on it. Targets `scripts/install.sh` and `scripts/test-install.sh`.

### 2. `scripts/test-install.sh` — local Docker rig (POSIX shell)

A POSIX shell script the **maintainer runs by hand on their Mac** while iterating on install.sh. It tests the **working-copy** install.sh against **locally-built** wrap binaries — no need to push a tag or wait for CI to iterate on a fix. It is **not** a test framework; it is a small wrapper around `bun build` + `docker run`. No TypeScript runtime, no test runner.

Usage:

```sh
./scripts/test-install.sh
```

What it does, per invocation:

1. **Stage assets locally.** Build wrap for both Linux-arm64 triples (`bun-linux-arm64` for glibc, `bun-linux-arm64-musl` for musl) using the existing `scripts/build.ts`. Tar each as `wrap-<triple>.tar.gz`. Compute `checksums.txt` over the tarballs. Copy the working-copy `scripts/install.sh` alongside. Final layout under `/tmp/wrap-test-stage/`:
   ```
   install.sh
   checksums.txt
   wrap-aarch64-unknown-linux-gnu.tar.gz
   wrap-aarch64-unknown-linux-musl.tar.gz
   ```

2. **Per container** in `{ubuntu:24.04, alpine:3.20}`:
   1. `docker run --rm --platform linux/arm64 -v /tmp/wrap-test-stage:/srv:ro <image> sh -c '<test commands>'`.
   2. Inside the container, the test commands:
      - Install prereqs: `apk add curl python3` (alpine) or `apt-get update && apt-get install -y -qq curl python3` (ubuntu).
      - Start the stage server: `python3 -m http.server -d /srv 8000 &` and wait briefly for it to bind.
      - Run install: `sh /srv/install.sh --base-url http://127.0.0.1:8000`.
      - Run the assertion checklist (below).
   3. On any assertion failure, exit non-zero with a message naming the image and which assertion failed.

`linux/arm64` is the only container platform — it runs natively on Apple Silicon at full speed. CI handles `linux/amd64` on real x86_64 runners. Maintainer testing locally on an Intel Mac would need `--platform linux/amd64`; out of scope until somebody is on Intel.

### 3. `verify-install` job — CI smoke (YAML)

Runs as a job in `release.yml` between `checksums`/install-asset upload and `publish-release`. Three matrix legs:

| Leg | Runner | Container |
|---|---|---|
| linux/amd64 glibc | `ubuntu-24.04` | `ubuntu:24.04` |
| linux/amd64 musl | `ubuntu-24.04` | `alpine:3.20` |
| macos/arm64 | `macos-14` | none (runs on host) |

Each leg:

1. `gh release download <tag> -D /tmp/r` — fetches the **draft** release's assets (tarballs, `checksums.txt`, `install.sh`) using the workflow's `GH_TOKEN`. Required because `releases/download/<tag>/...` returns 404 to anonymous curl while the release is still draft.
2. `python3 -m http.server -d /tmp/r 8000 &` — serves the staged assets locally over plain HTTP. Alpine needs `apk add python3 curl` first.
3. `sh /tmp/r/install.sh --base-url http://127.0.0.1:8000` — runs the just-uploaded install.sh against the local server. The hidden `--base-url` flag is the test escape hatch (see §Script behavior).
4. Run the same assertion checklist as the local rig. Failure leaves the release in draft for inspection.

The CI smoke does **not** invoke `scripts/test-install.sh` — different orchestration shape (yaml matrix vs shell loop, draft-asset download vs local build, container-as-leg vs nested docker). Trying to share orchestration code adds complexity for no benefit. The two rigs share install.sh and the assertion checklist; that's the only sharing that matters.

### Assertion checklist (local rig and CI both run these)

The container starts with a clean `$HOME` — no `~/.wrap/` exists. The checklist runs install/use/uninstall in that order:

1. **Install.** Run `install.sh --base-url …`.
   - `"$HOME/.local/bin/wrap" --version` exits 0 and prints a string containing the expected version (`package.json`'s `version` field for the local rig; the release tag for CI).
   - The relevant rc file (`~/.bashrc` for bash, `~/.zshenv` for zsh, `~/.config/fish/conf.d/wrap.fish` for fish) contains exactly one `. "$HOME/.wrap/env"` source line.

2. **Re-run = idempotent upgrade.** Run `install.sh --base-url …` again.
   - Exits 0.
   - The rc file still contains exactly one `. "$HOME/.wrap/env"` source line (no duplicates).

3. **Simulate user state.** Stub-create `~/.wrap/config.jsonc` and `~/.wrap/memory.json` with arbitrary recognizable content. (These files would normally be created by running wrap; the stub mimics that without needing a real wrap session inside the test container.)

4. **Uninstall.** Run `install.sh --uninstall --base-url …`.
   - The binary at `~/.local/bin/wrap` is gone.
   - The rc source line is gone.
   - `~/.wrap/env`, `~/.wrap/env.fish`, the fish conf.d file, and all completion files written during install are gone.
   - `~/.wrap/config.jsonc` and `~/.wrap/memory.json` are **byte-identical** to the stubs from step 3.

### Manual coverage (residual)

Mac x86_64 is not free in CI and not Docker-runnable on a Mac host. Maintainer runs install.sh by hand on an Intel Mac before cutting a real release. Linux glibc/musl arm64 are covered by the local Docker rig during dev; promote to a CI leg only if either becomes a release blocker.

---
## Implementation order

Sequenced so the tree is green at every commit and the install.sh dev loop runs entirely against locally-built artifacts.

1. **Pipeline plumbing.** Expand build matrix to 6 triples (add musl x64, musl arm64). Add `checksums` job. Wire `publish-release` to depend on `checksums` (verify-install comes later).
2. **Write the installer + local rig + completion sync.** Add `scripts/install.sh`, `scripts/test-install.sh`, and update `src/subcommands/completion.ts` zsh help-text path to `~/.local/share/zsh/site-functions/_wrap`. Iterate locally — `./scripts/test-install.sh` builds wrap, stages assets, runs install.sh inside ubuntu+alpine containers, runs the assertion checklist. No rc tag needed; the harness uses the working tree.
3. **`release.yml` additions:** shellcheck job (gates `build`), install.sh release-asset upload job, `verify-install` matrix job, wire `publish-release` to depend on `verify-install`.
4. **Maintainer cuts `vX.Y.Z-rc.0`.** First end-to-end run of the full pipeline including `verify-install`. Validates that the CI smoke actually catches what it's supposed to catch and the matrix builds clean across all 6 triples. If the rc fails verify-install, fix and re-run (existing `Create draft release` step is idempotent).
5. **Vault module-map update:** `vault/README.md` adds `scripts/install.sh` reference. (Defer the "channel is live" + Gatekeeper-correction note in `vault/release.md` to step 8.)
6. **Maintainer cuts a real release.** First non-prerelease that includes `install.sh` and `checksums.txt` as assets — `releases/latest/download/install.sh` now resolves.
7. Set up `wrap.talater.com/install.sh` redirect to `releases/latest/download/install.sh`. Validate end-to-end (`curl -fsSL https://wrap.talater.com/install.sh | sh` on a clean Mac).
8. Update website with three install rows. Update `vault/release.md` ("channel live", correct the Gatekeeper note).
