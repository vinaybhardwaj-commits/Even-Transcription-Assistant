#!/bin/bash
WT=/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt
cd "$WT"
npx tsc --noEmit -p tsconfig.tests.json 2>&1 | tail -150
echo "TSC_EXIT=$?"
