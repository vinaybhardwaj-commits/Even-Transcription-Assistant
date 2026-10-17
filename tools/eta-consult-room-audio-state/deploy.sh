#!/usr/bin/env bash
# Move the pinned deploy worktree (what ras-hourly.service runs) to the current HEAD, only from a clean commit.
#   ./deploy.sh            deploy HEAD
#   ./deploy.sh --check    show what would happen, change nothing
# Creates a new tag ras-deploy-YYYYMMDD-N at HEAD, moves the floating tag ras-deploy-current to it, and checks the
# worktree out (detached) at that tag, after installing requirements.txt into the venv first (the only place the venv changes). The timer's next firing then runs the new code; it is never edited in place.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="${RAS_DEPLOY_DIR:-$HOME/oc/consult/audio/deploy}"
VENV="${RAS_VENV:-$HOME/oc/consult/audio/ras-venv}"
LOG="${RAS_DEPLOY_LOG:-$HOME/oc/consult/audio/deploy.log}"
CHECK=0; [ "${1:-}" = "--check" ] && CHECK=1
cd "$REPO"

if [ -n "$(git status --porcelain)" ]; then
  echo "refusing: working tree is not clean (uncommitted or untracked files):" >&2
  git status --short >&2
  exit 1
fi
HEAD_SHA="$(git rev-parse --verify HEAD)"
day="$(date +%Y%m%d)"
n=1
while git rev-parse -q --verify "refs/tags/ras-deploy-$day-$n" >/dev/null; do n=$((n+1)); done
TAG="ras-deploy-$day-$n"
if [ -d "$DEPLOY" ] && [ -n "$(git -C "$DEPLOY" status --porcelain 2>/dev/null)" ]; then
  echo "refusing: deploy worktree $DEPLOY has local changes" >&2
  exit 1
fi
echo "HEAD $HEAD_SHA -> tag $TAG -> $DEPLOY"
[ "$CHECK" = 1 ] && exit 0
trap 'echo "$(date -Is) FAILED deploy of $HEAD_SHA aborted at line $LINENO" >> "$LOG"' ERR

# The live venv changes only here, and BEFORE any tag or worktree moves: install the pinned requirements of HEAD (user site
# ignored, so a copy in ~/.local never stands in for the venv's own). If pip fails nothing has moved; the failure is logged.
# RAS_VENV="" skips this (tests).
if [ -n "$VENV" ] && [ -x "$VENV/bin/python" ] && git cat-file -e "$HEAD_SHA:requirements.txt" 2>/dev/null; then
  REQ="$(mktemp)"; git show "$HEAD_SHA:requirements.txt" > "$REQ"
  if ! PYTHONNOUSERSITE=1 "$VENV/bin/python" -m pip install -q --no-warn-script-location -r "$REQ"; then
    rm -f "$REQ"
    echo "$(date -Is) FAILED pip install for $HEAD_SHA ($TAG not created, worktree and tags unchanged)" >> "$LOG"
    echo "refusing: pip install failed; nothing was deployed" >&2
    exit 1
  fi
  rm -f "$REQ"
fi
git tag "$TAG" "$HEAD_SHA"
git tag -f ras-deploy-current "$TAG" >/dev/null
if [ -d "$DEPLOY/.git" ] || [ -f "$DEPLOY/.git" ]; then
  git -C "$DEPLOY" checkout -q --detach "$TAG"
else
  git worktree add -q --detach "$DEPLOY" "$TAG"
fi
if [ "$(git -C "$DEPLOY" rev-parse HEAD)" != "$HEAD_SHA" ]; then
  echo "$(date -Is) FAILED worktree not at $HEAD_SHA after checkout of $TAG" >> "$LOG"
  exit 1
fi
echo "$(date -Is) $TAG $HEAD_SHA" >> "$LOG"
echo "deployed $TAG"
