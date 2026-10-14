#!/bin/bash
WT=/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt
cd "$WT"
echo "=== git status ==="
git status --short
echo "=== git stash list ==="
git stash list
echo "=== git log -3 ==="
git log --oneline -3
echo "=== git diff --stat ==="
git diff --stat
echo "=== grep for RouterSegmentation in types.ts (proof edit present) ==="
grep -n "RouterSegmentation" lib/stt/types.ts | head -5
