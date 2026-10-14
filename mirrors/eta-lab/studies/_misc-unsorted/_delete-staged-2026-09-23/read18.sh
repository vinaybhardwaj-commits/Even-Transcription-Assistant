#!/bin/bash
set -e
WT=/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt
echo "=== AssembleTapeInput type ==="
grep -n "AssembleTapeInput\|RawBenchWindowRow\|RawTranscriptRow\|type RawTranscript\|type RawBench" "$WT/lib/room-day/admin.ts" | head -30
