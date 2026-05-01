# Install script (`curl | sh`)

> Add a third install path alongside Homebrew and manual download: `curl -fsSL https://wrap.talater.com/install.sh | sh`. Targets any Unix shell, no package manager required, brew-aware so existing brew installs are upgraded via `brew upgrade` and never trampled.

**Status: Ready for implementation.**

The shape is opinionated: stay short and auditable, prefer `~/.local/bin` no-sudo install, defer to brew when brew already manages Wrap, never modify the user's filesystem without naming what changed in the success message.

---

## Goals & non-goals

**Goals**
1. One-line install on macOS + Linux, x86_64 + aarch64, glibc + musl.
2. No sudo. No surprise side effects. No telemetry.
3. Re-run = upgrade (idempotent).
4. Plays nicely with brew: never trample a brew-managed binary.
5. Auditable: short enough that a senior dev `curl ... | less` can read it before piping.

**Non-goals**
- Windows. Punt to a future `install.ps1`.
- 32-bit, ARMv7, BSDs, RISC-V. Bun-build limit; document as "use brew or build from source" if anyone asks.
- Self-update mechanism distinct from "re-run install.sh." No rustup-style toolchain manager.
- Cosign / sigstore CLI verification. GitHub artifact attestations are already published at [github.com/TalAter/wrap/attestations](https://github.com/TalAter/wrap/attestations). Power users verify out-of-band with `gh attestation verify <tarball> --repo TalAter/wrap` (the "paranoid path" — a one-liner documented on the website, never invoked from install.sh). The script doesn't reach for `gh`.

---

## Distribution shape

### URLs

Two URLs, hosted on `wrap.talater.com`:

- **`wrap.talater.com/install.sh`** — rolling. `Cache-Control: public, max-age=300, must-revalidate`. The URL the website points at.
- **`wrap.talater.com/install/v0.0.5.sh`** — immutable per-version snapshot. Long cache. For pinning in CI / Dockerfiles.

**Version baked at release time.** Each tag's `install.sh` is templated with its own version string before upload. The script does not resolve "latest" at runtime — the URL chosen by the user determines the version installed. Rolling URL = latest tag's templated copy; versioned URL = that tag's frozen copy. This eliminates the class of bug where a long-cached install.sh from an older release tries to fetch tarballs whose naming or layout changed in a newer release. No `--version` flag and no `WRAP_VERSION` env var; switching versions = switching URL.

The repo file `scripts/install.sh` contains the literal token `__WRAP_VERSION__` on the version-assignment line:

```sh
VERSION="__WRAP_VERSION__"
[ "$VERSION" = "__WRAP_VERSION__" ] && VERSION=latest
```

The release workflow runs `sed -i "s/__WRAP_VERSION__/${GITHUB_REF_NAME}/" scripts/install.sh` before uploading. The fallback line catches the un-substituted case (`scripts/install.sh` checked out from main, run locally) so it still works in dev — falling back to `releases/latest/download/...`.

### Hosting

`wrap.talater.com` redirects to GitHub release assets. No file is hosted on the website itself.

- `/install.sh` → `https://github.com/TalAter/wrap/releases/latest/download/install.sh` (rolling: GitHub resolves `latest` per release).
- `/install/<vX.Y.Z>.sh` → `https://github.com/TalAter/wrap/releases/download/<vX.Y.Z>/install.sh` (frozen: each tag's asset is uploaded once at release time and never mutated).

Mechanism: Cloudflare Pages with a `_redirects` file (or equivalent on whatever hosts `wrap.talater.com`). Cache the redirect itself for 5min; let GitHub set the asset's cache.

`scripts/install.sh` is uploaded as a release asset by the release workflow (see "Release pipeline changes" below).

### Source of truth

`scripts/install.sh` in this repo is the canonical script. The release workflow uploads it as an asset alongside the binaries. The website serves the same file.

---

## Build matrix expansion

Current: 4 binaries (mac arm/intel, linux gnu arm/intel).

New target additions:

| Triple | Bun target | Runner | Why |
|---|---|---|---|
| `x86_64-unknown-linux-musl` | `bun-linux-x64-musl` | ubuntu-24.04 | Alpine + distroless containers |
| `aarch64-unknown-linux-musl` | `bun-linux-arm64-musl` | ubuntu-24.04-arm | Alpine ARM containers |
| `x86_64-unknown-linux-gnu-baseline` | `bun-linux-x64-baseline` | ubuntu-24.04 | Pre-Haswell Intel CPUs (no AVX2) |
| `x86_64-unknown-linux-musl-baseline` | `bun-linux-x64-musl-baseline` | ubuntu-24.04 | Old Intel + musl |
| `x86_64-apple-darwin-baseline` | `bun-darwin-x64-baseline` | macos-15-intel | Pre-Haswell Intel Macs (rare, cheap) |

`-baseline` is a Wrap release-asset naming choice that surfaces Bun's pre-Haswell target variant. Not a real Rust triple. Document the convention in `vault/release.md` (which currently asserts "Rust-style target triples") so future maintainers know the suffix is Wrap-specific.

The brew tap is unaffected — tap continues to consume only the four non-musl, non-baseline triples it always has.

**Source of truth for triple names**: the matrix in `release.yml`. `install.sh`'s detection block must produce names that match. `checksums.txt` cross-validates — every triple emitted by the matrix appears as a line in the file, so a typo on either side is caught at install time (no checksum entry → abort).

---

## Verification

A single `checksums.txt` (GoReleaser-style) is uploaded alongside the binaries:

```
sha256-of-tarball  wrap-aarch64-apple-darwin.tar.gz
sha256-of-tarball  wrap-x86_64-apple-darwin.tar.gz
sha256-of-script   install.sh
... (one line per release asset, including install.sh itself)
```

`install.sh` is included so a curl-pipe consumer can verify the script they piped (after the fact) against the release.

The release workflow gathers per-job sha256s into a single file in a final job. install.sh downloads the tarball and `checksums.txt`, greps for the right line, pipes to `shasum -a 256 -c -` (or `sha256sum -c -` fallback).

**Warning convention**: this spec uses "warning" to mean a single stderr line prefixed `warning:`.

If neither `shasum` nor `sha256sum` is present, install.sh prints `warning: no sha256 tool found, skipping checksum verification` and continues. TLS already protects the download path; the checksum is defense-in-depth, and skipping on a hasher-less system matches the threat model of most curl-pipe installers. No env var or flag to opt out — the script always tries, warns when it can't.

`checksums.txt` missing is treated as a broken release. The pipeline-ordering rule below (`publish-release` waits on `checksums`) guarantees it's present at `releases/latest`; if it's absent, abort with `error: checksums.txt missing from release; report at https://github.com/TalAter/wrap/issues`.

GitHub artifact attestations remain enabled per the existing `attest-build-provenance` step. Documented on the website's paranoid path; not invoked from the script.

---

## Script behavior (flow)

**Flags** (all optional):
- `--install-dir <path>` — override install location. Sets `WRAP_INSTALL_DIR`.
- `--no-modify-path` — skip env-script writing and rc-file edits. Sets `WRAP_NO_MODIFY_PATH=1`.
- `--uninstall` — run uninstall flow (see §Uninstall).
- `-h`, `--help` — print usage and exit.

**Env vars** (CLI flags map 1:1; flags win on conflict):
- `WRAP_INSTALL_DIR` — install directory (default: `$HOME/.local/bin`). Tilde is **not** expanded; pass an explicit path.
- `WRAP_NO_MODIFY_PATH` — boolean.

**Boolean env-var convention**: any non-empty value enables; unset or empty disables. (`WRAP_NO_MODIFY_PATH=` is off; `WRAP_NO_MODIFY_PATH=1` or `=true` or `=anything` is on.)

**Output convention**: install.sh follows Wrap's runtime stdout invariant by analogy — all chrome (notes, warnings, errors, success message) goes to **stderr**. Stdout is unused. There is no "useful output" mode for an installer; reserving stdout means a caller can pipe install.sh into a logger and only see real output (none) without filtering chrome.

**Flow**:

```
1. License + identity header (5 lines, plain English).
2. zsh self-reexec guard:
   ```sh
   if [ -n "${ZSH_VERSION:-}" ]; then
     [ -f "$0" ] && exec sh "$0" "$@"
     printf 'error: pipe to sh, not zsh\n' >&2; exit 1
   fi
   ```
   Catches the `zsh ./install.sh` case where the `#!/bin/sh` shebang is bypassed by an explicit interpreter. `curl | zsh` can't re-exec (no file at `$0`) — fail loud rather than run POSIX-only code under zsh, where `set -eu` and globbing differ subtly.
3. set -eu. main() { ... } main "$@"  — partial-download guard.
4. Parse flags; map to env vars per the tables above.
5. Require curl. Snap-curl guard (see below): if curl is snap-confined, abort with a message pointing at apt-installed curl.
6. Root + HOME guard:
   - If `$HOME` is unset or empty, abort with `error: HOME is not set`.
   - If running as root with `$SUDO_USER` set, refuse with a message pointing at re-running without sudo. (Bare root inside a container — no `$SUDO_USER` — is allowed; install proceeds to `/root/.local/bin`. Container-as-root is a legitimate use case; sudo escalation from a real user account is the unsafe pattern this guard rejects.)
7. If `--uninstall` was passed: jump to §Uninstall flow (handles brew-managed and non-brew cases internally).
8. Brew handling (install path only; --uninstall already branched away):
   a. If `command -v brew` and `brew list talater/wrap/wrap` succeeds:
      → echo "wrap already installed using Homebrew; running brew upgrade..." (stderr)  exec `brew upgrade talater/wrap/wrap`.
   b. If `command -v brew` succeeds (not managed by brew):
      → echo "Note: wrap also available via 'brew install talater/wrap/wrap'" (stderr).
9. Detect OS+arch via `uname -sm` case → base triple (4 cases + error).
10. **musl swap (Linux only)**: detect musl → replace `-gnu` with `-musl`. Must run before step 11.
11. **baseline append (x86_64 only)**: detect AVX2 absence → append `-baseline`. Must run after step 10 so the suffix lands at the end (`...-musl-baseline`, not `...-baseline-musl`).
12. Build URL: `https://github.com/TalAter/wrap/releases/download/${VERSION}/wrap-${TRIPLE}.tar.gz` where `VERSION` is the templated tag (or `latest` in dev). Use `releases/latest/download/...` if VERSION resolves to `latest`.
13. `mktemp -d`; `trap 'rm -rf "$tmp"' EXIT INT TERM`. Download tarball + checksums.txt with curl --proto '=https' --tlsv1.2 -fsSL.
    (TLS flags require curl 7.34+, shipped on every supported distro since 2013.)
14. Verify. POSIX `sh` has no `pipefail`, so a naive `grep ... | sha256-tool -c -` would silently pass when the triple is absent from `checksums.txt` (empty grep output → empty stdin → exit 0 from the hasher). Capture grep output first:
    ```sh
    expected="$(grep " wrap-${TRIPLE}.tar.gz$" checksums.txt || true)"
    [ -n "$expected" ] || err "no checksum entry for wrap-${TRIPLE}.tar.gz"
    printf '%s\n' "$expected" | sha256-tool -c -
    ```
    If neither `shasum` nor `sha256sum` is available, print the warning described in §Verification and skip. If `checksums.txt` itself failed to download, abort.
15. Extract tarball into the temp dir; check tar exit code. Then:
    - `mkdir -p "$WRAP_INSTALL_DIR"` (creates `~/.local/bin` if missing).
    - `mv "$tmp/wrap" "$WRAP_INSTALL_DIR/wrap.new"` (this move may cross filesystems — `tmp` is typically `/tmp`, install dir is under `$HOME`).
    - `chmod +x "$WRAP_INSTALL_DIR/wrap.new"` **before** the final rename, so the atomic swap publishes an already-executable file (no window where `wrap` exists on PATH but isn't executable).
    - `mv -f "$WRAP_INSTALL_DIR/wrap.new" "$WRAP_INSTALL_DIR/wrap"` — same-directory rename, atomic. Safe even if the running `wrap` is being replaced (Unix `mv` unlinks the inode, doesn't touch the executing image).
16. PATH check: capture `existing="$(command -v wrap || true)"`. The env-script (step 17) doesn't change the running process's `PATH`, so this still reflects the user's pre-install shell. If `existing` is non-empty AND not equal to `$WRAP_INSTALL_DIR/wrap`, print a `warning:` line naming both paths so the user sees another `wrap` is shadowing on PATH.
17. PATH setup (env-script pattern; see below).
18. Install completions (best-effort; see below).
19. Print success: version, install dir, brew-alt note, list of rc files modified (if any), list of completion files written (if any). Always print the "open a new shell" line when **either** rc files were modified **or** zsh completions were installed (zsh needs a fresh `compinit`).
```

### Snap-curl guard

Ubuntu's snap-confined `curl` cannot write to `$HOME` paths (sandbox restriction). Detect and abort before downloading anything.

Check: if `command -v curl` resolves to a path under `/snap/`, abort with `error: snap-installed curl cannot write to your home directory. Install curl via apt: 'sudo apt install curl'` to stderr and `exit 1`.

The check is mechanical (path-prefix match on `command -v curl` output) — implement it directly; no attribution needed.

### Detection logic

```sh
case "$(uname -sm)" in
  "Darwin arm64")               TRIPLE=aarch64-apple-darwin ;;
  "Darwin x86_64")              TRIPLE=x86_64-apple-darwin ;;
  "Linux aarch64"|"Linux arm64") TRIPLE=aarch64-unknown-linux-gnu ;;
  "Linux x86_64")               TRIPLE=x86_64-unknown-linux-gnu ;;
  *) err "Unsupported platform: $(uname -sm)" ;;
