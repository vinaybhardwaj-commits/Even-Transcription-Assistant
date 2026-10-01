#!/bin/bash
# Usage: uninstall.sh <ssh-target>   Removes the policy entries, the kit files, and (via policy) the extension.
set -euo pipefail
TARGET="${1:?usage: uninstall.sh <ssh-target>}"
KIT="$(cd "$(dirname "$0")" && pwd)"
ID="$(cat "$KIT/extension-id.txt")"
REMOTE="$(ssh -o ConnectTimeout=15 "$TARGET" 'mktemp -d /tmp/eta-presence.XXXXXX')"
case "$REMOTE" in /tmp/eta-presence.*) ;; *) echo "unexpected remote dir" >&2; exit 1;; esac
scp -q -o ConnectTimeout=15 "$KIT/remote/remove.sh" "$TARGET:$REMOTE/"
ssh -t -o ConnectTimeout=15 "$TARGET" "sudo bash '$REMOTE/remove.sh' '$ID'; rc=\$?; rm -rf '$REMOTE'; exit \$rc"
echo "removed from $TARGET"
