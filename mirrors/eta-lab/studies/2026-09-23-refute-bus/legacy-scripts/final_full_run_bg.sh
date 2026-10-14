#!/bin/bash
LOG=/Users/vinaybhardwaj/dev/_fable/final_full_run.log
rm -f "$LOG" /Users/vinaybhardwaj/dev/_fable/final_full_run.done
WT=/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt
nohup bash -c '
cd '"$WT"'
{
docker ps -a --filter "name=eta-c2-e2e" -q | xargs -r docker rm -f
echo "=== git status before run ==="
git status --short
START=$(date +%s)
npx vitest run > /tmp/final_vitest_out.log 2>&1
RC=$?
END=$(date +%s)
echo "FINAL_VITEST_RC=$RC"
echo "FINAL_DURATION_S=$((END-START))"
tail -60 /tmp/final_vitest_out.log
echo "=== git status after run (must be unchanged) ==="
git status --short
} > '"$LOG"' 2>&1
touch /Users/vinaybhardwaj/dev/_fable/final_full_run.done
' > /Users/vinaybhardwaj/dev/_fable/final_full_run.nohup.log 2>&1 &
disown
echo "STARTED pid=$!"
