#!/bin/bash
WT=/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt
cd "$WT"
START=$(date +%s)
npx tsc --noEmit -p tsconfig.tests.json > /tmp/tsc_out.log 2>&1
TSC_RC=$?
echo "TSC_RC=$TSC_RC"
tail -60 /tmp/tsc_out.log
npx vitest run > /tmp/vitest_out.log 2>&1
VITEST_RC=$?
END=$(date +%s)
echo "VITEST_RC=$VITEST_RC"
echo "DURATION_S=$((END-START))"
tail -80 /tmp/vitest_out.log
