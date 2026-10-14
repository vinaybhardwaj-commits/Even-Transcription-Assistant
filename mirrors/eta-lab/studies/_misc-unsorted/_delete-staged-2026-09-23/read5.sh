#!/bin/bash
set -e
WT=/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt
echo "=== eta-router.ts full type block 1-100 ==="
cat -n "$WT/lib/stt/eta-router.ts" | sed -n '1,100p'
