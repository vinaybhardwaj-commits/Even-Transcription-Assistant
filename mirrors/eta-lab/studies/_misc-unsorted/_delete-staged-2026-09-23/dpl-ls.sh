#!/bin/zsh
cd /Users/vinaybhardwaj/dev/Even-Transcription-Assistant-ow || exit 1
npx -y vercel ls --scope vinaybhardwaj-commits-projects 2>&1 | head -12
