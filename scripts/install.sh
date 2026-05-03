#!/bin/sh
# wrap installer — https://github.com/TalAter/wrap
# Downloads the latest wrap release for your platform, verifies its sha256,
# installs it under $HOME/.local/bin (no sudo). Re-running upgrades.
# License: MIT.

set -eu

DEFAULT_BASE_URL='https://github.com/TalAter/wrap/releases/latest/download'
ISSUES_URL='https://github.com/TalAter/wrap/issues'

err() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

note() {
  printf '%s\n' "$1" >&2
}

warn() {
  printf 'warning: %s\n' "$1" >&2
}

usage() {
  cat >&2 <<'EOF'
Install wrap (https://github.com/TalAter/wrap).

Usage:
  install.sh [--install-dir <path>] [--no-modify-path]
  install.sh --uninstall [--install-dir <path>]
  install.sh -h | --help

Options:
  --install-dir <path>  Override install location (default: $HOME/.local/bin).
  --no-modify-path      Skip env script and rc file edits.
  --uninstall           Remove wrap, env scripts, rc-file source line, completions.
  -h, --help            Show this help.
EOF
}

main() {
  [ -n "${HOME:-}" ] || err "HOME is not set"

  install_dir="$HOME/.local/bin"
  modify_path=1
  uninstall=0
  base_url="$DEFAULT_BASE_URL"

  while [ $# -gt 0 ]; do
    case "$1" in
      --install-dir)
        [ $# -ge 2 ] || err "--install-dir requires a path"
        install_dir="$2"
        shift 2
        ;;
      --no-modify-path)
        modify_path=0
        shift
        ;;
      --uninstall)
        uninstall=1
        shift
        ;;
      --base-url)
        # Internal: undocumented, used by the local rig and CI verify-install.
        [ $# -ge 2 ] || err "--base-url requires a URL"
        base_url="$2"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        err "Unknown flag: $1"
        ;;
    esac
  done

  # Bare root is allowed (containers); sudo escalation from a normal user is not.
  if [ "$(id -u)" = 0 ] && [ -n "${SUDO_USER:-}" ]; then
    err "do not run with sudo; re-run as $SUDO_USER"
  fi

  if [ "$uninstall" = 1 ]; then
    do_uninstall "$install_dir"
    exit 0
  fi

  command -v curl >/dev/null 2>&1 || err "curl is required"

  if command -v brew >/dev/null 2>&1 && brew list talater/wrap/wrap >/dev/null 2>&1; then
    err "wrap is managed by Homebrew; run 'brew upgrade talater/wrap/wrap'"
  fi

  detect_triple

  url="${base_url}/wrap-${TRIPLE}.tar.gz"
  checksums_url="${base_url}/checksums.txt"

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT INT TERM

  note "Downloading wrap-${TRIPLE}.tar.gz..."
  curl -fsSL -o "$tmp/wrap-${TRIPLE}.tar.gz" "$url" \
    || err "download failed: $url"
  curl -fsSL -o "$tmp/checksums.txt" "$checksums_url" \
    || err "checksums.txt missing from release; report at $ISSUES_URL"

  verify_checksum "$tmp" "wrap-${TRIPLE}.tar.gz"

  tar -xzf "$tmp/wrap-${TRIPLE}.tar.gz" -C "$tmp" || err "failed to extract tarball"
  [ -f "$tmp/wrap" ] || err "tarball did not contain wrap binary"

  mkdir -p "$install_dir" || err "could not create $install_dir"
  # chmod before final rename so the published binary is already executable.
  mv "$tmp/wrap" "$install_dir/wrap.new"
  chmod +x "$install_dir/wrap.new"
  mv -f "$install_dir/wrap.new" "$install_dir/wrap"

  shadow_check "$install_dir"

  rc_files_modified=""
  if [ "$modify_path" = 1 ]; then
    write_env_scripts "$install_dir"
    rc_files_modified="$(update_rc_files)"
  fi

  completions_written="$(install_completions "$install_dir/wrap")"

  print_success "$install_dir" "$rc_files_modified" "$completions_written"
}

