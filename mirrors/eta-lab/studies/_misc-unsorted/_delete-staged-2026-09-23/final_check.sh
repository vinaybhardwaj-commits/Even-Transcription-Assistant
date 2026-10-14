#!/bin/bash
WT=/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt
cd "$WT"
echo "=== git status ==="
git status --short
echo "=== branch ==="
git branch --show-current
echo "=== log ==="
git log --oneline -3
echo "=== confirm s1-auto-drain untouched ==="
git rev-parse vinay/s1-auto-drain 2>&1 || git log --oneline -1 vinay/s1-auto-drain 2>&1
git rev-parse refs/tags/fable-premerge-vad 2>&1
