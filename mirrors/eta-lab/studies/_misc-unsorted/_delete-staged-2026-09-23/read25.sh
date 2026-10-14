#!/bin/bash
set -e
WT=/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt
echo "=== c1-route-job.test.ts (first 90 lines) ==="
sed -n '1,90p' "$WT/tests/unit/c1-route-job.test.ts"
