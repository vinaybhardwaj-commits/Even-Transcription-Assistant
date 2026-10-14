#!/bin/bash
set -e
WT=/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt
echo "=== admin.ts 380-500 ==="
sed -n '380,500p' "$WT/lib/room-day/admin.ts"
