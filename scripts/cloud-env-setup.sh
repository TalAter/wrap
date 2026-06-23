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
# The setup phase runs BEFORE the session's GitHub proxy exists, so cloning
# private repos here needs an explicit token. Add a GH_TOKEN env var to the
# environment (a PAT with read access to wrap-core/sweep/monowrapo). Without it
# we skip warming entirely and let the in-session hook provision instead — no
# hard failure either way. Assumes `bun` is on PATH (the routine runs it).
set -e

if [ -z "${GH_TOKEN:-}" ]; then
  echo "No GH_TOKEN — skipping cache warm; the SessionStart hook provisions in-session."
  exit 0
fi

warm=/tmp/wrap-warm
rm -rf "$warm"
mkdir -p "$warm"

# Clone the whole workspace (wrap included — monowrapo globs ../wrap) so the
# install resolves.
for repo in wrap-core sweep wrap monowrapo; do
  git clone --quiet "https://x-access-token:${GH_TOKEN}@github.com/TalAter/$repo" "$warm/$repo"
done

cd "$warm/monowrapo"
bun install
