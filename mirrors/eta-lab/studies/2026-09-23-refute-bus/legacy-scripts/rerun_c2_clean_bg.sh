#!/bin/bash
LOG=/Users/vinaybhardwaj/dev/_fable/c2_clean_run.log
rm -f "$LOG" /Users/vinaybhardwaj/dev/_fable/c2_clean_run.done
WT=/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt
nohup bash -c '
cd '"$WT"'
{
echo "=== removing any stale eta-c2-e2e containers ==="
docker ps -a --filter "name=eta-c2-e2e" -q | xargs -r docker rm -f
echo "=== confirm git status unchanged (no stash weirdness) ==="
git status --short
echo "=== running c2-e2e-runner.test.ts fresh ==="
npx vitest run tests/unit/c2-e2e-runner.test.ts 2>&1 | tail -80
echo "C2_RC=$?"
} > '"$LOG"' 2>&1
touch /Users/vinaybhardwaj/dev/_fable/c2_clean_run.done
' > /Users/vinaybhardwaj/dev/_fable/c2_clean_run.nohup.log 2>&1 &
disown
echo "STARTED pid=$!"
