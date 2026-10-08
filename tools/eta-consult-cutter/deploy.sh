#!/usr/bin/env bash
# Move the pinned deploy worktree (what cutter-hourly.service runs) to the current HEAD, only from a clean commit (same pattern as ras).
#   ./deploy.sh            deploy HEAD
#   ./deploy.sh --check    show what would happen, change nothing
# Creates a new tag cutter-deploy-YYYYMMDD-N at HEAD, moves the floating tag cutter-deploy-current to it, and checks the worktree out (detached) at that tag.
# The timer's next firing then runs the new code; it is never edited in place. The timer itself stays DISABLED until consult-lead enables it.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="${CUTTER_DEPLOY_DIR:-$HOME/oc/consult/cutter-deploy}"
LOG="${CUTTER_DEPLOY_LOG:-$HOME/oc/consult/cutter-deploy.log}"
CHECK=0; [ "${1:-}" = "--check" ] && CHECK=1
cd "$REPO"
if [ -n "$(git status --porcelain)" ]; then
  echo "refusing: working tree is not clean (uncommitted or untracked files):" >&2; git status --short >&2; exit 1
fi
HEAD_SHA="$(git rev-parse --verify HEAD)"
day="$(date +%Y%m%d)"; n=1
while git rev-parse -q --verify "refs/tags/cutter-deploy-$day-$n" >/dev/null; do n=$((n+1)); done
TAG="cutter-deploy-$day-$n"
if [ -d "$DEPLOY" ] && [ -n "$(git -C "$DEPLOY" status --porcelain 2>/dev/null)" ]; then
  echo "refusing: deploy worktree $DEPLOY has local changes" >&2; exit 1
fi
echo "HEAD $HEAD_SHA -> tag $TAG -> $DEPLOY"
[ "$CHECK" = 1 ] && exit 0
git tag "$TAG" "$HEAD_SHA"
git tag -f cutter-deploy-current "$TAG" >/dev/null
if [ -d "$DEPLOY/.git" ] || [ -f "$DEPLOY/.git" ]; then git -C "$DEPLOY" checkout -q --detach "$TAG"; else git worktree add -q --detach "$DEPLOY" "$TAG"; fi
test "$(git -C "$DEPLOY" rev-parse HEAD)" = "$HEAD_SHA"
echo "$(date -Is) $TAG $HEAD_SHA" >> "$LOG"
echo "deployed $TAG"
