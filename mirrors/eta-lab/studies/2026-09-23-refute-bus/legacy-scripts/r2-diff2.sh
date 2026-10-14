#!/bin/zsh
cd /Users/vinaybhardwaj/dev/Even-Transcription-Assistant-ow || exit 9
O=/Users/vinaybhardwaj/dev/_fable/r2-diff2.txt
MB=$(git merge-base fable-premerge-vad 135d33e)
{
echo "=== merge-base = $MB ==="; git log --oneline -1 $MB
echo "=== SCOPE: branch's own files (merge-base..135d33e) ==="; git diff --stat $MB..135d33e
echo "=== ROUND1 TIP 8d6b6e8 -> 135d33e (the fix only) ==="; git diff --stat 8d6b6e8..135d33e
echo "=== any router_server.py tracked in repo? ==="; git ls-files | grep -i router_server || echo "NONE TRACKED"
echo "=== FULL FIX DIFF 8d6b6e8..135d33e ==="; git diff 8d6b6e8..135d33e
} > $O 2>&1
echo "wrote $(wc -l < $O) lines"
