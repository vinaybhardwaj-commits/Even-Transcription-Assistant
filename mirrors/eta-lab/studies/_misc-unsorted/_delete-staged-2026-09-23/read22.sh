#!/bin/bash
set -e
WT=/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt
echo "=== route-metrics-truth.test.ts full ==="
cat -n "$WT/tests/unit/route-metrics-truth.test.ts"
