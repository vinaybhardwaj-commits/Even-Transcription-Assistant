#!/bin/zsh
cd /Users/vinaybhardwaj/dev/Even-Transcription-Assistant-ow || exit 9
O=/Users/vinaybhardwaj/dev/_fable/r2-diff.txt
{
echo "=== HEAD/branches ==="; git log --oneline -4 135d33e
echo "--- current checkout:"; git rev-parse --abbrev-ref HEAD; git rev-parse HEAD
echo "--- s1-auto-drain:"; git rev-parse vinay/s1-auto-drain
echo "--- premerge tag:"; git rev-parse fable-premerge-vad
echo "=== STATUS ==="; git status --porcelain | head -20
echo "=== SCOPE: files changed premerge..135d33e ==="; git diff --stat fable-premerge-vad..135d33e
echo "=== ROUTER FILE IN REPO? ==="; git log --oneline -3 -- '*router_server.py'
echo "=== DIFF vs round1 merge 5c184ea ==="; git diff --stat 5c184ea..135d33e
echo "=== FULL DIFF premerge..135d33e ==="; git diff fable-premerge-vad..135d33e
} > $O 2>&1
echo "wrote $(wc -l < $O) lines"
