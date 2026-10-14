#!/bin/bash
set -e
WT=/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt
echo "WT_EXISTS_CHECK"
if [ -d "$WT" ]; then
  echo "ALIVE=yes"
  echo "PATH=$WT"
  ls -la "$WT" | head -20
  echo "---git status---"
  cd "$WT" && git status --short --branch 2>&1 | head -20
  echo "---git log---"
  git log --oneline -3 2>&1
  echo "---node_modules---"
  ls "$WT/node_modules" 2>&1 | head -3
  echo "---node_modules count---"
  ls "$WT/node_modules" 2>/dev/null | wc -l
else
  echo "ALIVE=no"
fi