detect_triple() {
  case "$(uname -sm)" in
    "Darwin arm64")                 TRIPLE=aarch64-apple-darwin ;;
    "Darwin x86_64")                TRIPLE=x86_64-apple-darwin ;;
    "Linux aarch64"|"Linux arm64")  TRIPLE=aarch64-unknown-linux-gnu ;;
    "Linux x86_64")                 TRIPLE=x86_64-unknown-linux-gnu ;;
    *) err "unsupported platform: $(uname -sm)" ;;
  esac

  # Alpine's ldd prints to stderr and exits 1 with no args; --version prints
  # the loader version mixed across both streams. 2>&1 + grep is reliable.
  case "$TRIPLE" in
    *linux-gnu)
      if ldd --version 2>&1 | grep -qi musl; then
        TRIPLE="${TRIPLE%-gnu}-musl"
      fi
      ;;
  esac
}

verify_checksum() {
  tmp_dir="$1"
  filename="$2"

  if command -v sha256sum >/dev/null 2>&1; then
    hasher='sha256sum'
  elif command -v shasum >/dev/null 2>&1; then
    hasher='shasum -a 256'
  else
    warn "no sha256 tool found, skipping checksum verification"
    return 0
  fi

  # Capture grep first: POSIX sh has no pipefail, so a missing entry would
  # produce empty stdin and the hasher would falsely exit 0.
  expected="$(grep " ${filename}\$" "$tmp_dir/checksums.txt" || true)"
  [ -n "$expected" ] || err "no checksum entry for ${filename}"

  ( cd "$tmp_dir" && printf '%s\n' "$expected" | $hasher -c - >/dev/null ) \
    || err "checksum verification failed for ${filename}"
}

shadow_check() {
  bin_dir="$1"
  existing="$(command -v wrap 2>/dev/null || true)"
  [ -n "$existing" ] || return 0
  [ "$existing" = "$bin_dir/wrap" ] && return 0
  warn "another 'wrap' is on PATH at $existing (just installed: $bin_dir/wrap)"
}

