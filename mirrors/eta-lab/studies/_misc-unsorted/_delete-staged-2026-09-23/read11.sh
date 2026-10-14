#!/bin/bash
set -e
WT=/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt
echo "=== room-drain.ts 1060-1140 ==="
sed -n '1060,1140p' "$WT/lib/stt/room-drain.ts"
