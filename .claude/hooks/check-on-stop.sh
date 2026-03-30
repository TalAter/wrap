#!/bin/bash
#
# Stop hook: runs lint, typecheck, and tests when Claude stops.
#
# Optimizations to avoid unnecessary work:
#   1. Skip entirely if no files changed since last commit.
#   2. Skip if only non-code files changed (specs/, *.md).
#   3. Fingerprint the code-relevant diff and cache it on success.
#      If the fingerprint matches a previous successful run, skip.
#      On failure, don't cache — so the next stop always re-checks.
#   4. Run lint, tsc, and tests in parallel (~4s instead of ~5s).
#
# The lint script (`bun run lint`) uses `biome check --write`, so safe
# fixable issues (import ordering, formatting) are corrected automatically.

cd "$(dirname "$0")/../.." || exit 0

# --- Determine code-relevant changes ---
CHANGED=$(git diff --name-only HEAD 2>/dev/null)
[ -z "$CHANGED" ] && exit 0

# Filter out files that can't affect checks (specs/, .md)
CODE_CHANGED=$(echo "$CHANGED" | grep -v -e '^specs/' -e '\.md$' || true)
[ -z "$CODE_CHANGED" ] && exit 0

# --- Fingerprint: skip if checks already passed for this state ---
FINGERPRINT=$(git diff HEAD -- $CODE_CHANGED 2>/dev/null | shasum -a 256 | cut -d' ' -f1)
REPO_ID=$(pwd | shasum -a 256 | cut -c1-12)
CACHE_FILE="/tmp/wrap-hook-${REPO_ID}"
if [ -f "$CACHE_FILE" ] && [ "$(cat "$CACHE_FILE")" = "$FINGERPRINT" ]; then
  exit 0
fi

# --- Run checks in parallel ---
LINT_FILE=$(mktemp)
TSC_FILE=$(mktemp)
TEST_FILE=$(mktemp)
LINT_RC=$(mktemp)
TSC_RC=$(mktemp)
TEST_RC=$(mktemp)
trap 'rm -f "$LINT_FILE" "$TSC_FILE" "$TEST_FILE" "$LINT_RC" "$TSC_RC" "$TEST_RC"' EXIT

(bun run lint >"$LINT_FILE" 2>&1; echo $? >"$LINT_RC") &
(bunx tsc --noEmit >"$TSC_FILE" 2>&1; echo $? >"$TSC_RC") &
(bun test >"$TEST_FILE" 2>&1; echo $? >"$TEST_RC") &
wait

# --- Collect errors ---
ERRORS=""
[ "$(cat "$LINT_RC")" -ne 0 ] && ERRORS="${ERRORS}Biome check failed:\n$(cat "$LINT_FILE")\n\n"
[ "$(cat "$TSC_RC")" -ne 0 ] && ERRORS="${ERRORS}Typecheck failed:\n$(cat "$TSC_FILE")\n\n"
[ "$(cat "$TEST_RC")" -ne 0 ] && ERRORS="${ERRORS}Tests failed:\n$(cat "$TEST_FILE")\n\n"

if [ -n "$ERRORS" ]; then
  echo -e "$ERRORS" >&2
  exit 2
fi

# Cache fingerprint on success only
echo "$FINGERPRINT" >"$CACHE_FILE"
exit 0
