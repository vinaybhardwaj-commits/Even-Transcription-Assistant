#!/bin/zsh
cd /Users/vinaybhardwaj/dev/Even-Transcription-Assistant || exit 1
echo "=== promote 45eedda (even-transcription-assistant-6mcevplye.vercel.app) ==="
npx -y vercel promote even-transcription-assistant-6mcevplye.vercel.app --yes --scope vinaybhardwaj-commits-projects 2>&1 | tail -12
