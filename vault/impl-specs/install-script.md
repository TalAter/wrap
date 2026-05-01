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

No env vars. CLI flags only.

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
11. Build URL: `https://github.com/TalAter/wrap/releases/latest/download/wrap-${TRIPLE}.tar.gz`.
12. `mktemp -d`; `trap 'rm -rf "$tmp"' EXIT INT TERM`. Download tarball + checksums.txt with `curl --proto '=https' --tlsv1.2 -fsSL`.
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

1. **Expand build matrix** to 6 targets (4 current + 2 musl; see "Build matrix expansion" above).
2. **New job `checksums`**, depends on `build`: downloads every tarball, computes sha256, writes `checksums.txt`, uploads as release asset, attests.
3. **Upload `scripts/install.sh` as a release asset** as part of the existing publish step (or a tiny job before `publish-release`). Byte-identical to the repo file — no templating.
4. **`publish-release` now depends on `checksums`**. Required so `releases/latest` never resolves before all assets are present — otherwise a curl-pipe consumer hitting latest mid-release sees a 404 on `checksums.txt` or the install script.
5. **`bump-tap` unchanged.** Tap continues consuming the four canonical triples; new musl triples are install-script-only.

---

## Website changes

Three install rows on the website's install section:

1. **Homebrew (macOS, Linux)** — `brew install talater/wrap/wrap`. Recommended for managed environments.
2. **Install script** — `curl -fsSL https://wrap.talater.com/install.sh | sh`. Recommended for any Unix, CI, Docker. TLS curl flags live inside the script, not the user-facing one-liner.
3. **Manual download** — link to release assets. Document the macOS Gatekeeper workaround (`xattr -d com.apple.quarantine wrap` or right-click → Open) on this row only; curl-sh and brew don't trigger it.

---

## Vault updates

`vault/release.md` § "Future channels" already anticipates this. Update when shipped:
- Confirm channel is live, link to install.sh.
- Correct the existing Gatekeeper note: curl-sh does **not** trigger the "downloaded from internet" dialog. `curl` doesn't set `com.apple.quarantine` (only quarantine-aware apps like Safari/Chrome/Mail/AirDrop/Messages do). Brew works for the same reason — it uses curl under the hood. The Gatekeeper dialog applies only to the **manual browser download** path; document the workaround in the manual-download row of the website, not in install.sh chrome.

`vault/README.md` Module map: add `scripts/install.sh` reference.

---

## Testing

- `shellcheck scripts/install.sh` in CI.
- Manually validate against the rc release on macOS arm64, macOS x86_64, Linux glibc x86_64, Linux glibc arm64, Linux musl (Alpine container) x86_64.
- Idempotency: run install.sh twice; rc files should not gain duplicate `. "$HOME/.wrap/env"` lines.
- Uninstall: `install.sh --uninstall` removes the rc-source line and leaves `~/.wrap/` intact.

---
## Implementation order

1. Add musl targets to release matrix; verify they build clean. Tag a `-rc` to test.
2. Add `checksums.txt` job; verify the file shape and that `shasum -c` accepts it.
3. Write `scripts/install.sh`. Test against the rc release on a mac, linux-glibc, linux-musl (Alpine container).
4. Add `install.sh` upload to release workflow.
5. Set up `wrap.talater.com/install.sh` redirect to GitHub release `latest` asset.
6. Update website with three install rows.
7. Update `vault/release.md`.
8. Cut a real release and validate `wrap.talater.com/install.sh`.