# Replace leading $HOME with literal "$HOME" so env scripts work across machines.
normalize_home() {
  # shellcheck disable=SC2016  # literal '$HOME' is intentional
  case "$1" in
    "$HOME") printf '%s' '$HOME' ;;
    "$HOME"/*) printf '%s' "\$HOME${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

write_env_scripts() {
  bin_dir="$1"
  mkdir -p "$HOME/.wrap"

  norm="$(normalize_home "$bin_dir")"

  # POSIX env (bash + zsh). $PATH stays literal so each shell expands at startup.
  cat > "$HOME/.wrap/env" <<EOF
case ":\${PATH}:" in
  *":${norm}:"*) ;;
  *) export PATH="${norm}:\$PATH" ;;
esac
EOF

  # fish_add_path is idempotent; no contains-check needed.
  cat > "$HOME/.wrap/env.fish" <<EOF
fish_add_path -g ${norm}
EOF
}

# Append a source line if absent. Print rc path on stdout if modified.
ensure_rc_line() {
  rc="$1"
  line="$2"
  mkdir -p "$(dirname "$rc")"
  if [ -f "$rc" ] && grep -qxF "$line" "$rc"; then
    return 0
  fi
  printf '%s\n' "$line" >> "$rc"
  printf '%s ' "$rc"
}

update_rc_files() {
  modified=""
  # shellcheck disable=SC2016  # literal '$HOME' so the rc-file source line resolves at shell startup
  line='. "$HOME/.wrap/env"'

  # zsh: .zshenv (not .zshrc) so the source line lands in scripts and
  # non-interactive shells too. The env script is a guarded PATH prepend, so
  # leaking into subprocesses is the desired behavior. Pattern from rustup.
  for rc in "$HOME/.bashrc" "${ZDOTDIR:-$HOME}/.zshenv"; do
    out="$(ensure_rc_line "$rc" "$line")"
    modified="${modified}${out}"
  done

  fish_conf_dir="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d"
  fish_conf="$fish_conf_dir/wrap.fish"
  fish_line='source ~/.wrap/env.fish'
  mkdir -p "$fish_conf_dir"
  if ! [ -f "$fish_conf" ] || ! grep -qxF "$fish_line" "$fish_conf"; then
    printf '%s\n' "$fish_line" > "$fish_conf"
    modified="${modified}${fish_conf} "
  fi

  printf '%s' "$modified"
}

# Best-effort per-shell. A failure prints a warning and continues.
try_completion() {
  binary="$1"
  shell="$2"
  out_path="$3"

  out_dir="$(dirname "$out_path")"
  if ! mkdir -p "$out_dir" 2>/dev/null; then
    warn "could not create $out_dir; skipping $shell completion"
    return 1
  fi
  if ! "$binary" --completion "$shell" > "$out_path" 2>/dev/null; then
    warn "could not install $shell completion at $out_path"
    rm -f "$out_path" 2>/dev/null || true
    return 1
  fi
  return 0
}

install_completions() {
  binary="$1"
  written=""

  bash_path="${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion/completions/wrap"
  zsh_path="${XDG_DATA_HOME:-$HOME/.local/share}/zsh/site-functions/_wrap"
  fish_path="${XDG_CONFIG_HOME:-$HOME/.config}/fish/completions/wrap.fish"

  try_completion "$binary" bash "$bash_path" && written="${written}${bash_path} "
  try_completion "$binary" zsh  "$zsh_path"  && written="${written}${zsh_path} "
  try_completion "$binary" fish "$fish_path" && written="${written}${fish_path} "

  printf '%s' "$written"
}

print_success() {
  bin_dir="$1"
  rcs="$2"
  comps="$3"

  version="$("$bin_dir/wrap" --version 2>/dev/null || true)"
  [ -n "$version" ] || version='(unknown version)'

  note ""
  note "Installed wrap $version → $bin_dir/wrap"
  [ -z "$rcs" ]   || note "Modified rc files: $rcs"
  [ -z "$comps" ] || note "Wrote completions: $comps"

  if [ -n "$rcs" ] || [ -n "$comps" ]; then
    note "Open a new shell, or run '. \"\$HOME/.wrap/env\"' to use wrap now."
  fi
  case "$comps" in
    *"_wrap"*)
      note "Zsh: ensure ${XDG_DATA_HOME:-\$HOME/.local/share}/zsh/site-functions is on \$fpath."
      ;;
  esac
}

do_uninstall() {
  bin_dir="$1"
  removed=""
  updated=""

  if [ -e "$bin_dir/wrap" ]; then
    rm -f "$bin_dir/wrap"
    removed="${removed}${bin_dir}/wrap "
  fi

  for f in \
    "$HOME/.wrap/env" \
    "$HOME/.wrap/env.fish" \
    "${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/wrap.fish" \
    "${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion/completions/wrap" \
    "${XDG_DATA_HOME:-$HOME/.local/share}/zsh/site-functions/_wrap" \
    "${XDG_CONFIG_HOME:-$HOME/.config}/fish/completions/wrap.fish"; do
    if [ -e "$f" ]; then
      rm -f "$f"
      removed="${removed}${f} "
    fi
  done

  # shellcheck disable=SC2016  # literal '$HOME' so the rc-file source line resolves at shell startup
  line='. "$HOME/.wrap/env"'
  for rc in "$HOME/.bashrc" "${ZDOTDIR:-$HOME}/.zshenv"; do
    [ -f "$rc" ] || continue
    grep -qxF "$line" "$rc" || continue
    # Same-fs temp file → final mv is atomic rename. grep -v exits 1 when the
    # output is empty (rc had only the source line) — legitimate. Exit ≥2 is
    # a real error; do NOT mv the partial temp over the user's rc.
    tmp_rc="$(mktemp "${rc}.XXXXXX")"
    set +e
    grep -vxF "$line" "$rc" > "$tmp_rc"
    gv_status=$?
    set -e
    if [ "$gv_status" -gt 1 ]; then
      rm -f "$tmp_rc"
      err "failed to rewrite $rc"
    fi
    mv "$tmp_rc" "$rc"
    updated="${updated}${rc} "
  done

  note ""
  if [ -z "$removed" ] && [ -z "$updated" ]; then
    note "Nothing to uninstall."
  else
    [ -z "$removed" ] || note "Removed: $removed"
    [ -z "$updated" ] || note "Updated (source line dropped): $updated"
  fi
  note "Config and memory left at ~/.wrap/ — 'rm -rf ~/.wrap' to fully remove,"
  note "or run 'wrap --forget' before next uninstall to wipe data while keeping the dir."
}

main "$@"
