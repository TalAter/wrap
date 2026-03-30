#!/bin/bash
#
# Stop hook: runs lint, typecheck, and tests when Claude stops.
#
# Optimizations to avoid unnecessary work:
#   1. Fingerprint = HEAD sha + uncommitted code-relevant diff.
#      Non-code files (specs/, *.md) are excluded from the diff.
#   2. Fingerprint is cached on success. If it matches next run,
#      skip. On failure, cache is not updated — next stop re-checks.
#      Fingerprint is recomputed after checks because lint --write
#      may have changed files (so the cached state matches post-fix).
#   3. Lint, tsc, and tests run in parallel (~4s instead of ~5s).
#
# The lint script (`bun run lint`) uses `biome check --write`, so safe
# fixable issues (import ordering, formatting) are corrected automatically.

cd "$(dirname "$0")/../.." || exit 0

REPO_ID=$(pwd | shasum -a 256 | cut -c1-12)
CACHE_FILE="/tmp/wrap-hook-${REPO_ID}"

# --- Build fingerprint: HEAD commit + uncommitted code-relevant diff ---
HEAD_SHA=$(git rev-parse HEAD 2>/dev/null)
CODE_CHANGED=$(git diff --name-only HEAD 2>/dev/null | grep -v -e '^specs/' -e '\.md$' || true)
CODE_DIFF=$([ -n "$CODE_CHANGED" ] && echo "$CODE_CHANGED" | tr '\n' '\0' | xargs -0 git diff HEAD -- 2>/dev/null || true)
FINGERPRINT=$(printf '%s%s' "$HEAD_SHA" "$CODE_DIFF" | shasum -a 256 | cut -d' ' -f1)

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

# Recompute fingerprint after checks (lint --write may have changed files)
HEAD_SHA=$(git rev-parse HEAD 2>/dev/null)
CODE_CHANGED=$(git diff --name-only HEAD 2>/dev/null | grep -v -e '^specs/' -e '\.md$' || true)
CODE_DIFF=$([ -n "$CODE_CHANGED" ] && echo "$CODE_CHANGED" | tr '\n' '\0' | xargs -0 git diff HEAD -- 2>/dev/null || true)
FINGERPRINT=$(printf '%s%s' "$HEAD_SHA" "$CODE_DIFF" | shasum -a 256 | cut -d' ' -f1)
echo "$FINGERPRINT" >"$CACHE_FILE"
exit 0
