#!/bin/bash
set -e
WT=/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt
cd "$WT"
git log --oneline -- lib/stt/room-drain.ts | head -20
echo "=== diff for the buildRouteMetrics line across last 5 commits touching file ==="
git log -p -3 -- lib/stt/room-drain.ts | grep -n "languageTimeline\|routerOutcome\|buildRouteMetrics" 
