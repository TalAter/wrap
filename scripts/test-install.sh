#!/bin/sh
# scripts/test-install.sh — local Docker rig for install.sh.
#
# Builds wrap binaries for arm64 (glibc + musl), stages them with checksums.txt
# and the working-copy install.sh, then runs the install/re-install/uninstall
# assertion checklist inside ubuntu:24.04 and alpine:3.20 (linux/arm64).
#
# Run from the repo root: `./scripts/test-install.sh`.
# Requires: docker (orbstack works), bun.

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STAGE_DIR="${WRAP_TEST_STAGE_DIR:-/tmp/wrap-test-stage}"

note() {
  printf '== %s\n' "$1" >&2
}

err() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

build_for() {
  triple="$1"
  bun_target="$2"

  note "Building wrap for $triple ($bun_target)..."
  ( cd "$REPO_DIR" && WRAP_BUILD_TARGET="$bun_target" bun run scripts/build.ts ) \
    || err "build failed for $triple"

  ( cd "$REPO_DIR" && tar -czf "$STAGE_DIR/wrap-${triple}.tar.gz" wrap )
  rm -f "$REPO_DIR/wrap"
}

stage_assets() {
  rm -rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR"

  build_for aarch64-unknown-linux-gnu  bun-linux-arm64
  build_for aarch64-unknown-linux-musl bun-linux-arm64-musl

  ( cd "$STAGE_DIR" && sha256sum wrap-*.tar.gz > checksums.txt )

  cp "$SCRIPT_DIR/install.sh" "$STAGE_DIR/install.sh"
}

# Assertion checklist — runs inside the container under POSIX sh.
# shellcheck disable=SC2016  # all $-vars expand inside the container, not here
ASSERT_SCRIPT='
set -eu

if command -v apk >/dev/null 2>&1; then
  apk add --no-cache curl python3 >/dev/null
elif command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl python3 >/dev/null
fi

cd /srv
python3 -m http.server 8000 >/dev/null 2>&1 &
SERVER_PID=$!
trap "kill $SERVER_PID 2>/dev/null || true" EXIT

# Wait for server to bind.
i=0
while [ $i -lt 40 ]; do
  if curl -fsS http://127.0.0.1:8000/install.sh >/dev/null 2>&1; then break; fi
  i=$((i + 1))
  sleep 0.1
done

LINE_BASH=". \"\$HOME/.wrap/env\""
RC_BASH="$HOME/.bashrc"
RC_ZSH="${ZDOTDIR:-$HOME}/.zshenv"
FISH_CONF="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/wrap.fish"
FISH_LINE="source ~/.wrap/env.fish"

count_line() {
  # grep -c writes the count to stdout AND exits 1 when the count is 0,
  # so an `|| echo 0` fallback would double-print. Suppress the failure with
  # `|| true` and trust grep -c itself to print the right number either way.
  if [ ! -f "$1" ]; then echo 0; return; fi
  grep -cFx "$2" "$1" 2>/dev/null || true
}

# ---------- 1. Install ----------
echo "== install" >&2
sh /srv/install.sh --base-url http://127.0.0.1:8000

[ -x "$HOME/.local/bin/wrap" ] || { echo "FAIL: binary not at ~/.local/bin/wrap" >&2; exit 1; }

ACTUAL_VERSION="$("$HOME/.local/bin/wrap" --version 2>/dev/null || true)"
[ -n "$ACTUAL_VERSION" ] || { echo "FAIL: wrap --version produced empty output" >&2; exit 1; }
if [ -n "${EXPECTED_VERSION:-}" ]; then
  case "$ACTUAL_VERSION" in
    *"$EXPECTED_VERSION"*) ;;
    *) echo "FAIL: --version=$ACTUAL_VERSION does not contain $EXPECTED_VERSION" >&2; exit 1 ;;
  esac
fi

[ "$(count_line "$RC_BASH" "$LINE_BASH")" = 1 ]   || { echo "FAIL: ~/.bashrc has wrong number of source lines" >&2; exit 1; }
[ "$(count_line "$RC_ZSH"  "$LINE_BASH")" = 1 ]   || { echo "FAIL: ~/.zshenv has wrong number of source lines" >&2; exit 1; }
[ "$(count_line "$FISH_CONF" "$FISH_LINE")" = 1 ] || { echo "FAIL: fish conf.d has wrong number of source lines" >&2; exit 1; }

# ---------- 1b. --no-modify-path skips env + rc but keeps completions ----------
# Use a sentinel rc so the previous step state does not pollute this check.
echo "== --no-modify-path" >&2
SENTINEL_HOME="$(mktemp -d)"
HOME="$SENTINEL_HOME" sh /srv/install.sh --base-url http://127.0.0.1:8000 --no-modify-path

