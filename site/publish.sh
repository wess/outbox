#!/usr/bin/env bash
# Publish the built docs to a `gh-pages` branch.
#
# Only needed when the repository's Pages source is set to "Deploy from a
# branch". The workflow in .github/workflows/pages.yml is the better path — it
# deploys straight from Actions and needs no branch at all.
#
#   ./site/publish.sh
#
# This force-pushes `gh-pages`. That branch holds nothing but generated output,
# so its history is disposable — but it is a force push, so read before running.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BRANCH="${GH_PAGES_BRANCH:-gh-pages}"
REMOTE="${GH_PAGES_REMOTE:-origin}"
REPO_NAME="$(basename -s .git "$(git config --get remote."$REMOTE".url)")"
OWNER="$(git config --get remote."$REMOTE".url | sed -E 's#.*[:/]([^/]+)/[^/]+$#\1#')"

BASE="${SITE_BASE:-/$REPO_NAME}"
export SITE_URL="${SITE_URL:-https://$OWNER.github.io$BASE}"

echo "building for $SITE_URL"
bun run site/build.ts --base "$BASE"

if [ -n "$(git status --porcelain)" ]; then
  echo "working tree is dirty — commit or stash first" >&2
  exit 1
fi

WORKTREE="$(mktemp -d)"
trap 'git worktree remove --force "$WORKTREE" 2>/dev/null || true; rm -rf "$WORKTREE"' EXIT

if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git worktree add "$WORKTREE" "$BRANCH"
else
  git worktree add --detach "$WORKTREE"
  git -C "$WORKTREE" checkout --orphan "$BRANCH"
  git -C "$WORKTREE" rm -rf . >/dev/null 2>&1 || true
fi

# Replace the contents wholesale; the branch mirrors the build, nothing more.
find "$WORKTREE" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R site/public/. "$WORKTREE"/

git -C "$WORKTREE" add -A
if git -C "$WORKTREE" diff --cached --quiet; then
  echo "no changes to publish"
  exit 0
fi

git -C "$WORKTREE" commit -m "docs: publish $(git rev-parse --short HEAD)"
git -C "$WORKTREE" push --force "$REMOTE" "$BRANCH"

echo "published to $BRANCH — set Pages source to that branch, root folder"
