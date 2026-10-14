#!/bin/bash
WT=/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt
LOG=/Users/vinaybhardwaj/dev/_fable/full_test_run.log
rm -f "$LOG" /Users/vinaybhardwaj/dev/_fable/full_test_run.done
cd "$WT"
nohup bash -c '
START=$(date +%s)
npx tsc --noEmit -p tsconfig.tests.json > /tmp/tsc_out.log 2>&1
TSC_RC=$?
echo "TSC_RC=$TSC_RC" >> '"$LOG"'
cat /tmp/tsc_out.log >> '"$LOG"'
npx vitest run > /tmp/vitest_out.log 2>&1
VITEST_RC=$?
END=$(date +%s)
echo "VITEST_RC=$VITEST_RC" >> '"$LOG"'
echo "DURATION_S=$((END-START))" >> '"$LOG"'
cat /tmp/vitest_out.log >> '"$LOG"'
touch /Users/vinaybhardwaj/dev/_fable/full_test_run.done
' > /Users/vinaybhardwaj/dev/_fable/full_test_run.nohup.log 2>&1 &
disown
echo "STARTED pid=$!"
