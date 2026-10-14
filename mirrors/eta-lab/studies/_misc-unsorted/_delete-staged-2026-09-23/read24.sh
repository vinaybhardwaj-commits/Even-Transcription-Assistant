#!/bin/bash
set -e
WT=/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt
echo "=== tier2-jobs-route-tools.test.ts (search silent_window / poll step usage) ==="
grep -n "silent_window\|routeTranscribeKind\|pollStep\|STEPS.poll\|ctx.step\|adapterFor\|vi.mock" "$WT/tests/unit/tier2-jobs-route-tools.test.ts" | head -60
