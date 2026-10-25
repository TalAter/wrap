#!/bin/sh
# scripts/test-install.sh — local Docker rig for install.sh.
#
# Builds wrap binaries for one Linux arch (glibc + musl), stages them with
# checksums.txt, install.sh, and install-assert.sh, then runs the assertion
# checklist inside ubuntu:24.04 and alpine:3.20.
#
# The binaries are built inside a rust:slim-bookworm container of the same
# platform rather than on the host: cross-compiling Linux targets from macOS
# needs a musl/glibc cross toolchain (or `cross`), while a Linux container of
# the right arch only needs `rustup target add` + musl-tools — the same recipe
# release.yml uses. The container's cargo registry and target dir live in named
# Docker volumes so repeat runs only rebuild what changed.
#
# Run from the repo root: `./scripts/test-install.sh`.
# Requires Docker or Podman. Builds the host architecture by default;
# WRAP_TEST_PLATFORM can select linux/arm64 or linux/amd64 explicitly.

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STAGE_PARENT="${WRAP_TEST_STAGE_DIR:-${TMPDIR:-/tmp}}"
mkdir -p "$STAGE_PARENT"
STAGE_DIR=$(mktemp -d "$STAGE_PARENT/wrap-test.XXXXXX")
trap 'rm -rf "$STAGE_DIR"' EXIT
ENGINE=${CONTAINER_ENGINE:-}
if [ -z "$ENGINE" ]; then
  if command -v podman >/dev/null 2>&1; then ENGINE=podman; else ENGINE=docker; fi
fi
PLATFORM=${WRAP_TEST_PLATFORM:-}
if [ -z "$PLATFORM" ]; then
  case $(uname -m) in
    arm64|aarch64) PLATFORM=linux/arm64 ;;
    x86_64) PLATFORM=linux/amd64 ;;
    *) printf 'Unsupported host architecture; set WRAP_TEST_PLATFORM.\n' >&2; exit 1 ;;
  esac
fi

note() {
  printf '== %s\n' "$1" >&2
}

err() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

case "$PLATFORM" in
  linux/arm64) ARCH=aarch64 ;;
  linux/amd64) ARCH=x86_64 ;;
  *) err "unsupported WRAP_TEST_PLATFORM: $PLATFORM (linux/arm64 or linux/amd64)" ;;
esac

# Runs inside rust:slim-bookworm: /src is the repo (read-only), /out is the
# stage dir. Builds both triples, strips them, tars each as a single `wrap`,
# and writes checksums.txt in the same format as the release workflow.
# shellcheck disable=SC2016  # all $-vars expand inside the container, not here
BUILD_SCRIPT='
set -eu
apt-get update -qq >/dev/null
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq musl-tools >/dev/null
gnu="${ARCH}-unknown-linux-gnu"
musl="${ARCH}-unknown-linux-musl"
rustup target add "$gnu" "$musl" >/dev/null
export "CC_$(echo "$musl" | tr - _)=musl-gcc"
cd /src
for triple in "$gnu" "$musl"; do
  echo "== cargo build --target $triple" >&2
  cargo build --release --locked --quiet --target "$triple"
  strip "/target/$triple/release/wrap"
  tar -czf "/out/wrap-${triple}.tar.gz" -C "/target/$triple/release" wrap
done
cd /out
sha256sum wrap-*.tar.gz > checksums.txt
'

stage_assets() {
  note "Building wrap for $ARCH (glibc + musl) in rust:slim-bookworm ($PLATFORM)..."
  "$ENGINE" run --rm --platform "$PLATFORM" \
    -v "$REPO_DIR:/src:ro" \
    -v "$STAGE_DIR:/out" \
    -v wrap-test-cargo-registry:/usr/local/cargo/registry \
    -v "wrap-test-target-$ARCH:/target" \
    -e CARGO_TARGET_DIR=/target \
    -e "ARCH=$ARCH" \
    docker.io/library/rust:slim-bookworm sh -c "$BUILD_SCRIPT" \
    || err "build failed"

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
  expected_version="$(sed -n '/^\[package\]/,/^\[/{s/^version = "\(.*\)"$/\1/p}' "$REPO_DIR/Cargo.toml" | head -1)"
  "$ENGINE" run --rm --platform "$PLATFORM" \
    -v "$STAGE_DIR:/srv:ro" \
    -e "EXPECTED_VERSION=$expected_version" \
    "$image" sh -c "$CONTAINER_SCRIPT" \
    || err "checklist failed in $image"
}

main() {
  command -v "$ENGINE" >/dev/null 2>&1 || err "Docker or Podman required"

  stage_assets

  run_in_container "docker.io/library/ubuntu:24.04"
  run_in_container "docker.io/library/alpine:3.20"

  note "All containers passed."
}

main "$@"
