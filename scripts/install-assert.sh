#!/bin/sh
# Install/uninstall assertion checklist for wrap install.sh.
# Shared between scripts/test-install.sh (local Mac rig) and the
# release.yml verify-install jobs. Runs install → --no-modify-path →
# reinstall (idempotent) → uninstall, asserting state at each step.
#
# Required env:
#   BASE_URL          e.g. http://127.0.0.1:8000 — must already be serving
#                     install.sh + checksums.txt + tarballs.
#   INSTALL_SCRIPT    path to the install.sh under test.
# Optional env:
#   EXPECTED_VERSION  asserted as a substring of `wrap --version`.
#
# Self-sandboxes HOME via mktemp so it can run on a real user host (CI macos
# leg) without touching the runner's rc files.

set -eu

[ -n "${BASE_URL:-}" ]       || { echo "error: BASE_URL not set" >&2; exit 1; }
[ -n "${INSTALL_SCRIPT:-}" ] || { echo "error: INSTALL_SCRIPT not set" >&2; exit 1; }
[ -f "$INSTALL_SCRIPT" ]     || { echo "error: $INSTALL_SCRIPT not found" >&2; exit 1; }

HOME="$(mktemp -d)"
# POSIX shells exempt assignment from `set -e`, so a failed mktemp would
# silently leave HOME empty and then $HOME/foo would resolve to /foo.
if [ -z "$HOME" ] || [ ! -d "$HOME" ]; then
  echo "error: mktemp -d failed" >&2
  exit 1
fi
export HOME
SENTINEL_HOME=""
trap 'rm -rf "$HOME" "$SENTINEL_HOME"' EXIT INT TERM

# shellcheck disable=SC2016  # literal '$HOME' as written in the rc source line
LINE_BASH='. "$HOME/.wrap/env"'
RC_BASH="$HOME/.bashrc"
RC_ZSH="${ZDOTDIR:-$HOME}/.zshenv"
FISH_CONF="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/wrap.fish"
FISH_LINE='source ~/.wrap/env.fish'

count_line() {
  if [ ! -f "$1" ]; then echo 0; return; fi
  grep -cFx "$2" "$1" 2>/dev/null || true
}

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# ---------- 1. Install ----------
echo "== install" >&2
sh "$INSTALL_SCRIPT" --base-url "$BASE_URL"

[ -x "$HOME/.local/bin/wrap" ] || fail "binary not at \$HOME/.local/bin/wrap"

ACTUAL_VERSION="$("$HOME/.local/bin/wrap" --version 2>/dev/null || true)"
[ -n "$ACTUAL_VERSION" ] || fail "wrap --version produced empty output"
if [ -n "${EXPECTED_VERSION:-}" ]; then
  case "$ACTUAL_VERSION" in
    *"$EXPECTED_VERSION"*) ;;
    *) fail "--version=$ACTUAL_VERSION does not contain $EXPECTED_VERSION" ;;
  esac
fi

[ "$(count_line "$RC_BASH" "$LINE_BASH")"   = 1 ] || fail "$RC_BASH has wrong number of source lines"
[ "$(count_line "$RC_ZSH"  "$LINE_BASH")"   = 1 ] || fail "$RC_ZSH has wrong number of source lines"
[ "$(count_line "$FISH_CONF" "$FISH_LINE")" = 1 ] || fail "$FISH_CONF has wrong number of source lines"

# ---------- 1b. --no-modify-path skips env + rc but keeps completions ----------
echo "== --no-modify-path" >&2
SENTINEL_HOME="$(mktemp -d)"
if [ -z "$SENTINEL_HOME" ] || [ ! -d "$SENTINEL_HOME" ]; then
  echo "error: mktemp -d failed" >&2
  exit 1
fi
HOME="$SENTINEL_HOME" sh "$INSTALL_SCRIPT" --base-url "$BASE_URL" --no-modify-path

[ -x "$SENTINEL_HOME/.local/bin/wrap" ] || fail "--no-modify-path did not install binary"
[ ! -e "$SENTINEL_HOME/.wrap/env" ]      || fail "--no-modify-path wrote env script"
[ ! -e "$SENTINEL_HOME/.wrap/env.fish" ] || fail "--no-modify-path wrote fish env script"
[ ! -e "$SENTINEL_HOME/.bashrc" ]        || fail "--no-modify-path wrote .bashrc"
[ ! -e "$SENTINEL_HOME/.zshenv" ]        || fail "--no-modify-path wrote .zshenv"
[ -e "$SENTINEL_HOME/.local/share/bash-completion/completions/wrap" ] || fail "--no-modify-path skipped bash completion"
rm -rf "$SENTINEL_HOME"
SENTINEL_HOME=""

# ---------- 2. Re-run = idempotent upgrade ----------
echo "== reinstall" >&2
sh "$INSTALL_SCRIPT" --base-url "$BASE_URL"

[ "$(count_line "$RC_BASH" "$LINE_BASH")"   = 1 ] || fail "$RC_BASH duplicated source line on re-run"
[ "$(count_line "$RC_ZSH"  "$LINE_BASH")"   = 1 ] || fail "$RC_ZSH duplicated source line on re-run"
[ "$(count_line "$FISH_CONF" "$FISH_LINE")" = 1 ] || fail "$FISH_CONF duplicated on re-run"

# ---------- 3. Stub user data ----------
mkdir -p "$HOME/.wrap"
printf "stub-config\n" > "$HOME/.wrap/config.jsonc"
printf "stub-memory\n" > "$HOME/.wrap/memory.json"

# ---------- 4. Uninstall ----------
echo "== uninstall" >&2
sh "$INSTALL_SCRIPT" --uninstall

[ ! -e "$HOME/.local/bin/wrap" ] || fail "wrap binary still present"
[ ! -e "$HOME/.wrap/env" ]       || fail "\$HOME/.wrap/env still present"
[ ! -e "$HOME/.wrap/env.fish" ]  || fail "\$HOME/.wrap/env.fish still present"
[ ! -e "$FISH_CONF" ]            || fail "fish conf.d/wrap.fish still present"
[ ! -e "${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion/completions/wrap" ] || fail "bash completion still present"
[ ! -e "${XDG_DATA_HOME:-$HOME/.local/share}/zsh/site-functions/_wrap" ]         || fail "zsh completion still present"
[ ! -e "${XDG_CONFIG_HOME:-$HOME/.config}/fish/completions/wrap.fish" ]          || fail "fish completion still present"

[ "$(count_line "$RC_BASH" "$LINE_BASH")" = 0 ] || fail "$RC_BASH still contains source line"
[ "$(count_line "$RC_ZSH"  "$LINE_BASH")" = 0 ] || fail "$RC_ZSH still contains source line"

[ "$(cat "$HOME/.wrap/config.jsonc")" = "stub-config" ] || fail "config.jsonc not preserved"
[ "$(cat "$HOME/.wrap/memory.json")"  = "stub-memory" ] || fail "memory.json not preserved"

echo "== all assertions passed" >&2
