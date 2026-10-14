#!/bin/zsh
cd /Users/vinaybhardwaj/dev/Even-Transcription-Assistant-ow || exit 9
{
echo "=== HEAD ==="; git log --oneline -6
echo "=== STATUS ==="; git status --porcelain | head -20
echo "=== BRANCH ==="; git rev-parse --abbrev-ref HEAD
echo "=== DIFFSTAT ==="; git diff --stat fable-premerge-vad..HEAD
echo "=== FULLDIFF ==="; git diff fable-premerge-vad..HEAD
} > /Users/vinaybhardwaj/dev/_fable/refuter-diff.txt 2>&1
echo "wrote $(wc -l < /Users/vinaybhardwaj/dev/_fable/refuter-diff.txt) lines"
