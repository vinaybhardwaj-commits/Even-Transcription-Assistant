#!/bin/zsh
cd /Users/vinaybhardwaj/dev/Even-Transcription-Assistant-ow || exit 1
S=vinaybhardwaj-commits-projects
U=https://even-transcription-assistant-nlrmwk94n.vercel.app
echo "=== promote $U ==="
npx -y vercel promote "$U" --yes --scope "$S" 2>&1 | tail -20
echo "=== prod ==="
npx -y vercel ls --scope "$S" --prod 2>&1 | head -8
