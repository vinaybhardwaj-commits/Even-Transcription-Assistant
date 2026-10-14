#!/bin/bash
LOG=/Users/vinaybhardwaj/dev/_fable/measure_baseline.log
rm -f "$LOG" /Users/vinaybhardwaj/dev/_fable/measure_baseline.done
WT=/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt
nohup bash -c '
cd '"$WT"'
{
echo "=== diff stat BEFORE stash ==="
git diff --stat
echo "=== stashing ==="
git stash push -u -m "builder-temp-baseline-check"
echo "=== stash list ==="
git stash list
echo "=== diff stat AFTER stash (should be empty) ==="
git diff --stat
docker ps -a --filter "name=eta-c2-e2e" -q | xargs -r docker rm -f
echo "=== running full suite on TRUE baseline (8d6b6e8, unmodified) ==="
npx vitest run > /tmp/baseline_vitest_out.log 2>&1
RC=$?
echo "BASELINE_VITEST_RC=$RC"
tail -15 /tmp/baseline_vitest_out.log
echo "=== restoring my changes ==="
git stash pop
echo "=== diff stat AFTER pop (must match original) ==="
git diff --stat
} > '"$LOG"' 2>&1
touch /Users/vinaybhardwaj/dev/_fable/measure_baseline.done
' > /Users/vinaybhardwaj/dev/_fable/measure_baseline.nohup.log 2>&1 &
disown
echo "STARTED pid=$!"