[ -x "$SENTINEL_HOME/.local/bin/wrap" ] || { echo "FAIL: --no-modify-path did not install binary" >&2; exit 1; }
[ ! -e "$SENTINEL_HOME/.wrap/env" ]      || { echo "FAIL: --no-modify-path wrote env script" >&2; exit 1; }
[ ! -e "$SENTINEL_HOME/.wrap/env.fish" ] || { echo "FAIL: --no-modify-path wrote fish env script" >&2; exit 1; }
[ ! -e "$SENTINEL_HOME/.bashrc" ]        || { echo "FAIL: --no-modify-path wrote .bashrc" >&2; exit 1; }
[ ! -e "$SENTINEL_HOME/.zshenv" ]        || { echo "FAIL: --no-modify-path wrote .zshenv" >&2; exit 1; }
# Completions still installed under the sentinel HOME.
[ -e "$SENTINEL_HOME/.local/share/bash-completion/completions/wrap" ] || { echo "FAIL: --no-modify-path skipped bash completion" >&2; exit 1; }
rm -rf "$SENTINEL_HOME"

# ---------- 2. Re-run = idempotent upgrade ----------
echo "== reinstall" >&2
sh /srv/install.sh --base-url http://127.0.0.1:8000

[ "$(count_line "$RC_BASH" "$LINE_BASH")" = 1 ]   || { echo "FAIL: ~/.bashrc duplicated source line on re-run" >&2; exit 1; }
[ "$(count_line "$RC_ZSH"  "$LINE_BASH")" = 1 ]   || { echo "FAIL: ~/.zshenv duplicated source line on re-run" >&2; exit 1; }
[ "$(count_line "$FISH_CONF" "$FISH_LINE")" = 1 ] || { echo "FAIL: fish conf.d duplicated on re-run" >&2; exit 1; }

# ---------- 3. Stub user data ----------
mkdir -p "$HOME/.wrap"
printf "stub-config\n" > "$HOME/.wrap/config.jsonc"
printf "stub-memory\n" > "$HOME/.wrap/memory.json"

# ---------- 4. Uninstall ----------
echo "== uninstall" >&2
sh /srv/install.sh --uninstall

[ ! -e "$HOME/.local/bin/wrap" ] || { echo "FAIL: wrap binary still present" >&2; exit 1; }
[ ! -e "$HOME/.wrap/env" ]       || { echo "FAIL: ~/.wrap/env still present" >&2; exit 1; }
[ ! -e "$HOME/.wrap/env.fish" ]  || { echo "FAIL: ~/.wrap/env.fish still present" >&2; exit 1; }
[ ! -e "$FISH_CONF" ]            || { echo "FAIL: fish conf.d/wrap.fish still present" >&2; exit 1; }
[ ! -e "${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion/completions/wrap" ] || { echo "FAIL: bash completion still present" >&2; exit 1; }
[ ! -e "${XDG_DATA_HOME:-$HOME/.local/share}/zsh/site-functions/_wrap" ] || { echo "FAIL: zsh completion still present" >&2; exit 1; }
[ ! -e "${XDG_CONFIG_HOME:-$HOME/.config}/fish/completions/wrap.fish" ] || { echo "FAIL: fish completion still present" >&2; exit 1; }

[ "$(count_line "$RC_BASH" "$LINE_BASH")" = 0 ]   || { echo "FAIL: ~/.bashrc still contains source line" >&2; exit 1; }
[ "$(count_line "$RC_ZSH"  "$LINE_BASH")" = 0 ]   || { echo "FAIL: ~/.zshenv still contains source line" >&2; exit 1; }

[ "$(cat "$HOME/.wrap/config.jsonc")" = "stub-config" ] || { echo "FAIL: config.jsonc not preserved" >&2; exit 1; }
[ "$(cat "$HOME/.wrap/memory.json")"  = "stub-memory" ] || { echo "FAIL: memory.json not preserved" >&2; exit 1; }

echo "== all assertions passed" >&2
'

run_in_container() {
  image="$1"
  note "Running checklist in $image..."
  expected_version="$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$REPO_DIR/package.json" | head -1 | sed -e 's/.*"\([^"]*\)"$/\1/')"
  docker run --rm --platform linux/arm64 \
    -v "$STAGE_DIR:/srv:ro" \
    -e "EXPECTED_VERSION=$expected_version" \
    "$image" sh -c "$ASSERT_SCRIPT" \
    || err "checklist failed in $image"
}

main() {
  command -v docker >/dev/null 2>&1 || err "docker not found (orbstack/docker required)"
  command -v bun    >/dev/null 2>&1 || err "bun not found"

  stage_assets

  run_in_container "ubuntu:24.04"
  run_in_container "alpine:3.20"

  note "All containers passed."
}

main "$@"
