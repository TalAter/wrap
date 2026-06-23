#!/bin/sh
# Reference copy of the routine's cloud Environment → Setup script.
# Paste this into the Setup script field at claude.ai/code (Edit environment).
#
# It only warms the Bun module cache. The snapshot taken after setup keeps
# ~/.bun/install/cache, so the per-run SessionStart hook's workspace install
# hits cache instead of re-downloading every run. The hook
# (.claude/hooks/routine-session-start.sh) does the real, path-aware linkage
# against the live checkout — this script just primes the cache.
#
# Assumes `bun` is on PATH (the routine already runs `bun run mutate`).
set -e

warm=/tmp/wrap-warm
rm -rf "$warm"
mkdir -p "$warm"

# Clone the whole workspace (wrap included — monowrapo globs ../wrap) so the
# install resolves. GitHub's cloud proxy authorizes these with no token.
for repo in wrap-core sweep wrap monowrapo; do
  git clone --quiet "https://github.com/TalAter/$repo" "$warm/$repo"
done

cd "$warm/monowrapo"
bun install
