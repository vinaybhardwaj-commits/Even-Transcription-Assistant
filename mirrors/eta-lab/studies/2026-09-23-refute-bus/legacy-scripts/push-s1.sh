#!/bin/zsh
cd /Users/vinaybhardwaj/dev/_fable/wt-merge || exit 1
echo "head: $(git rev-parse --short HEAD)"
git push origin HEAD:vinay/s1-auto-drain 2>&1 | tail -4
echo
echo "=== log ==="
git log --oneline -4
