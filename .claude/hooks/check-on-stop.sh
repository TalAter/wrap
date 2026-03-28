#!/bin/bash
INPUT=$(cat)

# Prevent infinite loops — if we already triggered a continuation, skip
if [ "$(echo "$INPUT" | jq -r '.stop_hook_active')" = "true" ]; then
  exit 0
fi

cd "$(dirname "$0")/../.." || exit 0

ERRORS=""

# 1. Biome format (autoformat, don't block)
bun run format 2>&1 | tail -1 >&2

# 2. Biome lint
LINT_OUTPUT=$(bun run lint 2>&1)
if [ $? -ne 0 ]; then
  ERRORS="${ERRORS}Biome check failed:\n${LINT_OUTPUT}\n\n"
fi

# 3. Typecheck
TSC_OUTPUT=$(bunx tsc --noEmit 2>&1)
if [ $? -ne 0 ]; then
  ERRORS="${ERRORS}Typecheck failed:\n${TSC_OUTPUT}\n\n"
fi

# 4. Tests
TEST_OUTPUT=$(bun test 2>&1)
if [ $? -ne 0 ]; then
  ERRORS="${ERRORS}Tests failed:\n${TEST_OUTPUT}\n\n"
fi

if [ -n "$ERRORS" ]; then
  echo -e "$ERRORS" >&2
  exit 2
fi

exit 0
