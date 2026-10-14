#!/bin/bash
set -e
WT=/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt
echo "=== types.ts grep RouterResult/RouterJobStatus/segmentation/outcome ==="
grep -n "RouterResult\|RouterJobStatus\|segmentation\|outcome\|routerOutcome" "$WT/lib/stt/types.ts"
echo "=== eta-router.ts grep RouterResult type def ==="
grep -n "RouterResult\|segmentation\|outcome" "$WT/lib/stt/eta-router.ts" | head -60
