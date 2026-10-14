#!/bin/bash
WT=/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt
cd "$WT"
npx vitest run tests/unit/vad-starvation-job-path.test.ts tests/unit/route-metrics-truth.test.ts tests/unit/c1-route-job.test.ts tests/unit/room-day-tape.test.ts tests/unit/hotfix-silent-window.test.ts tests/unit/e11-silent-room-window.test.ts 2>&1 | tail -200
echo "VITEST_EXIT=$?"
