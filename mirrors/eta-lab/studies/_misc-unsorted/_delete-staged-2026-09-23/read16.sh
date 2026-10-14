#!/bin/bash
set -e
WT=/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt
echo "=== admin.ts 1-90 (imports/types) ==="
sed -n '1,90p' "$WT/lib/room-day/admin.ts"