esac

# musl swap
if [ "${TRIPLE#*linux}" != "$TRIPLE" ]; then
  if [ -f /etc/alpine-release ] || ldd --version 2>&1 | grep -qi musl \
     || ldd /bin/ls 2>&1 | grep -qi musl; then
    TRIPLE="${TRIPLE%-gnu}-musl"
  fi
fi

# baseline append — order matters: run after musl swap so suffix lands last (...-musl-baseline)
case "$TRIPLE" in
  x86_64-*)
    has_avx2=0
    os="$(uname -s)"
    if [ "$os" = Linux ] && grep -qm1 avx2 /proc/cpuinfo 2>/dev/null; then
      has_avx2=1
    elif [ "$os" = Darwin ] && \
         sysctl -n hw.optional.avx2_0 machdep.cpu.leaf7_features 2>/dev/null \
         | grep -Eq '^1$|AVX2'; then
      has_avx2=1
    fi
    [ "$has_avx2" = 0 ] && TRIPLE="${TRIPLE}-baseline"
    ;;
esac
```

### Env-script (PATH + zsh FPATH)

Unless `WRAP_NO_MODIFY_PATH=1`, install.sh writes two env scripts via heredoc — `~/.wrap/env` (POSIX sh, sourced by bash + zsh) and `~/.wrap/env.fish` (fish syntax). Each shell's rc gets one source line. The env scripts self-deduplicate so re-running install.sh is idempotent and changes to env-script content propagate on the next install.sh run.

Pattern adapted from rustup's `~/.cargo/env`, extended to also set `FPATH` so zsh completion discovery requires no separate `.zshrc` edit. `FPATH` (uppercase env var) and `fpath` (zsh array) are auto-synced by zsh; bash and dash ignore `FPATH` as an unused env var.

**Heredoc, not external file**: env-script content is inlined in install.sh via `cat > ~/.wrap/env`. Inlining keeps install.sh as a single auditable file and guarantees env-script content matches install.sh's version.

The heredoc has to substitute the install dir (which may be a `WRAP_INSTALL_DIR` override) **but** keep `$PATH` / `$FPATH` / `$HOME` literal so the env script evaluates them at every shell startup. Use an unquoted heredoc with selective `\$` escaping for the runtime variables. To stay portable across machines and HOME relocations, normalize an `$HOME`-relative install dir back to literal `$HOME/...` form before substitution; absolute non-HOME paths land as-is.

`~/.wrap/env` (default install dir; `$HOME/.local/bin` is **literal** in the file, expanded at shell startup):

```sh
case ":${PATH}:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac
# zsh auto-syncs uppercase FPATH into its fpath array; bash/dash ignore it.
case ":${FPATH:-}:" in
  *":$HOME/.local/share/zsh/site-functions:"*) ;;
  *) export FPATH="$HOME/.local/share/zsh/site-functions${FPATH:+:$FPATH}" ;;
