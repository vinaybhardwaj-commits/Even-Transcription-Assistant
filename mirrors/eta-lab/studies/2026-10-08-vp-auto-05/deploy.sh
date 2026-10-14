#!/usr/bin/env bash
# Move the pinned deploy worktree (what vp-auto-daily.service runs) to the current HEAD of a CLEAN checkout (same pattern as the cutter's deploy.sh).
#   ./deploy.sh            deploy HEAD
#   ./deploy.sh --check    show what would happen, change nothing
# Creates tag vp-auto-deploy-YYYYMMDD-N at HEAD, moves the floating tag vp-auto-deploy-current to it and checks the worktree out (detached) at that tag.
# The units are NOT installed or enabled by this script (consult-lead enables the timer after the refuter PASS).
set -euo pipefail
REPO="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
DEPLOY="${VPAUTO_DEPLOY_DIR:-$HOME/oc/consult/vp-auto-deploy}"
LOG="${VPAUTO_DEPLOY_LOG:-$HOME/oc/consult/vp-auto-deploy.log}"
CHECK=0; [ "${1:-}" = "--check" ] && CHECK=1
cd "$REPO"
if [ -n "$(git status --porcelain)" ]; then
  echo "refusing: working tree is not clean (uncommitted or untracked files):" >&2; git status --short >&2; exit 1
fi
HEAD_SHA="$(git rev-parse --verify HEAD)"
day="$(date +%Y%m%d)"; n=1
while git rev-parse -q --verify "refs/tags/vp-auto-deploy-$day-$n" >/dev/null; do n=$((n+1)); done
TAG="vp-auto-deploy-$day-$n"
if [ -d "$DEPLOY" ] && [ -n "$(git -C "$DEPLOY" status --porcelain 2>/dev/null)" ]; then
  echo "refusing: deploy worktree $DEPLOY has local changes" >&2; exit 1
fi
echo "HEAD $HEAD_SHA -> tag $TAG -> $DEPLOY"
[ "$CHECK" = 1 ] && exit 0
git tag "$TAG" "$HEAD_SHA"
git tag -f vp-auto-deploy-current "$TAG" >/dev/null
if [ -d "$DEPLOY/.git" ] || [ -f "$DEPLOY/.git" ]; then git -C "$DEPLOY" checkout -q --detach "$TAG"; else git worktree add -q --detach "$DEPLOY" "$TAG"; fi
test "$(git -C "$DEPLOY" rev-parse HEAD)" = "$HEAD_SHA"
echo "$(date -Is) $TAG $HEAD_SHA" >> "$LOG"
echo "deployed $TAG"
