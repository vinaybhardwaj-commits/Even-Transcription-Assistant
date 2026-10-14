#!/bin/bash
WT=/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt
cd "$WT"
echo "=== docker status ==="
docker ps -a 2>&1 | head -20
echo "=== git stash my changes ==="
git stash
echo "=== stash list ==="
git stash list
echo "=== run just the failing suite on baseline 8d6b6e8 ==="
npx vitest run tests/unit/c2-e2e-runner.test.ts 2>&1 | tail -40
echo "BASELINE_RC=$?"
echo "=== restore my changes ==="
git stash pop
git --no-pager diff --stat
