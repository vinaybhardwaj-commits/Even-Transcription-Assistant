#!/bin/zsh
set -u
cd /Users/vinaybhardwaj/dev/Even-Transcription-Assistant || exit 1
npx -y vercel env ls production --scope vinaybhardwaj-commits-projects 2>&1 | sed -E 's/[[:space:]]{2,}/ | /g' | head -60
