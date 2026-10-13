#!/bin/bash
# Installs scripts/steward/pre-push as this clone's pre-push hook. Run by the merge owner's decision, per clone.
set -eu
ROOT="$(git rev-parse --show-toplevel)"
HOOKS="$(git rev-parse --git-path hooks)"
[ -e "$HOOKS/pre-push" ] && { echo "pre-push hook already exists: $HOOKS/pre-push (not overwritten)" >&2; exit 1; }
mkdir -p "$HOOKS"
ln -s "$ROOT/scripts/steward/pre-push" "$HOOKS/pre-push"
echo "installed: $HOOKS/pre-push"
