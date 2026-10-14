#!/bin/zsh
cd /Users/vinaybhardwaj/dev/_fable/wt-merge || exit 1
echo "=== runner: app/api/run-migrations/route.ts ==="
grep -n -E "sort|readdir|version|ON CONFLICT|applied|already|gap|max|slice|parseInt|Number" app/api/run-migrations/route.ts | head -40
