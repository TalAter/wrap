#!/bin/sh
# scripts/test-install.sh — local Docker rig for install.sh.
#
# Builds wrap binaries for arm64 (glibc + musl), stages them with checksums.txt,
# install.sh, and install-assert.sh, then runs the assertion checklist inside
# ubuntu:24.04 and alpine:3.20 (linux/arm64).
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

  cp "$SCRIPT_DIR/install.sh"        "$STAGE_DIR/install.sh"
  cp "$SCRIPT_DIR/install-assert.sh" "$STAGE_DIR/install-assert.sh"
}

# Bootstrap a container: install prereqs, start the local http server,
# then exec install-assert.sh against it.
# shellcheck disable=SC2016  # all $-vars expand inside the container, not here
CONTAINER_SCRIPT='
set -eu

if command -v apk >/dev/null 2>&1; then
  apk add --no-cache curl python3 >/dev/null
elif command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl python3 >/dev/null
fi

cd /srv
python3 -m http.server 8000 >/dev/null 2>&1 &
trap "kill $! 2>/dev/null || true" EXIT

# Wait for server to bind.
i=0
while [ $i -lt 40 ]; do
  if curl -fsS http://127.0.0.1:8000/install.sh >/dev/null 2>&1; then break; fi
  i=$((i + 1))
  sleep 0.1
done

BASE_URL=http://127.0.0.1:8000 \
  INSTALL_SCRIPT=/srv/install.sh \
  EXPECTED_VERSION="${EXPECTED_VERSION:-}" \
  sh /srv/install-assert.sh
'

run_in_container() {
  image="$1"
  note "Running checklist in $image..."
  expected_version="$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$REPO_DIR/package.json" | head -1 | sed -e 's/.*"\([^"]*\)"$/\1/')"
  docker run --rm --platform linux/arm64 \
    -v "$STAGE_DIR:/srv:ro" \
    -e "EXPECTED_VERSION=$expected_version" \
    "$image" sh -c "$CONTAINER_SCRIPT" \
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
