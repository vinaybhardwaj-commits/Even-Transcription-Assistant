#!/bin/bash
set -e
WT=/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt
grep -n "engines_detail\|engines:\|assembleTape\|readEngineOutcome\|import.*route-run" "$WT/lib/room-day/admin.ts"
