#!/bin/zsh
export PATH="/opt/homebrew/bin:$PATH"
cd ~/dev/Even-Transcription-Assistant-ot || { echo "NO REPO DIR"; exit 1; }
echo "=== final status ==="
git status --porcelain=v1
pgrep -fl vitest || echo "no vitest running"
echo DONE
