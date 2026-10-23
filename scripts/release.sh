#!/usr/bin/env bash
# scripts/release.sh — cut a wrap release locally: preflight, bump the crate
# version, commit, tag. Deliberately never pushes; the push is the manual,
# easily-undone step that triggers .github/workflows/release.yml.
#
# Usage: scripts/release.sh <version>      e.g. 0.0.8 or 0.0.8-rc.1
#
# DRY_RUN=1 runs every preflight check and shows the version bump as a diff,
# then restores Cargo.toml/Cargo.lock and skips the commit and tag.

set -euo pipefail

usage() {
  echo "Usage: scripts/release.sh <version>  (e.g. 0.0.2 or 0.0.2-rc.1)" >&2
  exit 1
}

fail() {
  echo "error: $1" >&2
  exit 1
}

version="${1:-}"
[ -n "$version" ] || usage
case "$version" in
  *[!0-9A-Za-z.-]*) usage ;;
esac
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || usage
tag="v$version"

cd "$(dirname "$0")/.."

# ---- preflight --------------------------------------------------------------

[ -z "$(git status --porcelain)" ] || fail "working tree not clean. Commit or stash first."

branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "main" ] || fail "releases are cut from \`main\`, currently on \`$branch\`."

git fetch origin main --quiet
[ "$(git rev-parse main)" = "$(git rev-parse origin/main)" ] \
  || fail "local \`main\` differs from \`origin/main\`. Pull/push first."

[ -z "$(git tag -l "$tag")" ] || fail "tag $tag already exists."

echo "Running make check…" >&2
make check || fail "\`make check\` failed. Fix before tagging."

# ---- version bump -----------------------------------------------------------

# Only the first `version = "…"` line after [package] is the crate version;
# dependency tables below carry their own version keys.
perl -0pi -e 's/(\[package\][^\[]*?^version = ")[^"]*(")/${1}'"$version"'${2}/m' Cargo.toml
grep -q "^version = \"$version\"\$" Cargo.toml || fail "could not set version in Cargo.toml."

# Re-resolve only the workspace member so Cargo.lock's own `wrap` entry picks
# up the new version without touching any dependency.
cargo update --workspace --offline --quiet
grep -A1 '^name = "wrap"$' Cargo.lock | grep -q "^version = \"$version\"\$" \
  || fail "Cargo.lock did not pick up version $version."

if [ "${DRY_RUN:-}" = "1" ]; then
  git --no-pager diff -- Cargo.toml Cargo.lock
  git checkout --quiet -- Cargo.toml Cargo.lock
  echo "DRY_RUN=1: preflight passed; skipped commit and tag $tag." >&2
  exit 0
fi

git add Cargo.toml Cargo.lock
# Re-run safe: already at the target version means nothing to commit, still tag.
if [ -n "$(git diff --cached --name-only)" ]; then
  git commit --quiet -m "release $tag"
fi
git tag "$tag"

echo "Tagged $tag at HEAD." >&2
echo "Next: git push origin main && git push origin $tag" >&2
