#!/bin/bash
set -e
WT=/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt
echo "=== admin.ts 90-160 ==="
sed -n '90,160p' "$WT/lib/room-day/admin.ts"
echo "=== admin.ts 500-560 ==="
sed -n '500,560p' "$WT/lib/room-day/admin.ts"