esac
```

If `WRAP_INSTALL_DIR=/opt/wrap/bin` was passed, both `$HOME/.local/bin` references in the PATH block become `/opt/wrap/bin` literal; the FPATH block is unchanged (completion path is fixed at the XDG default regardless of binary install dir).

`~/.wrap/env.fish`:

```fish
contains $HOME/.local/bin $PATH
or set -gx PATH $HOME/.local/bin $PATH
```

(Fish doesn't need the FPATH block — fish completions are auto-discovered from a separate dir; see §Completions.)

Each shell sources the env script:

| Shell | Target file | How |
|---|---|---|
| bash | `~/.bashrc`, `~/.profile`, `~/.bash_profile` (whichever exist) | append `. "$HOME/.wrap/env"` line if absent |
| zsh | `${ZDOTDIR:-$HOME}/.zshenv` | append `. "$HOME/.wrap/env"` line if absent |
| fish | `${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/wrap.fish` | write file with `source ~/.wrap/env.fish`; overwrite is fine (contents are fixed) |

Idempotent append for bash/zsh — whole-line match avoids false positives when `. "$HOME/.wrap/env"` appears as a substring inside a comment or string:

```sh
line='. "$HOME/.wrap/env"'
grep -qxF "$line" "$rc" || printf '\n%s\n' "$line" >> "$rc"
```

For fish, just `printf 'source ~/.wrap/env.fish\n' > "$conf_d/wrap.fish"`.

`WRAP_NO_MODIFY_PATH=1` (or `--no-modify-path`) skips env-script writing AND rc edits. Required for managed envs where the user owns rc files.

**No `compinit` call.** `compinit` is interactive-shell setup; running it from `.zshenv` would slow non-interactive zsh and isn't our concern. Users who already have any working completions (git, brew, etc.) have `compinit` set up — Wrap's completion file rides their existing `compinit` once `FPATH` is set. Users without `compinit` have no completions for any tool; that's their choice, not Wrap's problem to fix.

### Completions

After binary install, run `wrap --completion <shell>` (writes completion script to stdout) and redirect to user-owned paths:

| Shell | Path | Discovery |
|---|---|---|
| bash | `${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion/completions/wrap` | bash-completion package auto-loads from this dir |
| zsh | `${XDG_DATA_HOME:-$HOME/.local/share}/zsh/site-functions/_wrap` | env-script puts this dir on `FPATH` (see §Env-script) |
| fish | `${XDG_CONFIG_HOME:-$HOME/.config}/fish/completions/wrap.fish` | fish auto-loads from this dir |

Best-effort: each shell's completion install is wrapped so a failure (path not writable, parent dir missing and uncreatable) prints one stderr `warning:` line and continues. The binary works without completions.

The success message reminds the user to open a new shell for completions to take effect.

Brew-managed installs own these in system paths; the curl-sh path writes to user paths. No collision: brew install short-circuits via the brew-detect branch and never reaches this step.

Update `src/subcommands/completion.ts` help-text zsh line to match install.sh's path (`~/.local/share/zsh/site-functions/_wrap` instead of the current `~/.zsh/completions/_wrap`) so hand-installers and the script point at the same location.

### Uninstall

This section describes `install.sh --uninstall`.

1. **Brew short-circuit** — if `brew list talater/wrap/wrap` succeeds: print "wrap was installed using Homebrew; run `brew uninstall wrap`" and exit. Steps 2–6 only run when not brew-managed.
2. Remove `${WRAP_INSTALL_DIR:-$HOME/.local/bin}/wrap`.
3. Remove `~/.wrap/env`, `~/.wrap/env.fish`.
4. Remove the `. "$HOME/.wrap/env"` line from each rc file that contains it. Skip rc files that don't contain the line — avoids any rewrite (and avoids clobbering an empty rc with another empty file). Use a temp-file rewrite when present (POSIX-portable; some `sed -i` implementations differ between GNU/BSD). Place the temp file beside `$rc` so the final `mv` is a same-filesystem rename — preserves the rc file's mode/owner/xattrs (default `mktemp` would land in `/tmp`, often a different filesystem):
   ```sh
   line='. "$HOME/.wrap/env"'
   grep -qxF "$line" "$rc" || continue   # nothing to remove
   tmp_rc="$(mktemp "${rc}.XXXXXX")"
   grep -vxF "$line" "$rc" > "$tmp_rc"
   mv "$tmp_rc" "$rc"
   ```
5. Remove `${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/wrap.fish`.
6. Remove completion files at the paths listed in §Completions.
7. Print success message including: "Config and memory left at `~/.wrap/` — `rm -rf ~/.wrap` to fully remove, or run `wrap --forget` before next uninstall to wipe data while keeping the dir structure."

### TTY

The script never prompts. All choices are flag- or env-driven. `curl | sh` is non-interactive by contract; introducing `</dev/tty` reads is more code than it's worth for the few decisions involved.

---

## Release pipeline changes

`.github/workflows/release.yml` currently has `create-release → build → publish-release → bump-tap`. Updates:

1. **Expand build matrix** to 9 targets (see "Build matrix expansion" above).
2. **New job `install-script`**, depends on `create-release`: templates `scripts/install.sh` (substitutes `__WRAP_VERSION__` → tag), uploads the templated copy as a release asset so `releases/download/<tag>/install.sh` resolves. Attests via `attest-build-provenance`. Templating is one `sed -i "s|__WRAP_VERSION__|${GITHUB_REF_NAME}|g" install.sh` (pipe delimiter avoids escaping if a future tag scheme ever uses `/`).
3. **New job `checksums`**, depends on `build` and `install-script`: downloads every release asset (tarballs + templated install.sh), computes sha256, writes `checksums.txt`, uploads as release asset, attests.
4. **`publish-release` now depends on `checksums`** (which transitively depends on `build` + `install-script`). Required so `releases/latest` never resolves before all assets are present — otherwise a curl-pipe consumer hitting latest mid-release sees a 404 on `checksums.txt` or the install script.
5. **`bump-tap` unchanged.** Tap continues consuming the four canonical triples; new triples (musl, baseline) are install-script-only.

`scripts/install.sh` is checked in with `__WRAP_VERSION__` placeholder. The repo copy is runnable for local dev (placeholder falls back to `latest`); the release-asset copy is the templated one.

---

## Website changes

Three install rows on the website's install section:

1. **Homebrew (macOS, Linux)** — `brew install talater/wrap/wrap`. Recommended for managed environments.
2. **Install script** — `curl -fsSL https://wrap.talater.com/install.sh | sh`. Recommended for any Unix, CI, Docker. The website's copy-paste line is exactly this — no extra `--proto`/`--tlsv1.2` flags. Those flags are inside the script itself (defense-in-depth on its own download calls), but exposing them in the user-facing one-liner adds visual noise without trust value for non-expert readers.
3. **Manual download** — link to release assets. Document the macOS Gatekeeper workaround (`xattr -d com.apple.quarantine wrap` or right-click → Open) on this row only; curl-sh and brew don't trigger it.

No README at repo root currently; creation is out of scope for this spec. If/when added, mirror the same rows.

---

## Vault updates

`vault/release.md` § "Future channels" already anticipates this. Update when shipped:
- Confirm channel is live, link to install.sh.
- Correct the existing Gatekeeper note: curl-sh does **not** trigger the "downloaded from internet" dialog. `curl` doesn't set `com.apple.quarantine` (only quarantine-aware apps like Safari/Chrome/Mail/AirDrop/Messages do). Brew works for the same reason — it uses curl under the hood. The Gatekeeper dialog applies only to the **manual browser download** path; document the workaround (`xattr -d com.apple.quarantine wrap` or right-click → Open) in the manual-download row of the website, not in install.sh chrome.

`vault/README.md` Module map: add `scripts/install.sh` reference.

New invariant or glossary entry not needed — install.sh is install-time tooling, not runtime ([[chrome]] in the glossary refers specifically to runtime UI).

---

## Testing

`scripts/install.sh` is shell, not TypeScript — Wrap's TDD rule (CLAUDE.md) applies to TS implementation, not to shell tooling here. Validation is integration-style:

- Run `shellcheck scripts/install.sh` in CI (separate workflow or step).
- Manually validate against the rc release on macOS arm64, macOS x86_64, Linux glibc x86_64, Linux glibc arm64, Linux musl (Alpine container) x86_64. Baseline variants are best-effort — exercise via `WRAP_INSTALL_DIR=/tmp/wrap-test sh install.sh` on at least one old-CPU host or `qemu` if accessible.
- Idempotency check: run install.sh twice; rc files should not gain duplicate `. "$HOME/.wrap/env"` lines.
- Uninstall check: `install.sh --uninstall` removes the rc-source line and leaves `~/.wrap/` intact.

No unit tests for the script.

---
## Implementation order

1. Add musl + baseline targets to release matrix; verify they build clean. Tag a `-rc` to test.
2. Add `checksums.txt` job; verify the file shape and that `shasum -c` accepts it.
3. Write `scripts/install.sh`. Test against the rc release on a mac, linux-glibc, linux-musl (Alpine container), old-CPU VM if available.
4. Add `install.sh` upload to release workflow.
5. Set up `wrap.talater.com` redirects (`/install.sh` and `/install/<v>.sh` → GitHub release assets per §Hosting).
6. Update website with three install rows.
7. Update `vault/release.md`.
8. Cut a real release and validate the rolling URL.
