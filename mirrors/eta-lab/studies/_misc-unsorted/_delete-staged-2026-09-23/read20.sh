#!/bin/bash
set -e
WT=/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt
grep -n "function buildSlotGrid" -A 25 "$WT/lib/room-day/admin.ts"
echo "=== existing room-day-tape.test.ts sample construction (first 120 lines) ==="
sed -n '1,120p' "$WT/tests/unit/room-day-tape.test.ts"
