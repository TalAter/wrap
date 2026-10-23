#!/bin/bash
#
# Stop hook: formats and lints the crate when Claude stops.

cd "$(dirname "$0")/../.." || exit 0

# Detach stdin so nothing in this script can read from the terminal.
exec </dev/null

OUTPUT=$(cargo fmt --all 2>&1 && cargo clippy --quiet --all-targets -- -D warnings 2>&1)
RC=$?

if [ "$RC" -ne 0 ]; then
  echo -e "Lint failed:\n$OUTPUT" >&2
  exit 2
fi
