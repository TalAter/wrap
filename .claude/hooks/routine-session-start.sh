#!/bin/sh
# Provision the monowrapo Bun workspace so wrap-core (and sweep) resolve to live
# sibling checkouts — the same model used locally. The cloud routine only checks
# out `wrap`; without this, `bun install` 404s on the unpublished wrap-core@0.0.1.
#
# Cloud sessions only. Local sessions already have the workspace on disk, so we
# no-op there (CLAUDE_CODE_REMOTE is set only in Claude Code's cloud env).
[ "$CLAUDE_CODE_REMOTE" = "true" ] || exit 0

set -e

WRAP_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
PARENT="$(dirname "$WRAP_DIR")"

# monowrapo's workspace globs are ../wrap, ../wrap-core, ../sweep (relative to
# the monowrapo dir). Ensure a sibling named exactly "wrap" points at the live
# checkout, whatever the routine named its worktree.
if [ "$(basename "$WRAP_DIR")" != "wrap" ] && [ ! -e "$PARENT/wrap" ]; then
  ln -s "$WRAP_DIR" "$PARENT/wrap"
fi

# Authorize private clones with GH_TOKEN when the env provides one; otherwise
# fall back to the in-session GitHub proxy. The proxy only works inside the live
# session (not the cached setup-script phase) — that's why cloning lives here.
auth_url() {
  if [ -n "${GH_TOKEN:-}" ]; then
    printf 'https://x-access-token:%s@github.com/TalAter/%s' "$GH_TOKEN" "$1"
  else
    printf 'https://github.com/TalAter/%s' "$1"
  fi
}

# Clone-or-refresh every sibling to its latest default branch, so stryker always
# runs against the wrap-core that's live on main.
for repo in wrap-core sweep monowrapo; do
  dir="$PARENT/$repo"
  if [ -d "$dir/.git" ]; then
    git -C "$dir" fetch --quiet origin
    git -C "$dir" reset --hard --quiet "@{u}"
  else
    git clone --quiet "$(auth_url "$repo")" "$dir"
  fi
done

# Workspace install: links ../wrap-core and ../sweep into wrap/node_modules.
cd "$PARENT/monowrapo"
bun install
